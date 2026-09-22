const axios = require("axios");

const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";

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

const TRUSTED_SOURCE_LABELS = new Set([
  "中央社",
  "鉅亨網",
  "MoneyDJ理財網",
  "MoneyDJ",
  "Yahoo奇摩股市",
  "工商時報",
  "科技新報",
  "自由財經",
  "ETtoday財經雲",
  "Reuters",
  "經濟日報",
  "聯合新聞網"
]);

const MATERIAL_NEWS_RE = /營收|財報|財測|法說|法說會|EPS|每股盈餘|獲利|毛利率|營益率|訂單|接單|出貨|產能|擴產|量產|新產品|新品|技術|專利|認證|客戶|供應鏈|合作|策略聯盟|投資|資本支出|併購|收購|處分|股利|配息|庫藏股|董事會|重大訊息|展望|上修|下修|海外廠|新廠|建廠|子公司|轉投資|合約|標案|訴訟|裁罰|事故|停工|復工|缺料|漲價|降價|市占|需求|庫存調整|產品組合|法人說明|董事長|總經理|高層異動|人事異動|現金增資|減資|可轉債|CB|增資|減資|分割|合併|處分資產|取得資產|AI伺服器|CoWoS|先進封裝|HBM|矽光子|ABF|載板|CPO|ASIC|晶圓|封裝|測試/;
const PRICE_CHATTER_RE = /盤中|零股排行榜|成交量TOP|漲停|跌停|衝上.*大關|站上.*大關|挑戰.*大關|創新高|寫新高|飆漲|暴漲|強勢表態|多頭|買盤|股價.*上看|目標價|技術面|籌碼面|K線|爆量|放量|噴出|急拉|大漲|重挫|殺低|逆勢漲|領漲|領跌|紅盤|黑盤|盤勢|熱門股|當沖|零股/;

function articleTimestamp(raw) {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function isMaterialCompanyNews(title) {
  const t = String(title || "");
  if (!MATERIAL_NEWS_RE.test(t)) return false;
  // 如果整個標題只有股價/盤勢語彙，且沒有明確公司面資訊，就排除。
  if (PRICE_CHATTER_RE.test(t) && !/營收|財報|財測|法說|EPS|每股盈餘|獲利|毛利率|營益率|訂單|接單|出貨|產能|擴產|量產|新產品|技術|專利|認證|客戶|合作|投資|併購|股利|配息|庫藏股|董事會|重大訊息|展望|新廠|海外廠|合約|訴訟|裁罰|停工|復工|漲價|降價|需求|市占/.test(t)) return false;
  return true;
}

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


function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(Number(n)); })
    .trim();
}

function xmlTag(block, tag) {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const m = String(block || "").match(re);
  return m ? decodeXml(m[1]) : "";
}

function xmlSource(block) {
  const m = String(block || "").match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i);
  return m ? decodeXml(m[1]) : "";
}

