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

const SETTLEMENT_START_DATE = "2026-09-11";

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

app.get("/export/trades", async function(req, res) {
  const token = process.env.EXPORT_TOKEN;
  if (!token || req.query.token !== token) return res.status(401).json({ error: "unauthorized" });
  try {
    const json = await portfolio.exportAllTradesJSON();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isTimeFormat(str) { return /^\d{1,2}:\d{2}$/.test(str); }
function isPriceFormat(str) { return /^[\d.]+$/.test(str); }
function isTeacher(name) {
  const t = process.env.SIGNAL_SENDER_NAME || "";
  if (!t) return false;
  return name.includes(t) || t.includes(name);
}
function isAdmin(name) {
  if (isTeacher(name)) return true;
  const admins = (process.env.ADMIN_NAMES || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return admins.some(function (a) { return name.includes(a) || a.includes(name); });
}
function extractGroupTag(text) {
  const m = text.match(/\s*(基本組|進階組)\s*$/);
  if (m) return { text: text.slice(0, m.index).trim(), group: m[1] };
  return { text: text, group: null };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function chunkMessage(text, maxLen) {
  maxLen = maxLen || 4500;
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
async function pushLongMessage(to, text) {
  const chunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5).map(function (c) { return { type: "text", text: c }; });
    await lineClient.pushMessage({ to: to, messages: batch });
    if (i + 5 < chunks.length) await sleep(500);
  }
}
async function replyLongMessage(replyToken, to, text) {
  const chunks = chunkMessage(text);
  const firstBatch = chunks.slice(0, 5).map(function (c) { return { type: "text", text: c }; });
  await lineClient.replyMessage({ replyToken: replyToken, messages: firstBatch });
  if (chunks.length > 5) await pushLongMessage(to, chunks.slice(5).join("\n\n"));
}

function buildSignalConfirmFlex(sig, detectedGroup, dateStr, timeStr, price) {
  const code = sig.stock_code;
  const name = sig.stock_name || portfolio.getName(code) || "";
  const actionText = sig.action === "賣出" ? "賣出" : "買入";
  const detailRows = [
    { type: "text", text: "時間：" + dateStr + " " + timeStr, size: "sm", color: "#666666", wrap: true },
  ];
  if (sig.suggested_price) detailRows.push({ type: "text", text: "老師建議價：" + sig.suggested_price, size: "sm", color: "#444444", wrap: true, margin: "sm" });
  detailRows.push({ type: "text", text: "歷史成交價：" + price, size: "sm", color: "#111111", weight: "bold", wrap: true, margin: "sm" });
  if (sig.original) detailRows.push({ type: "text", text: "訊息：" + sig.original, size: "xs", color: "#777777", wrap: true, margin: "md" });
  return {
    type: "flex",
    altText: "偵測到訊號 " + code + " " + name + " " + actionText,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📊 偵測到訊號", weight: "bold", size: "lg" },
          { type: "text", text: code + " " + name + " " + actionText + (detectedGroup ? "【" + detectedGroup + "】" : ""), weight: "bold", size: "xl", wrap: true, margin: "md" },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", contents: detailRows, margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [{
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "postback",
            label: "✅ 以 " + price + " 確認" + actionText,
            data: "action=confirm_signal&code=" + encodeURIComponent(code),
          },
        }],
      },
    },
  };
}

