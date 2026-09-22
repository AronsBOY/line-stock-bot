const axios = require("axios");

const RETROGRADES = [
  { start: "2020-02-17", end: "2020-03-10", sign: "雙魚／水瓶" },
  { start: "2020-06-18", end: "2020-07-12", sign: "巨蟹" },
  { start: "2020-10-14", end: "2020-11-03", sign: "天蠍／天秤" },
  { start: "2021-01-30", end: "2021-02-20", sign: "水瓶" },
  { start: "2021-05-29", end: "2021-06-22", sign: "雙子" },
  { start: "2021-09-27", end: "2021-10-18", sign: "天秤" },
  { start: "2022-01-14", end: "2022-02-03", sign: "水瓶／摩羯" },
  { start: "2022-05-10", end: "2022-06-03", sign: "雙子／金牛" },
  { start: "2022-09-09", end: "2022-10-02", sign: "天秤／處女" },
  { start: "2022-12-29", end: "2023-01-18", sign: "摩羯" },
  { start: "2023-04-21", end: "2023-05-14", sign: "金牛" },
  { start: "2023-08-23", end: "2023-09-15", sign: "處女" },
  { start: "2023-12-13", end: "2024-01-01", sign: "射手" },
  { start: "2024-04-01", end: "2024-04-25", sign: "牡羊" },
  { start: "2024-08-05", end: "2024-08-28", sign: "處女／獅子" },
  { start: "2024-11-25", end: "2024-12-15", sign: "射手" },
  { start: "2025-03-14", end: "2025-04-07", sign: "牡羊／雙魚" },
  { start: "2025-07-17", end: "2025-08-11", sign: "獅子" },
  { start: "2025-11-09", end: "2025-11-29", sign: "射手／天蠍" },
  { start: "2026-02-26", end: "2026-03-20", sign: "雙魚" },
  { start: "2026-06-29", end: "2026-07-23", sign: "巨蟹" },
  { start: "2026-10-24", end: "2026-11-13", sign: "天蠍" }
];

const SIGN_GUIDE = {
  "雙魚": {
    affected: "雙魚、處女、雙子、射手",
    caution: "訊息誤解、情緒判斷、文件細節、行程反覆；重要承諾與付款前多確認一次。"
  },
  "巨蟹": {
    affected: "巨蟹、摩羯、牡羊、天秤",
    caution: "家庭與工作排程、情緒化溝通、住家／交通安排、舊議題重談；避免急著下結論。"
  },
  "天蠍": {
    affected: "天蠍、金牛、獅子、水瓶",
    caution: "金錢往來、合約、信任與資訊落差；重要交易、密碼、付款與文件版本要二次核對。"
  },
  "雙子": {
    affected: "雙子、射手、處女、雙魚",
    caution: "訊息、通訊、3C、交通與文件最容易反覆；寄送前檢查收件人、附件與時間。"
  },
  "處女": {
    affected: "處女、雙魚、雙子、射手",
    caution: "工作細節、資料版本、健康作息與時間管理容易出錯；避免同時處理太多小事。"
  },
  "天秤": {
    affected: "天秤、牡羊、巨蟹、摩羯",
    caution: "合作、人際、合約與協調容易來回；口頭共識最好留下文字紀錄。"
  },
  "水瓶": {
    affected: "水瓶、獅子、金牛、天蠍",
    caution: "團隊溝通、科技設備、計畫變更與社群訊息要留意；重要資料先備份。"
  },
  "金牛": {
    affected: "金牛、天蠍、獅子、水瓶",
    caution: "金錢、購物、資產與價值判斷容易反覆；避免因短期情緒做重大消費決定。"
  },
  "摩羯": {
    affected: "摩羯、巨蟹、牡羊、天秤",
    caution: "工作責任、時程、主管溝通與行政流程容易重跑；重要期限預留緩衝。"
  },
  "射手": {
    affected: "射手、雙子、處女、雙魚",
    caution: "旅行、學習、跨國聯絡與長程計畫可能變動；訂票、簽證與日期要重查。"
  },
  "牡羊": {
    affected: "牡羊、天秤、巨蟹、摩羯",
    caution: "衝動回覆與臨時決策風險較高；工作交辦、交通與約定時間要明確確認。"
  },
  "獅子": {
    affected: "獅子、水瓶、金牛、天蠍",
    caution: "公開表達、主管互動、創作與個人形象容易被誤解；發文與簡報前先校對。"
  }
};

function twDateString(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d || new Date());
}

function dateLabel(s) {
  return String(s || "").replace(/-/g, "/");
}

function primarySign(sign) {
  return String(sign || "").split("／")[0];
}

