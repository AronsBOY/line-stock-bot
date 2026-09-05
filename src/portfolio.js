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

async function addBuy(code, name, date, price, signalTime, note, groupTag, suggestedPrice, source, priceType, qty) {
  const n = getName(code) || name || code;
  await pool.query(
    `INSERT INTO buys (code, name, trade_date, price, signal_time, note, group_tag, suggested_price, source, price_type, qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [code, n, date, parseFloat(price), signalTime || null, note || null, groupTag || null, suggestedPrice || null, source || "manual", priceType || null, qty != null ? qty : 1]
  );
}

async function addSell(code, name, date, price, signalTime, note, groupTag, suggestedPrice, source, priceType, qty) {
  const n = getName(code) || name || code;
  await pool.query(
    `INSERT INTO sells (code, name, trade_date, price, signal_time, note, group_tag, suggested_price, source, price_type, qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [code, n, date, parseFloat(price), signalTime || null, note || null, groupTag || null, suggestedPrice || null, source || "manual", priceType || null, qty != null ? qty : 1]
  );
}

async function deleteBySource(source) {
  const b = await pool.query(`DELETE FROM buys WHERE source=$1`, [source]);
  const s = await pool.query(`DELETE FROM sells WHERE source=$1`, [source]);
  return { buys: b.rowCount, sells: s.rowCount };
}

// 專門清「source欄位還沒存在以前」就寫進去、被誤標成manual的舊回補資料
// 判斷依據：這種資料一定有signal_time（真正手動打指令的紀錄，這欄永遠是空的）
async function deleteLegacyBackfill() {
  const b = await pool.query(`DELETE FROM buys WHERE source='backfill' OR (source='manual' AND signal_time IS NOT NULL)`);
  const s = await pool.query(`DELETE FROM sells WHERE source='backfill' OR (source='manual' AND signal_time IS NOT NULL)`);
  return { buys: b.rowCount, sells: s.rowCount };
}

async function deleteLegacyBackfill() {
  // 抓「有時間戳記+有備註」的資料——這是訊號來源（回補/即時確認）才會有的特徵，
  // 手動打「買/賣」指令絕對不會附這兩個欄位，用這個判斷比 source 欄位更可靠，
  // 因為舊版程式碼寫入的資料在新增 source 欄位時，已經被自動貼上跟手動輸入一樣的預設值。
  const b = await pool.query(`DELETE FROM buys WHERE source='backfill' OR (signal_time IS NOT NULL AND note IS NOT NULL)`);
  const s = await pool.query(`DELETE FROM sells WHERE source='backfill' OR (signal_time IS NOT NULL AND note IS NOT NULL)`);
  return { buys: b.rowCount, sells: s.rowCount };
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
  const holdRes = await pool.query(`SELECT COALESCE(SUM(qty),0)::float AS n FROM buys WHERE code=$1`, [code]);
  const soldRes = await pool.query(`SELECT COALESCE(SUM(qty),0)::float AS n FROM sells WHERE code=$1`, [code]);
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
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag, qty FROM buys WHERE code=$1 ORDER BY trade_date, id`,
    [code]
  )).rows;
  const sells = (await pool.query(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag, qty FROM sells WHERE code=$1 ORDER BY trade_date, id`,
    [code]
  )).rows;
  let all = [];
  buys.forEach(function (b) {
    all.push({ type: "買", date: b.trade_date, price: parseFloat(b.price), time: b.signal_time, note: b.note, group: b.group_tag, qty: parseFloat(b.qty) });
  });
  sells.forEach(function (s) {
    all.push({ type: "賣", date: s.trade_date, price: parseFloat(s.price), time: s.signal_time, note: s.note, group: s.group_tag, qty: parseFloat(s.qty) });
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
    txt += (i + 1) + ". [" + e.type + "] " + e.date + timePart + " " + e.price.toFixed(2) + "【數量】" + round2(e.qty) + "張" + groupLabel + "\n";
    if (e.note) txt += "   備註：" + e.note + "\n";
  });
  return txt.trim();
}

