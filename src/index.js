if (text.startsWith("新增 ")) {
    const parts = text.split(" ");
    if (parts.length >= 3 && /^\d{4,6}$/.test(parts[1]) && !isNaN(parseFloat(parts[2]))) {
      const code = parts[1].trim();
      const price = parseFloat(parts[2]);
      const name = parts[3] || code;
      await addBuy(code, name, price, date);
      const rows = await getStockDetail(code);
      const avg = (rows.reduce(function(a,b){return a+parseFloat(b.buy_price);},0)/rows.length).toFixed(2);
      const msg = "已記錄！\n" + code + " " + name + "\n買入價：" + price + "\n共買入：" + rows.length + " 次\n目前均價：" + avg;
      await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: msg }] });
      return;
    }
    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: "text", text: "格式錯誤！\n請用：新增 股票代號 買入價格 股票名稱\n例如：新增 2330 850 台積電" }] });
    return;
  }
