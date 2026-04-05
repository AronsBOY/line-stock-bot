const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUY_KEYWORDS = ["買入","買進","做多","進場","布局","佈局","加碼","逢低","可以買","建議買","建立基本持股"];
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
      system: "你是台股訊號解析專家。從訊息中提取股票買賣指令。只提取明確的買入或賣出指令，忽略問句觀望閒聊。只回傳JSON陣列不要說明：[{\"time\":\"HH:MM\",\"stock_code\":\"4位數字\",\"stock_name\":\"名稱\",\"action\":\"買入或賣出\",\"sender\":\"發送者\",\"original\":\"原始片段最多20字\",\"confidence\":\"high|medium|low\"}] 若無訊號回傳[]",
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
