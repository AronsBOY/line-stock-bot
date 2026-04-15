const CODE_NAMES = {
  "5475":"德宏","3167":"大量","7734":"印能","3533":"嘉澤",
  "3211":"順達","3563":"牧德","3535":"晶彩科","6739":"竹陞科技",
  "1802":"玻玻","3665":"貿聯KY","6788":"華景電","2368":"金像電",
  "3715":"定穎","3450":"聯鈞"
};

const portfolio = { buys: [], sells: [] };
let nextId = 1;

function addBuy(code, name, date, price) {
  const n = CODE_NAMES[code] || name || code;
  portfolio.buys.push({ id: nextId++, code, name: n, date, price: parseFloat(price) });
}

function addSell(code, name, date, price) {
  const n = CODE_NAMES[code] || name || code;
  portfolio.sells.push({ id: nextId++, code, name: n, date, price: parseFloat(price) });
}

function cancelEntry(code, date) {
  const bi = portfolio.buys.findIndex(function(b) { return b.code === code && b.date === date; });
  if (bi !== -1) { portfolio.buys.splice(bi, 1); return "已取消買入 " + code + " " + date; }
  const si = portfolio.sells.findIndex(function(s) { return s.code === code && s.date === date; });
  if (si !== -1) { portfolio.sells.splice(si, 1); return "已取消賣出 " + code + " " + date; }
  return "找不到 " + code + " " + date + " 的記錄";
}

function getGroups() {
  const g = {};
  portfolio.buys.forEach(function(b) {
    if (!g[b.code]) g[b.code] = { code: b.code, name: b.name, buys: [], sells: [] };
    g[b.code].buys.push(b);
  });
  portfolio.sells.forEach(function(s) {
    if (!g[s.code]) g[s.code] = { code: s.code, name: s.name, buys: [], sells: [] };
    g[s.code].sells.push(s);
  });
  return Object.values(g);
}

function getHoldingSummary(livePrices) {
  const groups = getGroups();
  const holding = groups.filter(function(g) { return g.buys.length > g.sells.length; });
  if (!holding.length) return "目前無持倉";

  let totalPnl = 0;
  let totalCost = 0;

  const lines = holding.map(function(g) {
    const totalBuy = g.buys.length;
    const totalSell = g.sells.length;
    const qty = totalBuy - totalSell;
    const avg = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / totalBuy;
    const p = livePrices && livePrices[g.code];
    const curPrice = p ? p.price : null;
    const pnlPerShare = curPrice ? curPrice - avg : null;
    const pnlTotal = pnlPerShare !== null ? pnlPerShare * qty * 1000 : null;
    const pct = pnlPerShare !== null ? pnlPerShare / avg * 100 : null;
    const costTotal = avg * qty * 1000;

    if (pnlTotal !== null) totalPnl += pnlTotal;
    totalCost += costTotal;

    let line = g.code + " " + g.name + "　持股：" + qty + " 張\n";
    line += "  均價：" + avg.toFixed(2) + "　成本：" + Math.round(costTotal).toLocaleString() + " 元\n";
    g.buys.forEach(function(b, i) {
      line += "  " + (i + 1) + ". " + b.date + " " + b.price.toFixed(2) + "\n";
    });
    if (totalSell > 0) {
      line += "  已賣出：" + totalSell + " 張\n";
    }
    if (curPrice !== null) {
      const arrow = pct >= 0 ? "▲" : "▼";
      line += "  現價：" + curPrice + " " + arrow + Math.abs(pct).toFixed(2) + "%\n";
      line += "  未實現損益：" + (pnlTotal >= 0 ? "+" : "") + Math.round(pnlTotal).toLocaleString() + " 元";
    } else {
      line += "  現價：查詢中...";
    }
    return line;
  });

  const divider = "═".repeat(20);
  return lines.join("\n\n") + "\n\n" + divider +
    "\n總持股：" + holding.length + " 支" +
    "\n總成本：" + Math.round(totalCost).toLocaleString() + " 元" +
    "\n總未實現損益：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

function getSettledSummary() {
  const groups = getGroups();
  const settled = groups.filter(function(g) { return g.buys.length > 0 && g.sells.length >= g.buys.length; });
  if (!settled.length) return "尚無已結算股票";

  let totalPnl = 0;
  const lines = settled.map(function(g) {
    const qty = g.buys.length;
    const avgBuy = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / qty;
    const avgSell = g.sells.slice(0, qty).reduce(function(a, b) { return a + b.price; }, 0) / qty;
    const pnl = (avgSell - avgBuy) * qty * 1000;
    const pct = (avgSell - avgBuy) / avgBuy * 100;
    totalPnl += pnl;
    const mark = pnl >= 0 ? "獲利" : "虧損";
    return g.code + " " + g.name + " " + mark + "　共 " + qty + " 張\n" +
      "  均買：" + avgBuy.toFixed(2) + "　均賣：" + avgSell.toFixed(2) + "\n" +
      "  已實現損益：" + (pnl >= 0 ? "+" : "") + Math.round(pnl).toLocaleString() + " 元 (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
  });

  const divider = "═".repeat(20);
  return "已結算\n" + divider + "\n" + lines.join("\n\n") + "\n\n" + divider +
    "\n合計：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

module.exports = { addBuy, addSell, cancelEntry, getHoldingSummary, getSettledSummary, portfolio };
