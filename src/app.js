require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { parseSingleMessage } = require("./signalParser");
const { fetchStockPrice, fetchHistoricalPrice, fetchMultipleStocks, formatFlexMessage } = require("./stockPrice");
const { setupScheduler, addSignal } = require("./scheduler");
const portfolio = require("./portfolio");
const pendingSignals = require("./pendingSignals");
const { migrate } = require("./migrate");
// historicalSignals.js（276筆歷史訊號）不再由 LINE Bot 讀取/回補/模擬——
// 保留該檔案在repo裡當純資料封存，需要結算/歷史分析改請 Claude 用「打包資料庫」匯出的DB資料處理。

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use("/webhook", line.middleware(lineConfig));
app.get("/", function(req, res) { res.json({ status: "running" }); });

// 資料庫匯出用的簡易保護端點：不透過 LINE 推送（LINE推播有自己的頻率/額度限制，
// 大JSON用pushMessage分批送很容易撞429），改直接開一個帶token驗證的HTTP端點，
// 讓 Claude 對話視窗能用這個連結直接讀取，不受 LINE 訊息限制影響。
app.get("/export/trades", async function(req, res) {
  const token = process.env.EXPORT_TOKEN;
  if (!token || req.query.token !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const json = await portfolio.exportAllTradesJSON();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isTimeFormat(str) { return /^\d{1,2}:\d{2}$/.test(str); }
function isPriceFormat(str) { return /^[\d.]+$/.test(str); }
function isTeacher(name) {
  const t = process.env.SIGNAL_SENDER_NAME || "";
  if (!t) return false;
  return name.includes(t) || t.includes(name);
}
function isAdmin(name) {
  // 這三個管理指令（回補歷史/模擬帳戶）除了老師本人，也允許 ADMIN_NAMES 環境變數裡列出的人
  if (isTeacher(name)) return true;
  const admins = (process.env.ADMIN_NAMES || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return admins.some(function (a) { return name.includes(a) || a.includes(name); });
}
function extractGroupTag(text) {
  // 從指令句尾抓「基本組」「進階組」，抓到就從文字裡拿掉，不影響原本指令解析
  const m = text.match(/\s*(基本組|進階組)\s*$/);
  if (m) return { text: text.slice(0, m.index).trim(), group: m[1] };
  return { text: text, group: null };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function chunkMessage(text, maxLen) {
  maxLen = maxLen || 4500; // 保留餘裕，LINE單則上限約5000字
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function pushLongMessage(to, text) {
  const chunks = chunkMessage(text);
  // LINE 一次 pushMessage 最多只能帶 5 則，超過的部分分批送、中間留一點間隔
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5).map(function (c) { return { type: "text", text: c }; });
    await lineClient.pushMessage({ to: to, messages: batch });
    if (i + 5 < chunks.length) await sleep(500);
  }
}

async function replyLongMessage(replyToken, to, text) {
  const chunks = chunkMessage(text);
  const firstBatch = chunks.slice(0, 5).map(function (c) { return { type: "text", text: c }; });
  await lineClient.replyMessage({ replyToken: replyToken, messages: firstBatch });
  if (chunks.length > 5) await pushLongMessage(to, chunks.slice(5).join("\n\n"));
}

function buildSignalConfirmFlex(sig, detectedGroup, dateStr, timeStr, price) {
  const code = sig.stock_code;
  const name = sig.stock_name || portfolio.getName(code) || "";
  const actionText = sig.action === "賣出" ? "賣出" : "買入";
  const detailRows = [
    { type: "text", text: "時間：" + dateStr + " " + timeStr, size: "sm", color: "#666666", wrap: true },
  ];
  if (sig.suggested_price) {
    detailRows.push({ type: "text", text: "老師建議價：" + sig.suggested_price, size: "sm", color: "#444444", wrap: true, margin: "sm" });
  }
  detailRows.push({ type: "text", text: "歷史成交價：" + price, size: "sm", color: "#111111", weight: "bold", wrap: true, margin: "sm" });
  if (sig.original) {
    detailRows.push({ type: "text", text: "訊息：" + sig.original, size: "xs", color: "#777777", wrap: true, margin: "md" });
  }

  return {
    type: "flex",
    altText: "偵測到訊號 " + code + " " + name + " " + actionText,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📊 偵測到訊號", weight: "bold", size: "lg" },
          { type: "text", text: code + " " + name + " " + actionText + (detectedGroup ? "【" + detectedGroup + "】" : ""), weight: "bold", size: "xl", wrap: true, margin: "md" },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", contents: detailRows, margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            action: {
              type: "postback",
              label: "✅ 以 " + price + " 確認" + actionText,
              data: "action=confirm_signal&code=" + encodeURIComponent(code),
            },
          },
        ],
      },
    },
  };
}

