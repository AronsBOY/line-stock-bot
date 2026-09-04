const pool = require("./db");

function rowToPending(r) {
  return {
    code: r.code,
    action: r.action,
    date: r.signal_date,
    time: r.signal_time,
    price: r.price !== null ? parseFloat(r.price) : null,
    suggestedPrice: r.suggested_price,
    original: r.original,
    group: r.group_tag,
  };
}

async function setPending(code, data) {
  await pool.query(
    `INSERT INTO pending_signals (code, action, signal_date, signal_time, price, suggested_price, original, group_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (code) DO UPDATE SET
       action = EXCLUDED.action,
       signal_date = EXCLUDED.signal_date,
       signal_time = EXCLUDED.signal_time,
       price = EXCLUDED.price,
       suggested_price = EXCLUDED.suggested_price,
       original = EXCLUDED.original,
       group_tag = EXCLUDED.group_tag,
       created_at = now()`,
    [code, data.action, data.date, data.time, data.price, data.suggestedPrice || null, data.original || null, data.group || null]
  );
}

async function getPending(code) {
  const { rows } = await pool.query(
    `SELECT code, action, to_char(signal_date, 'YYYY-MM-DD') AS signal_date, signal_time, price, suggested_price, original, group_tag
     FROM pending_signals WHERE code=$1`,
    [code]
  );
  if (!rows.length) return null;
  return rowToPending(rows[0]);
}

async function getAllPending() {
  const { rows } = await pool.query(
    `SELECT code, action, to_char(signal_date, 'YYYY-MM-DD') AS signal_date, signal_time, price, suggested_price, original, group_tag
     FROM pending_signals ORDER BY created_at`
  );
  return rows.map(rowToPending);
}

async function deletePending(code) {
  await pool.query(`DELETE FROM pending_signals WHERE code=$1`, [code]);
}

function detectGroup(text) {
  // 從訊息原文自動判斷是「進階組」還是「基本組」
  if (text.includes("進階組")) return "進階組";
  if (text.includes("基本組")) return "基本組";
  return null;
}

module.exports = { setPending, getPending, getAllPending, deletePending, detectGroup };
