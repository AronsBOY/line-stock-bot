const axios = require("axios");
const { buildHolderTrendPayload } = require("./tdccHolders");

const CACHE_MS = 10 * 60 * 1000;
let marketCache = { at: 0, data: null };

function num(v) {
  const n = Number(String(v == null ? "" : v).replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
}

function twDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d || new Date());
}

function ymd(s) {
  return String(s).replace(/-/g, "");
}

function rocDate(s) {
  const p = String(s).split("-");
  return (Number(p[0]) - 1911) + "/" + p[1] + "/" + p[2];
}

function recentDates(days) {
  const out = [];
  const base = new Date();
  for (let i = 0; i < (days || 8); i++) {
    const d = new Date(base.getTime() - i * 86400000);
    out.push(twDate(d));
  }
  return out;
}

function findFieldIndex(fields, patterns) {
  const fs = (fields || []).map(function(x) { return String(x || "").replace(/<[^>]+>/g, "").replace(/\s/g, ""); });
  for (const re of patterns) {
    const idx = fs.findIndex(function(x) { return re.test(x); });
    if (idx >= 0) return idx;
  }
  return -1;
}

function allTables(data) {
  const arr = [];
  if (data && Array.isArray(data.tables)) arr.push.apply(arr, data.tables);
  if (data && Array.isArray(data.fields) && Array.isArray(data.data)) arr.push({ fields: data.fields, data: data.data });
  return arr;
}

function parseTwseInstitutional(data) {
  const map = new Map();
  for (const table of allTables(data)) {
    const fields = table.fields || [];
    const rows = table.data || [];
    const codeI = findFieldIndex(fields, [/證券代號/, /股票代號/]);
    if (codeI < 0) continue;

    const foreignNetI = findFieldIndex(fields, [/外陸資.*買賣超/, /外資.*買賣超/]);
    const foreignDealerNetI = findFieldIndex(fields, [/外資自營商.*買賣超/]);
    const trustNetI = findFieldIndex(fields, [/投信.*買賣超/]);
    const dealerTotalI = findFieldIndex(fields, [/自營商.*買賣超.*合計/, /^自營商.*買賣超$/]);
    const dealerSelfI = findFieldIndex(fields, [/自營商\(自行買賣\).*買賣超/]);
    const dealerHedgeI = findFieldIndex(fields, [/自營商\(避險\).*買賣超/]);
    const totalI = findFieldIndex(fields, [/三大法人.*買賣超/]);

    rows.forEach(function(r) {
      const code = String(r[codeI] || "").trim();
      if (!/^\d{4,6}$/.test(code)) return;
      let foreign = foreignNetI >= 0 ? num(r[foreignNetI]) : 0;
      const foreignDealer = foreignDealerNetI >= 0 ? num(r[foreignDealerNetI]) : 0;
      if (foreign != null && foreignDealer != null) foreign += foreignDealer;
      const trust = trustNetI >= 0 ? num(r[trustNetI]) : null;
      let dealer = dealerTotalI >= 0 ? num(r[dealerTotalI]) : null;
      if (dealer == null) {
        const a = dealerSelfI >= 0 ? num(r[dealerSelfI]) : 0;
        const b = dealerHedgeI >= 0 ? num(r[dealerHedgeI]) : 0;
        dealer = (a || 0) + (b || 0);
      }
      const total = totalI >= 0 ? num(r[totalI]) : ((foreign || 0) + (trust || 0) + (dealer || 0));
      map.set(code, { foreign: foreign || 0, trust: trust || 0, dealer: dealer || 0, total: total || 0 });
    });
  }
  return map;
}

function parseTwseMargin(data) {
  const map = new Map();
  for (const table of allTables(data)) {
    const fields = table.fields || [];
    const rows = table.data || [];
    const codeI = findFieldIndex(fields, [/股票代號/, /證券代號/]);
    if (codeI < 0) continue;
    let mpI = findFieldIndex(fields, [/融資前日餘額/]);
    let mI = findFieldIndex(fields, [/融資今日餘額/, /融資餘額/]);
    let spI = findFieldIndex(fields, [/融券前日餘額/]);
    let sI = findFieldIndex(fields, [/融券今日餘額/, /融券餘額/]);

    rows.forEach(function(r) {
      const code = String(r[codeI] || "").trim();
      if (!/^\d{4,6}$/.test(code)) return;
      // 官方欄位順序 fallback：code,name,資買,資賣,現償,前資,資餘額,限額,券買,券賣,券償,前券,券餘額...
      const marginPrev = num(r[mpI >= 0 ? mpI : 5]);
      const margin = num(r[mI >= 0 ? mI : 6]);
      const shortPrev = num(r[spI >= 0 ? spI : 11]);
      const short = num(r[sI >= 0 ? sI : 12]);
      if (margin == null && short == null) return;
      map.set(code, { margin, marginPrev, short, shortPrev });
    });
  }
  return map;
}

