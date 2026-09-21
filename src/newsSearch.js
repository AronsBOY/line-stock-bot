const axios = require("axios");

const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

// 只收相對有公信力、且一般可直接公開閱讀的新聞來源。
// 故意不納入常見硬付費牆媒體。
const TRUSTED_DOMAINS = [
  "cna.com.tw",
  "anue.com",
  "cnyes.com",
  "moneydj.com",
  "tw.stock.yahoo.com",
  "ctee.com.tw",
  "technews.tw",
  "ec.ltn.com.tw",
  "ettoday.net",
  "reuters.com"
];

const SOURCE_NAMES = {
  "cna.com.tw": "中央社",
  "anue.com": "鉅亨網",
  "cnyes.com": "鉅亨網",
  "moneydj.com": "MoneyDJ",
  "tw.stock.yahoo.com": "Yahoo奇摩股市",
  "ctee.com.tw": "工商時報",
  "technews.tw": "科技新報",
  "ec.ltn.com.tw": "自由財經",
  "ettoday.net": "ETtoday財經雲",
  "reuters.com": "Reuters"
};

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function normalizeDomain(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function trustedBaseDomain(domain) {
  const d = normalizeDomain(domain);
  return TRUSTED_DOMAINS.find(function(base) {
    return d === base || d.endsWith("." + base);
  }) || null;
}

function sourceName(domain) {
  const base = trustedBaseDomain(domain);
  return base ? SOURCE_NAMES[base] : normalizeDomain(domain);
}

function isLikelyPublicUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  return !/(paywall|premium|subscribe|subscription|\/member\/|\/vip\/|login=)/.test(s);
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"].forEach(function(k) {
      u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return String(url || "");
  }
}

function articleDate(raw) {
  const s = String(raw || "");
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);
  if (compact) {
    const mm = compact[2], dd = compact[3];
    const hh = compact[4], min = compact[5];
    return mm + "/" + dd + (hh && min ? " " + hh + ":" + min : "");
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

function todayTW() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function buildQuery(code, name) {
  const safeCode = String(code || "").replace(/["()]/g, "");
  const safeName = String(name || "").replace(/["()]/g, "");
  const terms = safeName && safeName !== safeCode
    ? '("' + safeName + '" OR "' + safeCode + '")'
    : '("' + safeCode + '" AND 台股)';
  const domains = TRUSTED_DOMAINS.map(function(d) { return "domain:" + d; }).join(" OR ");
  return terms + " (" + domains + ")";
}

async function gdeltSearch(code, name, timespan) {
  const response = await axios.get(GDELT_URL, {
    timeout: 5500,
    params: {
      query: buildQuery(code, name),
      mode: "ArtList",
      maxrecords: 75,
      format: "json",
      sort: "HybridRel",
      timespan: timespan
    },
    headers: {
      "User-Agent": "LINE-Stock-Bot/1.0"
    }
  });

  const data = response.data || {};
  const articles = Array.isArray(data.articles) ? data.articles : [];

  return articles
    .filter(function(a) {
      return trustedBaseDomain(a.domain) && isLikelyPublicUrl(a.url);
    })
    .map(function(a) {
      return {
        title: cleanTitle(a.title),
        url: canonicalUrl(a.url),
        domain: normalizeDomain(a.domain),
        source: sourceName(a.domain),
        date: articleDate(a.seendate)
      };
    });
}

function mergeUnique(existing, incoming) {
  const seenUrl = new Set(existing.map(function(a) { return a.url; }));
  const seenTitle = new Set(existing.map(function(a) { return a.title; }));
  incoming.forEach(function(a) {
    if (!a.title || !a.url) return;
    if (seenUrl.has(a.url) || seenTitle.has(a.title)) return;
    seenUrl.add(a.url);
    seenTitle.add(a.title);
    existing.push(a);
  });
  return existing;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      reject(new Error((label || "operation") + " timeout after " + ms + "ms"));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function getStockNews(code, name, limit) {
  const max = limit || 3;
  let items = [];

  try {
    items = mergeUnique(items, await withTimeout(gdeltSearch(code, name, "1week"), 6500, "GDELT 1week"));
  } catch (err) {
    console.error("[新聞] 近一週搜尋失敗 " + code + ":", err.message);
  }

  // 只有近一週成功但篇數不足時才擴大到近一月；
  // 若近一週本身逾時/失敗，不再連續等第二個遠端逾時。
  if (items.length > 0 && items.length < max) {
    try {
      items = mergeUnique(items, await withTimeout(gdeltSearch(code, name, "1month"), 6500, "GDELT 1month"));
    } catch (err) {
      console.error("[新聞] 近一月搜尋失敗 " + code + ":", err.message);
    }
  }

  return items.slice(0, max);
}

function formatStockBlock(code, name, articles) {
  let out = "📌 " + code + " " + name + "\n";
  if (!articles.length) {
    return out + "近一個月沒有找到符合可信來源條件的公開新聞";
  }

  articles.forEach(function(a, i) {
    out += (i + 1) + ". " + a.title + "\n";
    out += "   " + a.source + (a.date ? "｜" + a.date : "") + "\n";
    out += "   " + a.url + "\n";
  });
  return out.trim();
}

async function buildSingleStockNewsReport(portfolio, code) {
  const name = portfolio.getName(code) || code;
  const articles = await getStockNews(code, name, 3);
  return "📰 熱門新聞｜" + code + " " + name + "\n" +
    "可信公開來源｜每檔最多 3 篇\n" +
    "────────────────────\n" +
    formatStockBlock(code, name, articles);
}

async function buildHoldingsNewsReport(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes)
    .filter(function(code) {
      return episodes[code].openEpisode && episodes[code].openEpisode.qty > 0.0001;
    })
    .sort();

  if (!codes.length) return "📰 持股新聞｜" + todayTW() + "\n目前沒有持股";

  // 搜尋全部目前持股，但最終只顯示「有找到新聞」的股票，最多 3 檔。
  // 某檔沒有新聞就不硬湊；全部都沒有則直接回覆「無」。
  const results = new Array(codes.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= codes.length) return;
      const code = codes[i];
      const name = portfolio.getName(code) || code;
      try {
        const articles = await getStockNews(code, name, 3);
        results[i] = { code, name, articles };
      } catch (err) {
        console.error("[新聞] 搜尋失敗 " + code + ":", err.message);
        results[i] = { code, name, articles: [] };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(3, codes.length); i++) workers.push(worker());

  try {
    await withTimeout(Promise.all(workers), 22000, "holdings news batch");
  } catch (err) {
    console.error("[持股新聞] 整批逾時:", err.message);
  }

  const found = results
    .filter(function(x) { return x && Array.isArray(x.articles) && x.articles.length > 0; })
    .slice(0, 3);

  if (!found.length) {
    return "📰 持股熱門新聞｜" + todayTW() + "\n" +
      "目前持股沒有找到符合可信來源條件的公開新聞";
  }

  const blocks = found.map(function(x) {
    return formatStockBlock(x.code, x.name, x.articles);
  });

  return "📰 持股熱門新聞｜" + todayTW() + "\n" +
    "最多顯示 3 檔有新聞的持股｜每檔最多 3 篇\n" +
    "沒有新聞的股票不列出；若全部沒有則顯示「無」\n" +
    "來源限可信公開媒體；整批搜尋最長約 22 秒\n" +
    "════════════════════\n\n" +
    blocks.join("\n\n════════════════════\n\n");
}

module.exports = {
  getStockNews,
  buildSingleStockNewsReport,
  buildHoldingsNewsReport
};