async function handleSignalPostback(event) {
  const data = new URLSearchParams((event.postback && event.postback.data) || "");
  if (data.get("action") !== "confirm_signal") return false;

  const code = data.get("code");
  const replyToken = event.replyToken;
  if (!code) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "確認失敗：缺少股票代號" }] });
    return true;
  }

  const pending = await pendingSignals.getPending(code);
  if (!pending) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "這筆 " + code + " 訊號已經確認過，或目前已不在待確認清單。" }] });
    return true;
  }
  if (!pending.price) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "這筆 " + code + " 尚未取得成交價，請改用：確認 " + code + " 實際成交價" }] });
    return true;
  }

  if (pending.action === "買入") {
    await portfolio.addBuy(code, code, pending.date, pending.price, pending.time, pending.original, pending.group, pending.suggestedPrice, "signal");
  } else {
    await portfolio.addSell(code, code, pending.date, pending.price, pending.time, pending.original, pending.group, pending.suggestedPrice, "signal");
  }
  await pendingSignals.deletePending(code);

  await lineClient.replyMessage({
    replyToken,
    messages: [{
      type: "text",
      text: "✅ 已記錄\n" + code + " " + (portfolio.getName(code) || "") + " " + pending.action + (pending.group ? "【" + pending.group + "】" : "") + "\n" +
        "日期：" + pending.date + " " + pending.time + "\n" +
        "成交價：" + pending.price + "（歷史）",
    }],
  });
  return true;
}