async function handleSignalPostback(event) {
  const data = new URLSearchParams((event.postback && event.postback.data) || "");
  if (data.get("action") !== "confirm_signal") return false;
  const code = data.get("code");
  const replyToken = event.replyToken;
  if (!code) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "確認失敗：缺少股票代號" }] });
    return true;
  }
  const pending = await pendingSignals.getPending(code);
  if (!pending) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "這筆 " + code + " 訊號已經確認過，或目前已不在待確認清單。" }] });
    return true;
  }
  if (!pending.price) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "這筆 " + code + " 尚未取得成交價，請改用：確認 " + code + " 實際成交價" }] });
    return true;
  }
  if (pending.action === "買入") await portfolio.addBuy(code, code, pending.date, pending.price, pending.time, pending.original, pending.group, pending.suggestedPrice, "signal");
  else await portfolio.addSell(code, code, pending.date, pending.price, pending.time, pending.original, pending.group, pending.suggestedPrice, "signal");
  await pendingSignals.deletePending(code);
  await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
    "✅ 已記錄\n" + code + " " + (portfolio.getName(code) || "") + " " + pending.action + (pending.group ? "【" + pending.group + "】" : "") + "\n" +
    "日期：" + pending.date + " " + pending.time + "\n" + "成交價：" + pending.price + "（歷史）"
  }] });
  return true;
}

async function processDetectedSignals(senderLabel, signalText, dateStr, timeStr) {
  const signals = await parseSingleMessage(senderLabel, timeStr, signalText);
  if (signals.length === 0) return [];
  const detectedGroup = pendingSignals.detectGroup(signalText);
  const msgs = [];
  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const code = sig.stock_code;
    const p = await fetchHistoricalPrice(code, dateStr, timeStr);
    const price = p ? p.price : null;
    await pendingSignals.setPending(code, { action: sig.action, date: dateStr, time: timeStr, price, suggestedPrice: sig.suggested_price, original: sig.original, group: detectedGroup });
    if (price) msgs.push(buildSignalConfirmFlex(sig, detectedGroup, dateStr, timeStr, price));
    else msgs.push({ type: "text", text:
      "📊 偵測到訊號\n" + "━".repeat(16) + "\n" +
      code + " " + (sig.stock_name || portfolio.getName(code) || "") + " " + sig.action + (detectedGroup ? "【" + detectedGroup + "】" : "") + "\n" +
      "時間：" + dateStr + " " + timeStr + "\n" +
      (sig.suggested_price ? "老師建議價：" + sig.suggested_price + "\n" : "") +
      "⚠ 股價查詢失敗\n訊息：" + sig.original + "\n" + "━".repeat(16) + "\n" +
      "請用「確認 " + code + " 實際成交價」記錄"
    });
  }
  return msgs;
}

function settlementEpisodeStats(entries) {
  const buys = entries.filter(function(e) { return e.type === "買"; });
  const sells = entries.filter(function(e) { return e.type === "賣"; });
  const buyQty = buys.reduce(function(sum, e) { return sum + e.qty; }, 0);
  const sellQty = sells.reduce(function(sum, e) { return sum + e.qty; }, 0);
  const buyValue = buys.reduce(function(sum, e) { return sum + e.price * e.qty; }, 0);
  const sellValue = sells.reduce(function(sum, e) { return sum + e.price * e.qty; }, 0);
  const avgBuy = buyQty > 0 ? buyValue / buyQty : 0;
  const avgSell = sellQty > 0 ? sellValue / sellQty : 0;
  const cost = buyValue * 1000;
  const proceeds = sellValue * 1000;
  const pnl = proceeds - cost;
  const pct = cost > 0 ? pnl / cost * 100 : 0;
  return { buyQty, sellQty, avgBuy, avgSell, pnl, pct };
}

