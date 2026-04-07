if (text === "持股") {
    const rows = await getPortfolio();
    if (rows.length === 0) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "目前沒有持股記錄\n\n用「新增 代號 名稱」來記錄買入\n例如：新增 2330 台積電" }] });
      return;
    }
    const codes = rows.map(function(r){return r.stock_code;});
    const prices = await fetchMultipleStocks(codes);
    const now2 = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    let msg = "目前持股　" + now2 + "\n" + "─".repeat(24) + "\n";
    rows.forEach(function(r) {
      const p = prices[r.stock_code];
      const currentPrice = p ? parseFloat(p.price) : null;
      const avg = parseFloat(r.avg_price);
      const totalCost = avg * parseInt(r.buy_count);
      const profitPct = currentPrice ? ((currentPrice - avg) / avg * 100).toFixed(2) : null;
      const profitAmt = currentPrice ? (currentPrice - avg).toFixed(2) : null;
      const arrow = profitPct >= 0 ? "▲" : "▼";
      const stockName = r.stock_name === r.stock_code ? r.stock_code : r.stock_name;
      msg += "\n" + r.stock_code + " " + stockName + "\n";
      msg += "  買入：" + r.buy_count + " 次　均價：" + r.avg_price + "\n";
      if (currentPrice) {
        msg += "  現價：" + currentPrice + "　" + arrow + profitPct + "%\n";
        msg += "  未實現損益：" + (profitAmt >= 0 ? "+" : "") + profitAmt + " 元/股\n";
      }
      msg += "  最早買入：" + (r.first_date || "-") + "\n";
    });
    msg += "\n" + "─".repeat(24) + "\n輸入「明細 代號」查看每筆記錄";
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }
