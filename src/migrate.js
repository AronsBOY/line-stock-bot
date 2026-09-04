require("dotenv").config();
const pool = require("./db");

// 這是你原本寫死在 portfolio.js 裡的資料，
// 只在資料庫是空的（第一次部署）時會被匯入一次，之後不會重複匯入。
const CODE_NAMES_SEED = {
  "2327": "國巨", "2351": "順德", "3037": "欣興", "3167": "大量",
  "3211": "順達", "3533": "嘉澤", "3535": "晶彩科", "3715": "定穎",
  "4749": "新應材", "4760": "勤凱", "4966": "譜瑞KY", "4971": "IET-KY",
  "4989": "榮科", "5475": "德宏", "6261": "久元", "6415": "矽力KY",
  "6739": "竹陞科技", "6805": "富世達", "7734": "印能", "8227": "巨有",
  "1560": "中砂", "1802": "玻玻", "2368": "金像電", "3450": "聯鈞",
  "3563": "牧德", "3665": "貿聯KY",
};

// 從 269 則歷史訊號原文裡自動抓出的股票中文名（回補歷史時很多股票沒有中文名，用這批補上）
// 只在 code_names 表裡「該代號還沒有名稱」時才會寫入，不會覆蓋掉你手動用「名稱」指令設定過的
const EXTRA_CODE_NAMES = {"1560":"中砂", "1802":"玻玻", "2303":"聯電", "2327":"國巨", "2344":"華邦電", "2351":"順德", "2360":"致茂", "2368":"金像電", "2426":"鼎元", "2441":"超豐", "3017":"奇鋐", "3037":"欣興", "3081":"聯亞", "3167":"大量", "3189":"景碩", "3211":"順達", "3264":"欣銓", "3324":"雙鴻", "3374":"精材", "3443":"創意", "3450":"聯鈞", "3532":"台勝科", "3533":"嘉澤", "3535":"晶彩科", "3563":"牧德", "3653":"健策", "3665":"貿聯KY", "3715":"定穎", "4722":"國精化", "4749":"新應材", "4760":"勤凱", "4931":"新盛力", "4966":"譜瑞KY", "4971":"IET-KY", "4989":"榮科", "4991":"環宇", "5284":"JPP", "5347":"世界", "5439":"高技", "5475":"德宏", "6173":"信昌電", "6187":"萬潤", "6213":"聯茂", "6239":"力成", "6257":"矽格", "6261":"久元", "6285":"啟碁", "6415":"矽力KY", "6531":"愛普", "6640":"均華", "6739":"竹陞科技", "6781":"華景電", "6788":"華景電", "6789":"采鈺", "6805":"富世達", "7734":"印能", "7751":"竑騰", "7828":"創新服務", "7853":"政美應用", "8021":"尖點", "8150":"南茂", "8227":"巨有", "8996":"高力"};

