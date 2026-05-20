const axios = require("axios");

function toTWTimestamp(dateStr, timeStr) {
  const dt = timeStr
    ? new Date(dateStr + "T" + timeStr + ":00+08:00")
    : new Date(dateStr + "T13:30:00+08:00");
  return Math.floor(dt.getTime() / 1000);
}

async function fetchHistoricalPrice(stockCode, dateStr, timeStr) {
  try {
    const dayStart = Math.floor(new Date(dateStr + "T09:00:00+08:00").getTime() / 1000);
    const dayEnd = Math.floor(new Date(dateStr + "T14:00:00+08:00").getTime() / 1000);
    const interval = timeStr ? "1m" : "1d";
    const { data } = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + ".TW",
      {
        params: { interval, period1: dayStart, period2: dayEnd },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      }
    );
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;

    if (!timeStr) {
      const meta = result.meta;
      const price = meta.regularMarketPrice || meta.chartPreviousClose;
      const prev = meta.previousClose || meta.chartPreviousClose;
      const change = price - prev;
      const changePct = (change / prev) * 100;
      return {
        code: stockCode,
        price: parseFloat(price.toFixed(2)),
        change: parseFloat(change.toFixed(2)),
        changePct: parseFloat(changePct.toFixed(2)),
        high: null, low: null,
        longName: result.meta.longName || result.meta.shortName || stockCode,
        marketStatus: "收盤",
        isUp: change >= 0,
        timestamp: dateStr,
        isHistorical: true,
      };
    }

    const timestamps = result.timestamp || [];
    const closes = result.indicators.quote[0].close || [];
    const highs = result.indicators.quote[0].high || [];
    const lows = result.indicators.quote[0].low || [];
    const target = toTWTimestamp(dateStr, timeStr);
    let closest = 0, minDiff = Infinity;
    timestamps.forEach(function(ts, i) {
      const diff = Math.abs(ts - target);
      if (diff < minDiff && closes[i] != null) { minDiff = diff; closest = i; }
    });
    const price = closes[closest];
    if (!price) return null;
    const prev = result.meta.previousClose || result.meta.chartPreviousClose;
    const change = price - prev;
    const changePct = (change / prev) * 100;
    const actualTs = new Date(timestamps[closest] * 1000);
    const actualTime = actualTs.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      code: stockCode,
      price: parseFloat(price.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      high: highs[closest] ? parseFloat(highs[closest].toFixed(2)) : null,
      low: lows[closest] ? parseFloat(lows[closest].toFixed(2)) : null,
      longName: result.meta.longName || result.meta.shortName || stockCode,
      marketStatus: actualTime + " 歷史",
      isUp: change >= 0,
      timestamp: dateStr + " " + actualTime,
      isHistorical: true,
    };
  } catch (err) {
    console.error("[Historical]", stockCode, err.message);
    return null;
  }
}

async function fetchLatestPrice(stockCode) {
  try {
    const { data } = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + ".TW",
      {
        params: { interval: "1m", range: "1d" },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      }
    );
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose;
    const change = price - prev;
    const changePct = (change / prev) * 100;
    const now = new Date();
    const twH = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getHours();
    const twM = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getMinutes();
    const isOpen = twH >= 9 && (twH < 13 || (twH === 13 && twM <= 30));
    return {
      code: stockCode,
      price: parseFloat(price.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      high: meta.regularMarketDayHigh ? parseFloat(meta.regularMarketDayHigh.toFixed(2)) : null,
      low: meta.regularMarketDayLow ? parseFloat(meta.regularMarketDayLow.toFixed(2)) : null,
      longName: meta.longName || meta.shortName || stockCode,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
      isHistorical: false,
    };
  } catch (err) {
    return null;
  }
}

async function fetchStockPrice(stockCode, dateStr, timeStr) {
  if (dateStr) return await fetchHistoricalPrice(stockCode, dateStr, timeStr);
  return await fetchLatestPrice(stockCode);
}

async function fetchMultipleStocks(codes) {
  const unique = [];
  codes.forEach(function(c) { if (!unique.includes(c)) unique.push(c); });
  const results = await Promise.allSettled(unique.map(function(c) { return fetchStockPrice(c); }));
  const output = {};
  unique.forEach(function(code, i) {
    output[code] = results[i].status === "fulfilled" ? results[i].value : null;
  });
  return output;
}

function formatFlexMessage(signals, pricesMap) {
  const bubbles = signals.map(function(sig) {
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
          { type: "separator", margin: "md" },
          { type: "box", layout: "horizontal", margin: "md", contents: [
            { type: "box", layout: "vertical", flex: 1, contents: [{ type: "text", text: "最高", size: "xs", color: "#888888" }, { type: "text", text: p.high ? String(p.high) : "-", size: "sm", weight: "bold" }]},
            { type: "box", layout: "vertical", flex: 1, contents: [{ type: "text", text: "最低", size: "xs", color: "#888888" }, { type: "text", text: p.low ? String(p.low) : "-", size: "sm", weight: "bold" }]},
            { type: "box", layout: "vertical", flex: 1, contents: [{ type: "text", text: "狀態", size: "xs", color: "#888888" }, { type: "text", text: p.marketStatus, size: "sm", weight: "bold" }]},
          ]},
        ] : [{ type: "text", text: "無法取得行情", color: "#888888", size: "sm" }],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: "#111111",
        contents: [
          { type: "text", text: sig.sender + " " + sig.time, size: "xs", color: "#888888" },
          { type: "text", text: sig.original, size: "xs", color: "#666666", wrap: true, margin: "sm" },
        ],
      },
    };
  });
  return {
    type: "flex",
    altText: "偵測到 " + signals.length + " 個股票訊號",
    contents: { type: "carousel", contents: bubbles },
  };
}

module.exports = { fetchStockPrice, fetchHistoricalPrice, fetchMultipleStocks, formatFlexMessage };
