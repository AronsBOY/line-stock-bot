const axios = require("axios");

async function tryYahoo(symbol) {
  try {
    const { data } = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol,
      { params: { interval: "1m", range: "1d" }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }
    );
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose;
    if (!price || !prev) return null;
    const change = price - prev;
    const changePct = (change / prev) * 100;
    const now = new Date();
    const twH = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getHours();
    const twM = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })).getMinutes();
    const isOpen = twH >= 9 && (twH < 13 || (twH === 13 && twM <= 30));
    return {
      code: symbol.replace(".TW", "").replace(".TWO", ""),
      price: parseFloat(price.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      high: meta.regularMarketDayHigh ? parseFloat(meta.regularMarketDayHigh.toFixed(2)) : null,
      low: meta.regularMarketDayLow ? parseFloat(meta.regularMarketDayLow.toFixed(2)) : null,
      longName: meta.longName || meta.shortName || symbol,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
      isHistorical: false,
      priceType: "即時",
    };
  } catch (err) {
    return null;
  }
}

async function fetchLatestPrice(stockCode) {
  const tw = await tryYahoo(stockCode + ".TW");
  if (tw) return tw;
  const two = await tryYahoo(stockCode + ".TWO");
  if (two) return two;
  return null;
}

async function fetchTWSEClose(stockCode, dateStr) {
  try {
    const d = dateStr.replace(/-/g, "");
    const ym = d.slice(0, 6) + "01";
    const { data } = await axios.get(
      "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
      { params: { date: ym, stockNo: stockCode, response: "json" }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }
    );
    if (!data || !data.data) return null;
    const parts = dateStr.split("-");
    const rocYear = parseInt(parts[0]) - 1911;
    const target = rocYear + "/" + parts[1] + "/" + parts[2];
    const row = data.data.find(function (r) { return r[0] === target; });
    if (!row) return null;
    const close = parseFloat(row[6].replace(/,/g, ""));
    const open = parseFloat(row[3].replace(/,/g, ""));
    const change = close - open;
    return {
      code: stockCode, price: close,
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(((change / open) * 100).toFixed(2)),
      high: parseFloat(row[4].replace(/,/g, "")),
      low: parseFloat(row[5].replace(/,/g, "")),
      longName: stockCode, marketStatus: "收盤（TWSE）",
      isUp: change >= 0, timestamp: dateStr, isHistorical: true,
      priceType: "收盤價",
    };
  } catch (err) { return null; }
}

async function fetchTPEXClose(stockCode, dateStr) {
  try {
    const parts = dateStr.split("-");
    const rocYear = parseInt(parts[0]) - 1911;
    const d = rocYear + "/" + parts[1] + "/" + parts[2];
    const { data } = await axios.get(
      "https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php",
      { params: { l: "zh-tw", d: d, stkno: stockCode }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }
    );
    if (!data || !data.aaData || !data.aaData.length) return null;
    const row = data.aaData[0];
    const close = parseFloat(row[6].replace(/,/g, ""));
    const open = parseFloat(row[3].replace(/,/g, ""));
    const change = close - open;
    return {
      code: stockCode, price: close,
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(((change / open) * 100).toFixed(2)),
      high: parseFloat(row[4].replace(/,/g, "")),
      low: parseFloat(row[5].replace(/,/g, "")),
      longName: stockCode, marketStatus: "收盤（TPEX）",
      isUp: change >= 0, timestamp: dateStr, isHistorical: true,
      priceType: "收盤價",
    };
  } catch (err) { return null; }
}

function toTWTimestamp(dateStr, timeStr) {
  const dt = timeStr
    ? new Date(dateStr + "T" + timeStr + ":00+08:00")
    : new Date(dateStr + "T13:30:00+08:00");
  return Math.floor(dt.getTime() / 1000);
}

