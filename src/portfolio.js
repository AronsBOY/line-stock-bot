const portfolio = { buys: [], sells: [] };
let nextId = 1;

function addBuy(code, name, date, price) {
  portfolio.buys.push({ id: nextId++, code, name, date, price: parseFloat(price) });
}

function addSell(code, name, date, price) {
  portfolio.sells.push({ id: nextId++, code, name, date, price: parseFloat(price) });
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
  let lines = holding.map(function(g) {
    const qty = g.buys.length;
    const avg = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / qty;
    const p = livePrices && livePrices[g.code];
    const curPrice = p ? p.price : null;
    const pnlPerShare = curPrice ? curPrice - avg : null;
    const pnlTotal = pnlPerShare !== null ? pnlPerShare * qty * 1000 : null;
    const pct = pnlPerShare !== null ? pnlPerShare / avg * 100 : null;
    if (pnlTotal !== null) totalPnl += pnlTotal;

    let line = g.code + " " + g.name + "\n";
    line += "  均價：" + avg.toFixed(2) + "\n";
    g.buys.forEach(function(b, i) {
      line += "  " + (i + 1) + ". " + b.date + " " + b.price.toFixed(2) + "\n";
    });
    if (curPrice !== null) {
      line += "  現價：" + curPrice + " " + (pct >= 0 ? "▲" : "▼") + Math.abs(pct).toFixed(2) + "%\n";
      line += "  未實現損益：" + (pnlTotal >= 0 ? "+" : "") + Math.round(pnlTotal) + " 元";
    } else {
      line += "  現價：查詢中...";
    }
    return line;
  });

  return lines.join("\n\n") + "\n\n" + "═".repeat(20) + "\n總未實現損益：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl) + " 元";
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
    return g.code + " " + g.name + " " + mark + "\n  均買：" + avgBuy.toFixed(1) + "　均賣：" + avgSell.toFixed(1) + "\n  損益：" + (pnl >= 0 ? "+" : "") + Math.round(pnl) + " 元 (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)";
  });

  return "已結算\n" + "═".repeat(20) + "\n" + lines.join("\n\n") + "\n\n" + "═".repeat(20) + "\n合計：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl) + " 元";
}

module.exports = { addBuy, addSell, cancelEntry, getHoldingSummary, getSettledSummary, portfolio };
