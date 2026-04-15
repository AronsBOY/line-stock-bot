const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUY_KEYWORDS = ["買入","買進","做多","進場","布局","佈局","加碼","逢低","可以買","建議買","建立基本持股","分批買回","買回","分批佈局"];
const SELL_KEYWORDS = ["賣出","賣掉","出場","停利","停損","獲利了結","出清","逢高賣","建議賣"];

function mightHaveSignal(text) {
  const hasSentiment = BUY_KEYWORDS.some(function(k) { return text.includes(k); }) ||
    SELL_KEYWORDS.some(function(k) { return text.includes(k); });
  const hasCode = /\b\d{4,6}\b/.test(text);
  return hasSentiment || hasCode;
}

async function parseSingleMessage(sender, time, text) {
  if (!mightHaveSignal(text)) return [];
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "你是台股訊號解析專家。從訊息中精準提取股票買賣指令。\n\n嚴格規則：\n1. 必須有明確的動作指令才算買入：「建立基本持股」「買入」「買進」「加碼」「分批買回」「買回」「佈局」「布局」「分批佈局」「逢低買」\n2. 以下不算買入指令，直接忽略：「續抱」「抱好」「持股」「創高」「表現不錯」「感謝」「觀望」「等待」「不動作」「先不出手」「先不必」\n3. 必須同時有股票代號和明確動作才能列入\n4. 若同一段話提到多支股票，只提取有明確買賣動作的那支，其他忽略\n5. 賣出類：「賣出」「出場」「停利」「停損」「獲利了結」「出清」「賣掉」\n\n只回傳JSON陣列不要說明：[{\"time\":\"HH:MM\",\"stock_code\":\"4位數字\",\"stock_name\":\"名稱\",\"action\":\"買入或賣出\",\"sender\":\"發送者\",\"original\":\"原始片段最多20字\",\"confidence\":\"high|medium|low\"}] 若無訊號回傳[]",
      messages: [{ role: "user", content: "[" + time + "] " + sender + ": " + text }],
    });
    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return parsed.filter(function(s) { return s.confidence !== "low"; });
  } catch (e) {
    console.error("[Parser]", e.message);
    return [];
  }
}

module.exports = { parseSingleMessage, mightHaveSignal };
