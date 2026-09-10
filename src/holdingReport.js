const { fetchMultipleStocks } = require("./stockPrice");

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function weekdayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00+08:00");
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
}

function todayTW() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return map.year + "-" + map.month + "-" + map.day;
}

function weightedAverage(entries) {
  const totalQty = entries.reduce(function (sum, e) { return sum + Number(e.qty || 0); }, 0);
  if (totalQty <= 0) return 0;
  const total = entries.reduce(function (sum, e) {
    return sum + Number(e.price || 0) * Number(e.qty || 0);
  }, 0);
  return total / totalQty;
}

function formatShares(lots) {
  return Math.round(Number(lots) * 1000).toLocaleString("en-US");
}

function formatMoney(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatEntry(e, index) {
  const weekday = weekdayOf(e.date);
  const time = e.time || "無";
  const range = e.suggestedPrice || "無";
  const priceType = e.priceType || "收盤價";
  return "　" + (index + 1) + ". [買] " + e.date + "(" + weekday + ") " + time +
    "【價位】" + range + "【" + priceType + "】" + Number(e.price).toFixed(2);
}

async function buildHoldingReport(portfolio, codes) {
  const allEpisodes = await portfolio.getAllEpisodes(codes);
  const openCodes = Object.keys(allEpisodes)
    .filter(function (code) {
      return allEpisodes[code].openEpisode && allEpisodes[code].openEpisode.qty > 0.0001;
    })
    .sort();

  const today = todayTW();
  const todayLabel = today + "(" + weekdayOf(today) + ")";
  const divider = "═".repeat(20);

  if (!openCodes.length) {
    return "【持股庫存】【" + todayLabel + "】\n\n" + divider + "\n\n目前無持股";
  }

  let livePrices = {};
  try {
    livePrices = await fetchMultipleStocks(openCodes);
  } catch (err) {
    console.error("[持股報表] 即時股價查詢失敗：", err.message);
  }

  let totalCost = 0;
  let totalPnl = 0;
  let hasAnyLivePrice = false;
  const blocks = [];

  openCodes.forEach(function (code) {
    const ep = allEpisodes[code].openEpisode;
    const buys = ep.entries.filter(function (e) { return e.type === "買"; });
    const qtyLots = round2(ep.qty);
    const avg = weightedAverage(buys);
    const cost = avg * qtyLots * 1000;
    const name = portfolio.getName(code) || code;
    const p = livePrices[code];
    const curPrice = p && p.price != null ? Number(p.price) : null;

    totalCost += cost;

    let block = code + " " + name +
      "　買入次數：" + buys.length +
      "　均價：" + avg.toFixed(2) +
      "　持股：" + formatShares(qtyLots) + " 股" +
      "　成本：" + formatMoney(cost) + " 元\n\n";

    buys.forEach(function (e, index) {
      block += formatEntry(e, index) + "\n\n";
    });

    if (curPrice !== null && avg > 0) {
      const pct = (curPrice - avg) / avg * 100;
      const pnl = (curPrice - avg) * qtyLots * 1000;
      totalPnl += pnl;
      hasAnyLivePrice = true;
      block += "　現價：" + curPrice + " " + (pct >= 0 ? "▲" : "▼") + Math.abs(pct).toFixed(2) + "%\n\n";
      block += "　未實現損益：" + (pnl >= 0 ? "+" : "") + formatMoney(pnl) + " 元";
    } else {
      block += "　現價：查無資料\n\n";
      block += "　未實現損益：暫無法計算";
    }

    blocks.push(block);
  });

  let footer = divider +
    "\n\n總持股：" + openCodes.length + " 支" +
    "\n\n總成本：" + formatMoney(totalCost) + " 元";

  if (hasAnyLivePrice) {
    footer += "\n\n總未實現損益：" + (totalPnl >= 0 ? "+" : "") + formatMoney(totalPnl) + " 元";
  } else {
    footer += "\n\n總未實現損益：暫無法計算";
  }

  return "【持股庫存】【" + todayLabel + "】\n\n" + divider + "\n\n" + blocks.join("\n\n") + "\n\n" + footer;
}

module.exports = { buildHoldingReport };
