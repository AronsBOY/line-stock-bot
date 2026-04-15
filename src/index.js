require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchMultipleStocks, formatFlexMessage } = require("./stockPrice");
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
      let msg = p
        ? p.code + " " + p.longName + "\n現價：" + p.price + " TWD\n" + (p.isUp ? "▲" : "▼") + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n最高：" + p.high + " 最低：" + p.low + "\n" + p.marketStatus + " " + p.timestamp
        : "無法取得 " + code + " 的行情";
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
      return;
    }
  }

  // 新增買入：新增 5475 2026-03-18 212
  const buyMatch = text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (buyMatch) {
    const code = buyMatch[1], date = buyMatch[2], price = buyMatch[3];
    const name = code;
    portfolio.addBuy(code, name, date, price);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增買入\n" + code + " " + date + " @" + price }] });
    return;
  }

  // 新增賣出：賣出 5475 2026-04-15 320
  const sellMatch = text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (sellMatch) {
    const code = sellMatch[1], date = sellMatch[2], price = sellMatch[3];
    const name = code;
    portfolio.addSell(code, name, date, price);
    const settled = portfolio.getSettledSummary();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "已新增賣出\n" + code + " " + date + " @" + price + "\n\n" + settled }] });
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
    const msg = portfolio.getHoldingSummary();
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
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
