const pool = require("./db");

// 股票代號↔名稱的記憶體快取，啟動時從 DB 載入一次，
// 之後 setName() 會同步寫入 DB 又更新快取，避免每次查名稱都打 DB。
let nameCache = {};

async function loadNameCache() {
  const { rows } = await pool.query("SELECT code, name FROM code_names");
  nameCache = {};
  rows.forEach(function (r) { nameCache[r.code] = r.name; });
  console.log("[Portfolio] 已載入 " + rows.length + " 個股票名稱");
  return nameCache;
}

function getName(code) {
  return nameCache[code] || null;
}

async function setName(code, name) {
  await pool.query(
    `INSERT INTO code_names (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
    [code, name]
  );
  nameCache[code] = name;
  await pool.query(`UPDATE buys SET name = $2 WHERE code = $1`, [code, name]);
  await pool.query(`UPDATE sells SET name = $2 WHERE code = $1`, [code, name]);
  return "已設定 " + code + " 名稱為「" + name + "」（已永久保存）";
}

async function addBuy(code, name, date, price, signalTime, note, groupTag) {
  const n = getName(code) || name || code;
  await pool.query(
    `INSERT INTO buys (code, name, trade_date, price, signal_time, note, group_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, n, date, parseFloat(price), signalTime || null, note || null, groupTag || null]
  );
}

