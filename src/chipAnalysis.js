const axios = require("axios");
const { buildHolderTrendPayload } = require("./tdccHolders");

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const CACHE_MS = 30 * 60 * 1000;
const stockCache = new Map();

function twDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d || new Date());
}

function daysAgo(n) {
  return twDate(new Date(Date.now() - n * 86400000));
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function finmind(dataset, code, startDate) {
  const key = dataset + ":" + code + ":" + startDate;
  const hit = stockCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const resp = await axios.get(FINMIND_URL, {
    timeout: 8000,
    params: {
      dataset,
      data_id: code,
      start_date: startDate
    },
    headers: { "User-Agent": "LINE-Stock-Bot/1.0" }
  });

  const data = resp.data && Array.isArray(resp.data.data) ? resp.data.data : [];
  stockCache.set(key, { at: Date.now(), data });
  return data;
}

function institutionalDay(row) {
  const foreign =
    n(row.Foreign_Investor_buy) - n(row.Foreign_Investor_sell);

  const trust =
    n(row.Investment_Trust_buy) - n(row.Investment_Trust_sell);

  const dealerOld =
    n(row.Dealer_buy) - n(row.Dealer_sell);

  const dealerNew =
    (n(row.Dealer_self_buy) - n(row.Dealer_self_sell)) +
    (n(row.Dealer_Hedging_buy) - n(row.Dealer_Hedging_sell));

  const dealer = dealerOld || dealerNew;
  const total = foreign + trust + dealer;

  return {
    date: row.date,
    foreign,
    trust,
    dealer,
    total
  };
}

function sumLast(rows, count, field) {
  return rows.slice(-count).reduce(function(a, x) {
    return a + n(x[field]);
  }, 0);
}

function sameSignTrend(rows) {
  const vals = rows.slice(-5).map(function(x) { return n(x.total); });
  if (!vals.length) return "無資料";

  let sign = 0;
  let count = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    const s = vals[i] > 0 ? 1 : vals[i] < 0 ? -1 : 0;
    if (!s) break;
    if (!sign) sign = s;
    if (s !== sign) break;
    count++;
  }

  if (count >= 2) return "連" + count + (sign > 0 ? "買" : "賣");
  return sign > 0 ? "偏買" : sign < 0 ? "偏賣" : "持平";
}

async function fetchInstitution(code) {
  try {
    const raw = await finmind(
      "TaiwanStockInstitutionalInvestorsBuySellWide",
      code,
      daysAgo(16)
    );
    const rows = raw
      .map(institutionalDay)
      .filter(function(x) { return x.date; })
      .sort(function(a, b) { return a.date.localeCompare(b.date); })
      .slice(-5);

    if (!rows.length) return null;
    return {
      date: rows[rows.length - 1].date,
      foreign5: sumLast(rows, 5, "foreign"),
      trust5: sumLast(rows, 5, "trust"),
      dealer5: sumLast(rows, 5, "dealer"),
      total5: sumLast(rows, 5, "total"),
      trend: sameSignTrend(rows),
      days: rows.length
    };
  } catch (err) {
    console.error("[籌碼] 法人資料失敗 " + code + ":", err.message);
    return null;
  }
}

async function fetchMargin(code) {
  try {
    const raw = await finmind(
      "TaiwanStockMarginPurchaseShortSale",
      code,
      daysAgo(16)
    );
    const rows = raw
      .filter(function(x) { return x && x.date; })
      .sort(function(a, b) { return xDate(a).localeCompare(xDate(b)); })
      .slice(-5);

    if (!rows.length) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];

    return {
      date: last.date,
      margin: n(last.MarginPurchaseTodayBalance),
      marginChange5: n(last.MarginPurchaseTodayBalance) - n(first.MarginPurchaseYesterdayBalance),
      short: n(last.ShortSaleTodayBalance),
      shortChange5: n(last.ShortSaleTodayBalance) - n(first.ShortSaleYesterdayBalance),
      days: rows.length
    };
  } catch (err) {
    console.error("[籌碼] 融資融券資料失敗 " + code + ":", err.message);
    return null;
  }
}

function xDate(x) {
  return String(x && x.date || "");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function lots(v) {
  if (!Number.isFinite(v)) return "—";
  const x = v / 1000;
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : 1;
  return (x > 0 ? "+" : x < 0 ? "-" : "") +
    abs.toFixed(digits).replace(/\.0$/, "") + "張";
}

function bal(v) {
  if (!Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US") + "張";
}

function deltaLots(v) {
  if (!Number.isFinite(v)) return "—";
  return (v > 0 ? "▲" : v < 0 ? "▼" : "") +
    Math.abs(Math.round(v)).toLocaleString("en-US") + "張";
}

function deltaPp(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.005) return "0.00pp";
  return (v > 0 ? "▲" : "▼") + Math.abs(v).toFixed(2) + "pp";
}

function colorBy(v, invert) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.0001) return "#777777";
  const good = invert ? v < 0 : v > 0;
  return good ? "#D32F2F" : "#008A3B";
}

function shortDate(s) {
  return s ? String(s).slice(5).replace("-", "/") : "—";
}

function trendArrow(text) {
  if (/增|買/.test(text || "")) return "↗ " + text;
  if (/減|賣/.test(text || "")) return "↘ " + text;
  return "→ " + (text || "持平");
}