function rssArticleDate(raw) {
  const d = new Date(raw);
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

async function googleNewsSearch(code, name, max) {
  const qName = String(name || "").trim();
  const qCode = String(code || "").trim();
  const subject = qName && qName !== qCode ? '("' + qName + '" OR "' + qCode + '")' : '("' + qCode + '" 台股)';
  const query = subject + ' (營收 OR 財報 OR 法說 OR EPS OR 訂單 OR 接單 OR 出貨 OR 產能 OR 擴產 OR 量產 OR 技術 OR 客戶 OR 合作 OR 投資 OR 股利 OR 重大訊息 OR 展望 OR 漲價 OR 需求) when:7d';

  const resp = await axios.get(GOOGLE_NEWS_RSS, {
    timeout: 6500,
    responseType: "text",
    params: {
      q: query,
      hl: "zh-TW",
      gl: "TW",
      ceid: "TW:zh-Hant"
    },
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const xml = String(resp.data || "");
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const out = [];

  for (let i = 0; i < itemBlocks.length; i++) {
    const block = itemBlocks[i];
    const title = cleanTitle(xmlTag(block, "title"));
    const url = canonicalUrl(xmlTag(block, "link"));
    const source = xmlSource(block);
    const pubDate = xmlTag(block, "pubDate");
    if (!title || !url) continue;

    // 優先可信來源；若來源標籤未知但確實有新聞，仍保留作為公開 RSS 後備來源。
    const trusted = TRUSTED_SOURCE_LABELS.has(source);
    out.push({
      title,
      url,
      domain: "news.google.com",
      source: source || "Google News",
      date: rssArticleDate(pubDate),
      timestamp: articleTimestamp(pubDate),
      trusted
    });
  }

  const filtered = out.filter(function(a) {
    return isMaterialCompanyNews(a.title);
  });
  filtered.sort(function(a, b) {
    if ((b.timestamp || 0) !== (a.timestamp || 0)) return (b.timestamp || 0) - (a.timestamp || 0);
    if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
    return 0;
  });
  return filtered.slice(0, max || 6);
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
  try {
    // 為降低負擔：每檔持股只發 1 次 Google News RSS 請求，不再同時查 GDELT、不做第二輪補查。
    return await withTimeout(googleNewsSearch(code, name, Math.max(max, 6)), 6500, "Google News RSS 7d");
  } catch (err) {
    console.error("[新聞] Google News RSS近一週失敗 " + code + ":", err.message);
    return [];
  }
}

function formatStockBlock(code, name, articles) {
  let out = "📌 " + code + " " + name + "\n";
  if (!articles.length) {
    return out + "近一週沒有找到公開新聞";
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
    "近一週公開新聞｜每檔最多 3 篇\n" +
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
    "最多顯示 3 檔有新聞的持股｜每檔最多 3 篇｜僅限近 7 天\n" +
    "沒有新聞的股票不列出；若全部沒有則顯示「無」\n" +
    "優先可信公開媒體；GDELT不足時用 Google News RSS（近7天）補足；整批搜尋最長約 22 秒\n" +
    "════════════════════\n\n" +
    blocks.join("\n\n════════════════════\n\n");
}

function articleFlexRows(articles) {
  const rows = [];
  articles.forEach(function(a, i) {
    rows.push({
      type: "text",
      text: (i + 1) + ". " + a.title,
      wrap: true,
      size: "sm",
      weight: "bold",
      color: "#1D4ED8",
      action: {
        type: "uri",
        label: "開啟新聞",
        uri: a.url
      },
      margin: i === 0 ? "none" : "lg"
    });
    rows.push({
      type: "text",
      text: (a.source || "公開來源") + (a.date ? "｜" + a.date : ""),
      wrap: true,
      size: "xs",
      color: "#777777",
      margin: "xs"
    });
  });
  return rows;
}

function buildHoldingsNewsFlex(holdings) {
  if (!Array.isArray(holdings) || !holdings.length) return null;

  return {
    type: "flex",
    altText: "持股重大新聞",
    contents: {
      type: "carousel",
      contents: holdings.map(function(x) {
        const rows = x.articles && x.articles.length
          ? articleFlexRows(x.articles)
          : [{
              type: "text",
              text: "近 7 天無重大公司面新聞",
              wrap: true,
              size: "sm",
              color: "#888888",
              margin: "md"
            }];
        return {
          type: "bubble",
          size: "kilo",
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "text",
                text: "📰 持股重大新聞",
                weight: "bold",
                size: "sm",
                color: "#B45309"
              },
              {
                type: "text",
                text: x.code + (x.name && x.name !== x.code ? " " + x.name : ""),
                weight: "bold",
                size: "xl",
                wrap: true
              },
              {
                type: "separator",
                margin: "md"
              }
            ].concat(rows)
          }
        };
      })
    }
  };
}

async function buildHoldingsNewsPayload(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes)
    .filter(function(code) {
      return episodes[code].openEpisode && episodes[code].openEpisode.qty > 0.0001;
    })
    .sort();

  if (!codes.length) {
    return {
      holdings: [],
      text: "📰 持股重大新聞｜" + todayTW() + "\n目前沒有持股"
    };
  }

  const results = new Array(codes.length);
  let cursor = 0;

  // 控制最多 3 個並行請求，降低外部新聞服務負擔。
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= codes.length) return;
      const code = codes[i];
      const name = portfolio.getName(code) || code;
      const articles = await getStockNews(code, name, 6);
      results[i] = { code, name, articles: articles || [] };
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(3, codes.length); i++) workers.push(worker());

  try {
    await withTimeout(Promise.all(workers), 24000, "holdings news batch");
  } catch (err) {
    console.error("[持股新聞] 整批逾時:", err.message);
  }

  const holdings = codes.map(function(code, i) {
    return results[i] || { code, name: portfolio.getName(code) || code, articles: [] };
  });

  // 全部候選新聞依發布時間由新到舊排序，再做全域最多 15 則配置；
  // 同一檔最多 3 則，沒有重大新聞的持股仍保留卡片並顯示「無重大公司面新聞」。
  const candidates = [];
  holdings.forEach(function(h) {
    (h.articles || []).forEach(function(a) {
      candidates.push({ code: h.code, article: a });
    });
  });
  candidates.sort(function(a, b) {
    return (b.article.timestamp || 0) - (a.article.timestamp || 0);
  });

  const selectedByCode = {};
  let total = 0;
  for (const item of candidates) {
    if (total >= 15) break;
    const arr = selectedByCode[item.code] || (selectedByCode[item.code] = []);
    if (arr.length >= 3) continue;
    arr.push(item.article);
    total++;
  }

  holdings.forEach(function(h) {
    h.articles = selectedByCode[h.code] || [];
  });

  return {
    holdings,
    text: "📰 持股重大新聞｜" + todayTW() + "\n" +
      "目前持股 " + holdings.length + " 檔｜每檔最多 3 則｜總數最多 15 則｜近 7 天公司面重大新聞"
  };
}

module.exports = {
  getStockNews,
  buildSingleStockNewsReport,
  buildHoldingsNewsReport,
  buildHoldingsNewsPayload,
  buildHoldingsNewsFlex
};
