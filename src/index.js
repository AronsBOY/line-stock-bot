require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchMultipleStocks, fetchHistoricalClose, formatFlexMessage } = require("./stockPrice");
const { setupScheduler, addSignal } = require("./scheduler");
const { initDB, addBuy, getPortfolio, getStockDetail, clearStock, clearAll, updateLastBuy } = require("./portfolio");

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

async function parseBatchSignals(text) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: "你是台股訊號解析專家。從歷史操作記錄中提取所有買入訊號。只回傳JSON陣列，不要任何說明：[{\"date\":\"YYYY/MM/DD\",\"stock_code\":\"4位數字\",\"stock_name\":\"股票名稱\",\"price_note\":\"原始價位描述\"}] 只提取買入/買進/加碼/建立基本持股，忽略賣出。",
    messages: [{ role: "user", content: text }],
  });
  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
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
  const time = now.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });

  console.log("[" + time + "] " + senderName + ": " + text.slice(0, 50));

  if (text.startsWith("新增 ")) {
    try {
      const parts = text.trim().split(/\s+/);
      const code = parts[1] ? parts[1].trim() : "";
      if (!code || !/^\d{4,6}$/.test(code)) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "格式錯誤！\n請用：\n新增 代號\n新增 代號 日期\n新增 代號 日期 價格\n\n例如：\n新增 2330\n新增 2330 2026-03-18\n新增 2330 2026-03-18 850" }] });
        return;
      }
      const datePattern = /^\d{4}[\.\-\/]\d{1,2}[\.\-\/]\d{1,2}$|^\d{8}$/;
      const dateStr = parts[2] && datePattern.test(parts[2]) ? parts[2] : null;
      const manualPrice = parts[3] ? parseFloat(parts[3]) : null;
      let price, priceType, stockName;
      if (dateStr && manualPrice && !isNaN(manualPrice)) {
        price = manualPrice;
        priceType = dateStr + " 手動填入";
        const priceData = await fetchMultipleStocks([code]);
        const p = priceData[code];
        stockName = p ? p.longName : code;
      } else if (dateStr) {
        const hist = await fetchHistoricalClose(code, dateStr);
        if (!hist) {
          await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 在 " + dateStr + " 的收盤價\n可能是假日或非交易日" }] });
          return;
        }
        price = parseFloat(hist.price);
        stockName = hist.longName || code;
        priceType = dateStr + " 收盤價";
      } else {
        const priceData = await fetchMultipleStocks([code]);
        const p = priceData[code];
        if (!p) {
          await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 的股價，請稍後再試" }] });
          return;
        }
        price = parseFloat(p.price);
        stockName = p.longName || code;
        priceType = p.marketStatus === "盤中" ? "即時股價" : "盤後股價";
      }
      await addBuy(code, stockName, price, dateStr || date, null);
      const rows = await getStockDetail(code);
      const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
      const msg = "已記錄！\n" + code + " " + stockName + "\n" + priceType + "：" + price + "\n共買入：" + rows.length + " 次\n目前均價：" + avg;
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    } catch (err) {
      console.error("[新增]", err.message);
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "新增失敗：" + err.message }] });
    }
    return;
  }

  if (text.startsWith("回溯\n") || text.startsWith("回溯 ")) {
    const content = text.replace(/^回溯[\n ]/, "").trim();
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "正在解析歷史訊號，請稍候..." }] });
    try {
      const signals = await parseBatchSignals(content);
      if (signals.length === 0) {
        await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "沒有找到買入訊號" }] });
        return;
      }
      const codes = [...new Set(signals.map(function(s){ return s.stock_code; }))];
      const prices = await fetchMultipleStocks(codes);
      let successCount = 0;
      let failList = [];
      let summary = "回溯完成！\n" + "─".repeat(20) + "\n";
      for (const sig of signals) {
        const p = prices[sig.stock_code];
        if (!p) { failList.push(sig.stock_code + " " + sig.stock_name); continue; }
        const price = parseFloat(p.price);
        await addBuy(sig.stock_code, sig.stock_name, price, sig.date, sig.price_note);
        summary += sig.date + " " + sig.stock_code + " " + sig.stock_name + "\n";
        summary += "  現價：" + price + " 備註：" + sig.price_note + "\n";
        successCount++;
      }
      summary += "─".repeat(20) + "\n成功記錄 " + successCount + " 筆";
      if (failList.length > 0) { summary += "\n無法取得行情：" + failList.join("、"); }
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: summary }] });
    } catch (err) {
      console.error("[回溯]", err.message);
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "回溯失敗：" + err.message }] });
    }
    return;
  }

  if (text === "持股") {
    const rows = await getPortfolio();
    if (rows.length === 0) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "目前沒有持股記錄\n\n用「新增 代號」來記錄買入\n例如：新增 2330" }] });
      return;
    }
    const codes = rows.map(function(r){ return r.stock_code; });
    const prices = await fetchMultipleStocks(codes);
    const nowStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    let msg = "目前持股 " + nowStr + "\n" + "─".repeat(24​​​​​​​​​​​​​​​​
