const cron = require("node-cron");
const { fetchMultipleStocks } = require("./stockPrice");

const todaySignals = [];

function addSignal(signal) {
  todaySignals.push(signal);
}

async function buildDailySummary() {
  if (todaySignals.length === 0) return "今日無股票訊號記錄";
  const codes = [];
  todaySignals.forEach(function(s) { if (!codes.includes(s.stock_code)) codes.push(s.stock_code); });
  const prices = await fetchMultipleStocks(codes);
  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  let report = "今日訊號彙整\n" + now + "\n\n";
  const buys = todaySignals.filter(function(s) { return s.action === "買入"; });
  const sells = todaySignals.filter(function(s) { return s.action === "賣出"; });
  if (buys.length) {
    report += "買入 " + buys.length + " 個\n";
    buys.forEach(function(s) {
      const p = prices[s.stock_code];
      report += "  " + s.stock_code + " " + s.stock_name + " @" + s.time + " 收盤:" + (p ? p.price : "無資料") + "\n";
    });
  }
  if (sells.length) {
    report += "賣出 " + sells.length + " 個\n";
    sells.forEach(function(s) {
      const p = prices[s.stock_code];
      report += "  " + s.stock_code + " " + s.stock_name + " @" + s.time + " 收盤:" + (p ? p.price : "無資料") + "\n";
    });
  }
  return report + "\n僅供參考，非投資建議";
}

function setupScheduler(lineClient) {
  const groups = (process.env.TARGET_GROUP_IDS || "").split(",").filter(Boolean);
  if (!groups.length) { console.log("未設定TARGET_GROUP_IDS"); return; }
  const push = async function(text) {
    for (let i = 0; i < groups.length; i++) {
      try { await lineClient.pushMessage({ to: groups[i], messages: [{ type: "text", text: text }] }); }
      catch (e) { console.error("[Scheduler]", e.message); }
    }
  };
  cron.schedule("55 8 * * 1-5", function() {
    push("台股即將於 9:00 開盤！\n輸入「查股 代號」可查詢個股\n例如：查股 2330");
  }, { timezone: "Asia/Taipei" });
  cron.schedule("35 13 * * 1-5", async function() {
    const summary = await buildDailySummary();
    await push(summary);
    todaySignals.length = 0;
  }, { timezone: "Asia/Taipei" });
  console.log("定時任務啟動，群組數:" + groups.length);
}

module.exports = { setupScheduler, addSignal };
