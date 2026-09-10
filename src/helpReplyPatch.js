const line = require("@line/bot-sdk");

const MessagingApiClient = line.messagingApi.MessagingApiClient;
const previousReplyMessage = MessagingApiClient.prototype.replyMessage;

const HELP_TEXT = [
  "📋 LINE 股票 Bot 指令",
  "────────────────────",
  "",
  "【📊 持股查詢】",
  "持股",
  "→ 單張 Flex 卡查看全部目前持股、均價、現價、報酬率、成本與未實現損益",
  "",
  "庫存持股明細",
  "持股明細",
  "→ 查看全部持股的完整買進紀錄、日期、時間、建議價位與成交價",
  "",
  "明細 6239",
  "→ 查看指定股票的全部買賣紀錄",
  "",
  "明細 6239 進階組",
  "→ 只查看指定組別的交易紀錄",
  "",
  "【✅ 老師訊號確認】",
  "待確認",
  "→ 查看 AI 已偵測、但尚未正式寫入的買賣訊號",
  "",
  "確認 6669",
  "→ 用系統抓到的訊號價格正式記錄該筆交易",
  "",
  "確認 6669 2385",
  "→ 改用你指定的價格正式記錄",
  "",
  "確認全部",
  "→ 一次確認所有已有價格的待確認訊號",
  "",
  "【📝 手動買賣】",
  "買 6239 2026-09-10",
  "→ 以該日收盤價記錄買入",
  "",
  "買 6239 2026-09-10 10:20",
  "→ 以指定時間附近的歷史價格記錄買入",
  "",
  "買 6239 2026-09-10 280",
  "→ 以指定價格 280 記錄買入",
  "",
  "賣 6239 2026-09-10",
  "→ 以該日價格賣出目前持股",
  "",
  "賣 6239 2026-09-10 一半",
  "→ 賣出目前持股的一半",
  "",
  "賣 6239 2026-09-10 280",
  "→ 以指定價格 280 記錄賣出",
  "",
  "💡 買／賣指令最後可加：基本組 或 進階組",
  "例：買 6239 2026-09-10 280 進階組",
  "",
  "【🔎 股價 / 資訊】",
  "查股 2330",
  "→ 查目前股價",
  "",
  "查股 2330 2026-09-10",
  "→ 查指定日期價格",
  "",
  "查股 2330 2026-09-10 10:20",
  "→ 查指定日期與時間的歷史價格",
  "",
  "新聞 2330",
  "→ AI 簡短整理公司業務、概念與近期資訊",
  "",
  "【🛠 資料調整】",
  "調整 6239 2026-09-10 280",
  "→ 修改該日一筆買／賣紀錄的價格",
  "",
  "取消 6239 2026-09-10",
  "→ 刪除該日一筆交易紀錄",
  "",
  "名稱 6239 力成",
  "→ 設定股票代號對應名稱",
  "",
  "備份",
  "→ 輸出目前買賣紀錄的文字備份",
  "",
  "【🔐 管理指令】",
  "打包資料庫",
  "→ 產生完整 buys / sells JSON 匯出連結，供外部備份或分析",
  "",
  "強制對齊持股",
  "→ 依 2026-09-10 定稿快照重建目前庫存；屬高風險資料操作",
  "",
  "清空所有交易紀錄",
  "→ 清空 buys / sells；需再次輸入「清空所有交易紀錄 我確定」",
  "",
  "清除回補資料",
  "→ 清除舊回補 / 校正來源資料",
  "",
  "────────────────────",
  "一般最常用：持股｜持股明細｜待確認｜確認 代號｜查股 代號｜明細 代號"
].join("\n");

MessagingApiClient.prototype.replyMessage = async function patchedHelpReply(args) {
  const messages = args && args.messages;
  const isOldHelp = Array.isArray(messages) && messages.length === 1 &&
    messages[0] && messages[0].type === "text" &&
    typeof messages[0].text === "string" &&
    messages[0].text.indexOf("📋 指令一覽") === 0;

  if (isOldHelp) {
    return previousReplyMessage.call(this, Object.assign({}, args, {
      messages: [{ type: "text", text: HELP_TEXT }]
    }));
  }

  return previousReplyMessage.call(this, args);
};

module.exports = { HELP_TEXT };