async function buildSettlementSummary(mode, today) {
  const allEpisodes = await portfolio.getAllEpisodes();
  const items = [];
  for (const code in allEpisodes) {
    const info = allEpisodes[code];
    info.closedEpisodes.forEach(function(ep, idx) {
      if (!ep.entries.length) return;
      const closeEvent = ep.entries[ep.entries.length - 1];
      const closeDate = closeEvent.date;
      if (closeDate < SETTLEMENT_START_DATE) return;
      if (mode === "today" && closeDate !== today) return;
      const stats = settlementEpisodeStats(ep.entries);
      items.push({
        code,
        name: portfolio.getName(code) || code,
        round: idx + 1,
        closeDate,
        closeTime: closeEvent.time || "",
        qty: stats.buyQty,
        avgBuy: stats.avgBuy,
        avgSell: stats.avgSell,
        pnl: stats.pnl,
        pct: stats.pct,
      });
    });
  }

  items.sort(function(a, b) {
    const ka = a.closeDate + " " + a.closeTime;
    const kb = b.closeDate + " " + b.closeTime;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });

  const title = mode === "today" ? "【今日結算】" + today : "【已結算】自 " + SETTLEMENT_START_DATE + " 起";
  if (!items.length) return title + "\n目前沒有符合條件的已結算輪次";

  let totalPnl = 0;
  let txt = title + "\n" + "═".repeat(20) + "\n";
  items.forEach(function(item) {
    totalPnl += item.pnl;
    txt += item.code + " " + item.name + "｜" + item.closeDate + (item.closeTime ? " " + item.closeTime : "") + "\n";
    txt += "  賣光結算｜" + (Math.round(item.qty * 100) / 100) + " 張\n";
    txt += "  均買：" + item.avgBuy.toFixed(2) + "　均賣：" + item.avgSell.toFixed(2) + "\n";
    txt += "  損益：" + (item.pnl >= 0 ? "+" : "") + Math.round(item.pnl).toLocaleString() + " 元（" + (item.pct >= 0 ? "+" : "") + item.pct.toFixed(2) + "%）\n\n";
  });
  txt += "═".repeat(20) + "\n共 " + items.length + " 輪｜合計：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
  return txt.trim();
}

