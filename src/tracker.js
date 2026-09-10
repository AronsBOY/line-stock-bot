#!/usr/bin/env node
/**
 * portfolio-tracker.js
 * ------------------------------------------------------------------
 * 獨立的持股追蹤小工具(跟之前改的「強哥股票Bot」line-stock-bot repo無關，
 * 這是給你自己另一個進階組追蹤用的全新精簡版)。
 *
 * 設計核心：偵測到訊號 → 不會自動記錄 → 一定要你輸入「確認」才會寫進庫存。
 * 資料庫只保留 2026-09-10 定稿的 9 檔庫存起始資料，更早的歷史都已清空。
 *
 * 用法(互動式 CLI，在終端機執行):
 *   node tracker.js
 *
 * 指令：
 *   訊號 <文字>                 → 嘗試從一段文字偵測買/賣訊號，存成「待確認」
 *   確認 <代號>                 → 用偵測到的價格，把待確認訊號寫入庫存
 *   確認 <代號> <價格>          → 用手動指定的價格寫入庫存(覆蓋偵測到的價格)
 *   待確認                      → 列出所有還沒確認的訊號
 *   買 <代號> <名稱> <日期> <價位或"無"> <價格>   → 直接記錄一筆買入(略過確認流程，供你手動補登)
 *   賣 <代號> <股數或"全部"> <價格>                → 賣出，股數用「股」為單位(1張=1000股)
 *   持股                        → 印出目前庫存持股(格式跟你要的一樣)
 *   調整 <代號> <第幾筆> <新價格>   → 修改某一筆買入價格
 *   取消 <代號> <第幾筆>         → 刪除某一筆買入紀錄
 *   備份                        → 把目前資料庫存成一份帶時間戳記的 JSON 備份
 *   結束                        → 離開
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DB_PATH = path.join(__dirname, "holdings.json");
const weekdayZh = ["日", "一", "二", "三", "四", "五", "六"];

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}
function todayInfo() {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, "0"), d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0"), mm = String(now.getMinutes()).padStart(2, "0");
  return { date: `${y}-${m}-${d}`, weekday: weekdayZh[now.getDay()], time: `${hh}:${mm}` };
}
function weekdayOf(dateStr) {
  const dt = new Date(dateStr + "T00:00:00");
  return isNaN(dt.getTime()) ? "無" : weekdayZh[dt.getDay()];
}

// ── 訊號偵測：只做基本的關鍵字/代號/價位擷取，抓不到就回傳 null，不會亂猜 ──
function parseSignal(text) {
  const codeMatch = text.match(/\b(\d{4,6})\b/);
  if (!codeMatch) return null;
  const code = codeMatch[1];

  const isSell = /(賣出|獲利了結|全數賣出|全數退出|停損|退出追蹤)/.test(text);
  const isBuy = /(建立.*持股|可以加碼|先追蹤|先建立|買入|加碼)/.test(text);
  const action = isSell ? "賣" : (isBuy ? "買" : null);
  if (!action) return null;

  // 價位區間：抓「數字-數字」「數字以下」「平盤」「平盤附近」等常見講法
  let priceRange = "無";
  const rangeMatch = text.match(/(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?(?:附近)?|\d+(?:\.\d+)?\s*以下|平盤(?:\d+)?(?:以下|附近)?)/);
  if (rangeMatch) priceRange = rangeMatch[1].trim();

  return { code, action, priceRange, rawText: text.trim() };
}

// ── 確認流程 ──
function addPendingSignal(db, sig) {
  db.pending = db.pending || {};
  db.pending[sig.code] = sig;
  saveDB(db);
  console.log(`📊 偵測到訊號\n代號：${sig.code}　動作：${sig.action}\n建議價位：${sig.priceRange}\n原文：${sig.rawText}\n請輸入「確認 ${sig.code}」或「確認 ${sig.code} 實際價格」來記錄`);
}

function confirmSignal(db, code, manualPrice) {
  const sig = db.pending && db.pending[code];
  if (!sig) { console.log(`⚠️ 沒有 ${code} 的待確認訊號`); return; }
  const price = manualPrice != null ? manualPrice : null;
  if (price == null) {
    console.log(`⚠️ 這則訊號沒有附帶明確成交價，請用「確認 ${code} <價格>」手動指定`);
    return;
  }
  const t = todayInfo();
  if (sig.action === "買") {
    recordBuy(db, code, sig.name || code, t.date, sig.priceRange, price, 1000, t.weekday, t.time);
  } else {
    recordSell(db, code, "全部", price);
  }
  delete db.pending[code];
  saveDB(db);
  console.log(`✅ 已確認並記錄 ${code}`);
}

// ── 買賣紀錄 ──
function recordBuy(db, code, name, date, priceRange, price, shares, weekday, time) {
  db.holdings[code] = db.holdings[code] || { name, entries: [] };
  db.holdings[code].name = db.holdings[code].name || name;
  db.holdings[code].entries.push({
    date, weekday: weekday || weekdayOf(date), time: time || "無",
    priceRange: priceRange || "無", priceType: "手動", price: Number(price), shares: shares || 1000,
  });
  saveDB(db);
}

function recordSell(db, code, sharesOrAll, price) {
  const h = db.holdings[code];
  if (!h || !h.entries.length) { console.log(`⚠️ 目前沒有 ${code} 的庫存`); return; }
  if (sharesOrAll === "全部") {
    delete db.holdings[code];
  } else {
    // 簡化：從最早的一筆開始扣減股數
    let remain = Number(sharesOrAll);
    while (remain > 0 && h.entries.length) {
      const first = h.entries[0];
      if (first.shares <= remain) { remain -= first.shares; h.entries.shift(); }
      else { first.shares -= remain; remain = 0; }
    }
    if (!h.entries.length) delete db.holdings[code];
  }
  saveDB(db);
}

// ── 顯示 ──
function formatHoldings(db) {
  const t = todayInfo();
  let out = `【持股庫存】【${t.date}(${t.weekday})】\n${"═".repeat(20)}\n`;
  const codes = Object.keys(db.holdings).sort();
  if (!codes.length) return out + "目前無庫存持股";
  for (const code of codes) {
    const h = db.holdings[code];
    const totalShares = h.entries.reduce((a, e) => a + e.shares, 0);
    const totalCost = h.entries.reduce((a, e) => a + e.shares * e.price, 0);
    const avg = totalCost / totalShares;
    out += `${code} ${h.name}　買入次數：${h.entries.length}　均價：${avg.toFixed(2)}　持股：${totalShares} 股　成本：${Math.round(totalCost).toLocaleString()} 元\n`;
    h.entries.forEach((e, i) => {
      out += `　${i + 1}. [買] ${e.date}(${e.weekday}) ${e.time}【價位】${e.priceRange}【${e.priceType}】${e.price.toFixed(2)}\n`;
    });
    out += `　現價：(未查詢，請自行比對)\n`;
  }
  out += `${"═".repeat(20)}\n總持股：${codes.length} 支\n`;
  return out;
}

// ── CLI ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("持股追蹤工具已啟動。輸入「持股」查看目前庫存，輸入「結束」離開。");
rl.setPrompt("> ");
rl.prompt();

rl.on("line", (lineRaw) => {
  const line = lineRaw.trim();
  const db = loadDB();

  if (line === "結束") { rl.close(); return; }

  if (line === "持股") {
    console.log(formatHoldings(db));
  } else if (line === "待確認") {
    const pend = db.pending || {};
    const keys = Object.keys(pend);
    console.log(keys.length ? keys.map((k) => `${k}：${pend[k].action}　${pend[k].priceRange}`).join("\n") : "目前沒有待確認訊號");
  } else if (line.startsWith("訊號 ")) {
    const text = line.slice(3).trim();
    const sig = parseSignal(text);
    if (!sig) console.log("⚠️ 沒有偵測到明確的買賣訊號(需要股票代號 + 買/賣關鍵字)");
    else addPendingSignal(db, sig);
  } else if (line.startsWith("確認 ")) {
    const parts = line.split(/\s+/);
    const code = parts[1];
    const price = parts[2] ? parseFloat(parts[2]) : null;
    confirmSignal(db, code, price);
  } else if (line.startsWith("買 ")) {
    // 買 <代號> <名稱> <日期> <價位或"無"> <價格>
    const parts = line.split(/\s+/);
    if (parts.length < 6) { console.log("格式：買 代號 名稱 日期 價位(或無) 價格"); }
    else {
      const [, code, name, date, priceRange, priceStr] = parts;
      recordBuy(db, code, name, date, priceRange === "無" ? "無" : priceRange, parseFloat(priceStr), 1000, weekdayOf(date), "無");
      console.log(`✅ 已記錄買入 ${code}`);
    }
  } else if (line.startsWith("賣 ")) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) { console.log("格式：賣 代號 股數(或全部) 價格"); }
    else {
      const [, code, sharesOrAll, priceStr] = parts;
      recordSell(db, code, sharesOrAll, parseFloat(priceStr));
      console.log(`✅ 已記錄賣出 ${code}`);
    }
  } else if (line.startsWith("調整 ")) {
    const parts = line.split(/\s+/);
    const [, code, idxStr, newPriceStr] = parts;
    const idx = parseInt(idxStr, 10) - 1;
    const h = db.holdings[code];
    if (h && h.entries[idx]) { h.entries[idx].price = parseFloat(newPriceStr); saveDB(db); console.log(`✅ 已調整 ${code} 第 ${idxStr} 筆`); }
    else console.log("⚠️ 找不到這筆紀錄");
  } else if (line.startsWith("取消 ")) {
    const parts = line.split(/\s+/);
    const [, code, idxStr] = parts;
    const idx = parseInt(idxStr, 10) - 1;
    const h = db.holdings[code];
    if (h && h.entries[idx]) { h.entries.splice(idx, 1); if (!h.entries.length) delete db.holdings[code]; saveDB(db); console.log(`✅ 已取消 ${code} 第 ${idxStr} 筆`); }
    else console.log("⚠️ 找不到這筆紀錄");
  } else if (line === "備份") {
    const backupPath = path.join(__dirname, `backup-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`✅ 已備份到 ${backupPath}`);
  } else if (line) {
    console.log("看不懂這個指令，可用：訊號 / 確認 / 待確認 / 買 / 賣 / 持股 / 調整 / 取消 / 備份 / 結束");
  }
  rl.prompt();
}).on("close", () => process.exit(0));
