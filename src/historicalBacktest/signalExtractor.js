const { parseSingleMessage } = require('../signalParser');

function inferQtyRule(action, original) {
  const t = original || '';
  if (action === '買入') return 'one_lot';
  if (/賣光|出清|清倉|全出|全部賣|全部出|全數賣|全數出/.test(t)) return 'all';
  if (/一半|半數|砍半|減碼一半|賣一半/.test(t)) return 'half';
  return 'all';
}

async function extractSignals(messages, options) {
  const senderFilter = options && options.senderFilter ? options.senderFilter : null;
  const rows = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m.date || !m.message) continue;
    if (senderFilter && !m.sender.includes(senderFilter)) continue;

    let parsed = [];
    try {
      parsed = await parseSingleMessage(m.sender || '歷史訊息', m.time || '00:00', m.message);
    } catch (err) {
      rows.push({
        row_id: i + 1,
        date: m.date,
        time: m.time || '',
        sender: m.sender || '',
        stock_code: '',
        stock_name: '',
        action: '解析失敗',
        qty_rule: '',
        suggested_price: '',
        confidence: 0,
        original: m.message,
        reason: err.message,
      });
      continue;
    }

    if (!parsed.length) {
      rows.push({
        row_id: i + 1,
        date: m.date,
        time: m.time || '',
        sender: m.sender || '',
        stock_code: '',
        stock_name: '',
        action: '忽略',
        qty_rule: '',
        suggested_price: '',
        confidence: 0.95,
        original: m.message,
        reason: 'AI未判定為明確買賣指令',
      });
      continue;
    }

    parsed.forEach(function (s, j) {
      rows.push({
        row_id: String(i + 1) + '-' + String(j + 1),
        date: m.date,
        time: m.time || '',
        sender: m.sender || '',
        stock_code: s.stock_code || '',
        stock_name: s.stock_name || '',
        action: s.action || '',
        qty_rule: inferQtyRule(s.action, s.original || m.message),
        suggested_price: s.suggested_price || '',
        confidence: 0.9,
        original: s.original || m.message,
        reason: '',
      });
    });
  }
  return rows;
}

module.exports = { extractSignals, inferQtyRule };