function attentionText(x) {
  const notes = [];

  if (x.holder && x.holder.available) {
    if (x.holder.bigTrend && x.holder.bigTrend.direction > 0) notes.push("大戶" + x.holder.bigTrend.text);
    else if (x.holder.bigTrend && x.holder.bigTrend.direction < 0) notes.push("大戶" + x.holder.bigTrend.text);
  }

  if (x.inst) {
    if (x.inst.total5 > 0) notes.push("法人5日買超");
    else if (x.inst.total5 < 0) notes.push("法人5日賣超");
  }

  if (x.margin) {
    if (x.margin.marginChange5 > 0) notes.push("融資增加");
    else if (x.margin.marginChange5 < 0) notes.push("融資減少");
  }

  return notes.length ? "👀 " + notes.slice(0, 3).join("｜") : "👀 籌碼變化不明顯";
}

async function buildChipPayload(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes)
    .filter(function(code) {
      return episodes[code].openEpisode && episodes[code].openEpisode.qty > 0.0001;
    })
    .sort();

  if (!codes.length) {
    return { items: [], text: "📊 籌碼\n目前沒有持股庫存" };
  }

  const holderPromise = buildHolderTrendPayload(portfolio)
    .catch(function() { return { items: [] }; });

  const instPromise = mapLimit(codes, 3, fetchInstitution);
  const marginPromise = mapLimit(codes, 3, fetchMargin);

  const [holder, instList, marginList] = await Promise.all([
    holderPromise,
    instPromise,
    marginPromise
  ]);

  const holderMap = new Map((holder.items || []).map(function(x) {
    return [x.code, x];
  }));

  const items = codes.map(function(code, i) {
    return {
      code,
      name: portfolio.getName(code) || code,
      holder: holderMap.get(code) || null,
      inst: instList[i] || null,
      margin: marginList[i] || null
    };
  });

  return {
    items,
    text: "📊 持股籌碼｜集保4週｜法人5日｜融資券5日"
  };
}

function textLine(label, value, valueColor) {
  return {
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#666666", flex: 5 },
      { type: "text", text: value, size: "sm", weight: "bold", align: "end", color: valueColor || "#222222", flex: 8, wrap: true }
    ]
  };
}

function sectionTitle(title, date) {
  return {
    type: "box",
    layout: "horizontal",
    margin: "lg",
    contents: [
      { type: "text", text: title, size: "sm", weight: "bold", color: "#0077B6", flex: 7 },
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

  body.push(sectionTitle("① 集保大戶／散戶｜4週", x.holder && x.holder.date));
  if (x.holder && x.holder.available) {
    const bigTrend = x.holder.bigTrend ? trendArrow(x.holder.bigTrend.text) : "";
    const retailTrend = x.holder.retailTrend ? trendArrow(x.holder.retailTrend.text) : "";
    body.push(textLine(
      "千張大戶",
      x.holder.big.toFixed(2) + "%  " + deltaPp(x.holder.bigDelta) + "  " + bigTrend,
      colorBy(x.holder.bigDelta, false)
    ));
    body.push(textLine(
      "30張以下",
      x.holder.retail.toFixed(2) + "%  " + deltaPp(x.holder.retailDelta) + "  " + retailTrend,
      colorBy(x.holder.retailDelta, true)
    ));
  } else {
    body.push(textLine("資料", "本期查無"));
  }

  body.push(sectionTitle("② 三大法人｜近5日", x.inst && x.inst.date));
  if (x.inst) {
    body.push(textLine("外資", lots(x.inst.foreign5), colorBy(x.inst.foreign5, false)));
    body.push(textLine("投信", lots(x.inst.trust5), colorBy(x.inst.trust5, false)));
    body.push(textLine("自營商", lots(x.inst.dealer5), colorBy(x.inst.dealer5, false)));
    body.push(textLine(
      "5日合計",
      lots(x.inst.total5) + "  " + trendArrow(x.inst.trend),
      colorBy(x.inst.total5, false)
    ));
  } else {
    body.push(textLine("資料", "近5日查無"));
  }

  body.push(sectionTitle("③ 融資／融券｜近5日", x.margin && x.margin.date));
  if (x.margin) {
    body.push(textLine(
      "融資",
      bal(x.margin.margin) + "  " + deltaLots(x.margin.marginChange5),
      colorBy(x.margin.marginChange5, true)
    ));
    body.push(textLine(
      "融券",
      bal(x.margin.short) + "  " + deltaLots(x.margin.shortChange5),
      colorBy(x.margin.shortChange5, false)
    ));
  } else {
    body.push(textLine("資料", "近5日查無"));
  }

  body.push({
    type: "separator",
    margin: "lg"
  });
  body.push({
    type: "text",
    text: attentionText(x),
    size: "xs",
    color: "#555555",
    margin: "md",
    wrap: true
  });

  return {
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: body
    }
  };
}

function buildChipMessages(payload) {
  if (!payload.items || !payload.items.length) {
    return [{ type: "text", text: payload.text }];
  }

  const chunks = [];
  for (let i = 0; i < payload.items.length; i += 10) {
    chunks.push(payload.items.slice(i, i + 10));
  }

  return chunks.slice(0, 5).map(function(chunk, idx) {
    return {
      type: "flex",
      altText: "持股籌碼" + (chunks.length > 1 ? " " + (idx + 1) + "/" + chunks.length : ""),
      contents: {
        type: "carousel",
        contents: chunk.map(chipBubble)
      }
    };
  });
}

module.exports = {
  buildChipPayload,
  buildChipMessages
};
