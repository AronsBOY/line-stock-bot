const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id SERIAL PRIMARY KEY,
        stock_code VARCHAR(10) NOT NULL,
        stock_name VARCHAR(50),
        buy_price DECIMAL(10,2) NOT NULL,
        buy_date VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("資料庫初始化完成");
  } catch (err) {
    console.error("資料庫初始化失敗:", err.message);
  }
}

async function addBuy(stockCode, stockName, buyPrice, buyDate) {
  await pool.query(
    "INSERT INTO portfolio (stock_code, stock_name, buy_price, buy_date) VALUES ($1, $2, $3, $4)",
    [stockCode, stockName || stockCode, buyPrice, buyDate]
  );
}

async function getPortfolio() {
  const result = await pool.query(`
    SELECT stock_code, stock_name,
      COUNT(*) as buy_count,
      ROUND(AVG(buy_price)::numeric, 2) as avg_price,
      MIN(buy_price) as min_price,
      MAX(buy_price) as max_price,
      MIN(buy_date) as first_date,
      MAX(buy_date) as last_date
    FROM portfolio
    GROUP BY stock_code, stock_name
    ORDER BY stock_code
  `);
  return result.rows;
}

async function getStockDetail(stockCode) {
  const result = await pool.query(
    "SELECT * FROM portfolio WHERE stock_code = $1 ORDER BY created_at ASC",
    [stockCode]
  );
  return result.rows;
}

async function clearStock(stockCode) {
  const result = await pool.query(
    "DELETE FROM portfolio WHERE stock_code = $1",
    [stockCode]
  );
  return result.rowCount;
}

async function clearAll() {
  await pool.query("DELETE FROM portfolio");
}

module.exports = { initDB, addBuy, getPortfolio, getStockDetail, clearStock, clearAll };
