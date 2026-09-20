const line = require("@line/bot-sdk");

const originalMiddleware = line.middleware;

line.middleware = function patchedLineMiddleware(config) {
  const middleware = originalMiddleware(config);
  return function settlementCommandMiddleware(req, res, next) {
    return middleware(req, res, function afterLineMiddleware(err) {
      if (err) return next(err);
      try {
        const events = req.body && Array.isArray(req.body.events) ? req.body.events : [];
        events.forEach(function (event) {
          if (event && event.type === "message" && event.message && event.message.type === "text") {
            if (event.message.text.trim() === "結算") event.message.text = "已結算";
          }
        });
      } catch (e) {
        console.error("[結算指令修正]", e.message);
      }
      return next();
    });
  };
};