async function handleEvent(event) {
  if (event.type === "postback") {
    try { await handleSignalPostback(event); }
    catch (err) {
      console.error("[Postback]", err.message);
      try { await lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: "按鈕確認失敗：" + err.message }] }); } catch (e) {}
    }
    return;
  }
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

  // ── 補偵測：管理員可將漏掉的老師原文重新送進訊號解析流程 ──
  const replayMatch = text.match(/^補偵測\s+([\s\S]+)$/);
  if (replayMatch) {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] });
      return;
    }
    try {
      const originalText = replayMatch[1].trim();
      const msgs = await processDetectedSignals("老師補偵測", originalText, dateStr, timeStr);
      if (!msgs.length) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "沒有從這段文字辨識到明確買賣訊號" }] });
      } else {
        await lineClient.replyMessage({ replyToken, messages: msgs.slice(0, 5) });
      }
    } catch (err) {
      console.error("[補偵測]", err.message);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "補偵測失敗：" + err.message }] });
    }
    return;
  }

  const queryMatch = text.match(/^查股\s+(\d{4,6})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (queryMatch) {
    const code = queryMatch[1], qDate = queryMatch[2] || null, qTime = queryMatch[3] || null;
    const p = await fetchStockPrice(code, qDate, qTime);
    if (p) {
      const arrow = p.isUp ? "▲" : "▼";
      const label = qDate ? (qTime ? qTime + " 歷史價" : "收盤價") : p.marketStatus;
      const name = portfolio.getName(code) || p.longName || code;
      const msg = code + " " + name + "\n" + label + "：" + p.price + " TWD\n" + arrow + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n" + (p.high ? "最高：" + p.high + "　最低：" + p.low + "\n" : "") + p.timestamp;
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } else await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + queryMatch[1] + " 的資料" }] });
    return;
  }

  const nameMatch = text.match(/^名稱\s+(\d{4,6})\s+(.+)$/);
  if (nameMatch) {
    const result = await portfolio.setName(nameMatch[1], nameMatch[2].trim());
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  const newsMatch = text.match(/^新聞\s+(\d{4,6})$/);
  if (newsMatch) {
    const code = newsMatch[1];
    const name = portfolio.getName(code) || code;
    try {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢 " + code + " " + name + " 資訊中..." }] });
      const resp = await anthropic.messages.create({ model: "claude-sonnet-5", max_tokens: 500, messages: [{ role: "user", content: "請用繁體中文簡短介紹台股 " + code + " " + name + "，包含：1.主要業務 2.所屬概念股族群 3.近期重要消息（你知道的），200字以內。" }] });
      const info = resp.content[0].text;
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "📋 " + code + " " + name + "\n" + "─".repeat(18) + "\n" + info }] });
    } catch (err) { await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "無法取得 " + code + " 的資訊" }] }); }
    return;
  }

  const confirmExtract = extractGroupTag(text);
  const confirmMatch = confirmExtract.text.match(/^確認\s+(\d{4,6})(?:\s+([\d.]+))?$/);
  if (confirmMatch) {
    const code = confirmMatch[1];
    const manualPrice = confirmMatch[2] ? parseFloat(confirmMatch[2]) : null;
    const pending = await pendingSignals.getPending(code);
    if (!pending) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的待確認訊號" }] }); return; }
    const finalPrice = manualPrice || pending.price;
    if (!finalPrice) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "請提供成交價：\n確認 " + code + " 價格" }] }); return; }
    const finalGroup = confirmExtract.group || pending.group;
    if (pending.action === "買入") await portfolio.addBuy(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup, pending.suggestedPrice, "signal");
    else await portfolio.addSell(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup, pending.suggestedPrice, "signal");
    await pendingSignals.deletePending(code);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄\n" + code + " " + (portfolio.getName(code) || "") + " " + pending.action + (finalGroup ? "【" + finalGroup + "】" : "") + "\n日期：" + pending.date + " " + pending.time + "\n成交價：" + finalPrice + (manualPrice ? "（手動）" : "（歷史）") }] });
    return;
  }

  if (text === "確認全部") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] }); return; }
    const failed = [];
    for (const p of all) {
      if (!p.price) { failed.push(p.code); continue; }
      if (p.action === "買入") await portfolio.addBuy(p.code, p.code, p.date, p.price, p.time, p.original, p.group, p.suggestedPrice, "signal");
      else await portfolio.addSell(p.code, p.code, p.date, p.price, p.time, p.original, p.group, p.suggestedPrice, "signal");
      await pendingSignals.deletePending(p.code);
    }
    let msg = "✅ 已記錄 " + (all.length - failed.length) + " 筆";
    if (failed.length) msg += "\n⚠ 缺少股價：\n" + failed.map(function(c) { return "確認 " + c + " 價格"; }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  if (text === "待確認") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] }); return; }
    const list = all.map(function(p) { return p.code + " " + (portfolio.getName(p.code) || "") + " " + p.action + (p.group ? "【" + p.group + "】" : "") + (p.price ? " @" + p.price : " ⚠無股價") + "（" + p.date + " " + p.time + "）"; }).join("\n");
    await replyLongMessage(replyToken, sourceId, "待確認訊號：\n" + list + "\n\n可直接點訊號卡片的確認按鈕；舊的「確認 代號」或「確認全部」仍可使用。");
    return;
  }

  if (text === "備份") { const backup = await portfolio.getBackup(); await replyLongMessage(replyToken, sourceId, backup); return; }

  const buyExtract = extractGroupTag(text);
  const buyMatch = buyExtract.text.match(/^買\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (buyMatch) {
    const code = buyMatch[1], bDate = buyMatch[2], last = buyMatch[3] ? buyMatch[3].trim() : null;
    let price = null;
    if (!last) { const p = await fetchHistoricalPrice(code, bDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, bDate, last); price = p ? p.price : null; }
    else if (isPriceFormat(last)) price = parseFloat(last);
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價，請手動填入：\n買 " + code + " " + bDate + " 價格" }] }); return; }
    await portfolio.addBuy(code, code, bDate, price, null, null, buyExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄買入\n" + code + " " + (portfolio.getName(code) || "") + (buyExtract.group ? "【" + buyExtract.group + "】" : "") + "\n" + bDate + " @" + price }] });
    return;
  }

  const sellExtract = extractGroupTag(text);
  const sellMatch = sellExtract.text.match(/^賣\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (sellMatch) {
    const code = sellMatch[1], sDate = sellMatch[2], last = sellMatch[3] ? sellMatch[3].trim() : null;
    let price = null, qtyStr = "全部";
    if (!last) { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, sDate, last); price = p ? p.price : null; }
    else if (last === "一半" || last === "全部") { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; qtyStr = last; }
    else if (isPriceFormat(last)) price = parseFloat(last);
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價" }] }); return; }
    const { remaining } = await portfolio.getRemaining(code);
    if (remaining <= 0) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: code + " 目前無持股可賣" }] }); return; }
    let qty = remaining;
    if (qtyStr === "一半") qty = remaining / 2;
    else if (!isNaN(parseInt(qtyStr))) qty = Math.min(parseFloat(qtyStr), remaining);
    await portfolio.addSell(code, code, sDate, price, null, null, sellExtract.group, null, "manual", null, qty);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出\n" + code + " " + (portfolio.getName(code) || "") + (sellExtract.group ? "【" + sellExtract.group + "】" : "") + " ×" + qty + "張 @" + price + "\n剩餘：" + (remaining - qty) + " 張" }] });
    return;
  }

  const fullBuyExtract = extractGroupTag(text);
  const fullBuyMatch = fullBuyExtract.text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (fullBuyMatch) { await portfolio.addBuy(fullBuyMatch[1], fullBuyMatch[1], fullBuyMatch[2], fullBuyMatch[3], null, null, fullBuyExtract.group); await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已新增買入 " + fullBuyMatch[1] + " " + fullBuyMatch[2] + " @" + fullBuyMatch[3] }] }); return; }

  const fullSellExtract = extractGroupTag(text);
  const fullSellMatch = fullSellExtract.text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)(?:\s+(.+))?/);
  if (fullSellMatch) {
    const code = fullSellMatch[1], fsDate = fullSellMatch[2], fsPrice = fullSellMatch[3];
    const qtyStr = fullSellMatch[4] ? fullSellMatch[4].trim() : "1";
    const { remaining } = await portfolio.getRemaining(code);
    let qty = 1;
    if (qtyStr === "一半") qty = remaining / 2;
    else if (qtyStr === "全部") qty = remaining;
    else qty = Math.min(parseFloat(qtyStr) || 1, remaining);
    await portfolio.addSell(code, code, fsDate, fsPrice, null, null, fullSellExtract.group, null, "manual", null, qty);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出 " + code + " ×" + qty + "張 @" + fsPrice }] });
    return;
  }

  const adjustMatch = text.match(/^調整\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (adjustMatch) { const result = await portfolio.adjustPrice(adjustMatch[1], adjustMatch[2], adjustMatch[3]); await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] }); return; }
  const cancelMatch = text.match(/^取消\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) { const result = await portfolio.cancelEntry(cancelMatch[1], cancelMatch[2]); await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] }); return; }

  if (text === "持股" || text === "我的持股") {
    try {
      let codes = portfolio.WATCHLIST_CODES;
      try { const recentCodes = await portfolio.getRecentActiveCodes(14); codes = Array.from(new Set(portfolio.WATCHLIST_CODES.concat(recentCodes))); } catch (recentErr) { console.error("[持股] 查最近活躍代號失敗：", recentErr.message); }
      const list = await portfolio.getSimpleInventory(codes);
      const msg = portfolio.formatSimpleInventory(list);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } catch (err) { console.error("[持股]", err.message); try { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢持股時發生錯誤：" + err.message }] }); } catch (e) {} }
    return;
  }

  if (text === "打包資料庫") {
    if (!isAdmin(senderName)) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] }); return; }
    const token = process.env.EXPORT_TOKEN;
    if (!token) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "尚未設定 EXPORT_TOKEN" }] }); return; }
    const base = process.env.BASE_URL || "https://web-production-cec15.up.railway.app";
    const url = base + "/export/trades?token=" + token;
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "📦 資料庫匯出連結(請勿外流)：\n" + url }] });
    return;
  }

  const detailMatch = text.match(/^明細\s+(\d{4,6})(?:\s+(基本組|進階組))?$/);
  if (detailMatch) { const code = detailMatch[1]; const groupFilter = detailMatch[2] || null; const entries = await portfolio.getTransactionList(code, groupFilter); const msg = portfolio.formatTransactionList(code, portfolio.getName(code), entries); await replyLongMessage(replyToken, sourceId, msg); return; }

  if (text === "今日結算" || text === "結算") {
    try {
      const msg = await buildSettlementSummary("today", dateStr);
      await replyLongMessage(replyToken, sourceId, msg);
    } catch (err) {
      console.error("[今日結算]", err.message);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢今日結算時發生錯誤：" + err.message }] });
    }
    return;
  }

  if (text === "已結算") {
    try {
      const msg = await buildSettlementSummary("all", dateStr);
      await replyLongMessage(replyToken, sourceId, msg);
    } catch (err) {
      console.error("[已結算]", err.message);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢已結算時發生錯誤：" + err.message }] });
    }
    return;
  }

  if (text === "強制對齊持股") {
    if (!isAdmin(senderName)) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] }); return; }
    const KEEP_CODES = portfolio.WATCHLIST_CODES;
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "開始強制對齊，請稍候..." }] });
    try {
      const result = await portfolio.forceAlignHoldings(KEEP_CODES, function(code) { return fetchStockPrice(code, null, null); });
      let msg = "✅ 強制對齊完成\n" + "─".repeat(20) + "\n結清：" + result.closed.length + " 檔\n";
      result.closed.forEach(function(c) { msg += "  " + c.code + " ×" + c.qty + "張 @" + c.price + "\n"; });
      if (result.failed.length) msg += "查無股價失敗：" + result.failed.join(", ") + "\n";
      msg += "\n輸入「持股」查看結果";
      await pushLongMessage(sourceId, msg);
    } catch (err) { console.error("[強制對齊持股]", err.message); await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "強制對齊時發生錯誤：" + err.message }] }); }
    return;
  }

  if (text === "清空所有交易紀錄") {
    if (!isAdmin(senderName)) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] }); return; }
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "⚠️ 這會清空所有買賣紀錄，無法復原。\n確定請輸入：清空所有交易紀錄 我確定" }] }); return;
  }
  if (text === "清空所有交易紀錄 我確定") {
    if (!isAdmin(senderName)) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] }); return; }
    try { const result = await portfolio.wipeAllTrades(); await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已清空所有交易紀錄\n刪除買入：" + result.buys + " 筆\n刪除賣出：" + result.sells + " 筆" }] }); }
    catch (err) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "清空時發生錯誤：" + err.message }] }); }
    return;
  }
  if (text === "清除回補資料") {
    if (!isAdmin(senderName)) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用" }] }); return; }
    try { const result = await portfolio.deleteLegacyBackfill(); await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已清除回補資料\n刪除買入：" + result.buys + " 筆\n刪除賣出：" + result.sells + " 筆" }] }); }
    catch (err) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "清除時發生錯誤：" + err.message }] }); }
    return;
  }

  if (text === "指令" || text === "help") {
    const msg = "📋 指令一覽\n" + "─".repeat(20) + "\n" +
      "【偵測確認】\n偵測到訊號後可直接點卡片按鈕確認\n補偵測 老師原始訊息（管理員）\n確認 5475　確認 5475 158　確認全部　待確認\n\n" +
      "【買賣記錄】\n買 3533 2026-04-23 2445\n賣 3533 2026-04-23 一半\n\n" +
      "【查詢】\n查股 2330\n新聞 2330\n明細 3533\n持股\n今日結算（只看今天賣光的輪次）\n已結算（只看 " + SETTLEMENT_START_DATE + " 起）\n備份\n\n" +
      "【管理】\n打包資料庫\n清空所有交易紀錄\n清除回補資料\n強制對齊持股";
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  if (!isTeacher(senderName)) return;
  try {
    const msgs = await processDetectedSignals(senderName, text, dateStr, timeStr);
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