async function fetchYahooIntraday(stockCode, dateStr, timeStr) {
  for (const suffix of [".TW", ".TWO"]) {
    try {
      const dayStart = Math.floor(new Date(dateStr + "T09:00:00+08:00").getTime() / 1000);
      const dayEnd = Math.floor(new Date(dateStr + "T14:00:00+08:00").getTime() / 1000);
      const { data } = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/" + stockCode + suffix,
        { params: { interval: "1m", period1: dayStart, period2: dayEnd }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }
      );
      const result = data.chart && data.chart.result && data.chart.result[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const closes = result.indicators.quote[0].close || [];
      if (!timestamps.length) continue;
      if (!timeStr) {
        const meta = result.meta;
        const price = meta.regularMarketPrice || meta.chartPreviousClose;
        const prev = meta.previousClose || meta.chartPreviousClose;
        const change = price - prev;
        return {
          code: stockCode, price: parseFloat(price.toFixed(2)),
          change: parseFloat(change.toFixed(2)),
          changePct: parseFloat(((change/prev)*100).toFixed(2)),
          longName: meta.longName || meta.shortName || stockCode,
          marketStatus: "收盤（Yahoo）", isUp: change >= 0,
          timestamp: dateStr, isHistorical: true,
          priceType: "收盤價",
        };
      }
      const target = toTWTimestamp(dateStr, timeStr);
      let closest = 0, minDiff = Infinity;
      timestamps.forEach(function (ts, i) {
        const diff = Math.abs(ts - target);
        if (diff < minDiff && closes[i] != null) { minDiff = diff; closest = i; }
      });
      const price = closes[closest];
      if (!price) continue;
      const prev = result.meta.previousClose || result.meta.chartPreviousClose;
      const change = price - prev;
      const actualTs = new Date(timestamps[closest] * 1000);
      const actualTime = actualTs.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
      return {
        code: stockCode, price: parseFloat(price.toFixed(2)),
        change: parseFloat(change.toFixed(2)),
        changePct: parseFloat(((change/prev)*100).toFixed(2)),
        high: result.indicators.quote[0].high[closest] ? parseFloat(result.indicators.quote[0].high[closest].toFixed(2)) : null,
        low: result.indicators.quote[0].low[closest] ? parseFloat(result.indicators.quote[0].low[closest].toFixed(2)) : null,
        longName: result.meta.longName || result.meta.shortName || stockCode,
        marketStatus: actualTime + " 歷史", isUp: change >= 0,
        timestamp: dateStr + " " + actualTime, isHistorical: true,
        priceType: "時價",
      };
    } catch (err) { continue; }
  }
  return null;
}

async function fetchHistoricalPrice(stockCode, dateStr, timeStr) {
  if (timeStr) {
    const yahoo = await fetchYahooIntraday(stockCode, dateStr, timeStr);
    if (yahoo) return yahoo;
  }
  const twse = await fetchTWSEClose(stockCode, dateStr);
  if (twse) return twse;
  const tpex = await fetchTPEXClose(stockCode, dateStr);
  if (tpex) return tpex;
  return await fetchYahooIntraday(stockCode, dateStr, null);
}

async function fetchStockPrice(stockCode, dateStr, timeStr) {
  if (dateStr) return await fetchHistoricalPrice(stockCode, dateStr, timeStr);
  return await fetchLatestPrice(stockCode);
}

async function fetchMultipleStocks(codes) {
  const unique = [];
  codes.forEach(function (c) { if (!unique.includes(c)) unique.push(c); });
  // 節流：分批平行處理，每批最多10檔、批次間隔1秒，避免瞬間對Yahoo/TWSE打太密集被暫時封鎖
  const BATCH_SIZE = 10;
  const output = {};
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(function (c) { return fetchStockPrice(c); }));
    batch.forEach(function (code, j) {
      output[code] = results[j].status === "fulfilled" ? results[j].value : null;
    });
    if (i + BATCH_SIZE < unique.length) await new Promise(function (r) { setTimeout(r, 1000); });
  }
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
