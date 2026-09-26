const axios = require("axios");

const ARCHIVE_API = "https://api.github.com/repos/wirelessr/tdcc-opendata-archive/contents/snapshots";
const RAW_BASE = "https://raw.githubusercontent.com/wirelessr/tdcc-opendata-archive/main/snapshots";
const CACHE_MS = 12 * 60 * 60 * 1000;
let cache = { at: 0, snapshots: [] };

function cleanCode(v) {
  return String(v || "").trim();
}

function parsePct(v) {
  const n = Number(String(v || "").trim().replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function parseSnapshotCsv(text, wantedCodes) {
  const wanted = wantedCodes ? new Set(wantedCodes.map(cleanCode)) : null;
  const map = new Map();
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const p = line.split(",");
    if (p.length < 6) continue;

    const date = cleanCode(p[0]);
    const code = cleanCode(p[1]);
    const level = Number(cleanCode(p[2]));
    const pct = parsePct(p[5]);
    if (!code || !Number.isFinite(level)) continue;
    if (wanted && !wanted.has(code)) continue;

    let row = map.get(code);
    if (!row) {
      row = { code, date, big: 0, retail: 0 };
      map.set(code, row);
    }

    // TDCC level 15 = 1,000,001 股以上（約 1,000 張以上）
    if (level === 15) row.big += pct;

    // TDCC level 1~6 = 30,000 股以下（30 張以下）
    if (level >= 1 && level <= 6) row.retail += pct;
  }

  return map;
}

async function listRecentSnapshotFiles(limit) {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric"
  }).format(new Date());

  const resp = await axios.get(ARCHIVE_API + "/" + year, {
    timeout: 6000,
    headers: { "User-Agent": "LINE-Stock-Bot/1.0" }
  });

  const files = Array.isArray(resp.data) ? resp.data : [];
  return files
    .map(function(x) { return x && x.name; })
    .filter(function(name) { return /^\d{4}-\d{2}-\d{2}\.csv$/.test(String(name || "")); })
    .sort()
    .slice(-(limit || 4));
}

async function fetchSnapshotFile(file, wantedCodes) {
  const year = String(file).slice(0, 4);
  const url = RAW_BASE + "/" + year + "/" + file;
  const resp = await axios.get(url, {
    timeout: 8500,
    responseType: "text",
    headers: { "User-Agent": "LINE-Stock-Bot/1.0" }
  });

  return {
    file,
    date: file.replace(".csv", ""),
    rows: parseSnapshotCsv(resp.data, wantedCodes)
  };
}

async function getRecentSnapshots(wantedCodes) {
  const now = Date.now();
  if (cache.snapshots.length && now - cache.at < CACHE_MS) {
    return cache.snapshots.map(function(s) {
      const filtered = new Map();
      wantedCodes.forEach(function(code) {
        const row = s.rows.get(cleanCode(code));
        if (row) filtered.set(cleanCode(code), row);
      });
      return { file: s.file, date: s.date, rows: filtered };
    });
  }

  const files = await listRecentSnapshotFiles(4);
  if (!files.length) throw new Error("找不到集保週資料");

  const snapshots = [];
  for (const file of files) {
    snapshots.push(await fetchSnapshotFile(file, wantedCodes));
  }

  // cache 只存這次查詢的股票即可；持股改變時若缺股票會再刷新。
  cache = { at: now, snapshots };
  return snapshots;
}

function ensureCoverage(snapshots, codes) {
  const latest = snapshots[snapshots.length - 1];
  return codes.every(function(code) { return latest.rows.has(cleanCode(code)); });
}

async function loadSnapshotsForHoldings(codes) {
  let snapshots = await getRecentSnapshots(codes);
  if (ensureCoverage(snapshots, codes)) return snapshots;

  // 持股清單可能在 cache 後變更，強制重抓一次。
  cache = { at: 0, snapshots: [] };
  snapshots = await getRecentSnapshots(codes);
  return snapshots;
}

function delta(curr, prev) {
  if (curr == null || prev == null) return null;
  return curr - prev;
}

function trendInfo(values) {
  const valid = values.filter(function(v) { return Number.isFinite(v); });
  if (valid.length < 2) return { text: "資料不足", direction: 0 };

  let direction = 0;
  let count = 0;
  for (let i = valid.length - 1; i > 0; i--) {
    const d = valid[i] - valid[i - 1];
    const dir = d > 0.0001 ? 1 : d < -0.0001 ? -1 : 0;
    if (!dir) break;
    if (!direction) direction = dir;
    if (dir !== direction) break;
    count++;
  }

  if (!count) return { text: "持平", direction: 0 };
  return { text: "連" + count + (direction > 0 ? "增" : "減"), direction };
}

function fmtPct(v) {
  return Number.isFinite(v) ? v.toFixed(2) + "%" : "—";
}