// ══════════════════════════════════════════
// 輪次邏輯：把每檔股票的買賣紀錄，依時間順序切成一輪一輪
// 持股歸零＝一輪結束（已結算），歸零後的新買入＝開新的一輪（可能還在持股中）
// ══════════════════════════════════════════

async function getAllRawEvents() {
  const buys = (await pool.query(
    `SELECT code, name, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag, suggested_price, price_type, qty, id
     FROM buys ORDER BY trade_date, signal_time NULLS FIRST, id`
  )).rows;
  const sells = (await pool.query(
    `SELECT code, name, to_char(trade_date, 'YYYY-MM-DD') AS trade_date, price, signal_time, note, group_tag, suggested_price, price_type, qty, id
     FROM sells ORDER BY trade_date, signal_time NULLS FIRST, id`
  )).rows;
  const byCode = {};
  function ensure(code) { if (!byCode[code]) byCode[code] = { buys: [], sells: [] }; return byCode[code]; }
  buys.forEach(function (b) {
    ensure(b.code).buys.push({
      type: "買", date: b.trade_date, time: b.signal_time, price: parseFloat(b.price),
      note: b.note, group: b.group_tag, suggestedPrice: b.suggested_price, priceType: b.price_type,
      qty: parseFloat(b.qty), id: b.id,
    });
  });
  sells.forEach(function (s) {
    ensure(s.code).sells.push({
      type: "賣", date: s.trade_date, time: s.signal_time, price: parseFloat(s.price),
      note: s.note, group: s.group_tag, suggestedPrice: s.suggested_price, priceType: s.price_type,
      qty: parseFloat(s.qty), id: s.id,
    });
  });
  return byCode;
}

function sortKey(e) {
  return e.date + " " + (e.time || "00:00") + " " + String(e.id).padStart(8, "0");
}

// 把單一股票的買賣事件切成輪次；回傳 { closedEpisodes: [...], openEpisode: {...}|null, orphanSells: [...] }
function buildEpisodes(rawEvents) {
  const events = rawEvents.buys.concat(rawEvents.sells);
  events.sort(function (a, b) { return sortKey(a) < sortKey(b) ? -1 : 1; });

  const closedEpisodes = [];
  const orphanSells = [];
  let current = null;
  const EPS = 0.0001; // 浮點數誤差容許值，避免1.5-1.5算出來是0.00000001而永遠關不了輪

  events.forEach(function (e) {
    if (e.type === "買") {
      if (!current) current = { entries: [], qty: 0 };
      current.entries.push(e);
      current.qty += e.qty;
    } else {
      if (!current || current.qty <= EPS) {
        orphanSells.push(e); // 沒有對應持股的賣出訊號，資料異常，不算進任何一輪
        return;
      }
      current.entries.push(e);
      current.qty -= e.qty;
      if (current.qty <= EPS) {
        current.qty = Math.max(0, current.qty); // 清掉浮點誤差留下的極小負數
        closedEpisodes.push(current);
        current = null;
      }
    }
  });

  return { closedEpisodes: closedEpisodes, openEpisode: current, orphanSells: orphanSells };
}