async function handleEvent(event) {
  if (event.type === "postback") {
    try {
      await handleSignalPostback(event);
    } catch (err) {
      console.error("[Postback]", err.message);
      try {
        await lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: "按鈕確認失敗：" + err.message }] });
      } catch (e) {}
    }
    return;
  }
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
  const senderId = event.source.userId;
  const replyToken = event.replyToken;

  let senderName = "群組成員";
  try {
    if (event.source.groupId) {
      const p = await lineClient.getGroupMemberProfile(event.source.groupId, senderId);
      senderName = p.displayName;
    } else {
      const p = await lineClient.getProfile(senderId);
      senderName = p.displayName;
    }
  } catch (e) {}

  const now = new Date();
  const twNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const dateStr = twNow.toLocaleDateString("sv-SE");
  const timeStr = twNow.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  console.log("[" + timeStr + "] " + senderName + ": " + text);

  // ── 查股 ──
  const queryMatch = text.match(/^查股\s+(\d{4,6})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (queryMatch) {
    const code = queryMatch[1], qDate = queryMatch[2] || null, qTime = queryMatch[3] || null;
    const p = await fetchStockPrice(code, qDate, qTime);
    if (p) {
      const arrow = p.isUp ? "▲" : "▼";
      const label = qDate ? (qTime ? qTime + " 歷史價" : "收盤價") : p.marketStatus;
      const name = portfolio.getName(code) || p.longName || code;
      const msg = code + " " + name + "\n" + label + "：" + p.price + " TWD\n" +
        arrow + " " + Math.abs(p.change) + " (" + Math.abs(p.changePct) + "%)\n" +
        (p.high ? "最高：" + p.high + "　最低：" + p.low + "\n" : "") + p.timestamp;
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } else {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得 " + queryMatch[1] + " 的資料" }] });
    }
    return;
  }

  // ── 股票名稱設定 ──
  const nameMatch = text.match(/^名稱\s+(\d{4,6})\s+(.+)$/);
  if (nameMatch) {
    const result = await portfolio.setName(nameMatch[1], nameMatch[2].trim());
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 個股資訊 / 新聞 ──
  const newsMatch = text.match(/^新聞\s+(\d{4,6})$/);
  if (newsMatch) {
    const code = newsMatch[1];
    const name = portfolio.getName(code) || code;
    try {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢 " + code + " " + name + " 資訊中..." }] });
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 500,
        messages: [{ role: "user", content: "請用繁體中文簡短介紹台股 " + code + " " + name + "，包含：1.主要業務 2.所屬概念股族群 3.近期重要消息（你知道的），200字以內。" }],
      });
      const info = resp.content[0].text;
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "📋 " + code + " " + name + "\n" + "─".repeat(18) + "\n" + info }] });
    } catch (err) {
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "無法取得 " + code + " 的資訊" }] });
    }
    return;
  }

  // ── 確認訊號 ──
  const confirmExtract = extractGroupTag(text);
  const confirmMatch = confirmExtract.text.match(/^確認\s+(\d{4,6})(?:\s+([\d.]+))?$/);
  if (confirmMatch) {
    const code = confirmMatch[1];
    const manualPrice = confirmMatch[2] ? parseFloat(confirmMatch[2]) : null;
    const pending = await pendingSignals.getPending(code);
    if (!pending) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "找不到 " + code + " 的待確認訊號" }] });
      return;
    }
    const finalPrice = manualPrice || pending.price;
    if (!finalPrice) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "請提供成交價：\n確認 " + code + " 價格" }] });
      return;
    }
    const finalGroup = confirmExtract.group || pending.group;
    if (pending.action === "買入") await portfolio.addBuy(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup, pending.suggestedPrice, "signal");
    else await portfolio.addSell(code, code, pending.date, finalPrice, pending.time, pending.original, finalGroup, pending.suggestedPrice, "signal");
    await pendingSignals.deletePending(code);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
      "✅ 已記錄\n" + code + " " + (portfolio.getName(code) || "") + " " + pending.action + (finalGroup ? "【" + finalGroup + "】" : "") + "\n" +
      "日期：" + pending.date + " " + pending.time + "\n" +
      "成交價：" + finalPrice + (manualPrice ? "（手動）" : "（歷史）")
    }] });
    return;
  }

  // ── 確認全部 ──
  if (text === "確認全部") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const failed = [];
    for (const p of all) {
      if (!p.price) { failed.push(p.code); continue; }
      if (p.action === "買入") await portfolio.addBuy(p.code, p.code, p.date, p.price, p.time, p.original, p.group, p.suggestedPrice, "signal");
      else await portfolio.addSell(p.code, p.code, p.date, p.price, p.time, p.original, p.group, p.suggestedPrice, "signal");
      await pendingSignals.deletePending(p.code);
    }
    let msg = "✅ 已記錄 " + (all.length - failed.length) + " 筆";
    if (failed.length) msg += "\n⚠ 缺少股價：\n" + failed.map(function(c) { return "確認 " + c + " 價格"; }).join("\n");
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 待確認清單 ──
  if (text === "待確認") {
    const all = await pendingSignals.getAllPending();
    if (!all.length) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "目前沒有待確認的訊號" }] });
      return;
    }
    const list = all.map(function(p) {
      return p.code + " " + (portfolio.getName(p.code) || "") + " " + p.action + (p.group ? "【" + p.group + "】" : "") +
        (p.price ? " @" + p.price : " ⚠無股價") + "（" + p.date + " " + p.time + "）";
    }).join("\n");
    await replyLongMessage(replyToken, sourceId, "待確認訊號：\n" + list + "\n\n可直接點訊號卡片的確認按鈕；舊的「確認 代號」或「確認全部」仍可使用。");
    return;
  }

  // ── 備份 ──
  if (text === "備份") {
    const backup = await portfolio.getBackup();
    await replyLongMessage(replyToken, sourceId, backup);
    return;
  }

  // ── 買入 ──
  const buyExtract = extractGroupTag(text);
  const buyMatch = buyExtract.text.match(/^買\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (buyMatch) {
    const code = buyMatch[1], bDate = buyMatch[2], last = buyMatch[3] ? buyMatch[3].trim() : null;
    let price = null;
    if (!last) { const p = await fetchHistoricalPrice(code, bDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, bDate, last); price = p ? p.price : null; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價，請手動填入：\n買 " + code + " " + bDate + " 價格" }] }); return; }
    await portfolio.addBuy(code, code, bDate, price, null, null, buyExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄買入\n" + code + " " + (portfolio.getName(code) || "") + (buyExtract.group ? "【" + buyExtract.group + "】" : "") + "\n" + bDate + " @" + price }] });
    return;
  }

  // ── 賣出 ──
  const sellExtract = extractGroupTag(text);
  const sellMatch = sellExtract.text.match(/^賣\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (sellMatch) {
    const code = sellMatch[1], sDate = sellMatch[2], last = sellMatch[3] ? sellMatch[3].trim() : null;
    let price = null, qtyStr = "全部";
    if (!last) { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; }
    else if (isTimeFormat(last)) { const p = await fetchHistoricalPrice(code, sDate, last); price = p ? p.price : null; }
    else if (last === "一半" || last === "全部") { const p = await fetchHistoricalPrice(code, sDate, null); price = p ? p.price : null; qtyStr = last; }
    else if (isPriceFormat(last)) { price = parseFloat(last); }
    if (!price) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "無法取得股價" }] }); return; }
    const { remaining } = await portfolio.getRemaining(code);
    if (remaining <= 0) { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: code + " 目前無持股可賣" }] }); return; }
    let qty = remaining;
    if (qtyStr === "一半") qty = remaining / 2; // 精準一半，例如3張賣一半=1.5張，不四捨五入
    else if (!isNaN(parseInt(qtyStr))) qty = Math.min(parseFloat(qtyStr), remaining);
    await portfolio.addSell(code, code, sDate, price, null, null, sellExtract.group, null, "manual", null, qty);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出\n" + code + " " + (portfolio.getName(code) || "") + (sellExtract.group ? "【" + sellExtract.group + "】" : "") + " ×" + qty + "張 @" + price + "\n剩餘：" + (remaining - qty) + " 張" }] });
    return;
  }

  // ── 新增（舊格式）──
  const fullBuyExtract = extractGroupTag(text);
  const fullBuyMatch = fullBuyExtract.text.match(/^新增\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (fullBuyMatch) {
    await portfolio.addBuy(fullBuyMatch[1], fullBuyMatch[1], fullBuyMatch[2], fullBuyMatch[3], null, null, fullBuyExtract.group);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已新增買入 " + fullBuyMatch[1] + " " + fullBuyMatch[2] + " @" + fullBuyMatch[3] }] });
    return;
  }

  // ── 賣出（舊格式）──
  const fullSellExtract = extractGroupTag(text);
  const fullSellMatch = fullSellExtract.text.match(/^賣出\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)(?:\s+(.+))?/);
  if (fullSellMatch) {
    const code = fullSellMatch[1], fsDate = fullSellMatch[2], fsPrice = fullSellMatch[3];
    const qtyStr = fullSellMatch[4] ? fullSellMatch[4].trim() : "1";
    const { remaining } = await portfolio.getRemaining(code);
    let qty = 1;
    if (qtyStr === "一半") qty = remaining / 2;
    else if (qtyStr === "全部") qty = remaining;
    else qty = Math.min(parseFloat(qtyStr) || 1, remaining);
    await portfolio.addSell(code, code, fsDate, fsPrice, null, null, fullSellExtract.group, null, "manual", null, qty);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "✅ 已記錄賣出 " + code + " ×" + qty + "張 @" + fsPrice }] });
    return;
  }

  // ── 調整價格 ──
  const adjustMatch = text.match(/^調整\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)/);
  if (adjustMatch) {
    const result = await portfolio.adjustPrice(adjustMatch[1], adjustMatch[2], adjustMatch[3]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 取消 ──
  const cancelMatch = text.match(/^取消\s+(\d{4,6})\s+(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) {
    const result = await portfolio.cancelEntry(cancelMatch[1], cancelMatch[2]);
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: result }] });
    return;
  }

  // ── 持股 ──
  // 重新設計：只回傳「庫存持股」本身（代號/張數/均價/成本），不查即時股價、不算損益、不掃歷史結算。
  // 查詢範圍 = 固定10檔(portfolio.WATCHLIST_CODES) + 最近14天內有買賣紀錄的代號，純DB加總，運算最輕量。
  if (text === "持股" || text === "我的持股") {
    try {
      let codes = portfolio.WATCHLIST_CODES;
      try {
        const recentCodes = await portfolio.getRecentActiveCodes(14);
        codes = Array.from(new Set(portfolio.WATCHLIST_CODES.concat(recentCodes)));
      } catch (recentErr) {
        console.error("[持股] 查最近活躍代號失敗，改只用固定10檔：", recentErr.message);
      }
      const list = await portfolio.getSimpleInventory(codes);
      const msg = portfolio.formatSimpleInventory(list);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } catch (err) {
      console.error("[持股]", err.message);
      try { await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "查詢持股時發生錯誤：" + err.message }] }); } catch (e) {}
    }
    return;
  }

  // ── 打包資料庫（僅限老師本人或管理員）──
  // 改成回傳一個HTTP匯出連結，不透過LINE推送大JSON——pushMessage分批送大量文字很容易撞LINE自己的429/額度限制
  // （今天「打包資料庫」卡住不動就是這個原因，不是報價API的問題）。連結貼給 Claude 就能直接讀取。
  if (text === "打包資料庫") {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用（偵測到你目前的名稱是：「" + senderName + "」，請確認跟 ADMIN_NAMES 有對上）" }] });
      return;
    }
    const token = process.env.EXPORT_TOKEN;
    if (!token) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "尚未設定 EXPORT_TOKEN，請先在 Railway 環境變數加上 EXPORT_TOKEN 再試一次" }] });
      return;
    }
    const base = process.env.BASE_URL || "https://web-production-cec15.up.railway.app";
    const url = base + "/export/trades?token=" + token;
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "📦 資料庫匯出連結(請勿外流，含存取權杖)：\n" + url + "\n\n把這個連結貼給 Claude，它可以直接讀取全部買賣紀錄。" }] });
    return;
  }

  // ── 明細（條列式查看每筆買賣）──
  const detailMatch = text.match(/^明細\s+(\d{4,6})(?:\s+(基本組|進階組))?$/);
  if (detailMatch) {
    const code = detailMatch[1];
    const groupFilter = detailMatch[2] || null;
    const entries = await portfolio.getTransactionList(code, groupFilter);
    const msg = portfolio.formatTransactionList(code, portfolio.getName(code), entries);
    await replyLongMessage(replyToken, sourceId, msg);
    return;
  }

  // ── 結算 ──
  // 已移除：改由 Claude 對話視窗處理。先打「打包資料庫」匯出資料貼給 Claude 分析結算/損益。
  if (text === "結算" || text === "已結算") {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "「結算」已經搬到 Claude 對話視窗處理囉，LINE Bot 這邊只提供「持股」（目前庫存）。\n要算結算/損益的話：先打「打包資料庫」把資料匯出，貼到 Claude 對話視窗請它幫你算。" }] });
    return;
  }

  // ── 強制對齊持股（僅限老師本人或管理員，直接照給定名單強制結清其他所有持股）──
  if (text === "強制對齊持股") {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用（偵測到你目前的名稱是：「" + senderName + "」，請確認跟 ADMIN_NAMES 有對上）" }] });
      return;
    }
    const KEEP_CODES = portfolio.WATCHLIST_CODES; // 聯亞/鼎元/順德/環宇/富世達/聯茂/精材/尖點/力成/啟碁
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "開始強制對齊，只保留這10檔：聯亞/鼎元/順德/環宇/富世達/聯茂/精材/尖點/力成/啟碁，其他持股會用現在的即時股價強制結清，請稍候..." }] });
    try {
      const result = await portfolio.forceAlignHoldings(KEEP_CODES, function(code) { return fetchStockPrice(code, null, null); });
      let msg = "✅ 強制對齊完成\n" + "─".repeat(20) + "\n";
      msg += "結清：" + result.closed.length + " 檔\n";
      result.closed.forEach(function(c) { msg += "  " + c.code + " ×" + c.qty + "張 @" + c.price + "\n"; });
      if (result.failed.length) msg += "查無股價失敗：" + result.failed.join(", ") + "\n";
      msg += "\n輸入「持股」查看結果";
      await pushLongMessage(sourceId, msg);
    } catch (err) {
      console.error("[強制對齊持股]", err.message);
      await lineClient.pushMessage({ to: sourceId, messages: [{ type: "text", text: "強制對齊時發生錯誤：" + err.message }] });
    }
    return;
  }

  // ── 清空所有交易紀錄（僅限老師本人或管理員，危險操作：buys/sells 全部清空，不分來源、含手動輸入的，無法復原，需二次確認）──
  if (text === "清空所有交易紀錄") {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用（偵測到你目前的名稱是：「" + senderName + "」，請確認跟 ADMIN_NAMES 有對上）" }] });
      return;
    }
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "⚠️ 這會清空「所有」買賣紀錄（含手動輸入的），無法復原。\n確定要執行的話，請輸入：清空所有交易紀錄 我確定" }] });
    return;
  }
  if (text === "清空所有交易紀錄 我確定") {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用（偵測到你目前的名稱是：「" + senderName + "」，請確認跟 ADMIN_NAMES 有對上）" }] });
      return;
    }
    try {
      const result = await portfolio.wipeAllTrades();
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
        "✅ 已清空所有交易紀錄\n刪除買入：" + result.buys + " 筆\n刪除賣出：" + result.sells + " 筆\n\n之後手動打「買/賣」指令記錄即可"
      }] });
    } catch (err) {
      console.error("[清空所有交易紀錄]", err.message);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "清空時發生錯誤：" + err.message }] });
    }
    return;
  }

  // ── 清除回補資料（僅限老師本人或管理員，安全刪除，不會動到手動輸入的紀錄）──
  if (text === "清除回補資料") {
    if (!isAdmin(senderName)) {
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "此指令僅限老師本人或管理員使用（偵測到你目前的名稱是：「" + senderName + "」，請確認跟 ADMIN_NAMES 有對上）" }] });
      return;
    }
    try {
      const result = await portfolio.deleteLegacyBackfill();
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text:
        "✅ 已清除「回補歷史」寫入的資料\n刪除買入：" + result.buys + " 筆\n刪除賣出：" + result.sells + " 筆\n\n（你手動打指令記錄的資料不受影響）\n可以重新輸入「回補歷史」再跑一次"
      }] });
    } catch (err) {
      console.error("[清除回補資料]", err.message);
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: "清除時發生錯誤：" + err.message }] });
    }
    return;
  }

  // ── 指令說明 ──
  if (text === "指令" || text === "help") {
    const msg =
      "📋 指令一覽\n" + "─".repeat(20) + "\n" +
      "【偵測確認】\n偵測到訊號後可直接點卡片按鈕確認；舊指令仍保留：確認 5475　確認 5475 158　確認全部　待確認\n\n" +
      "【買賣記錄】\n買 3533 2026-04-23 10:04\n買 3533 2026-04-23\n買 3533 2026-04-23 2445\n賣 3533 2026-04-23 一半\n賣 3533 2026-04-23 2445\n\n" +
      "【調整】\n調整 3533 2026-04-23 2500\n取消 3533 2026-04-23\n名稱 2327 國巨\n\n" +
      "【組別分類】\n買/賣/新增/賣出 指令結尾可加「基本組」或「進階組」\n例：買 3533 2026-04-23 2445 進階組\n\n" +
      "【查詢】\n查股 2330\n查股 2330 2026-04-23\n查股 2330 2026-04-23 10:04\n新聞 2330\n明細 3533\n明細 3533 進階組\n持股（目前庫存，不查即時股價，運算輕量）\n備份\n\n" +
      "【結算/歷史分析】\n已搬到 Claude 對話視窗處理，LINE Bot 不再跑這類重運算。\n先打「打包資料庫」匯出資料，貼到 Claude 對話視窗請它算結算/損益。\n\n" +
      "【管理】\n打包資料庫（僅限老師本人，匯出全部buys/sells成JSON，貼給Claude保存/分析）\n清空所有交易紀錄（僅限老師本人，全部buys/sells砍掉重來，需輸入「我確定」二次確認）\n清除回補資料（僅限老師本人）\n強制對齊持股（僅限老師本人）";
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }

  // ── 老師訊號偵測 ──
  if (!isTeacher(senderName)) return;

  try {
    const signals = await parseSingleMessage(senderName, timeStr, text);
    if (signals.length === 0) return;
    const detectedGroup = pendingSignals.detectGroup(text);
    const msgs = [];
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      const code = sig.stock_code;
      const p = await fetchHistoricalPrice(code, dateStr, timeStr);
      const price = p ? p.price : null;
      await pendingSignals.setPending(code, { action: sig.action, date: dateStr, time: timeStr, price, suggestedPrice: sig.suggested_price, original: sig.original, group: detectedGroup });

      if (price) {
        msgs.push(buildSignalConfirmFlex(sig, detectedGroup, dateStr, timeStr, price));
      } else {
        const msg =
          "📊 偵測到訊號\n" + "━".repeat(16) + "\n" +
          code + " " + (sig.stock_name || portfolio.getName(code) || "") + " " + sig.action + (detectedGroup ? "【" + detectedGroup + "】" : "") + "\n" +
          "時間：" + dateStr + " " + timeStr + "\n" +
          (sig.suggested_price ? "老師建議價：" + sig.suggested_price + "\n" : "") +
          "⚠ 股價查詢失敗\n" +
          "訊息：" + sig.original + "\n" + "━".repeat(16) + "\n" +
          "請用「確認 " + code + " 實際成交價」記錄";
        msgs.push({ type: "text", text: msg });
      }
    }
    if (msgs.length > 0) await lineClient.replyMessage({ replyToken, messages: msgs.slice(0, 5) });
  } catch (err) { console.error("[老師訊號]", err.message); }
}

app.post("/webhook", async function(req, res) {
  res.status(200).json({ ok: true });
  const events = req.body.events || [];
  await Promise.allSettled(events.map(handleEvent));
});

const PORT = process.env.PORT || 3000;

(async function start() {
  try {
    await migrate();
    await portfolio.loadNameCache();
    app.listen(PORT, function() {
      console.log("LINE Stock Bot 啟動 Port:" + PORT);
      setupScheduler(lineClient);
    });
  } catch (err) {
    console.error("[Startup] 啟動失敗：", err.message);
    process.exit(1);
  }
})();
