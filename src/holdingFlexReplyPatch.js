const line = require("@line/bot-sdk");
const portfolio = require("./portfolio");
const { buildHoldingFlex } = require("./holdingFlex");

const MessagingApiClient = line.messagingApi.MessagingApiClient;
const originalReplyMessage = MessagingApiClient.prototype.replyMessage;

MessagingApiClient.prototype.replyMessage = async function patchedReplyMessage(args) {
  try {
    const messages = args && args.messages;
    const isHoldingReply = Array.isArray(messages) && messages.length === 1 &&
      messages[0] && messages[0].type === "text" &&
      typeof messages[0].text === "string" &&
      messages[0].text.indexOf("【持股庫存】") === 0;

    if (isHoldingReply) {
      const flex = await buildHoldingFlex(portfolio);
      return originalReplyMessage.call(this, Object.assign({}, args, { messages: [flex] }));
    }
  } catch (err) {
    console.error("[持股 Flex] 建立失敗，退回文字版：", err.message);
  }

  return originalReplyMessage.call(this, args);
};
