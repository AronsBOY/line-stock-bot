const CODE_NAMES = {
  "2351":"順德","3167":"大量","3211":"順達","3533":"嘉澤",
  "3535":"晶彩科","3563":"牧德","3715":"定穎","4749":"新應材",
  "4971":"IET-KY","4989":"形將","5347":"世界","5475":"德宏",
  "6739":"竹陞科技","6788":"華景電","7734":"印能","1802":"玻玻",
  "2368":"金像電","3450":"聯鈞","3665":"貿聯KY","8358":"金居",
  "1560":"中砂"
};

const portfolio = {
  buys: [
    {id:1,code:"2351",name:"順德",date:"2026-04-23",price:158.5},
    {id:2,code:"2351",name:"順德",date:"2026-04-24",price:151.5},
    {id:3,code:"2351",name:"順德",date:"2026-04-29",price:151.5},
    {id:4,code:"3211",name:"順達",date:"2026-03-30",price:354},
    {id:5,code:"3211",name:"順達",date:"2026-03-31",price:345},
    {id:6,code:"3211",name:"順達",date:"2026-04-02",price:332},
    {id:7,code:"3211",name:"順達",date:"2026-04-14",price:350},
    {id:8,code:"3533",name:"嘉澤",date:"2026-03-23",price:1985},
    {id:9,code:"3533",name:"嘉澤",date:"2026-03-27",price:2260},
    {id:10,code:"3533",name:"嘉澤",date:"2026-03-31",price:2025},
    {id:11,code:"3533",name:"嘉澤",date:"2026-04-07",price:2030},
    {id:12,code:"3533",name:"嘉澤",date:"2026-04-23",price:2445},
    {id:13,code:"3535",name:"晶彩科",date:"2026-04-10",price:134},
    {id:14,code:"3535",name:"晶彩科",date:"2026-04-13",price:130},
    {id:15,code:"3715",name:"定穎",date:"2026-04-15",price:188},
    {id:16,code:"3715",name:"定穎",date:"2026-04-20",price:198},
    {id:17,code:"4749",name:"新應材",date:"2026-04-23",price:976},
    {id:18,code:"4749",name:"新應材",date:"2026-04-24",price:981},
    {id:19,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:20,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:21,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:22,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:23,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:24,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:25,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:26,code:"4971",name:"IET-KY",date:"2026-03-16",price:333},
    {id:27,code:"4989",name:"形將",date:"2026-05-05",price:104},
    {id:28,code:"5475",name:"德宏",date:"2026-03-18",price:212},
    {id:29,code:"5475",name:"德宏",date:"2026-03-19",price:212},
    {id:30,code:"5475",name:"德宏",date:"2026-03-24",price:192},
    {id:31,code:"6739",name:"竹陞科技",date:"2026-04-13",price:1480},
    {id:32,code:"6739",name:"竹陞科技",date:"2026-04-13",price:1510},
    {id:33,code:"7734",name:"印能",date:"2026-03-18",price:1900},
    {id:34,code:"7734",name:"印能",date:"2026-03-20",price:1855},
    {id:35,code:"7734",name:"印能",date:"2026-03-20",price:1855},
    {id:36,code:"7734",name:"印能",date:"2026-03-24",price:1660},
    {id:37,code:"1802",name:"玻玻",date:"2026-03-23",price:51.9},
    {id:38,code:"3167",name:"大量",date:"2026-03-18",price:349},
    {id:39,code:"3167",name:"大量",date:"2026-03-24",price:317},
  ],
  sells: [
    {id:50,code:"1802",name:"玻玻",date:"2026-04-16",price:64.1},
    {id:51,code:"3167",name:"大量",date:"2026-04-16",price:698},
    {id:52,code:"3167",name:"大量",date:"2026-04-16",price:698},
    {id:53,code:"5475",name:"德宏",date:"2026-04-14",price:316},
    {id:54,code:"7734",name:"印能",date:"2026-04-23",price:3150},
    {id:55,code:"7734",name:"印能",date:"2026-04-23",price:3150},
    {id:56,code:"3535",name:"晶彩科",date:"2026-05-05",price:136},
    {id:57,code:"3535",name:"晶彩科",date:"2026-05-05",price:136},
  ]
};

let nextId = 200;

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

function adjustPrice(code, date, newPrice) {
  const b = portfolio.buys.find(function(b) { return b.code === code && b.date === date; });
  if (b) { b.price = parseFloat(newPrice); return "已調整 " + code + " " + date + " 買入價為 " + newPrice; }
  const s = portfolio.sells.find(function(s) { return s.code === code && s.date === date; });
  if (s) { s.price = parseFloat(newPrice); return "已調整 " + code + " " + date + " 賣出價為 " + newPrice; }
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
  let totalPnl = 0, totalCost = 0;
  const lines = holding.map(function(g) {
    const qty = g.buys.length - g.sells.length;
    const avg = g.buys.reduce(function(a, b) { return a + b.price; }, 0) / g.buys.length;
    const p = livePrices && livePrices[g.code];
    const curPrice = p ? p.price : null;
    const pnlTotal = curPrice ? (curPrice - avg) * qty * 1000 : null;
    const pct = curPrice ? (curPrice - avg) / avg * 100 : null;
    const costTotal = avg * qty * 1000;
    if (pnlTotal !== null) totalPnl += pnlTotal;
    totalCost += costTotal;
    let line = g.code + " " + g.name + "　持股：" + qty + " 張\n";
    line += "  均價：" + avg.toFixed(2) + "　成本：" + Math.round(costTotal).toLocaleString() + " 元\n";
    g.buys.forEach(function(b, i) { line += "  " + (i+1) + ". " + b.date + " " + b.price.toFixed(2) + "\n"; });
    if (g.sells.length > 0) line += "  已賣出：" + g.sells.length + " 張\n";
    if (curPrice !== null) {
      line += "  現價：" + curPrice + " " + (pct >= 0 ? "▲" : "▼") + Math.abs(pct).toFixed(2) + "%\n";
      line += "  未實現損益：" + (pnlTotal >= 0 ? "+" : "") + Math.round(pnlTotal).toLocaleString() + " 元";
    } else { line += "  現價：查詢中..."; }
    return line;
  });
  const d = "═".repeat(20);
  return lines.join("\n\n") + "\n\n" + d +
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
    return g.code + " " + g.name + " " + (pnl >= 0 ? "獲利" : "虧損") + "　共 " + qty + " 張\n" +
      "  均買：" + avgBuy.toFixed(2) + "　均賣：" + avgSell.toFixed(2) + "\n" +
      "  已實現損益：" + (pnl >= 0 ? "+" : "") + Math.round(pnl).toLocaleString() + " 元 (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
  });
  const d = "═".repeat(20);
  return "已結算\n" + d + "\n" + lines.join("\n\n") + "\n\n" + d +
    "\n合計：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

module.exports = { addBuy, addSell, cancelEntry, adjustPrice, getHoldingSummary, getSettledSummary, portfolio, CODE_NAMES };
