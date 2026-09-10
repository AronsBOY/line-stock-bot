const line = require("@line/bot-sdk");
const portfolio = require("./portfolio");
const { buildHoldingFlex } = require("./holdingFlex");

const MessagingApiClient = line.messagingApi.MessagingApiClient;
const originalReplyMessage = MessagingApiClient.prototype.replyMessage;
const originalMiddleware = line.middleware;

// 記住使用者原始輸入，讓「庫存持股明細 / 持股明細」可以沿用既有持股查詢，
// 但回覆時保留完整文字版，不轉成 Flex。
const originalCommandByReplyToken = new Map();

line.middleware = function patchedLineMiddleware(config) {
  const middleware = originalMiddleware(config);
  return function(req, res, next) {
    return middleware(req, res, function(err) {
      if (!err && req.body && Array.isArray(req.body.events)) {
        req.body.events.forEach(function(event) {
          if (!event || event.type !== "message" || !event.message || event.message.type !== "text") return;
          const originalText = String(event.message.text || "").trim();
          if (originalText === "庫存持股明細" || originalText === "持股明細") {
            if (event.replyToken) originalCommandByReplyToken.set(event.replyToken, originalText);
            // 內部借用既有「持股」處理流程，最後在 replyMessage 階段保留文字版。
            event.message.text = "持股";
          }
        });
      }
      return next(err);
    });
  };
};

MessagingApiClient.prototype.replyMessage = async function patchedReplyMessage(args) {
  const replyToken = args && args.replyToken;
  const originalCommand = replyToken ? originalCommandByReplyToken.get(replyToken) : null;

  try {
    const messages = args && args.messages;
    const isHoldingReply = Array.isArray(messages) && messages.length === 1 &&
      messages[0] && messages[0].type === "text" &&
      typeof messages[0].text === "string" &&
      messages[0].text.indexOf("【持股庫存】") === 0;

    // 明細指令：直接回原本完整長文字，不轉 Flex。
    if (isHoldingReply && (originalCommand === "庫存持股明細" || originalCommand === "持股明細")) {
      originalCommandByReplyToken.delete(replyToken);
      return originalReplyMessage.call(this, args);
    }

    // 一般「持股 / 我的持股」：轉成單張 Flex 總覽。
    if (isHoldingReply) {
      const flex = await buildHoldingFlex(portfolio);
      if (replyToken) originalCommandByReplyToken.delete(replyToken);
      return originalReplyMessage.call(this, Object.assign({}, args, { messages: [flex] }));
    }
  } catch (err) {
    console.error("[持股 Flex] 建立失敗，退回文字版：", err.message);
  }

  if (replyToken) originalCommandByReplyToken.delete(replyToken);
  return originalReplyMessage.call(this, args);
};
