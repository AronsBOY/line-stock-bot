const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const KNOWN_NAMES = Object.values(require("./knownStockNames"));

// 第一層過濾：不再要求固定買賣關鍵字，只要訊息裡有股票代號、或提到已知的股票名稱，
// 就交給 AI 判斷是不是真的訊號（AI 判斷不是訊號就會回傳空陣列，不會誤發通知）
function mightHaveSignal(text) {
  const hasCode = /\b\d{4,6}\b/.test(text);
  const hasKnownName = KNOWN_NAMES.some(function(name) { return text.includes(name); });
  return hasCode || hasKnownName;
}

async function parseSingleMessage(sender, time, text) {
  if (!mightHaveSignal(text)) return [];
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      system: `你是台股訊號解析專家。從老師的訊息中精準提取股票買賣指令。
嚴格規則：
1. 必須有明確動作才算訊號。老師的用詞會變化很多，不限於固定詞彙，只要語意上是「叫人買進/加碼/建倉」或「叫人賣出/獲利了結/停損/出場」都算，例如「建立回基本持股」「先獲利一半吧」這種變化用法也要判斷得出來。
2. 「建立基本持股」「建立持股」「建立基本部位」「建立部位」「開始佈局」「零股佈局」等，只要語意是在要求現在建立該股票部位，一律視為明確買入訊號。例：「大立光(3008)平盤6700-6800附近建立基本持股」必須解析為大立光(3008)買入，suggested_price 為「平盤6700-6800附近」。
3. 「轉換過去」「轉換到」「換過去」「換到」這類資金轉換說法，若只是「建議可把A轉換過去」「之後可轉換到B」等預告、規劃或比較，不視為已執行的買賣指令，也不要因此替A產生賣出或替B額外產生買入。只有同一句另外出現明確執行動作，例如「A先賣出，再買B」，才依明確動作記錄。
4. 以下不算訊號，直接忽略：純粹的心得評論、股價評論（例如「距離500又更進一步」）、回顧過去已經做過的事（例如「加碼不少次」「已經加碼」）、轉述法說會/市場消息但沒有下指令、轉述其他人的喊價（例如「內資喊XXX 200」）、單純比價（例如「股價要比XXX高」）、「續抱」「抱好」「持股不變」「觀望」「等待」「先不出手」「筆記」「看法」。
5. 特別注意否定句：如果句子在說「不用/不會/不必/沒有要/更正」等，是取消或否定動作的意思，不算訊號，即使句子裡也出現了「加碼」「買」之類的字。
6. 一句話裡可能同時提到好幾檔股票，要逐一分辨每一檔各自的動作是什麼，不要把其他檔的動作誤植到不相關的代號上。
7. 必須同時有股票代號（或明確股票名稱）和明確動作。
8. 提取老師建議的價位區間或條件（如「160以下」「185-188附近」「跌停」「平盤以下」），沒有就填 null。
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
