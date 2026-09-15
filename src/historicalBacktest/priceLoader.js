const { fetchHistoricalPrice } = require('../stockPrice');
const config = require('./config');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function attachClosePrices(signals) {
  const cache = {};
  const out = [];

  for (const row of signals) {
    if (!row.stock_code || !row.date || !['買入', '賣出'].includes(row.action)) {
      out.push(Object.assign({}, row));
      continue;
    }

    const key = row.stock_code + '|' + row.date;
    let p = cache[key];
    if (p === undefined) {
      try {
        // time=null：統一使用該交易日收盤價，避免把盤中訊號時間混進回測。
        p = await fetchHistoricalPrice(row.stock_code, row.date, null);
      } catch (err) {
        p = null;
      }
      cache[key] = p || null;
      await sleep(config.priceRequestDelayMs);
    }

    out.push(Object.assign({}, row, {
      execution_price: p && p.price != null ? Number(p.price) : null,
      execution_price_type: '收盤價',
      price_status: p && p.price != null ? 'OK' : 'MISSING',
    }));
  }

  return out;
}

module.exports = { attachClosePrices };
