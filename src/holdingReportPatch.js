const portfolio = require("./portfolio");
const { buildHoldingReport } = require("./holdingReport");
const { forceAlignToSnapshot } = require("./forceAlignSnapshot");

// 讓既有 app 的「持股」呼叫介面不變：
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

// 既有 LINE 指令「強制對齊持股」改成以 src/holdings.json 的 2026-09-10 定稿快照為唯一基準。
// 會在同一個 transaction 內清空 buys/sells，再重建 9 檔、21 筆買入資料；失敗時整筆 rollback。
portfolio.WATCHLIST_CODES = ["2426", "3529", "4991", "6213", "6239", "6285", "6669", "6805", "8021"];
portfolio.forceAlignHoldings = async function patchedForceAlignHoldings() {
  const result = await forceAlignToSnapshot(portfolio);
  return {
    closed: [],
    failed: [],
    snapshotAligned: true,
    stockCount: result.stockCount,
    buyRows: result.buyRows,
    totalShares: result.totalShares,
  };
};

module.exports = portfolio;