function currentOrNextRetrograde(today) {
  const t = today || twDateString();
  const active = RETROGRADES.find(function(r) { return r.start <= t && t <= r.end; });
  if (active) return { mode: "進行中", item: active };
  const next = RETROGRADES.find(function(r) { return r.start > t; });
  if (next) return { mode: "下一次", item: next };
  return { mode: "資料待更新", item: RETROGRADES[RETROGRADES.length - 1] };
}

async function fetchTaiexDaily() {
  const start = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
  const end = Math.floor((Date.now() + 86400000) / 1000);
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII";
  const resp = await axios.get(url, {
    timeout: 7000,
    params: {
      period1: start,
      period2: end,
      interval: "1d",
      events: "history",
      includeAdjustedClose: "true"
    },
    headers: { "User-Agent": "Mozilla/5.0 LINE-Stock-Bot/1.0" }
  });
  const result = resp.data && resp.data.chart && resp.data.chart.result && resp.data.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error("無法取得台股歷史資料");
  const closes = result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
  const map = [];
  result.timestamp.forEach(function(ts, i) {
    const close = closes && closes[i];
    if (close == null || !Number.isFinite(Number(close))) return;
    const d = new Date(ts * 1000);
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
    map.push({ date: key, close: Number(close) });
  });
  return map;
}

function calcPeriodReturn(rows, start, end) {
  const inRange = rows.filter(function(x) { return x.date >= start && x.date <= end; });
  if (inRange.length < 2) return null;
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  return {
    startDate: first.date,
    endDate: last.date,
    startClose: first.close,
    endClose: last.close,
    pct: (last.close / first.close - 1) * 100
  };
}

async function buildEntertainmentBacktest(today) {
  const t = today || twDateString();
  const completed = RETROGRADES.filter(function(r) { return r.end < t; });
  const rows = await fetchTaiexDaily();
  const samples = completed.map(function(r) {
    const perf = calcPeriodReturn(rows, r.start, r.end);
    return perf ? Object.assign({}, r, perf) : null;
  }).filter(Boolean);

  if (!samples.length) return null;

  const avg = samples.reduce(function(a, x) { return a + x.pct; }, 0) / samples.length;
  const wins = samples.filter(function(x) { return x.pct > 0; }).length;
  const best = samples.reduce(function(a, b) { return b.pct > a.pct ? b : a; });
  const worst = samples.reduce(function(a, b) { return b.pct < a.pct ? b : a; });

  return {
    count: samples.length,
    avg,
    wins,
    winRate: wins / samples.length * 100,
    best,
    worst
  };
}

function pct(v) {
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

async function buildMercuryRetrogradeReport() {
  const today = twDateString();
  const target = currentOrNextRetrograde(today);
  const r = target.item;
  const pSign = primarySign(r.sign);
  const guide = SIGN_GUIDE[pSign] || {
    affected: "雙子、處女，以及本次逆行星座的對宮與四分相星座",
    caution: "溝通、文件、交通、3C 與行程安排多確認一次。"
  };

  let backtestText;
  try {
    const bt = await buildEntertainmentBacktest(today);
    if (!bt) {
      backtestText = "📊 娛樂回測：暫無足夠歷史樣本";
    } else {
      backtestText =
        "📊 水逆 × 台股娛樂回測\n" +
        "樣本：" + bt.count + " 次已完成水逆（2020年至今）\n" +
        "平均報酬：" + pct(bt.avg) + "\n" +
        "上漲：" + bt.wins + " 次｜下跌：" + (bt.count - bt.wins) + " 次｜勝率：" + bt.winRate.toFixed(1) + "%\n" +
        "最好：" + dateLabel(bt.best.start) + "～" + dateLabel(bt.best.end) + " " + pct(bt.best.pct) + "\n" +
        "最差：" + dateLabel(bt.worst.start) + "～" + dateLabel(bt.worst.end) + " " + pct(bt.worst.pct);
    }
  } catch (err) {
    console.error("[水逆回測]", err.message);
    backtestText = "📊 娛樂回測：台股歷史資料暫時無法取得";
  }

  return (
    "☿ 水星逆行娛樂觀測\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📅 " + target.mode + "：" + dateLabel(r.start) + " ～ " + dateLabel(r.end) + "\n" +
    "♏ 逆行星座：" + r.sign + "\n\n" +
    backtestText + "\n\n" +
    "🔮 受影響星座\n" +
    guide.affected + "\n\n" +
    "⚠️ 注意項目\n" +
    guide.caution + "\n\n" +
    "🎲 娛樂提醒：占星與市場回測只看歷史巧合，不代表水逆會造成股市漲跌。"
  );
}

module.exports = {
  RETROGRADES,
  buildMercuryRetrogradeReport
};
