  if (text.startsWith("新增 ")) {
    const parts = text.trim().split(/\s+/);
    const code = parts[1] ? parts[1].trim() : "";

    if (!code || !/^\d{4,6}$/.test(code)) {
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "格式錯誤！\n請用：\n新增 代號（自動抓當下股價）\n新增 代號 日期（抓收盤價）\n新增 代號 日期 價格（手動填價）\n\n例如：\n新增 2330\n新增 2330 2026/03/18\n新增 2330 2026/03/18 850" }] });
      return;
    }

    const datePattern = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/;
    const dateStr = parts[2] && datePattern.test(parts[2]) ? parts[2] : null;
    const manualPrice = parts[3] ? parseFloat(parts[3]) : null;

    let price, priceType, stockName;

    if (dateStr && manualPrice && !isNaN(manualPrice)) {
      price = manualPrice;
      priceType = dateStr + " 手動填入";
      const priceData = await fetchMultipleStocks([code]);
      const p = priceData[code];
      stockName = p ? p.longName : code;
    } else if (dateStr) {
      const hist = await fetchHistoricalClose(code, dateStr);
      if (!hist) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 在 " + dateStr + " 的收盤價\n可能是假日或非交易日" }] });
        return;
      }
      price = parseFloat(hist.price);
      stockName = hist.longName || code;
      priceType = dateStr + " 收盤價";
    } else {
      const priceData = await fetchMultipleStocks([code]);
      const p = priceData[code];
      if (!p) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "無法取得 " + code + " 的股價，請稍後再試" }] });
        return;
      }
      price = parseFloat(p.price);
      stockName = p.longName || code;
      priceType = p.marketStatus === "盤中" ? "即時股價" : "盤後股價";
    }

    await addBuy(code, stockName, price, dateStr || date, null);
    const rows = await getStockDetail(code);
    const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
    const msg = "已記錄！\n" + code + " " + stockName + "\n" + priceType + "：" + price + "\n共買入：" + rows.length + " 次\n目前均價：" + avg;
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
    return;
  }
