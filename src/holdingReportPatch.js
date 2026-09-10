const portfolio = require("./portfolio");
const { buildHoldingReport } = require("./holdingReport");

// 讓既有 index/app 的「持股」呼叫介面不變：
// getSimpleInventory() 先產生完整報表，formatSimpleInventory() 再直接回傳文字。
const originalGetSimpleInventory = portfolio.getSimpleInventory;
const originalFormatSimpleInventory = portfolio.formatSimpleInventory;

portfolio.getSimpleInventory = async function patchedGetSimpleInventory(codes) {
  try {
    const report = await buildHoldingReport(portfolio, codes);
    return { __detailedHoldingReport: report };
  } catch (err) {
    console.error("[持股報表] 完整報表失敗，退回精簡庫存：", err.message);
    return originalGetSimpleInventory(codes);
  }
};

portfolio.formatSimpleInventory = function patchedFormatSimpleInventory(result) {
  if (result && result.__detailedHoldingReport) return result.__detailedHoldingReport;
  return originalFormatSimpleInventory(result);
};

module.exports = portfolio;
