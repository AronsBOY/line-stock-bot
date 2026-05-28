require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchStockPrice, fetchHistoricalPrice, fetchMultipleStocks, formatFlexMessage } = require("./stockPrice");
const { setupScheduler, addSignal } = require("./scheduler");
const portfolio = require("./portfolio");

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const app = express();
app.use("/webhook", line.middleware(lineConfig));
app.get("/", function(req, res) { res.json({ status: "running" }); });

const pendingSignals = {};

function isTimeFormat(str) { return /^\d{1,2}:\d{2}$/.test(str); }
function isPriceFormat(str) { return /^[\d.]+$/.test(str); }

function isTeacher(name) {
  const teacherName = process.env.SIGNAL_SENDER_NAME || "";
  if (!teacherName) return false;
  return name.includes(teacherName) || teacherName.includes(name);
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
      const msg = code + " " + p.longName + "\n" + label + "：" + p.price + " TWD\n" +
        arrow + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n" +
        (p.high ? "最高：" + p.high + "　最低：" + p.low + "\n" : "") + p.timestamp;
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } else {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + queryMatch[1] + " 的資料" }] });
    }
    return;
  }

  // ── 確認訊號 ──
  const confirmMatch = text.match(/^確認\s+(\d{4,6})(?:\s+([\d.]+))?$/);
  if (confirmMatch) {
    const code = confirmMatch[1];
    const manualPrice = confirmMatch[2] ? parseFloat(confirmMatch[2]) : null;
    const pending = pendingSignals[code];
    if (!pending) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的待確認訊號" }] });
      return;
    }
    const finalPrice = manualPrice || pending.price;
    if (!finalPrice) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "請提供成交價：\n確認 " + code + " 價格" }] });
      return;
    }
    if (pending.action === "買入") portfolio.addBuy(code, code, pending.date, finalPrice);
    else portfolio.addSell(code, code, pending.date, finalPrice);
    delete pendingSignals[code];
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
      "✅ 已記錄\n" + code + " " + (portfolio.CODE_NAMES[code] || "") + " " + pending.action + "\n" +
      "日期：" + pending.date + " " + pending.time + "\n" +
      "成交價：" + finalPrice + (manualPrice ? "（手動）" : "（歷史）")
    }] });
    return;
  }

  // ── 確認全部 ──
  if (text === "確認全部") {
    const keys = Object.keys(pendingSignals);
    if (!keys.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const failed = [];
    keys.forEach(function(code) {
      const p = pendingSignals[code];
      if (!p.price) { failed.push(code); return; }
      if (p.action === "買入") portfolio.addBuy(code, code, p.date, p.price);
      else portfolio.addSell(code, code, p.date, p.price);
      delete pendingSignals[code];
    });
    let msg = "✅ 已記錄 " + (keys.length - failed.length) + " 筆訊號";
    if (failed.length) msg += "\n⚠ 以下缺少股價，請手動確認：\n" + failed.map(function(c) { return "確認 " + c + " 價格"; }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 待確認清單 ──
  if (text === "待確認") {
    const keys = Object.keys(pendingSignals);
    if (!keys.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const list = keys.map(function(code) {
      const p = pendingSignals[code];
      return code + " " + (portfolio.CODE_NAMES[code] || "") + " " + p.action +
        (p.price ? " @" + p.price : " ⚠無股價") +
        "（" + p.date + " " + p.time + "）";
    }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "待確認訊號：\n" + list + "\n\n回覆「確認 代號」或「確認全部」" }] });
    return;
  }

  // ── 買入 ──
  const buyMatch = text.match(/^買\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (buyMatch) {
    const code = buyMatch[1], bDate = buyMatch[2], last = buyMatch[3] ? buyMatch[3].trim() : null;
    let price = null;
    if (!last) { const p = await fetchHistoricalPrice(code, bDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, bDate, last); price = p ? p.price : null; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價，請手動填入：\n買 " + code + " " + bDate + " 價格" }] }); return; }
    portfolio.addBuy(code, code, bDate, price);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄買入\n" + code + " " + (portfolio.CODE_NAMES[code] || "") + "\n" + bDate + " @" + price }] });
    return;
  }

  // ── 賣出 ──
  const sellMatch = text.match(/^賣\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (sellMatch) {
    const code = sellMatch[1], sDate = sellMatch[2], last = sellMatch[3] ? sellMatch[3].trim() : null;
    let price = null, qtyStr = "全部";
    if (!last) { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, sDate, last); price = p ? p.price : null; }
    else if (last === "一半" || last === "全部") { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; qtyStr = last; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價，請手動填入：\n賣 " + code + " " + sDate + " 價格" }] }); return; }
    const holdCount = portfolio.portfolio.buys.filter(function(b) { return b.code === code; }).length;
    const soldCount = portfolio.portfolio.sells.filter(function(s) { return s.code === code; }).length;
    const remaining = holdCount - soldCount;
    if (remaining <= 0) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: code + " 目前無持股可賣" }] }); return; }
    let qty = remaining;
    if (qtyStr === "一半") qty = Math.ceil(remaining / 2);
    else if (!isNaN(parseInt(qtyStr))) qty = Math.min(parseInt(qtyStr), remaining);
    for (let i = 0; i < qty; i++) portfolio.addSell(code, code, sDate, price);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出\n" + code + " " + (portfolio.CODE_NAMES[code] || "") + " ×" + qty + "張 @" + price + "\n剩餘：" + (remaining - qty) + " 張" }] });
    return;
  }

  // ── 新增（舊格式）──
  const fullBuyMatch = text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (fullBuyMatch) {
    portfolio.addBuy(fullBuyMatch[1], fullBuyMatch[1], fullBuyMatch[2], fullBuyMatch[3]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已新增買入 " + fullBuyMatch[1] + " " + fullBuyMatch[2] + " @" + fullBuyMatch[3] }] });
    return;
  }

  // ── 賣出（舊格式）──
  const fullSellMatch = text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)(?:\s+(.+))?/);
  if (fullSellMatch) {
    const code = fullSellMatch[1], fsDate = fullSellMatch[2], fsPrice = fullSellMatch[3];
    const qtyStr = fullSellMatch[4] ? fullSellMatch[4].trim() : "1";
    const holdCount = portfolio.portfolio.buys.filter(function(b) { return b.code === code; }).length;
    const soldCount = portfolio.portfolio.sells.filter(function(s) { return s.code === code; }).length;
    const remaining = holdCount - soldCount;
    let qty = 1;
    if (qtyStr === "一半") qty = Math.ceil(remaining / 2);
    else if (qtyStr === "全部") qty = remaining;
    else qty = Math.min(parseInt(qtyStr) || 1, remaining);
    for (let i = 0; i < qty; i++) portfolio.addSell(code, code, fsDate, fsPrice);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出 " + code + " ×" + qty + "張 @" + fsPrice }] });
    return;
  }

  // ── 調整價格 ──
  const adjustMatch = text.match(/^調整\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (adjustMatch) {
    const result = portfolio.adjustPrice(adjustMatch[1], adjustMatch[2], adjustMatch[3]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 取消 ──
  const cancelMatch = text.match(/^取消\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) {
    const result = portfolio.cancelEntry(cancelMatch[1], cancelMatch[2]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 持股 ──
  if (text === "持股" || text === "我的持股") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢中，請稍候..." }] });
    try {
      const allCodes = [...new Set(portfolio.portfolio.buys.map(function(b) { return b.code; }))];
      const livePrices = {};
      for (let i = 0; i < allCodes.length; i++) {
        const r = await fetchMultipleStocks([allCodes[i]]);
        if (r[allCodes[i]]) livePrices[allCodes[i]] = r[allCodes[i]];
      }
      const msg = portfolio.getHoldingSummary(livePrices);
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: msg }] });
    } catch (err) { console.error("[持股]", err.message); }
    return;
  }

  // ── 結算 ──
  if (text === "結算" || text === "已結算") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: portfolio.getSettledSummary() }] });
    return;
  }

  // ── 指令說明 ──
  if (text === "指令" || text === "help") {
    const msg =
      "📋 指令一覽\n" + "─".repeat(20) + "\n" +
      "【自動偵測】\n老師發訊號 → Bot 推播確認卡\n\n" +
      "【確認訊號】\n確認 5475　→ 以歷史價記錄\n確認 5475 158　→ 手動價格記錄\n確認全部　→ 一次全確認\n待確認　→ 查看待確認清單\n\n" +
      "【買賣記錄】\n買 3533 2026-04-23 10:04　→ 歷史股價\n買 3533 2026-04-23　→ 收盤價\n買 3533 2026-04-23 2445　→ 手動價格\n賣 3533 2026-04-23 一半\n賣 3533 2026-04-23 2445\n\n" +
      "【調整】\n調整 3533 2026-04-23 2500\n取消 3533 2026-04-23\n\n" +
      "【查詢】\n查股 2330\n查股 2330 2026-04-23\n查股 2330 2026-04-23 10:04\n持股\n結算";
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 老師訊號偵測 ──
  if (!isTeacher(senderName)) return;

  try {
    const signals = await parseSingleMessage(senderName, timeStr, text);
    if (signals.length === 0) return;

    const msgs = [];
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      const code = sig.stock_code;
      const p = await fetchHistoricalPrice(code, dateStr, timeStr);
      const price = p ? p.price : null;

      pendingSignals[code] = {
        action: sig.action,
        date: dateStr,
        time: timeStr,
        price: price,
        suggestedPrice: sig.suggested_price,
        original: sig.original,
      };

      const priceLine = price
        ? "歷史成交價：" + price
        : "⚠ 股價查詢失敗";

      const msg =
        "📊 偵測到訊號\n" + "━".repeat(16) + "\n" +
        code + " " + (sig.stock_name || portfolio.CODE_NAMES[code] || "") + " " + sig.action + "\n" +
        "時間：" + dateStr + " " + timeStr + "\n" +
        (sig.suggested_price ? "老師建議價：" + sig.suggested_price + "\n" : "") +
        priceLine + "\n" +
        "訊息：" + sig.original + "\n" +
        "━".repeat(16) + "\n" +
        (price
          ? "回覆「確認 " + code + "」以 " + price + " 記錄"
          : "回覆「確認 " + code + " 實際成交價」記錄");

      msgs.push({ type: "text", text: msg });
    }

    if (msgs.length > 0) {
      await lineClient.replyMessage({ replyToken, messages: msgs.slice(0, 5) });
    }
  } catch (err) {
    console.error("[老師訊號]", err.message);
  }
}

app.post("/webhook", async function(req, res) {
  res.status(200).json({ ok: true });
  const events = req.body.events || [];
  await Promise.allSettled(events.map(handleEvent));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("LINE Stock Bot 啟動 Port:" + PORT);
  setupScheduler(lineClient);
});
