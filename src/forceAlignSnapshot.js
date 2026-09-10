const pool = require("./db");
const snapshot = require("./holdings.json");

async function forceAlignToSnapshot(portfolio) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sells");
    await client.query("DELETE FROM buys");

    let buyRows = 0;
    const codes = Object.keys(snapshot.holdings || {});

    for (const code of codes) {
      const item = snapshot.holdings[code];
      await client.query(
        `INSERT INTO code_names (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
        [code, item.name]
      );

      for (const e of item.entries || []) {
        const qty = Number(e.shares || 0) / 1000;
        await client.query(
          `INSERT INTO buys
           (code, name, trade_date, price, signal_time, note, group_tag, suggested_price, source, price_type, qty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            code,
            item.name,
            e.date,
            Number(e.price),
            e.time && e.time !== "無" ? e.time : null,
            "2026-09-10 使用者指定持股快照強制對齊",
            null,
            e.priceRange && e.priceRange !== "無" ? e.priceRange : null,
            "snapshot",
            e.priceType || null,
            qty,
          ]
        );
        buyRows += 1;
      }
    }

    await client.query("COMMIT");
    await portfolio.loadNameCache();

    return {
      stockCount: codes.length,
      buyRows,
      totalShares: codes.reduce(function (sum, code) {
        return sum + (snapshot.holdings[code].entries || []).reduce(function (s, e) {
          return s + Number(e.shares || 0);
        }, 0);
      }, 0),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { forceAlignToSnapshot };