function parseTpexInstitutional(data) {
  const map = new Map();
  const rows = data && Array.isArray(data.aaData) ? data.aaData : [];
  rows.forEach(function(r) {
    const code = String(r[0] || "").trim();
    if (!/^\d{4,6}$/.test(code)) return;
    // TPEx 24欄：外資合計買賣超 col10、投信 col13、自營商合計 col22、三大法人合計 col23
    map.set(code, {
      foreign: num(r[10]) || 0,
      trust: num(r[13]) || 0,
      dealer: num(r[22]) || 0,
      total: num(r[23]) || 0
    });
  });
  return map;
}

function parseTpexMargin(data) {
  const map = new Map();
  const rows = data && Array.isArray(data.aaData) ? data.aaData : [];
  rows.forEach(function(r) {
    const code = String(r[0] || "").trim();
    if (!/^\d{4,6}$/.test(code)) return;
    // code,name,前資,資買,資賣,現償,資餘額,...,前券,券賣,券買,券償,券餘額
    map.set(code, {
      marginPrev: num(r[2]),
      margin: num(r[6]),
      shortPrev: num(r[10]),
      short: num(r[14])
    });
  });
  return map;
}

async function fetchFirstValid(dates, fetcher, parser) {
  for (const date of dates) {
    try {
      const data = await fetcher(date);
      const parsed = parser(data);
      if (parsed && parsed.size) return { date, map: parsed };
    } catch (e) {
      // 非交易日、尚未公布、限流都直接往前找
    }
  }
  return { date: null, map: new Map() };
}

async function fetchMarketData() {
  if (marketCache.data && Date.now() - marketCache.at < CACHE_MS) return marketCache.data;
  const dates = recentDates(8);
  const headers = { "User-Agent": "Mozilla/5.0 LINE-Stock-Bot/1.0" };

  const twseInstP = fetchFirstValid(dates, async function(date) {
    const r = await axios.get("https://www.twse.com.tw/rwd/zh/fund/T86", {
      params: { date: ymd(date), selectType: "ALLBUT0999", response: "json" },
      timeout: 7000, headers
    });
    return r.data;
  }, parseTwseInstitutional);

  const twseMarginP = fetchFirstValid(dates, async function(date) {
    const r = await axios.get("https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN", {
      params: { date: ymd(date), selectType: "ALL", response: "json" },
      timeout: 7000, headers
    });
    return r.data;
  }, parseTwseMargin);

  const tpexInstP = fetchFirstValid(dates, async function(date) {
    const r = await axios.get("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php", {
      params: { l: "zh-tw", o: "json", se: "EW", t: "D", d: rocDate(date), s: "0,asc" },
      timeout: 7000, headers
    });
    return r.data;
  }, parseTpexInstitutional);

  const tpexMarginP = fetchFirstValid(dates, async function(date) {
    const r = await axios.get("https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php", {
      params: { l: "zh-tw", o: "json", d: rocDate(date), s: "0,asc" },
      timeout: 7000, headers
    });
    return r.data;
  }, parseTpexMargin);

  const [twseInst, twseMargin, tpexInst, tpexMargin] = await Promise.all([twseInstP, twseMarginP, tpexInstP, tpexMarginP]);
  const data = { twseInst, twseMargin, tpexInst, tpexMargin };
  marketCache = { at: Date.now(), data };
  return data;
}

function mergeForCode(code, market) {
  const inst = market.twseInst.map.get(code) || market.tpexInst.map.get(code) || null;
  const margin = market.twseMargin.map.get(code) || market.tpexMargin.map.get(code) || null;
  return {
    inst,
    instDate: market.twseInst.map.has(code) ? market.twseInst.date : market.tpexInst.map.has(code) ? market.tpexInst.date : null,
    margin,
    marginDate: market.twseMargin.map.has(code) ? market.twseMargin.date : market.tpexMargin.map.has(code) ? market.tpexMargin.date : null
  };
}

function lots(v) {
  if (!Number.isFinite(v)) return "—";
  const n = v / 1000;
  const abs = Math.abs(n);
  const s = abs >= 1000 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(abs >= 100 ? 0 : 1);
  return (n > 0 ? "+" : n < 0 ? "-" : "") + s + "張";
}

function bal(v) {
  if (!Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US") + "張";
}

function changeLots(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  return curr - prev;
}

function changeText(curr, prev) {
  const d = changeLots(curr, prev);
  if (!Number.isFinite(d)) return "—";
  return (d > 0 ? "▲" : d < 0 ? "▼" : "") + Math.abs(Math.round(d)).toLocaleString("en-US") + "張";
}

function deltaPp(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.005) return "0.00pp";
  return (v > 0 ? "▲" : "▼") + Math.abs(v).toFixed(2) + "pp";
}

