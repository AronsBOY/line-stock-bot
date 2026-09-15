require('dotenv').config();
const path = require('path');
const { readLineExport } = require('./lineParser');
const { extractSignals } = require('./signalExtractor');
const { sampleForReview } = require('./reviewSampler');
const { attachClosePrices } = require('./priceLoader');
const { runSimulation } = require('./simulator');
const { writeCsv, writeJson } = require('./io');
const config = require('./config');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node src/historicalBacktest/run.js <line_chat.txt> [startingCapital]');
    process.exit(1);
  }

  const startingCapital = process.argv[3] ? Number(process.argv[3]) : config.startingCapital;
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    console.error('startingCapital 必須是正數');
    process.exit(1);
  }

  const outputDir = path.resolve(process.cwd(), 'historical-backtest-output');
  const messages = readLineExport(path.resolve(input));
  const senderFilter = process.env.HISTORICAL_SENDER_FILTER || null;
  const parsed = await extractSignals(messages, { senderFilter });
  const review = sampleForReview(parsed);

  writeCsv(path.join(outputDir, 'parsed_signals.csv'), parsed);
  writeCsv(path.join(outputDir, 'review.csv'), review);

  // 第一階段先使用 AI 結果直接跑一版；正式結論前應以人工覆核後的 validated_signals.csv 再跑一次。
  const executable = parsed.filter(function (x) { return x.action === '買入' || x.action === '賣出'; });
  const priced = await attachClosePrices(executable);
  writeCsv(path.join(outputDir, 'signals_with_close.csv'), priced);

  const infinite = runSimulation(priced, { infiniteCapital: true });
  const capital = runSimulation(priced, { infiniteCapital: false, startingCapital });

  writeCsv(path.join(outputDir, 'backtest_infinite.csv'), infinite.ledger);
  writeCsv(path.join(outputDir, 'backtest_capital.csv'), capital.ledger);
  writeJson(path.join(outputDir, 'summary.json'), {
    generatedAt: new Date().toISOString(),
    input: path.resolve(input),
    senderFilter,
    messages: messages.length,
    parsedRows: parsed.length,
    reviewRows: review.length,
    missingPrices: priced.filter(function (x) { return x.price_status === 'MISSING'; }).length,
    infinite: {
      realizedPnl: infinite.realizedPnl,
      filled: infinite.filled,
      skipped: infinite.skipped,
    },
    capital: {
      startingCapital: capital.startingCapital,
      endingCash: capital.endingCash,
      realizedPnl: capital.realizedPnl,
      filled: capital.filled,
      skipped: capital.skipped,
      skippedInsufficientCash: capital.ledger.filter(function (x) { return x.reason === '資金不足'; }).length,
      skippedNoPosition: capital.ledger.filter(function (x) { return x.reason === '無持股可賣'; }).length,
    },
  });

  console.log('完成。輸出資料夾：' + outputDir);
  console.log('請先人工檢查 review.csv；正式績效不要直接使用未覆核的 AI 初判結果。');
}

main().catch(function (err) {
  console.error('[historicalBacktest]', err);
  process.exit(1);
});
