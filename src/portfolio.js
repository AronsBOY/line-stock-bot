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

function getHoldingSummary() {
  const groups = getGroups();
  const holding = groups.filter(function(g) { return g.buys.length > g.sells.length; });
  if (!holding.length) return "目前無持倉";
  return "目前持倉：\n" + holding.map(function(g) {
    const avg = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / g.buys.length;
    return g.code + " " + g.name + " ×" + g.buys.length + " 均價" + avg.toFixed(1);
  }).join("\n");
}

function getSettledSummary() {
  const groups = getGroups();
  const settled = groups.filter(function(g) { return g.buys.length > 0 && g.sells.length >= g.buys.length; });
  if (!settled.length) return "尚無已結算股票";
  return "已結算：\n" + settled.map(function(g) {
    const avgBuy = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / g.buys.length;
    const avgSell = g.sells.slice(0, g.buys.length).reduce(function(a, b) { return a + b.price; }, 0) / g.buys.length;
    const pnl = (avgSell - avgBuy) * g.buys.length;
    const pct = (avgSell - avgBuy) / avgBuy * 100;
    const mark = pnl >= 0 ? "獲利" : "虧損";
    return g.code + " " + g.name + " " + mark + " " + (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)";
  }).join("\n");
}

module.exports = { addBuy, addSell, cancelEntry, getHoldingSummary, getSettledSummary };