const BUYS_SEED = [
  { code: "1802", date: "2026-03-23", price: 51.9 },
  { code: "2351", date: "2026-04-23", price: 158.5 },
  { code: "2351", date: "2026-04-24", price: 151.5 },
  { code: "2351", date: "2026-04-29", price: 151.5 },
  { code: "3167", date: "2026-03-18", price: 349 },
  { code: "3167", date: "2026-03-24", price: 317 },
  { code: "3211", date: "2026-03-30", price: 354 },
  { code: "3211", date: "2026-03-31", price: 345 },
  { code: "3211", date: "2026-04-02", price: 332 },
  { code: "3211", date: "2026-04-14", price: 350 },
  { code: "3533", date: "2026-03-23", price: 1985 },
  { code: "3533", date: "2026-03-27", price: 2260 },
  { code: "3533", date: "2026-03-31", price: 2025 },
  { code: "3533", date: "2026-04-07", price: 2030 },
  { code: "3533", date: "2026-04-23", price: 2445 },
  { code: "3533", date: "2026-04-23", price: 2485 },
  { code: "3535", date: "2026-04-10", price: 134 },
  { code: "3535", date: "2026-04-13", price: 130 },
  { code: "4749", date: "2026-04-23", price: 976 },
  { code: "4749", date: "2026-04-24", price: 981 },
  { code: "4749", date: "2026-04-25", price: 985 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "4971", date: "2026-03-16", price: 333 },
  { code: "5475", date: "2026-03-18", price: 212 },
  { code: "5475", date: "2026-03-19", price: 212 },
  { code: "5475", date: "2026-03-24", price: 192 },
  { code: "6739", date: "2026-04-13", price: 1480 },
  { code: "6739", date: "2026-04-13", price: 1510 },
  { code: "6739", date: "2026-04-14", price: 1380 },
  { code: "7734", date: "2026-03-18", price: 1900 },
  { code: "7734", date: "2026-03-20", price: 1855 },
  { code: "7734", date: "2026-03-20", price: 1855 },
  { code: "7734", date: "2026-03-24", price: 1660 },
  { code: "1560", date: "2026-05-15", price: 640 },
  { code: "6805", date: "2026-05-06", price: 1870 },
  { code: "6805", date: "2026-05-12", price: 1900 },
  { code: "2327", date: "2026-06-05", price: 690 },
  { code: "2327", date: "2026-06-05", price: 710 },
  { code: "3037", date: "2026-06-05", price: 930 },
  { code: "3037", date: "2026-06-08", price: 902 },
  { code: "3715", date: "2026-04-15", price: 188 },
  { code: "3715", date: "2026-04-20", price: 198 },
  { code: "3715", date: "2026-05-08", price: 182.5 },
  { code: "4760", date: "2026-06-03", price: 407 },
  { code: "4760", date: "2026-06-05", price: 400 },
  { code: "4760", date: "2026-06-08", price: 385 },
  { code: "4966", date: "2026-06-05", price: 744 },
  { code: "4989", date: "2026-05-05", price: 104 },
  { code: "6261", date: "2026-05-26", price: 119.5 },
  { code: "6415", date: "2026-05-28", price: 629 },
  { code: "6415", date: "2026-06-02", price: 593 },
  { code: "8227", date: "2026-05-15", price: 207 },
  { code: "8227", date: "2026-05-27", price: 219 },
  { code: "8227", date: "2026-05-28", price: 215 },
];