async function addSell(code, name, date, price, signalTime, note, groupTag) {
  const n = getName(code) || name || code;
  await pool.query(
    `INSERT INTO sells (code, name, trade_date, price, signal_time, note, group_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, n, date, parseFloat(price), signalTime || null, note || null, groupTag || null]
  );
}

async function findExisting(code, date) {
  // 用來檢查歷史回補時，是否已經有同代號同日期的紀錄（避免跟舊資料重複）
  const b = await pool.query(`SELECT id, price FROM buys WHERE code=$1 AND trade_date=$2`, [code, date]);
  const s = await pool.query(`SELECT id, price FROM sells WHERE code=$1 AND trade_date=$2`, [code, date]);
  return { buys: b.rows, sells: s.rows };
}

async function cancelEntry(code, date) {
  const b = await pool.query(
    `DELETE FROM buys WHERE id = (SELECT id FROM buys WHERE code=$1 AND trade_date=$2 LIMIT 1) RETURNING id`,
    [code, date]
  );
  if (b.rowCount > 0) return "已取消買入 " + code + " " + date;
  const s = await pool.query(
    `DELETE FROM sells WHERE id = (SELECT id FROM sells WHERE code=$1 AND trade_date=$2 LIMIT 1) RETURNING id`,
    [code, date]
  );
  if (s.rowCount > 0) return "已取消賣出 " + code + " " + date;
  return "找不到 " + code + " " + date + " 的記錄";
}

async function adjustPrice(code, date, newPrice) {
  const b = await pool.query(
    `UPDATE buys SET price=$3 WHERE id = (SELECT id FROM buys WHERE code=$1 AND trade_date=$2 LIMIT 1) RETURNING id`,
    [code, date, parseFloat(newPrice)]
  );
  if (b.rowCount > 0) return "已調整 " + code + " " + date + " 買入價為 " + newPrice;
  const s = await pool.query(
    `UPDATE sells SET price=$3 WHERE id = (SELECT id FROM sells WHERE code=$1 AND trade_date=$2 LIMIT 1) RETURNING id`,
    [code, date, parseFloat(newPrice)]
  );
  if (s.rowCount > 0) return "已調整 " + code + " " + date + " 賣出價為 " + newPrice;
  return "找不到 " + code + " " + date + " 的記錄";
}

async function getBackup() {
  const buys = (await pool.query(
    `SELECT code, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price FROM buys ORDER BY id`
  )).rows;
  const sells = (await pool.query(
    `SELECT code, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price FROM sells ORDER BY id`
  )).rows;
  const now = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  let txt = "=== 持股備份 " + now + " ===\n\n【買入記錄】\n";
  buys.forEach(function (b) { txt += "新增 " + b.code + " " + b.trade_date + " " + b.price + "\n"; });
  txt += "\n【賣出記錄】\n";
  sells.forEach(function (s) { txt += "賣出 " + s.code + " " + s.trade_date + " " + s.price + " 1\n"; });
  txt += "\n=== 備份結束 ===";
  return txt;
}

async function getRemaining(code) {
  const holdRes = await pool.query(`SELECT COUNT(*)::int AS n FROM buys WHERE code=$1`, [code]);
  const soldRes = await pool.query(`SELECT COUNT(*)::int AS n FROM sells WHERE code=$1`, [code]);
  const holdCount = holdRes.rows[0].n;
  const soldCount = soldRes.rows[0].n;
  return { holdCount: holdCount, soldCount: soldCount, remaining: holdCount - soldCount };
}

async function getHeldCodes() {
  const { rows } = await pool.query(`
    SELECT b.code FROM buys b
    GROUP BY b.code
    HAVING COUNT(*) > (SELECT COUNT(*) FROM sells s WHERE s.code = b.code)
  `);
  return rows.map(function (r) { return r.code; });
}

async function getGroups() {
  const buys = (await pool.query(
    `SELECT code, name, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note FROM buys ORDER BY trade_date, id`
  )).rows;
  const sells = (await pool.query(
    `SELECT code, name, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note FROM sells ORDER BY trade_date, id`
  )).rows;
  const g = {};
  buys.forEach(function (b) {
    if (!g[b.code]) g[b.code] = { code: b.code, name: getName(b.code) || b.name, buys: [], sells: [] };
    g[b.code].buys.push({ date: b.trade_date, price: parseFloat(b.price), time: b.signal_time, note: b.note });
  });
  sells.forEach(function (s) {
    if (!g[s.code]) g[s.code] = { code: s.code, name: getName(s.code) || s.name, buys: [], sells: [] };
    g[s.code].sells.push({ date: s.trade_date, price: parseFloat(s.price), time: s.signal_time, note: s.note });
  });
  return Object.values(g);
}

function fmtEntryLine(e, i) {
  const timePart = e.time ? " " + e.time : "";
  let line = "  " + (i + 1) + ". " + e.date + timePart + " " + e.price.toFixed(2);
  if (e.note) line += "\n     備註：" + e.note;
  return line;
}

async function getHoldingSummary(livePrices) {
  const groups = await getGroups();
  const holding = groups.filter(function (g) { return g.buys.length > g.sells.length; });
  if (!holding.length) return "目前無持倉";
  let totalPnl = 0, totalCost = 0;
  const lines = holding.map(function (g) {
    const qty = g.buys.length - g.sells.length;
    const avg = g.buys.reduce(function (a, b) { return a + b.price; }, 0) / g.buys.length;
    const p = livePrices && livePrices[g.code];
    const curPrice = p ? p.price : null;
    const pnlTotal = curPrice ? (curPrice - avg) * qty * 1000 : null;
    const pct = curPrice ? (curPrice - avg) / avg * 100 : null;
    const costTotal = avg * qty * 1000;
    if (pnlTotal !== null) totalPnl += pnlTotal;
    totalCost += costTotal;
    const name = getName(g.code) || g.name;
    let line = g.code + " " + name + "　持股：" + qty + " 張\n";
    line += "  均價：" + avg.toFixed(2) + "　成本：" + Math.round(costTotal).toLocaleString() + " 元\n";
    g.buys.forEach(function (b, i) { line += fmtEntryLine(b, i) + "\n"; });
    if (g.sells.length > 0) line += "  已賣出：" + g.sells.length + " 張\n";
    if (curPrice !== null) {
      line += "  現價：" + curPrice + " " + (pct >= 0 ? "▲" : "▼") + Math.abs(pct).toFixed(2) + "%\n";
      line += "  未實現損益：" + (pnlTotal >= 0 ? "+" : "") + Math.round(pnlTotal).toLocaleString() + " 元";
    } else {
      line += "  現價：查詢中...";
    }
    return line;
  });
  const d = "═".repeat(20);
  return lines.join("\n\n") + "\n\n" + d +
    "\n總持股：" + holding.length + " 支" +
    "\n總成本：" + Math.round(totalCost).toLocaleString() + " 元" +
    "\n總未實現損益：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

async function getSettledSummary() {
  const groups = await getGroups();
  const settled = groups.filter(function (g) { return g.buys.length > 0 && g.sells.length >= g.buys.length; });
  if (!settled.length) return "尚無已結算股票";
  let totalPnl = 0;
  const lines = settled.map(function (g) {
    const qty = g.buys.length;
    const avgBuy = g.buys.reduce(function (a, b) { return a + b.price; }, 0) / qty;
    const avgSell = g.sells.slice(0, qty).reduce(function (a, b) { return a + b.price; }, 0) / qty;
    const pnl = (avgSell - avgBuy) * qty * 1000;
    const pct = (avgSell - avgBuy) / avgBuy * 100;
    totalPnl += pnl;
    const name = getName(g.code) || g.name;
    return g.code + " " + name + " " + (pnl >= 0 ? "獲利" : "虧損") + "　共 " + qty + " 張\n" +
      "  均買：" + avgBuy.toFixed(2) + "　均賣：" + avgSell.toFixed(2) + "\n" +
      "  已實現損益：" + (pnl >= 0 ? "+" : "") + Math.round(pnl).toLocaleString() + " 元 (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
  });
  const d = "═".repeat(20);
  return "已結算\n" + d + "\n" + lines.join("\n\n") + "\n\n" + d +
    "\n合計：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

async function getSettledSummarySplit() {
  const groups = await getGroups();
  const settled = groups.filter(function (g) { return g.buys.length > 0 && g.sells.length >= g.buys.length; });
  if (!settled.length) return { profit: [], loss: [], profitText: "尚無獲利標的", lossText: "尚無虧損標的", totalPnl: 0 };

  const profitGroups = [], lossGroups = [];
  settled.forEach(function (g) {
    const qty = g.buys.length;
    const avgBuy = g.buys.reduce(function (a, b) { return a + b.price; }, 0) / qty;
    const avgSell = g.sells.slice(0, qty).reduce(function (a, b) { return a + b.price; }, 0) / qty;
    const pnl = (avgSell - avgBuy) * qty * 1000;
    const pct = (avgSell - avgBuy) / avgBuy * 100;
    const item = { g, qty, avgBuy, avgSell, pnl, pct };
    if (pnl >= 0) profitGroups.push(item); else lossGroups.push(item);
  });
  profitGroups.sort(function (a, b) { return b.pnl - a.pnl; });
  lossGroups.sort(function (a, b) { return a.pnl - b.pnl; });

  function renderGroup(item) {
    const name = getName(item.g.code) || item.g.name;
    let block = item.g.code + " " + name + "　共 " + item.qty + " 張\n" +
      "  均買：" + item.avgBuy.toFixed(2) + "　均賣：" + item.avgSell.toFixed(2) + "\n" +
      "  損益：" + (item.pnl >= 0 ? "+" : "") + Math.round(item.pnl).toLocaleString() + " 元 (" + (item.pct >= 0 ? "+" : "") + item.pct.toFixed(2) + "%)\n";
    block += "  買入明細：\n";
    item.g.buys.forEach(function (b, i) { block += fmtEntryLine(b, i) + "\n"; });
    block += "  賣出明細：\n";
    item.g.sells.forEach(function (s, i) { block += fmtEntryLine(s, i) + "\n"; });
    return block.trim();
  }

  const totalPnl = profitGroups.reduce(function (a, x) { return a + x.pnl; }, 0) +
                    lossGroups.reduce(function (a, x) { return a + x.pnl; }, 0);
  const d = "═".repeat(20);

  const profitText = profitGroups.length
    ? "💰 獲利標的（" + profitGroups.length + " 檔）\n" + d + "\n" + profitGroups.map(renderGroup).join("\n\n")
    : "尚無獲利標的";
  const lossText = lossGroups.length
    ? "📉 虧損標的（" + lossGroups.length + " 檔）\n" + d + "\n" + lossGroups.map(renderGroup).join("\n\n")
    : "尚無虧損標的";

  return { profit: profitGroups, loss: lossGroups, profitText, lossText, totalPnl };
}

async function getTransactionList(code, groupFilter) {
  const buys = (await pool.query(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag FROM buys WHERE code=$1 ORDER BY trade_date, id`,
    [code]
  )).rows;
  const sells = (await pool.query(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag FROM sells WHERE code=$1 ORDER BY trade_date, id`,
    [code]
  )).rows;
  let all = [];
  buys.forEach(function (b) {
    all.push({ type: "買", date: b.trade_date, price: parseFloat(b.price), time: b.signal_time, note: b.note, group: b.group_tag });
  });
  sells.forEach(function (s) {
    all.push({ type: "賣", date: s.trade_date, price: parseFloat(s.price), time: s.signal_time, note: s.note, group: s.group_tag });
  });
  if (groupFilter) all = all.filter(function (e) { return e.group === groupFilter; });
  all.sort(function (a, b) { return (a.date + (a.time||"")).localeCompare(b.date + (b.time||"")); });
  return all;
}

function formatTransactionList(code, name, entries) {
  if (!entries.length) return code + " " + (name || "") + " 目前沒有任何交易紀錄";
  let txt = code + " " + (name || "") + " 交易明細（共 " + entries.length + " 筆）\n" + "─".repeat(20) + "\n";
  entries.forEach(function (e, i) {
    const groupLabel = e.group ? "【" + e.group + "】" : "";
    const timePart = e.time ? " " + e.time : "";
    txt += (i + 1) + ". [" + e.type + "] " + e.date + timePart + " " + e.price.toFixed(2) + groupLabel + "\n";
    if (e.note) txt += "   備註：" + e.note + "\n";
  });
  return txt.trim();
}

module.exports = {
  loadNameCache, getName, setName,
  addBuy, addSell, findExisting, cancelEntry, adjustPrice,
  getBackup, getRemaining, getHeldCodes,
  getHoldingSummary, getSettledSummary, getSettledSummarySplit,
  getTransactionList, formatTransactionList,
};
