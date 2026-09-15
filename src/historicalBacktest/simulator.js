const config = require('./config');

function round(n, d) {
  const p = Math.pow(10, d || 2);
  return Math.round((n + Number.EPSILON) * p) / p;
}

function qtyForSignal(signal, positionQty) {
  const rule = signal.qty_rule || 'one_lot';
  if (rule === 'all') return positionQty;
  if (rule === 'half') return positionQty / 2;
  if (rule === 'one_lot') return config.defaultBuyLots;
  if (typeof signal.qty === 'number' && signal.qty > 0) return signal.qty;
  return signal.action === '買入' ? config.defaultBuyLots : positionQty;
}

function runSimulation(signals, options) {
  const infinite = !!options.infiniteCapital;
  let cash = infinite ? Infinity : Number(options.startingCapital || config.startingCapital);
  const startingCapital = cash;
  const positions = {};
  const ledger = [];
  let realizedPnl = 0;

  function pos(code) {
    if (!positions[code]) positions[code] = { qty: 0, avgCost: 0 };
    return positions[code];
  }

  signals.slice().sort(function (a, b) {
    return (a.date + ' ' + (a.time || '00:00')).localeCompare(b.date + ' ' + (b.time || '00:00'));
  }).forEach(function (s) {
    if (!s.execution_price || !s.stock_code || !['買入', '賣出'].includes(s.action)) return;
    const p = pos(s.stock_code);
    const qty = qtyForSignal(s, p.qty);
    const amount = qty * config.lotShares * s.execution_price;

    if (s.action === '買入') {
      if (!infinite && amount > cash + 0.0001) {
        ledger.push(Object.assign({}, s, { status: 'SKIPPED', reason: '資金不足', qty, amount, cash_after: cash }));
        return;
      }
      const oldCost = p.avgCost * p.qty;
      p.qty += qty;
      p.avgCost = p.qty > 0 ? (oldCost + s.execution_price * qty) / p.qty : 0;
      if (!infinite) cash -= amount;
      ledger.push(Object.assign({}, s, { status: 'FILLED', reason: '', qty, amount, cash_after: infinite ? null : cash, position_after: p.qty }));
      return;
    }

    if (p.qty <= 0.0001) {
      ledger.push(Object.assign({}, s, { status: 'SKIPPED', reason: '無持股可賣', qty: 0, amount: 0, cash_after: infinite ? null : cash }));
      return;
    }

    const sellQty = Math.min(qty, p.qty);
    const proceeds = sellQty * config.lotShares * s.execution_price;
    const pnl = (s.execution_price - p.avgCost) * sellQty * config.lotShares;
    realizedPnl += pnl;
    p.qty = round(p.qty - sellQty, 6);
    if (!infinite) cash += proceeds;
    if (p.qty <= 0.0001) { p.qty = 0; p.avgCost = 0; }
    ledger.push(Object.assign({}, s, {
      status: 'FILLED', reason: '', qty: sellQty, amount: proceeds,
      realized_pnl: pnl, cash_after: infinite ? null : cash, position_after: p.qty,
    }));
  });

  const filled = ledger.filter(function (x) { return x.status === 'FILLED'; }).length;
  const skipped = ledger.length - filled;
  return {
    mode: infinite ? 'infinite' : 'capital',
    startingCapital: infinite ? null : startingCapital,
    endingCash: infinite ? null : cash,
    realizedPnl,
    filled,
    skipped,
    ledger,
    positions,
  };
}

module.exports = { runSimulation, qtyForSignal };