const SELLS_SEED = [
  { code: "1802", date: "2026-04-16", price: 64.1 },
  { code: "2351", date: "2026-05-01", price: 187.5 },
  { code: "2351", date: "2026-05-01", price: 187.5 },
  { code: "2351", date: "2026-05-01", price: 187.5 },
  { code: "3167", date: "2026-04-16", price: 698 },
  { code: "3167", date: "2026-04-16", price: 698 },
  { code: "3211", date: "2026-05-01", price: 385 },
  { code: "3211", date: "2026-05-01", price: 385 },
  { code: "3211", date: "2026-05-01", price: 385 },
  { code: "3211", date: "2026-05-01", price: 385 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3533", date: "2026-05-01", price: 2555 },
  { code: "3535", date: "2026-05-05", price: 136 },
  { code: "3535", date: "2026-05-05", price: 136 },
  { code: "4749", date: "2026-05-01", price: 1130 },
  { code: "4749", date: "2026-05-01", price: 1130 },
  { code: "4749", date: "2026-05-01", price: 1130 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "4971", date: "2026-05-01", price: 777 },
  { code: "5475", date: "2026-04-14", price: 316 },
  { code: "5475", date: "2026-05-01", price: 352 },
  { code: "5475", date: "2026-05-01", price: 352 },
  { code: "6739", date: "2026-05-01", price: 1485 },
  { code: "6739", date: "2026-05-01", price: 1485 },
  { code: "6739", date: "2026-05-01", price: 1485 },
  { code: "7734", date: "2026-04-23", price: 3150 },
  { code: "7734", date: "2026-04-23", price: 3150 },
  { code: "7734", date: "2026-05-01", price: 4500 },
  { code: "7734", date: "2026-05-01", price: 4500 },
  { code: "1560", date: "2026-06-04", price: 716 },
  { code: "6805", date: "2026-06-03", price: 2130 },
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS code_names (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS buys (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        trade_date DATE NOT NULL,
        price NUMERIC NOT NULL,
        signal_time TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sells (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        trade_date DATE NOT NULL,
        price NUMERIC NOT NULL,
        signal_time TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // 對舊版本（第一階段已部署過）的資料庫做欄位補丁，新增備註/時間欄位
    await client.query(`ALTER TABLE buys ADD COLUMN IF NOT EXISTS signal_time TEXT;`);
    await client.query(`ALTER TABLE buys ADD COLUMN IF NOT EXISTS note TEXT;`);
    await client.query(`ALTER TABLE sells ADD COLUMN IF NOT EXISTS signal_time TEXT;`);
    await client.query(`ALTER TABLE sells ADD COLUMN IF NOT EXISTS note TEXT;`);
    // 進階組／基本組分類欄位
    await client.query(`ALTER TABLE buys ADD COLUMN IF NOT EXISTS group_tag TEXT;`);
    await client.query(`ALTER TABLE sells ADD COLUMN IF NOT EXISTS group_tag TEXT;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_signals (
        code TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        signal_date DATE NOT NULL,
        signal_time TEXT NOT NULL,
        price NUMERIC,
        suggested_price TEXT,
        original TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // 這張表這階段先建起來，第三階段做收盤報告時才會開始寫入使用
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_signals (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        action TEXT NOT NULL,
        signal_date DATE NOT NULL,
        signal_time TEXT NOT NULL,
        suggested_price TEXT,
        original TEXT,
        sender TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_buys_code ON buys(code);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sells_code ON sells(code);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_daily_signals_date ON daily_signals(signal_date);`);
    await client.query(`ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS group_tag TEXT;`);
    await client.query(`ALTER TABLE buys ADD COLUMN IF NOT EXISTS suggested_price TEXT;`);
    await client.query(`ALTER TABLE sells ADD COLUMN IF NOT EXISTS suggested_price TEXT;`);

    const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM buys");
    if (rows[0].n === 0) {
      console.log("[Migrate] buys 資料表為空，開始匯入既有持股資料...");
      for (const code in CODE_NAMES_SEED) {
        await client.query(
          `INSERT INTO code_names (code, name) VALUES ($1, $2)
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
          [code, CODE_NAMES_SEED[code]]
        );
      }
      for (const b of BUYS_SEED) {
        await client.query(
          `INSERT INTO buys (code, name, trade_date, price) VALUES ($1, $2, $3, $4)`,
          [b.code, CODE_NAMES_SEED[b.code] || b.code, b.date, b.price]
        );
      }
      for (const s of SELLS_SEED) {
        await client.query(
          `INSERT INTO sells (code, name, trade_date, price) VALUES ($1, $2, $3, $4)`,
          [s.code, CODE_NAMES_SEED[s.code] || s.code, s.date, s.price]
        );
      }
      console.log("[Migrate] 匯入完成：" + BUYS_SEED.length + " 筆買入、" + SELLS_SEED.length + " 筆賣出、" + Object.keys(CODE_NAMES_SEED).length + " 個股票名稱");
    } else {
      console.log("[Migrate] buys 資料表已有 " + rows[0].n + " 筆資料，略過種子匯入");
    }

    // 補上從歷史訊號原文抓到的股票名稱，只在該代號目前還沒有名稱時才寫入，不會覆蓋掉已設定的
    let addedNames = 0;
    for (const code in EXTRA_CODE_NAMES) {
      const r = await client.query(
        `INSERT INTO code_names (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
        [code, EXTRA_CODE_NAMES[code]]
      );
      if (r.rowCount > 0) addedNames++;
    }
    if (addedNames > 0) console.log("[Migrate] 補上 " + addedNames + " 個股票名稱");

    await client.query("COMMIT");
    console.log("[Migrate] 資料庫結構就緒");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate] 失敗：", err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(function () { process.exit(0); })
    .catch(function () { process.exit(1); });
}

module.exports = { migrate };
