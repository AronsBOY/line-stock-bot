const axios = require("axios");

async function fetchStockPrice(stockCode) {
  try {
    const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
    const { data } = await axios.get(url, {
      params: { ex_ch: "tse_" + stockCode + ".tw", json: 1, delay: 0 },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });

    const item = data.msgArray && data.msgArray[0];
    if (!item || !item.z || item.z === "-") {
      return await fetchStockPriceYahoo(stockCode);
    }

    const price = parseFloat(item.z);
    const prev = parseFloat(item.y);
    const change = price - prev;
    const changePct = (change / prev) * 100;
    const now = new Date();
    const twH = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getHours();
    const twM = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getMinutes();
    const isOpen = twH >= 9 && (twH < 13 || (twH === 13 && twM <= 30));

    return {
      code: stockCode,
      price: price,
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      high: parseFloat(item.h) || null,
      low: parseFloat(item.l) || null,
      volume: parseInt(item.v) || null,
      longName: item.n || stockCode,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    };
  } catch (err) {
    return await fetchStockPriceYahoo(stockCode);
  }
}

async function fetchStockPriceYahoo(stockCode) {
  try {
    const { data } = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + ".TW", {
      params: { interval: "1m", range: "1d" },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
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
      volume: meta.regularMarketVolume,
      longName: meta.longName || meta.shortName || stockCode,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
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
            { type: "text", text: String(p.price), size: "3xl", weight: "bold", color: color, flex: 1 },
            { type: "text", text: arrow + " " + Math.abs(p.change) + "\n(" + Math.abs(p.changePct) + "%)", size: "sm", color: color, align: "end", wrap: true },
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

module.exports = { fetchStockPrice, fetchMultipleStocks, formatFlexMessage };
