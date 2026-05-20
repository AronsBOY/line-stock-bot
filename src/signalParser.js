const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUY_KEYWORDS = ["買入","買進","做多","進場","布局","佈局","加碼","逢低","可以買","建議買","建立基本持股","分批買回","買回","分批佈局","建倉"];
const SELL_KEYWORDS = ["賣出","賣掉","出場","停利","停損","獲利了結","出清","逢高賣","建議賣"];

function mightHaveSignal(text) {
  const hasSentiment =
    BUY_KEYWORDS.some(function(k) { return text.includes(k); }) ||
    SELL_KEYWORDS.some(function(k) { return text.includes(k); });
  const hasCode = /\b\d{4,6}\b/.test(text);
  return hasSentiment && hasCode;
}

async function parseSingleMessage(sender, time, text) {
  if (!mightHaveSignal(text)) return [];
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `你是台股訊號解析專家。從老師的訊息中精準提取股票買賣指令。

嚴格規則：
1. 必須有明確動作才算訊號：「建立基本持股」「買入」「買進」「加碼」「分批買回」「佈局」「布局」「逢低買」「建倉」
2. 以下不算訊號，直接忽略：「續抱」「抱好」「持股不變」「觀望」「等待」「先不出手」「筆記」「看法」
3. 必須同時有股票代號和明確動作
4. 提取老師建議的價位區間（如「160以下」「185-188附近」「800以下」），沒有就填 null

只回傳 JSON 陣列，不要說明：
[{
  "stock_code": "4位數字",
  "stock_name": "股票名稱",
  "action": "買入或賣出",
  "suggested_price": "老師建議價位描述或null",
  "original": "原始片段最多30字",
  "confidence": "high|medium|low"
}]
若無訊號回傳 []`,
      messages: [{ role: "user", content: "[" + time + "] " + sender + ":\n" + text }],
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
