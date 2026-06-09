// ── 核對 ──
  const checkMatch = text.match(/^核對(?:\s+(\d{4,6}))?$/);
  if (checkMatch) {
    const code = checkMatch[1] || null;
    if (code) {
      const buys = portfolio.portfolio.buys.filter(function(b) { return b.code === code; });
      const sells = portfolio.portfolio.sells.filter(function(s) { return s.code === code; });
      const name = portfolio.CODE_NAMES[code] || code;
      const remaining = buys.length - sells.length;
      let msg = "🔍 " + code + " " + name + " 核對\n" + "─".repeat(18) + "\n";
      msg += "【買入 " + buys.length + " 筆】\n";
      buys.forEach(function(b, i) { msg += (i+1) + ". " + b.date + " @" + b.price + "\n"; });
      msg += "\n【賣出 " + sells.length + " 筆】\n";
      if (sells.length) {
        sells.forEach(function(s, i) { msg += (i+1) + ". " + s.date + " @" + s.price + (s.price === 0 ? " ⚠未填價格" : "") + "\n"; });
      } else {
        msg += "（無）\n";
      }
      msg += "\n目前持股：" + remaining + " 張";
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    } else {
      const groups = {};
      portfolio.portfolio.buys.forEach(function(b) {
        if (!groups[b.code]) groups[b.code] = { buys: 0, sells: 0 };
        groups[b.code].buys++;
      });
      portfolio.portfolio.sells.forEach(function(s) {
        if (!groups[s.code]) groups[s.code] = { buys: 0, sells: 0 };
        groups[s.code].sells++;
      });
      let msg = "🔍 全部持股核對\n" + "─".repeat(18) + "\n";
      Object.keys(groups).forEach(function(code) {
        const g = groups[code];
        const name = portfolio.CODE_NAMES[code] || code;
        const remaining = g.buys - g.sells;
        const hasBadSell = portfolio.portfolio.sells.some(function(s) { return s.code === code && s.price === 0; });
        msg += code + " " + name + "：買" + g.buys + " 賣" + g.sells + " 剩" + remaining + (hasBadSell ? " ⚠" : "") + "\n";
      });
      msg += "\n⚠ = 有賣出記錄但未填價格\n輸入「核對 代號」查看詳細";
      await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text: msg }] });
    }
    return;
  }
