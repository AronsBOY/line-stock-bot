require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
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
  const time = now.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });

  console.log("[" + time + "] " + senderName + ": " + text);

  if (text.startsWith("新增 ")) {
    const parts = text.split(" ");
    const code = parts[1] ? parts[1].trim() : "";
    const hasDate = parts[parts.length - 1] && /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(parts[parts.length - 1]);
    const dateStr = hasDate ? parts[parts.length - 1] : null;
    const name = hasDate ? parts.slice(2, parts.length - 1).join(" ").trim() || code : parts.slice(2).join(" ").trim() || code;

    if (!code || !/^\d{4,6}$/.test(code)) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "格式錯誤！\n請用：新增 股票代號 股票名稱\n例如：新增 2330 台積電\n\n或指定日期：\n新增 2330 台積電 2026/03/18" }] });
      return;
    }

    let price, priceType;
    if (dateStr) {
      const hist = await fetchHistoricalClose(code, dateStr);
      if (!hist) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 在 " + dateStr + " 的收盤價\n可能是假日或非交易日" }] });
        return;
      }
      price = parseFloat(hist.price);
      priceType = dateStr + " 收盤價";
    } else {
      const priceData = await fetchMultipleStocks([code]);
      const p = priceData[code];
      if (!p) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 的股價，請稍後再試" }] });
        return;
      }
      price = parseFloat(p.price);
      priceType = p.marketStatus === "盤中" ? "即時股價" : "盤後股價";
    }

    await addBuy(code, name, price, dateStr || date);
    const rows = await getStockDetail(code);
    const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
    const msg = "已記錄！\n" + code + " " + name + "\n" + priceType + "：" + price + "\n共買入：" + rows.length + " 次\n目前均價：" + avg;
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }


  if (text === "持股") {
    const rows = await getPortfolio();
    if (rows.length === 0) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "目前沒有持股記錄\n\n用「新增 代號 名稱」來記錄買入\n例如：新增 2330 台積電" }] });
      return;
    }
    const codes = rows.map(function(r){return r.stock_code;});
    const prices = await fetchMultipleStocks(codes);
    const nowStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    let msg = "目前持股　" + nowStr + "\n" + "─".repeat(24) + "\n";
    rows.forEach(function(r) {
      const p = prices[r.stock_code];
      const currentPrice = p ? parseFloat(p.price) : null;
      const avg = parseFloat(r.avg_price);
      const profitPct = currentPrice ? ((currentPrice - avg) / avg * 100).toFixed(2) : null;
      const profitAmt = currentPrice ? (currentPrice - avg).toFixed(2) : null;
      const arrow = profitPct >= 0 ? "▲" : "▼";
      const stockName = r.stock_name === r.stock_code ? r.stock_code : r.stock_name;
      msg += "\n" + r.stock_code + " " + stockName + "\n";
      msg += "  買入：" + r.buy_count + " 次　均價：" + r.avg_price + "\n";
      msg += "  首次買入：" + (r.first_date || "-") + "\n";
      if (currentPrice) {
        msg += "  現價：" + currentPrice + "　" + arrow + Math.abs(profitPct) + "%\n";
        msg += "  未實現損益：" + (profitAmt >= 0 ? "+" : "") + profitAmt + " 元/股\n";
      }
    });
    msg += "\n" + "─".repeat(24) + "\n輸入「明細 代號」查看每筆記錄";
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  if (text.startsWith("明細 ")) {
    const code = text.replace("明細 ", "").trim();
    const rows = await getStockDetail(code);
    if (rows.length === 0) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的記錄" }] });
      return;
    }
    const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
    let msg = code + " " + rows[0].stock_name + " 買入明細\n" + "─".repeat(20) + "\n";
    rows.forEach(function(r, i) {
      msg += (i+1) + ". " + r.buy_date + " 買入 " + r.buy_price + "\n";
    });
    msg += "─".repeat(20) + "\n共 " + rows.length + " 次　均價：" + avg;
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  if (text.startsWith("修改 ")) {
    const parts = text.split(" ");
    const code = parts[1] ? parts[1].trim() : "";
    const newPrice = parts[2] ? parseFloat(parts[2]) : null;
    if (!code || !/^\d{4,6}$/.test(code) || !newPrice || isNaN(newPrice)) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "格式錯誤！\n請用：修改 股票代號 新價格\n例如：修改 2330 900" }] });
      return;
    }
    const updated = await updateLastBuy(code, newPrice);
    if (!updated) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的記錄" }] });
      return;
    }
    const rows = await getStockDetail(code);
    const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "已修改！\n" + code + " 最後一筆改為 " + newPrice + "\n目前均價：" + avg }] });
    return;
  }

  if (text.startsWith("清除 ") && text !== "清除全部") {
    const code = text.replace("清除 ", "").trim();
    const count = await clearStock(code);
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: count > 0 ? "已清除 " + code + " 的 " + count + " 筆記錄" : "找不到 " + code + " 的記錄" }] });
    return;
  }

  if (text === "清除全部") {
    await clearAll();
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "已清除所有持股記錄" }] });
    return;
  }

  if (text.startsWith("查股 ") || text.startsWith("/stock ")) {
    const code = text.replace(/^查股 |^\/stock /, "").trim();
    if (/^\d{4,6}$/.test(code)) {
      const prices = await fetchMultipleStocks([code]);
      const p = prices[code];
      const msg = p ? p.code + " " + p.longName + "\n現價：" + p.price + " TWD\n" + (p.isUp ? "▲" : "▼") + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n最高：" + p.high + " 最低：" + p.low + "\n" + p.marketStatus + " " + p.timestamp : "無法取得 " + code + " 的行情";
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
      return;
    }
  }

  if (process.env.AUTO_REPLY !== "true") return;

  try {
    const signals = await parseSingleMessage(senderName, time, text);
    if (signals.length === 0) return;
    const newSignals = signals.filter(function(s) { return !isDuplicate(sourceId, s.stock_code, s.action); });
    if (newSignals.length === 0) return;
    const codes = newSignals.map(function(s){return s.stock_code;});
    const pricesMap = await fetchMultipleStocks(codes);
    newSignals.forEach(function(s){addSignal(s);});
    const flexMsg = formatFlexMessage(newSignals, pricesMap);
    await lineClient.replyMessage({ replyToken: replyToken, messages: [flexMsg] });
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
app.listen(PORT, async function() {
  console.log("LINE Stock Bot 啟動 Port:" + PORT);
  await initDB();
  setupScheduler(lineClient);
});
