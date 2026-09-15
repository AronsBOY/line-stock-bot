const fs = require('fs');
const path = require('path');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(filePath, rows) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!rows.length) { fs.writeFileSync(filePath, '', 'utf8'); return; }
  const keys = Array.from(rows.reduce(function (set, r) {
    Object.keys(r).forEach(function (k) { set.add(k); });
    return set;
  }, new Set()));
  const lines = [keys.map(csvEscape).join(',')];
  rows.forEach(function (r) {
    lines.push(keys.map(function (k) {
      const v = typeof r[k] === 'object' && r[k] !== null ? JSON.stringify(r[k]) : r[k];
      return csvEscape(v);
    }).join(','));
  });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = { writeCsv, writeJson };