function colorBy(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.0001) return "#777777";
  return v > 0 ? "#D32F2F" : "#008A3B";
}

function shortDate(s) {
  return s ? String(s).slice(5).replace("-", "/") : "—";
}

async function buildChipPayload(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes)
    .filter(function(code) { return episodes[code].openEpisode && episodes[code].openEpisode.qty > 0.0001; })
    .sort();

  if (!codes.length) return { items: [], text: "📊 籌碼\n目前沒有持股庫存" };

  const [holder, market] = await Promise.all([
    buildHolderTrendPayload(portfolio).catch(function() { return { items: [] }; }),
    fetchMarketData()
  ]);

  const holderMap = new Map((holder.items || []).map(function(x) { return [x.code, x]; }));

  const items = codes.map(function(code) {
    const h = holderMap.get(code) || null;
    const m = mergeForCode(code, market);
    return {
      code,
      name: portfolio.getName(code) || code,
      holder: h,
      inst: m.inst,
      instDate: m.instDate,
      margin: m.margin,
      marginDate: m.marginDate
    };
  });

  return { items, text: "📊 持股籌碼｜僅顯示目前持股庫存" };
}

function textLine(label, value, valueColor) {
  return {
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#666666", flex: 5 },
      { type: "text", text: value, size: "sm", weight: "bold", align: "end", color: valueColor || "#222222", flex: 7 }
    ]
  };
}

function sectionTitle(title, date) {
  return {
    type: "box",
    layout: "horizontal",
    margin: "lg",
    contents: [
      { type: "text", text: title, size: "sm", weight: "bold", color: "#0077B6", flex: 6 },
      { type: "text", text: date ? shortDate(date) : "無資料", size: "xs", color: "#999999", align: "end", flex: 3 }
    ]
  };
}

function chipBubble(x) {
  const body = [
    { type: "text", text: "📊 籌碼", size: "sm", weight: "bold", color: "#B45309" },
    { type: "text", text: x.code + (x.name !== x.code ? " " + x.name : ""), size: "xl", weight: "bold", wrap: true },
    { type: "separator", margin: "md" }
  ];

  body.push(sectionTitle("① 集保大戶／散戶", x.holder && x.holder.date));
  if (x.holder && x.holder.available) {
    body.push(textLine("千張大戶", (Number.isFinite(x.holder.big) ? x.holder.big.toFixed(2) + "%" : "—") + "  " + deltaPp(x.holder.bigDelta), colorBy(x.holder.bigDelta)));
    body.push(textLine("30張以下散戶", (Number.isFinite(x.holder.retail) ? x.holder.retail.toFixed(2) + "%" : "—") + "  " + deltaPp(x.holder.retailDelta), colorBy(x.holder.retailDelta)));
  } else {
    body.push(textLine("資料", "本期查無"));
  }

  body.push(sectionTitle("② 三大法人", x.instDate));
  if (x.inst) {
    body.push(textLine("外資", lots(x.inst.foreign), colorBy(x.inst.foreign)));
    body.push(textLine("投信", lots(x.inst.trust), colorBy(x.inst.trust)));
    body.push(textLine("自營商", lots(x.inst.dealer), colorBy(x.inst.dealer)));
    body.push(textLine("合計", lots(x.inst.total), colorBy(x.inst.total)));
  } else {
    body.push(textLine("資料", "查無"));
  }

  body.push(sectionTitle("③ 融資／融券餘額", x.marginDate));
  if (x.margin) {
    const md = changeLots(x.margin.margin, x.margin.marginPrev);
    const sd = changeLots(x.margin.short, x.margin.shortPrev);
    body.push(textLine("融資", bal(x.margin.margin) + "  " + changeText(x.margin.margin, x.margin.marginPrev), colorBy(md)));
    body.push(textLine("融券", bal(x.margin.short) + "  " + changeText(x.margin.short, x.margin.shortPrev), colorBy(sd)));
  } else {
    body.push(textLine("資料", "查無"));
  }

  return {
    type: "bubble",
    size: "kilo",
    body: { type: "box", layout: "vertical", spacing: "sm", contents: body }
  };
}

function buildChipMessages(payload) {
  if (!payload.items || !payload.items.length) return [{ type: "text", text: payload.text }];
  const chunks = [];
  for (let i = 0; i < payload.items.length; i += 10) chunks.push(payload.items.slice(i, i + 10));
  return chunks.slice(0, 5).map(function(chunk, idx) {
    return {
      type: "flex",
      altText: "持股籌碼" + (chunks.length > 1 ? " " + (idx + 1) + "/" + chunks.length : ""),
      contents: { type: "carousel", contents: chunk.map(chipBubble) }
    };
  });
}

module.exports = {
  buildChipPayload,
  buildChipMessages
};
