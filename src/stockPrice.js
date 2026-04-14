const axios = require("axios");

async function fetchChineseName(stockCode) {
  try {
    const res = await axios.get("https://www.twse.com.tw/rwd/zh/api/stockSearch?keyword=" + stockCode + "&type=ALL", {
      headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000
    });
    const data = res.data;
    if (data && data.data && data.data.length > 0) {
      for (const item of data.data) {
        if (item[0] === stockCode) return item[1];
      }
    }
  } catch (e) {}
  try {
    const res = await axios.get("https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&se=EW&s=0,asc,0&d=114/04/15&q=" + stockCode, {
      headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000
    });
    const data = res.data;
    if (data && data.aaData && data.aaData.length > 0) {
      for (const item of data.aaData) {
        if (item[0] === stockCode) return item[1];
      }
    }
  } catch (e) {}
  return null;
}

async function fetchStockPrice(stockCode) {
  try {
    let data = null;
    for (const suffix of [".TW", ".TWO"]) {
      try {
        const res = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + suffix, {
          params: { interval: "1m", range: "1d" },
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 8000,
        });
        if (res.data.chart && res.data.chart.result && res.data.chart.result[0]) {
          data = res.data;
          break;
        }
      } catch (e) {}
    }
    if (!data) return null;
    const result = data.chart.result[0];
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose;
    const change = price - prev;
    const changePct = (change / prev) * 100;
    const now = new Date();
    const twH = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getHours();
    const twM = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getMinutes();
    const isOpen = twH >= 9 && (twH < 13 || (twH === 13 && twM <= 30));
    const cnName = await fetchChineseName(stockCode);
    return {
      code: stockCode,
      price: price.toFixed(2),
      change: change.toFixed(2),
      changePct: changePct.toFixed(2),
      high: meta.regularMarketDayHigh ? meta.regularMarketDayHigh.toFixed(2) : "-",
      low: meta.regularMarketDayLow ? meta.regularMarketDayLow.toFixed(2) : "-",
      volume: meta.regularMarketVolume,
      longName: cnName || meta.longName || meta.shortName || stockCode,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    };
  } catch (err) {
    return null;
  }
}

async function fetchHistoricalClose(stockCode, dateStr) {
  try {
    const normalized = dateStr.replace(/\./g, "-").replace(/\//g, "-");
    const parts = normalized.split("-");
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const day = parseInt(parts[2]);
    const targetDate = new Date(Date.UTC(year, month, day));
    const p1 = Math.floor(targetDate.getTime() / 1000) - 86400;
    const p2 = Math.floor(targetDate.getTime() / 1000) + 172800;
    let data = null;
    for (const suffix of [".TW", ".TWO"]) {
      try {
        const res = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + suffix, {
          params: { interval: "1d", period1: p1, period2: p2 },
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 8000,
        });
        if (res.data.chart && res.data.chart.result && res.data.chart.result[0] && res.data.chart.result[0].timestamp && res.data.chart.result[0].timestamp.length > 0) {
          data = res.data;
          break;
        }
      } catch (e) {}
    }
    if (!data) return null;
    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const closes = result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close || [];
    let closestPrice = null;
    let closestDiff = Infinity;
    timestamps.forEach(function(ts, i) {
      const d = new Date((ts + 8 * 3600) * 1000);
      const dStr = d.toISOString().slice(0, 10);
      const tStr = targetDate.toISOString().slice(0, 10);
      const diff = Math.abs(new Date(dStr) - new Date(tStr));
      if (diff < closestDiff && closes[i]) {
        closestDiff = diff;
        closestPrice = closes[i];
      }
    });
    if (!closestPrice) return null;
    const cnName = await fetchChineseName(stockCode);
    const meta = result.meta;
    return {
      price: closestPrice.toFixed(2),
      longName: cnName || meta.longName || meta.shortName || stockCode
    };
  } catch (err) {
    return null;
  }
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
    const color = p && parseFloat(p.change) >= 0 ? "#00C851" : "#FF4444";
    const arrow = p && parseFloat(p.change) >= 0 ? "▲" : "▼";
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
            { type: "text", text: p.price, size: "3xl", weight: "bold", color: color, flex: 1 },
            { type: "text", text: arrow + " " + Math.abs(p.change) + "\n(" + Math.abs(p.changePct) + "%)", size: "sm", color: color, align: "end", wrap: true },
          ]},
          { type: "separator", margin: "md" },
          { type: "box", layout: "horizontal", margin: "md", contents: [
            { type: "box", layout: "vertical", flex: 1, contents: [{ type: "text", text: "最高", size: "xs", color: "#888888" }, { type: "text", text: p.high, size: "sm", weight: "bold" }]},
            { type: "box", layout: "vertical", flex: 1, contents: [{ type: "text", text: "最低", size: "xs", color: "#888888" }, { type: "text", text: p.low, size: "sm", weight: "bold" }]},
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

module.exports = { fetchStockPrice, fetchHistoricalClose, fetchMultipleStocks, formatFlexMessage };