function fmtDelta(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.005) return "0.00pp";
  return (v > 0 ? "▲" : "▼") + Math.abs(v).toFixed(2) + "pp";
}

function deltaColor(v, invert) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return "#777777";
  const positive = invert ? v < 0 : v > 0;
  return positive ? "#D32F2F" : "#008A3B";
}

function dateShort(s) {
  return String(s || "").slice(5).replace("-", "/");
}

async function buildHolderTrendPayload(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes)
    .filter(function(code) {
      return episodes[code].openEpisode && episodes[code].openEpisode.qty > 0.0001;
    })
    .sort();

  if (!codes.length) {
    return { items: [], text: "📊 集保大戶／散戶\n目前沒有持股" };
  }

  const snapshots = await loadSnapshotsForHoldings(codes);
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

  const items = codes.map(function(code) {
    const series = snapshots.map(function(s) {
      const r = s.rows.get(code);
      return {
        date: s.date,
        big: r ? r.big : null,
        retail: r ? r.retail : null
      };
    });

    const curr = latest.rows.get(code);
    const old = prev ? prev.rows.get(code) : null;
    const bigValues = series.map(function(x) { return x.big; });
    const retailValues = series.map(function(x) { return x.retail; });

    return {
      code,
      name: portfolio.getName(code) || code,
      date: latest.date,
      prevDate: prev ? prev.date : null,
      big: curr ? curr.big : null,
      bigDelta: curr && old ? delta(curr.big, old.big) : null,
      bigTrend: trendInfo(bigValues),
      retail: curr ? curr.retail : null,
      retailDelta: curr && old ? delta(curr.retail, old.retail) : null,
      retailTrend: trendInfo(retailValues),
      available: !!curr
    };
  });

  return {
    items,
    text:
      "📊 集保大戶／散戶｜" + dateShort(latest.date) + "\n" +
      "千張大戶＝1,000張以上｜散戶＝30張以下\n" +
      "週變化＝最新一期－前一期（百分點 pp）"
  };
}

function holderBubble(x) {
  const noData = [{
    type: "text",
    text: "本期查無集保分級資料",
    size: "sm",
    color: "#888888",
    margin: "md",
    wrap: true
  }];

  const dataRows = [
    {
      type: "box",
      layout: "horizontal",
      margin: "lg",
      contents: [
        { type: "text", text: "千張大戶", size: "sm", color: "#555555", flex: 4 },
        { type: "text", text: fmtPct(x.big), size: "lg", weight: "bold", align: "end", flex: 3 }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        { type: "text", text: "週變化", size: "xs", color: "#888888", flex: 4 },
        { type: "text", text: fmtDelta(x.bigDelta) + "｜" + x.bigTrend.text, size: "sm", weight: "bold", align: "end", color: deltaColor(x.bigDelta, false), flex: 5 }
      ]
    },
    {
      type: "separator",
      margin: "md"
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      contents: [
        { type: "text", text: "30張以下散戶", size: "sm", color: "#555555", flex: 5 },
        { type: "text", text: fmtPct(x.retail), size: "lg", weight: "bold", align: "end", flex: 3 }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        { type: "text", text: "週變化", size: "xs", color: "#888888", flex: 4 },
        { type: "text", text: fmtDelta(x.retailDelta) + "｜" + x.retailTrend.text, size: "sm", weight: "bold", align: "end", color: deltaColor(x.retailDelta, true), flex: 5 }
      ]
    }
  ];

  return {
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "📊 集保大戶／散戶", size: "sm", color: "#0077B6", weight: "bold" },
        { type: "text", text: x.code + (x.name !== x.code ? " " + x.name : ""), size: "xl", weight: "bold", wrap: true },
        { type: "text", text: dateShort(x.date) + (x.prevDate ? " vs " + dateShort(x.prevDate) : ""), size: "xs", color: "#888888" },
        { type: "separator", margin: "md" }
      ].concat(x.available ? dataRows : noData)
    }
  };
}

function buildHolderTrendMessages(payload) {
  if (!payload.items || !payload.items.length) {
    return [{ type: "text", text: payload.text }];
  }

  // LINE Flex carousel 單則最多放有限 bubble，這裡每 10 檔切一則。
  const chunks = [];
  for (let i = 0; i < payload.items.length; i += 10) {
    chunks.push(payload.items.slice(i, i + 10));
  }

  return chunks.slice(0, 5).map(function(chunk, idx) {
    return {
      type: "flex",
      altText: "集保大戶散戶變化" + (chunks.length > 1 ? " " + (idx + 1) + "/" + chunks.length : ""),
      contents: {
        type: "carousel",
        contents: chunk.map(holderBubble)
      }
    };
  });
}

module.exports = {
  buildHolderTrendPayload,
  buildHolderTrendMessages
};
