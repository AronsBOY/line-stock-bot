module.exports = {
  lotShares: 1000,
  defaultBuyLots: 1,
  startingCapital: 3000000,
  reviewRandomRate: 0.05,
  reviewSeed: 20260914,
  priceRequestDelayMs: 1100,
  lowConfidenceThreshold: 0.85,
  // 第一版先不納入手續費/交易稅，避免把「訊號品質」和「交易成本」混在一起。
  fees: {
    enabled: false,
    buyFeeRate: 0,
    sellFeeRate: 0,
    sellTaxRate: 0,
  },
};
