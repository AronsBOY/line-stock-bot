const axios = require("axios");

const FUGLE_BASE = "https://api.fugle.tw/marketdata/v1.0/stock";

function fugleHeaders() {
  return { "X-API-KEY": process.env.FUGLE_API_KEY };
}

function nowTW() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

// ── 即時報價 ──
async function fetchLatestPrice(stockCode) {
  try {
    const { data } = await axios.get(FUGLE_BASE + "/intraday/quote/" + stockCode, {
      headers: fugleHeaders(), timeout: 8000,
    });
    if (!data || data.closePrice == null) return null;
    const price = data.closePrice;
    const change = data.change != null ? data.change : (data.previousClose != null ? price - data.previousClose : 0);
    const changePct = data.changePercent != null ? data.changePercent : (data.previousClose ? (change / data.previousClose) * 100 : 0);
    return {
      code: stockCode,
      price: price,
      change: change,
      changePct: changePct,
      high: data.highPrice != null ? data.highPrice : null,
      low: data.lowPrice != null ? data.lowPrice : null,
      longName: data.name || stockCode,
      marketStatus: data.isClose ? "盤後" : "盤中",
      isUp: change >= 0,
      timestamp: nowTW(),
      isHistorical: false,
    };
  } catch (err) {
    return null;
  }
}

// ── 歷史收盤價（日Ｋ）──
async function fetchHistoricalClose(stockCode, dateStr) {
  try {
    const { data } = await axios.get(FUGLE_BASE + "/historical/candles/" + stockCode, {
      headers: fugleHeaders(),
      params: { from: dateStr, to: dateStr, fields: "open,high,low,close,volume,change" },
      timeout: 8000,
    });
    if (!data || !data.data || !data.data.length) return null;
    const row = data.data[0];
    const close = row.close;
    const change = row.change != null ? row.change : 0;
    const prevClose = close - change;
    return {
      code: stockCode,
      price: close,
      change: parseFloat(change.toFixed(2)),
      changePct: prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0,
      high: row.high != null ? row.high : null,
      low: row.low != null ? row.low : null,
      longName: stockCode,
      marketStatus: "收盤（Fugle）",
      isUp: change >= 0,
      timestamp: dateStr,
      isHistorical: true,
    };
  } catch (err) {
    return null;
  }
}

// ── 歷史分K（指定時間點）──
async function fetchHistoricalIntraday(stockCode, dateStr, timeStr) {
  try {
    const { data } = await axios.get(FUGLE_BASE + "/historical/candles/" + stockCode, {
      headers: fugleHeaders(),
      params: { from: dateStr, to: dateStr, timeframe: "1", fields: "open,high,low,close,volume", sort: "asc" },
      timeout: 8000,
    });
    if (!data || !data.data || !data.data.length) return null;
    const rows = data.data;
    const parts = timeStr.split(":");
    const targetMinutes = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    let closest = rows[0], minDiff = Infinity;
    rows.forEach(function (r) {
      const d = new Date(r.date);
      const twH = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getHours();
      const twM = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getMinutes();
      const diff = Math.abs((twH * 60 + twM) - targetMinutes);
      if (diff < minDiff) { minDiff = diff; closest = r; }
    });
    const d = new Date(closest.date);
    const actualTime = d.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
    const dayClose = await fetchHistoricalClose(stockCode, dateStr);
    const prevClose = dayClose ? dayClose.price - dayClose.change : closest.close;
    const change = closest.close - prevClose;
    return {
      code: stockCode,
      price: closest.close,
      change: parseFloat(change.toFixed(2)),
      changePct: prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0,
      high: closest.high != null ? closest.high : null,
      low: closest.low != null ? closest.low : null,
      longName: stockCode,
      marketStatus: actualTime + " 歷史",
      isUp: change >= 0,
      timestamp: dateStr + " " + actualTime,
      isHistorical: true,
    };
  } catch (err) {
    return null;
  }
}

async function fetchHistoricalPrice(stockCode, dateStr, timeStr) {
  if (timeStr) {
    const intraday = await fetchHistoricalIntraday(stockCode, dateStr, timeStr);
    if (intraday) return intraday;
  }
  return await fetchHistoricalClose(stockCode, dateStr);
}

async function fetchStockPrice(stockCode, dateStr, timeStr) {
  if (dateStr) return await fetchHistoricalPrice(stockCode, dateStr, timeStr);
  return await fetchLatestPrice(stockCode);
}

async function fetchMultipleStocks(codes) {
  const unique = [];
  codes.forEach(function (c) { if (!unique.includes(c)) unique.push(c); });
  const results = await Promise.allSettled(unique.map(function (c) { return fetchStockPrice(c); }));
  const output = {};
  unique.forEach(function (code, i) {
    output[code] = results[i].status === "fulfilled" ? results[i].value : null;
  });
  return output;
}

function formatFlexMessage(signals, pricesMap) {
  const bubbles = signals.map(function (sig) {
    const p = pricesMap[sig.stock_code];
    const isBuy = sig.action === "買入";
    const color = p && p.change >= 0 ? "#00C851" : "#FF4444";
    const arrow = p && p.change >= 0 ? "▲" : "▼";
    return {
      type: "bubble", size: "kilo",
      header: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: isBuy ? "#1A3A2A" : "#3A1A1A",
        contents: [
          { type: "text", text: isBuy ? "買入" : "賣出", color: isBuy ? "#00C851" : "#FF4444", size: "sm", weight: "bold" },
          { type: "text", text: sig.stock_code + " " + (sig.stock_name || ""), size: "xl", weight: "bold", color: "#FFFFFF" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px", backgroundColor: "#1A1A1A",
        contents: p ? [
          { type: "box", layout: "horizontal", alignItems: "center", contents: [
            { type: "text", text: String(p.price), size: "3xl", weight: "bold", color, flex: 1 },
            { type: "text", text: arrow + " " + Math.abs(p.change) + "\n(" + Math.abs(p.changePct) + "%)", size: "sm", color, align: "end", wrap: true },
          ]},
        ] : [{ type: "text", text: "無法取得行情", color: "#888888", size: "sm" }],
      },
    };
  });
  return { type: "flex", altText: "偵測到 " + signals.length + " 個股票訊號", contents: { type: "carousel", contents: bubbles } };
}

module.exports = { fetchStockPrice, fetchHistoricalPrice, fetchMultipleStocks, formatFlexMessage };
