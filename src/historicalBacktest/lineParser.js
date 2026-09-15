const fs = require('fs');

function parseLineExport(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let currentDate = null;
  let current = null;

  function flush() {
    if (current && current.message) rows.push(current);
    current = null;
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    // 常見 LINE 匯出日期：2026/09/11(五) 或 2026/09/11
    const dm = line.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
    if (dm && !/^\d{1,2}:\d{2}\s/.test(line)) {
      flush();
      currentDate = dm[1] + '-' + String(dm[2]).padStart(2, '0') + '-' + String(dm[3]).padStart(2, '0');
      continue;
    }

    // 常見 LINE 匯出：12:31\t葉宇乘-進階組\t訊息
    const tm = line.match(/^(\d{1,2}:\d{2})(?:\s+|\t+)([^\t]+?)(?:\t+|\s{2,})(.*)$/);
    if (tm) {
      flush();
      current = {
        date: currentDate,
        time: tm[1],
        sender: tm[2].trim(),
        message: tm[3].trim(),
      };
      continue;
    }

    // 若格式只有「12:31 名稱 訊息」，嘗試寬鬆解析。
    const loose = line.match(/^(\d{1,2}:\d{2})\s+(.+?)\s{2,}(.+)$/);
    if (loose) {
      flush();
      current = {
        date: currentDate,
        time: loose[1],
        sender: loose[2].trim(),
        message: loose[3].trim(),
      };
      continue;
    }

    if (current) current.message += '\n' + line.trim();
  }
  flush();
  return rows;
}

function readLineExport(path) {
  return parseLineExport(fs.readFileSync(path, 'utf8'));
}

module.exports = { parseLineExport, readLineExport };
