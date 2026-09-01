require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchStockPrice, fetchHistoricalPrice, fetchMultipleStocks, formatFlexMessage } = require("./stockPrice");
const { setupScheduler, addSignal } = require("./scheduler");
const portfolio = require("./portfolio");
const pendingSignals = require("./pendingSignals");
const { migrate } = require("./migrate");

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use("/webhook", line.middleware(lineConfig));
app.get("/", function(req, res) { res.json({ status: "running" }); });

function isTimeFormat(str) { return /^\d{1,2}:\d{2}$/.test(str); }
function isPriceFormat(str) { return /^[\d.]+$/.test(str); }
function isTeacher(name) {
  const t = process.env.SIGNAL_SENDER_NAME || "";
  if (!t) return false;
  return name.includes(t) || t.includes(name);
}
function extractGroupTag(text) {
  // 從指令句尾抓「基本組」「進階組」，抓到就從文字裡拿掉，不影響原本指令解析
  const m = text.match(/\s*(基本組|進階組)\s*$/);
  if (m) return { text: text.slice(0, m.index).trim(), group: m[1] };
  return { text: text, group: null };
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
  const senderId = event.source.userId;
  const replyToken = event.replyToken;

  let senderName = "群組成員";
  try {
    if (event.source.groupId) {
      const p = await lineClient.getGroupMemberProfile(event.source.groupId, senderId);
      senderName = p.displayName;
    } else {
      const p = await lineClient.getProfile(senderId);
      senderName = p.displayName;
    }
  } catch (e) {}

  const now = new Date();
  const twNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const dateStr = twNow.toLocaleDateString("sv-SE");
  const timeStr = twNow.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  console.log("[" + timeStr + "] " + senderName + ": " + text);

  // ── 查股 ──
  const queryMatch = text.match(/^查股\s+(\d{4,6})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (queryMatch) {
    const code = queryMatch[1], qDate = queryMatch[2] || null, qTime = queryMatch[3] || null;
    const p = await fetchStockPrice(code, qDate, qTime);
    if (p) {
      const arrow = p.isUp ? "▲" : "▼";
      const label = qDate ? (qTime ? qTime + " 歷史價" : "收盤價") : p.marketStatus;
      const name = portfolio.getName(code) || p.longName || code;
      const msg = code + " " + name + "\n" + label + "：" + p.price + " TWD\n" +
        arrow + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n" +
        (p.high ? "最高：" + p.high + "　最低：" + p.low + "\n" : "") + p.timestamp;
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } else {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + queryMatch[1] + " 的資料" }] });
    }
    return;
  }

  // ── 股票名稱設定 ──
  const nameMatch = text.match(/^名稱\s+(\d{4,6})\s+(.+)$/);
  if (nameMatch) {
    const result = await portfolio.setName(nameMatch[1], nameMatch[2].trim());
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 個股資訊 / 新聞 ──
  const newsMatch = text.match(/^新聞\s+(\d{4,6})$/);
  if (newsMatch) {
    const code = newsMatch[1];
    const name = portfolio.getName(code) || code;
    try {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢 " + code + " " + name + " 資訊中..." }] });
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: "請用繁體中文簡短介紹台股 " + code + " " + name + "，包含：1.主要業務 2.所屬概念股族群 3.近期重要消息（你知道的），200字以內。" }],
      });
      const info = resp.content[0].text;
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "📋 " + code + " " + name + "\n" + "─".repeat(18) + "\n" + info }] });
    } catch (err) {
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "無法取得 " + code + " 的資訊" }] });
    }
    return;
  }

  // ── 確認訊號 ──
  const confirmExtract = extractGroupTag(text);
  const confirmMatch = confirmExtract.text.match(/^確認\s+(\d{4,6})(?:\s+([\d.]+))?$/);
  if (confirmMatch) {
    const code = confirmMatch[1];
    const manualPrice = confirmMatch[2] ? parseFloat(confirmMatch[2]) : null;
    const pending = await pendingSignals.getPending(code);
    if (!pending) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的待確認訊號" }] });
      return;
    }
    const finalPrice = manualPrice || pending.price;
    if (!finalPrice) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "請提供成交價：\n確認 " + code + " 價格" }] });
      return;
    }
    const finalGroup = confirmExtract.group || pending.group;
    if (pending.action === "買入") await portfolio.addBuy(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup);
    else await portfolio.addSell(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup);
    await pendingSignals.deletePending(code);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
      "✅ 已記錄\n" + code + " " + (portfolio.getName(code) || "") + " " + pending.action + (finalGroup ? "【" + finalGroup + "】" : "") + "\n" +
      "日期：" + pending.date + " " + pending.time + "\n" +
      "成交價：" + finalPrice + (manualPrice ? "（手動）" : "（歷史）")
    }] });
    return;
  }

  // ── 確認全部 ──
  if (text === "確認全部") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const failed = [];
    for (const p of all) {
      if (!p.price) { failed.push(p.code); continue; }
      if (p.action === "買入") await portfolio.addBuy(p.code, p.code, p.date, p.price, p.time, p.original, p.group);
      else await portfolio.addSell(p.code, p.code, p.date, p.price, p.time, p.original, p.group);
      await pendingSignals.deletePending(p.code);
    }
    let msg = "✅ 已記錄 " + (all.length - failed.length) + " 筆";
    if (failed.length) msg += "\n⚠ 缺少股價：\n" + failed.map(function(c) { return "確認 " + c + " 價格"; }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 待確認清單 ──
  if (text === "待確認") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const list = all.map(function(p) {
      return p.code + " " + (portfolio.getName(p.code) || "") + " " + p.action + (p.group ? "【" + p.group + "】" : "") +
        (p.price ? " @" + p.price : " ⚠無股價") + "（" + p.date + " " + p.time + "）";
    }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "待確認訊號：\n" + list + "\n\n回覆「確認 代號」或「確認全部」" }] });
    return;
  }

  // ── 備份 ──
  if (text === "備份") {
    const backup = await portfolio.getBackup();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: backup }] });
    return;
  }

  // ── 買入 ──
  const buyExtract = extractGroupTag(text);
  const buyMatch = buyExtract.text.match(/^買\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (buyMatch) {
    const code = buyMatch[1], bDate = buyMatch[2], last = buyMatch[3] ? buyMatch[3].trim() : null;
    let price = null;
    if (!last) { const p = await fetchHistoricalPrice(code, bDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, bDate, last); price = p ? p.price : null; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價，請手動填入：\n買 " + code + " " + bDate + " 價格" }] }); return; }
    await portfolio.addBuy(code, code, bDate, price, null, null, buyExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄買入\n" + code + " " + (portfolio.getName(code) || "") + (buyExtract.group ? "【" + buyExtract.group + "】" : "") + "\n" + bDate + " @" + price }] });
    return;
  }

  // ── 賣出 ──
  const sellExtract = extractGroupTag(text);
  const sellMatch = sellExtract.text.match(/^賣\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (sellMatch) {
    const code = sellMatch[1], sDate = sellMatch[2], last = sellMatch[3] ? sellMatch[3].trim() : null;
    let price = null, qtyStr = "全部";
    if (!last) { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, sDate, last); price = p ? p.price : null; }
    else if (last === "一半" || last === "全部") { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; qtyStr = last; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價" }] }); return; }
    const { remaining } = await portfolio.getRemaining(code);
    if (remaining <= 0) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: code + " 目前無持股可賣" }] }); return; }
    let qty = remaining;
    if (qtyStr === "一半") qty = Math.max(1, Math.floor(remaining / 2));
    else if (!isNaN(parseInt(qtyStr))) qty = Math.min(parseInt(qtyStr), remaining);
    for (let i = 0; i < qty; i++) await portfolio.addSell(code, code, sDate, price, null, null, sellExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出\n" + code + " " + (portfolio.getName(code) || "") + (sellExtract.group ? "【" + sellExtract.group + "】" : "") + " ×" + qty + "張 @" + price + "\n剩餘：" + (remaining - qty) + " 張" }] });
    return;
  }

  // ── 新增（舊格式）──
  const fullBuyExtract = extractGroupTag(text);
  const fullBuyMatch = fullBuyExtract.text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (fullBuyMatch) {
    await portfolio.addBuy(fullBuyMatch[1], fullBuyMatch[1], fullBuyMatch[2], fullBuyMatch[3], null, null, fullBuyExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已新增買入 " + fullBuyMatch[1] + " " + fullBuyMatch[2] + " @" + fullBuyMatch[3] }] });
    return;
  }

  // ── 賣出（舊格式）──
  const fullSellExtract = extractGroupTag(text);
  const fullSellMatch = fullSellExtract.text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)(?:\s+(.+))?/);
  if (fullSellMatch) {
    const code = fullSellMatch[1], fsDate = fullSellMatch[2], fsPrice = fullSellMatch[3];
    const qtyStr = fullSellMatch[4] ? fullSellMatch[4].trim() : "1";
    const { remaining } = await portfolio.getRemaining(code);
    let qty = 1;
    if (qtyStr === "一半") qty = Math.max(1, Math.floor(remaining / 2));
    else if (qtyStr === "全部") qty = remaining;
    else qty = Math.min(parseInt(qtyStr) || 1, remaining);
    for (let i = 0; i < qty; i++) await portfolio.addSell(code, code, fsDate, fsPrice, null, null, fullSellExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出 " + code + " ×" + qty + "張 @" + fsPrice }] });
    return;
  }

  // ── 調整價格 ──
  const adjustMatch = text.match(/^調整\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (adjustMatch) {
    const result = await portfolio.adjustPrice(adjustMatch[1], adjustMatch[2], adjustMatch[3]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 取消 ──
  const cancelMatch = text.match(/^取消\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) {
    const result = await portfolio.cancelEntry(cancelMatch[1], cancelMatch[2]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 持股 ──
  if (text === "持股" || text === "我的持股") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢中，請稍候..." }] });
    try {
      const allCodes = await portfolio.getHeldCodes();
      const livePrices = await fetchMultipleStocks(allCodes);
      const msg = await portfolio.getHoldingSummary(livePrices);
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: msg }] });
    } catch (err) { console.error("[持股]", err.message); }
    return;
  }

  // ── 明細（條列式查看每筆買賣）──
  const detailMatch = text.match(/^明細\s+(\d{4,6})(?:\s+(基本組|進階組))?$/);
  if (detailMatch) {
    const code = detailMatch[1];
    const groupFilter = detailMatch[2] || null;
    const entries = await portfolio.getTransactionList(code, groupFilter);
    const msg = portfolio.formatTransactionList(code, portfolio.getName(code), entries);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 結算 ──
  if (text === "結算" || text === "已結算") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: await portfolio.getSettledSummary() }] });
    return;
  }

  // ── 指令說明 ──
  if (text === "指令" || text === "help") {
    const msg =
      "📋 指令一覽\n" + "─".repeat(20) + "\n" +
      "【偵測確認】\n確認 5475　確認 5475 158　確認全部　待確認\n\n" +
      "【買賣記錄】\n買 3533 2026-04-23 10:04\n買 3533 2026-04-23\n買 3533 2026-04-23 2445\n賣 3533 2026-04-23 一半\n賣 3533 2026-04-23 2445\n\n" +
      "【調整】\n調整 3533 2026-04-23 2500\n取消 3533 2026-04-23\n名稱 2327 國巨\n\n" +
      "【組別分類】\n買/賣/新增/賣出 指令結尾可加「基本組」或「進階組」\n例：買 3533 2026-04-23 2445 進階組\n\n" +
      "【查詢】\n查股 2330\n查股 2330 2026-04-23\n查股 2330 2026-04-23 10:04\n新聞 2330\n明細 3533\n明細 3533 進階組\n持股\n結算\n備份";
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 老師訊號偵測 ──
  if (!isTeacher(senderName)) return;

  try {
    const signals = await parseSingleMessage(senderName, timeStr, text);
    if (signals.length === 0) return;
    const detectedGroup = pendingSignals.detectGroup(text);
    const msgs = [];
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      const code = sig.stock_code;
      const p = await fetchHistoricalPrice(code, dateStr, timeStr);
      const price = p ? p.price : null;
      await pendingSignals.setPending(code, { action: sig.action, date: dateStr, time: timeStr, price, suggestedPrice: sig.suggested_price, original: sig.original, group: detectedGroup });
      const msg =
        "📊 偵測到訊號\n" + "━".repeat(16) + "\n" +
        code + " " + (sig.stock_name || portfolio.getName(code) || "") + " " + sig.action + (detectedGroup ? "【" + detectedGroup + "】" : "") + "\n" +
        "時間：" + dateStr + " " + timeStr + "\n" +
        (sig.suggested_price ? "老師建議價：" + sig.suggested_price + "\n" : "") +
        (price ? "歷史成交價：" + price : "⚠ 股價查詢失敗") + "\n" +
        "訊息：" + sig.original + "\n" + "━".repeat(16) + "\n" +
        (price ? "回覆「確認 " + code + "」以 " + price + " 記錄" : "回覆「確認 " + code + " 實際成交價」記錄");
      msgs.push({ type: "text", text: msg });
    }
    if (msgs.length > 0) await lineClient.replyMessage({ replyToken, messages: msgs.slice(0, 5) });
  } catch (err) { console.error("[老師訊號]", err.message); }
}

app.post("/webhook", async function(req, res) {
  res.status(200).json({ ok: true });
  const events = req.body.events || [];
  await Promise.allSettled(events.map(handleEvent));
});

const PORT = process.env.PORT || 3000;

(async function start() {
  try {
    await migrate();
    await portfolio.loadNameCache();
    app.listen(PORT, function() {
      console.log("LINE Stock Bot 啟動 Port:" + PORT);
      setupScheduler(lineClient);
    });
  } catch (err) {
    console.error("[Startup] 啟動失敗：", err.message);
    process.exit(1);
  }
})();
