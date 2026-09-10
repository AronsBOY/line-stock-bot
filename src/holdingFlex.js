const { fetchMultipleStocks } = require("./stockPrice");

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function fmtMoney(n) {
  return Math.round(Number(n)).toLocaleString("en-US");
}

function fmtShares(lots) {
  return Math.round(Number(lots) * 1000).toLocaleString("en-US");
}

function weightedAverage(entries) {
  const qty = entries.reduce(function (s, e) { return s + Number(e.qty || 0); }, 0);
  if (!qty) return 0;
  return entries.reduce(function (s, e) { return s + Number(e.price || 0) * Number(e.qty || 0); }, 0) / qty;
}

function todayTW() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const m = {};
  p.forEach(function (x) { m[x.type] = x.value; });
  return m.year + "-" + m.month + "-" + m.day;
}

function weekday(dateStr) {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  const d = new Date(dateStr + "T12:00:00Z");
  return names[d.getUTCDay()];
}

function text(value, size, weight, color, align, flex) {
  const o = { type: "text", text: String(value), size: size || "sm", color: color || "#333333", wrap: false };
  if (weight) o.weight = weight;
  if (align) o.align = align;
  if (flex != null) o.flex = flex;
  return o;
}

async function buildHoldingFlex(portfolio) {
  const episodes = await portfolio.getAllEpisodes();
  const codes = Object.keys(episodes).filter(function (c) {
    return episodes[c].openEpisode && episodes[c].openEpisode.qty > 0.0001;
  }).sort();

  const prices = await fetchMultipleStocks(codes);
  let totalCost = 0;
  let totalPnl = 0;

  const rows = codes.map(function (code) {
    const ep = episodes[code].openEpisode;
    const buys = ep.entries.filter(function (e) { return e.type === "買"; });
    const qty = round2(ep.qty);
    const avg = weightedAverage(buys);
    const cost = avg * qty * 1000;
    const p = prices[code];
    const cur = p && p.price != null ? Number(p.price) : null;
    const pnl = cur != null ? (cur - avg) * qty * 1000 : null;
    const pct = cur != null && avg ? (cur - avg) / avg * 100 : null;
    totalCost += cost;
    if (pnl != null) totalPnl += pnl;
    return {
      code, name: portfolio.getName(code) || code, buys: buys.length, qty, avg, cost, cur, pnl, pct
    };
  });

  const date = todayTW();
  const bodyContents = [];

  rows.forEach(function (r, i) {
    if (i > 0) bodyContents.push({ type: "separator", margin: "md", color: "#E5E7EB" });
    bodyContents.push({
      type: "box", layout: "vertical", margin: i ? "md" : "none", spacing: "xs",
      action: { type: "message", label: "查看 " + r.code + " 明細", text: "明細 " + r.code },
      contents: [
        { type: "box", layout: "horizontal", contents: [
          text(r.code + " " + r.name, "sm", "bold", "#111827", null, 3),
          text(r.pct == null ? "--" : ((r.pct >= 0 ? "▲ " : "▼ ") + Math.abs(r.pct).toFixed(2) + "%"), "sm", "bold", r.pct == null ? "#9CA3AF" : (r.pct >= 0 ? "#D32F2F" : "#16803C"), "end", 2)
        ]},
        { type: "box", layout: "horizontal", contents: [
          text("買 " + r.buys + "次｜" + fmtShares(r.qty) + "股", "xs", null, "#6B7280", null, 3),
          text("現價 " + (r.cur == null ? "--" : r.cur), "xs", null, "#374151", "end", 2)
        ]},
        { type: "box", layout: "horizontal", contents: [
          text("均價 " + r.avg.toFixed(2), "xs", null, "#6B7280", null, 2),
          text("成本 " + fmtMoney(r.cost), "xs", null, "#6B7280", "center", 3),
          text(r.pnl == null ? "損益 --" : ((r.pnl >= 0 ? "+" : "") + fmtMoney(r.pnl)), "xs", "bold", r.pnl == null ? "#9CA3AF" : (r.pnl >= 0 ? "#D32F2F" : "#16803C"), "end", 2)
        ]}
      ]
    });
  });

  return {
    type: "flex",
    altText: "持股總覽 " + date,
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box", layout: "vertical", paddingAll: "18px", spacing: "xs",
        contents: [
          text("📊 持股總覽", "xl", "bold", "#111827"),
          text(date + "（" + weekday(date) + "）｜共 " + rows.length + " 檔", "sm", null, "#6B7280")
        ]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
        contents: bodyContents
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "separator", color: "#D1D5DB" },
          { type: "box", layout: "horizontal", margin: "md", contents: [
            text("總成本", "sm", "bold", "#374151", null, 2),
            text(fmtMoney(totalCost) + " 元", "sm", "bold", "#111827", "end", 3)
          ]},
          { type: "box", layout: "horizontal", contents: [
            text("未實現損益", "sm", "bold", "#374151", null, 2),
            text((totalPnl >= 0 ? "+" : "") + fmtMoney(totalPnl) + " 元", "sm", "bold", totalPnl >= 0 ? "#D32F2F" : "#16803C", "end", 3)
          ]},
          text("點任一股票可查看買進明細", "xxs", null, "#9CA3AF", "center")
        ]
      }
    }
  };
}

module.exports = { buildHoldingFlex };
