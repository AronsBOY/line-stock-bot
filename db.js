const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("[DB] 未設定 DATABASE_URL，資料庫功能將無法運作");
}

// Railway 內網 Postgres 連線通常不需要 SSL。
// 如果你的連線字串是走外部 proxy 網址，或連線失敗顯示 SSL 相關錯誤，
// 在 Railway 環境變數加上 PGSSL=true 即可切換成需要 SSL 的模式。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

pool.on("error", function (err) {
  console.error("[DB] 連線池發生未預期錯誤：", err.message);
});

module.exports = pool;
