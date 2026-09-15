const config = require('./config');

function seededRandom(seed) {
  let x = seed >>> 0;
  return function () {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function shouldForceReview(row) {
  const text = (row.original || '') + ' ' + (row.reason || '');
  if ((row.confidence != null) && row.confidence < config.lowConfidenceThreshold) return true;
  if (/賣光|出清|清倉|全出|全部賣|停損|止損|下車|一半|減碼|部分賣|砍半/.test(text)) return true;
  if (row.action === '忽略' && /\d{4,6}|買|賣|加碼|減碼|持股|部位/.test(text)) return true;
  return false;
}

function sampleForReview(rows) {
  const rand = seededRandom(config.reviewSeed);
  return rows.filter(function (row) {
    return shouldForceReview(row) || rand() < config.reviewRandomRate;
  }).map(function (row) {
    return Object.assign({}, row, {
      human_ok: '',
      human_action: '',
      human_qty_rule: '',
      human_note: '',
    });
  });
}

module.exports = { sampleForReview, shouldForceReview };
