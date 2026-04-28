require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchStockPrice, fetchMultipleStocks, formatFlexMessage } = require("./stockPrice");
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

app.get("/", function(req, res) {
  res.json({ status: "running" });
});

const recentSignals = new Map();

function isDuplicate(groupId, stockCode, action) {
  const key = groupId + "_" + stockCode + "_" + action;
  const last = recentSignals.get(key);
  const now = Date.now();
  if (last && now - last < 300000) return true;
  recentSignals.set(key, now);
  return false;
}

function getTodayTW() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
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
      const profile = await lineClient.getGroupMemberProfile(event.source.groupId, senderId);
      senderName = profile.displayName;
    } else {
      const profile = await lineClient.getProfile(senderId);
      senderName = profile.displayName;
    }
  } catch (e) {}

  if (process.env.ALLOWED_SENDERS) {
    const allowed = process.env.ALLOWED_SENDERS.split(",").map(function(s) { return s.trim(); });
    if (!allowed.includes(senderId)) return;
  }

  const now = new Date();
  const time = now.toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  console.log("[" + time + "] " + senderName + ": " + text);

  // 查股指令
  if (text.startsWith("查股 ") || text.startsWith("/stock ")) {
    const code = text.replace(/^查股 |^\/stock /, "").trim();
    if (/^\d{4,6}$/.test(code)) {
      const prices = await fetchMultipleStocks([code]);
      const p = prices[code];
      const msg = p
        ? p.code + " " + p.longName + "\n現價：" + p.price + " TWD\n" + (p.isUp ? "▲" : "▼") + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n最高：" + p.high + " 最低：" + p.low + "\n" + p.marketStatus + " " + p.timestamp
        : "無法取得 " + code + " 的行情";
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
      return;
    }
  }

  // 簡化買入：買 3533（自動抓今日日期+即時股價）
  const quickBuyMatch = text.match(/^買\s+(\d{4,6})$/);
  if (quickBuyMatch) {
    const code = quickBuyMatch[1];
    const p = await fetchStockPrice(code);
    if (!p) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 即時股價，請改用：\n新增 " + code + " " + getTodayTW() + " 價格" }] });
      return;
    }
    const date = getTodayTW();
    portfolio.addBuy(code, code, date, p.price);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增買入\n" + code + " " + p.longName + "\n日期：" + date + "\n成交價：" + p.price + "\n（即時 " + p.marketStatus + "）" }] });
    return;
  }

  // 簡化賣出：賣 3533 / 賣 3533 一半（自動抓今日日期+即時股價）
  const quickSellMatch = text.match(/^賣\s+(\d{4,6})(?:\s+(.+))?$/);
  if (quickSellMatch) {
    const code = quickSellMatch[1];
    const qtyStr = quickSellMatch[2] ? quickSellMatch[2].trim() : "全部";
    const p = await fetchStockPrice(code);
    if (!p) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 即時股價，請改用：\n賣出 " + code + " " + getTodayTW() + " 價格" }] });
      return;
    }
    const date = getTodayTW();
    const holdingCount = portfolio.portfolio.buys.filter(function(b) { return b.code === code; }).length;
    const soldCount = portfolio.portfolio.sells.filter(function(s) { return s.code === code; }).length;
    const remaining = holdingCount - soldCount;
    if (remaining <= 0) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: code + " 目前無持股可賣" }] });
      return;
    }
    let qty = remaining;
    if (qtyStr === "一半") qty = Math.ceil(remaining / 2);
    else if (!isNaN(parseInt(qtyStr))) qty = Math.min(parseInt(qtyStr), remaining);
    for (let i = 0; i < qty; i++) {
      portfolio.addSell(code, code, date, p.price);
    }
    const settled = portfolio.getSettledSummary();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增賣出\n" + code + " " + p.longName + " ×" + qty + "張\n日期：" + date + "\n成交價：" + p.price + "\n剩餘：" + (remaining - qty) + " 張\n\n" + settled }] });
    return;
  }

  // 完整買入：新增 5475 2026-03-18 212
  const buyMatch = text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (buyMatch) {
    portfolio.addBuy(buyMatch[1], buyMatch[1], buyMatch[2], buyMatch[3]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增買入\n" + buyMatch[1] + " " + buyMatch[2] + " @" + buyMatch[3] }] });
    return;
  }

  // 完整賣出：賣出 3665 2026-03-17 1740 2
  const sellMatch = text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)(?:\s+(.+))?/);
  if (sellMatch) {
    const code = sellMatch[1];
    const date = sellMatch[2];
    const price = sellMatch[3];
    const qtyStr = sellMatch[4] ? sellMatch[4].trim() : "1";
    const holdingCount = portfolio.portfolio.buys.filter(function(b) { return b.code === code; }).length;
    const soldCount = portfolio.portfolio.sells.filter(function(s) { return s.code === code; }).length;
    const remaining = holdingCount - soldCount;
    let qty = 1;
    if (qtyStr === "一半") qty = Math.ceil(remaining / 2);
    else if (qtyStr === "全部") qty = remaining;
    else qty = Math.min(parseInt(qtyStr) || 1, remaining);
    if (qty < 1) qty = 1;
    for (let i = 0; i < qty; i++) {
      portfolio.addSell(code, code, date, price);
    }
    const settled = portfolio.getSettledSummary();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增賣出\n" + code + " ×" + qty + "張 " + date + " @" + price + "\n剩餘持股：" + (remaining - qty) + " 張\n\n" + settled }] });
    return;
  }

  // 取消指令：取消 5475 2026-03-18
  const cancelMatch = text.match(/^取消\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) {
    const result = portfolio.cancelEntry(cancelMatch[1], cancelMatch[2]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // 查看持股
  if (text === "持股" || text === "我的持股") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢中，請稍候..." }] });
    try {
      const allCodes = [...new Set(portfolio.portfolio.buys.map(function(b) { return b.code; }))];
      const livePrices = {};
      for (let i = 0; i < allCodes.length; i++) {
        const result = await fetchMultipleStocks([allCodes[i]]);
        if (result[allCodes[i]]) livePrices[allCodes[i]] = result[allCodes[i]];
      }
      const msg = portfolio.getHoldingSummary(livePrices);
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: msg }] });
    } catch (err) {
      console.error("[持股]", err.message);
    }
    return;
  }

  // 查看結算
  if (text === "結算" || text === "已結算") {
    const msg = portfolio.getSettledSummary();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  if (process.env.AUTO_REPLY !== "true") return;

  try {
    const signals = await parseSingleMessage(senderName, time, text);
    if (signals.length === 0) return;
    const newSignals = signals.filter(function(s) {
      return !isDuplicate(sourceId, s.stock_code, s.action);
    });
    if (newSignals.length === 0) return;
    const codes = newSignals.map(function(s) { return s.stock_code; });
    const pricesMap = await fetchMultipleStocks(codes);
    newSignals.forEach(function(s) { addSignal(s); });
    const flexMsg = formatFlexMessage(newSignals, pricesMap);
    await lineClient.replyMessage({ replyToken, messages: [flexMsg] });
  } catch (err) {
    console.error("[Handler]", err.message);
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