async function getAllEpisodes() {
  const byCode = await getAllRawEvents();
  const result = {}; // code -> { closedEpisodes, openEpisode, orphanSells }
  for (const code in byCode) {
    result[code] = buildEpisodes(byCode[code]);
  }
  return result;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function weightedAvg(entries) {
  const totalQty = entries.reduce(function (a, e) { return a + e.qty; }, 0);
  if (totalQty <= 0) return 0;
  const totalCost = entries.reduce(function (a, e) { return a + e.price * e.qty; }, 0);
  return totalCost / totalQty;
}

function episodeStats(entries) {
  const buys = entries.filter(function (e) { return e.type === "買"; });
  const sells = entries.filter(function (e) { return e.type === "賣"; });
  const buyQty = buys.reduce(function (a, e) { return a + e.qty; }, 0);
  const sellQty = sells.reduce(function (a, e) { return a + e.qty; }, 0);
  const avgBuy = weightedAvg(buys);
  const avgSell = weightedAvg(sells);
  return { buys, sells, avgBuy, avgSell, buyQty, sellQty };
}

// 統一極簡格式：不帶時間、不帶備註、不帶組別，只留日期/指令區間價位/實際價位（標明時價或收盤價）/實際數量
function fmtEntryMinimal(e, i) {
  const priceRange = e.suggestedPrice || "-";
  const priceType = e.priceType || "收盤價"; // 舊資料沒有這欄位時，預設當作收盤價
  const qtyStr = round2(e.qty) + "張";
  return "  " + (i + 1) + ". [" + e.type + "] " + e.date + "【指令】" + priceRange + "【" + priceType + "】" + e.price.toFixed(2) + "【數量】" + qtyStr;
}

function todayTW() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

async function getHoldingSummaryByEpisode(allEpisodesInput, livePrices) {
  const allEpisodes = allEpisodesInput || (await getAllEpisodes());
  const codesWithOpen = Object.keys(allEpisodes).filter(function (c) { return allEpisodes[c].openEpisode; });
  if (!codesWithOpen.length) return "【持股庫存】（" + todayTW() + "）\n目前無持倉";

  let totalPnl = 0, totalCost = 0;
  const blocks = codesWithOpen.map(function (code) {
    const ep = allEpisodes[code].openEpisode;
    const stats = episodeStats(ep.entries);
    const qty = round2(ep.qty);
    const p = livePrices && livePrices[code];
    const curPrice = p ? p.price : null;
    const costTotal = stats.avgBuy * qty * 1000;
    const pnlTotal = curPrice !== null ? (curPrice - stats.avgBuy) * qty * 1000 : null;
    if (pnlTotal !== null) totalPnl += pnlTotal;
    totalCost += costTotal;
    const name = getName(code) || (ep.entries[0] && ep.entries[0].name) || code;
    let block = code + " " + name + "　買入次數：" + stats.buys.length + "　均價：" + stats.avgBuy.toFixed(2) + "　持股：" + qty + " 張　成本：" + Math.round(costTotal).toLocaleString() + " 元\n";
    ep.entries.forEach(function (e, i) { block += fmtEntryMinimal(e, i) + "\n"; });
    if (curPrice !== null) {
      const pct = (curPrice - stats.avgBuy) / stats.avgBuy * 100;
      block += "  現價：" + curPrice + " " + (pct >= 0 ? "▲" : "▼") + Math.abs(pct).toFixed(2) + "%\n";
      block += "  未實現損益：" + (pnlTotal >= 0 ? "+" : "") + Math.round(pnlTotal).toLocaleString() + " 元";
    } else {
      block += "  現價：查詢中...";
    }
    if (allEpisodes[code].closedEpisodes.length > 0) {
      block += "\n  （此檔另有 " + allEpisodes[code].closedEpisodes.length + " 輪已結算，見「結算」）";
    }
    return block.trim();
  });

  const d = "═".repeat(20);
  return "【持股庫存】（" + todayTW() + "）\n" + d + "\n" + blocks.join("\n\n") + "\n\n" + d +
    "\n總持股：" + codesWithOpen.length + " 支" +
    "\n總成本：" + Math.round(totalCost).toLocaleString() + " 元" +
    "\n總未實現損益：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
}

async function getSettledSummaryByEpisode(allEpisodesInput) {
  const allEpisodes = allEpisodesInput || (await getAllEpisodes());
  const profitBlocks = [], lossBlocks = [];
  let totalPnl = 0;
  let orphanCount = 0;

  for (const code in allEpisodes) {
    const info = allEpisodes[code];
    orphanCount += info.orphanSells.length;
    info.closedEpisodes.forEach(function (ep, idx) {
      const stats = episodeStats(ep.entries);
      const qty = round2(stats.buyQty);
      const pnl = (stats.avgSell - stats.avgBuy) * qty * 1000;
      const pct = stats.avgBuy ? (stats.avgSell - stats.avgBuy) / stats.avgBuy * 100 : 0;
      totalPnl += pnl;
      const name = getName(code) || (ep.entries[0] && ep.entries[0].name) || code;
      const roundLabel = info.closedEpisodes.length > 1 ? "　第" + (idx + 1) + "輪" : "";
      let block = code + " " + name + roundLabel + "　數量：" + qty + " 張\n";
      ep.entries.forEach(function (e, i) { block += fmtEntryMinimal(e, i) + "\n"; });
      block += "  均買：" + stats.avgBuy.toFixed(2) + "　－　均賣：" + stats.avgSell.toFixed(2) +
        "　＝　" + (pct >= 0 ? "贏 " : "輸 ") + Math.abs(pct).toFixed(2) + "%，" +
        (pnl >= 0 ? "贏 +" : "輸 ") + Math.round(pnl).toLocaleString() + " 元";
      if (pnl >= 0) profitBlocks.push({ block, pnl }); else lossBlocks.push({ block, pnl });
    });
  }
  profitBlocks.sort(function (a, b) { return b.pnl - a.pnl; });
  lossBlocks.sort(function (a, b) { return a.pnl - b.pnl; });

  const d = "═".repeat(20);
  const profitText = profitBlocks.length
    ? "【已結算】贏（" + profitBlocks.length + " 輪）\n" + d + "\n" + profitBlocks.map(function (x) { return x.block; }).join("\n\n")
    : "【已結算】贏\n尚無獲利紀錄";
  const lossText = lossBlocks.length
    ? "【已結算】輸（" + lossBlocks.length + " 輪）\n" + d + "\n" + lossBlocks.map(function (x) { return x.block; }).join("\n\n")
    : "【已結算】輸\n尚無虧損紀錄";
  let footer = "\n總已實現損益：" + (totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString() + " 元";
  if (orphanCount > 0) footer += "\n⚠ 有 " + orphanCount + " 筆賣出訊號查無對應持股（可能是資料異常），未計入結算，可用「明細 代號」查看";
  return { profitText, lossText, totalPnl, footer };
}

// 強制對齊持股：只保留指定代號清單，其他有持股的一律用「現在的即時股價」強制賣光結清
// 這是管理員手動校正用的，不是真實訊號，會清楚標註來源
async function forceAlignHoldings(keepCodes, fetchLivePriceFn) {
  const allEpisodes = await getAllEpisodes();
  const closed = [];
  const failed = [];
  for (const code in allEpisodes) {
    if (keepCodes.includes(code)) continue;
    const ep = allEpisodes[code].openEpisode;
    if (!ep || ep.qty <= 0) continue;
    try {
      const p = await fetchLivePriceFn(code);
      if (!p) { failed.push(code); continue; }
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
      await addSell(code, getName(code) || code, today, p.price, null, "系統校正：使用者確認實際已無持股", null, null, "correction", p.priceType || null, ep.qty);
      closed.push({ code, qty: ep.qty, price: p.price });
    } catch (err) {
      failed.push(code);
    }
  }
  return { closed, failed };
}

module.exports = {
  loadNameCache, getName, setName,
  addBuy, addSell, findExisting, cancelEntry, adjustPrice, deleteBySource, deleteLegacyBackfill,
  getBackup, getRemaining, getHeldCodes,
  getHoldingSummary, getSettledSummary, getSettledSummarySplit,
  getTransactionList, formatTransactionList,
  getAllEpisodes, getHoldingSummaryByEpisode, getSettledSummaryByEpisode,
  forceAlignHoldings,
};
