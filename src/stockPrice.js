const axios = require("axios");

const FUGLE_KEY = process.env.FUGLE_API_KEY;

async function fetchFuglePrice(stockCode) {
  try {
    const { data } = await axios.get(
      "https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/" + stockCode,
      {
        headers: { "X-API-KEY": FUGLE_KEY },
        timeout: 8000,
      }
    );
    if (!data || !data.lastPrice) return null;
    const price = data.lastPrice;
    const prev = data.previousClose;
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
      high: data.highPrice ? parseFloat(data.highPrice.toFixed(2)) : null,
      low: data.lowPrice ? parseFloat(data.lowPrice.toFixed(2)) : null,
      volume: data.total && data.total.tradeVolume || null,
      longName: data.name || stockCode,
      marketStatus: isOpen ? "盤中" : "盤後",
      isUp: change >= 0,
      timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    };
  } catch (err) {
    return null;
  }
}

async function fetchYahooPrice(
