# Binance Futures Pump/Dump Alert

A mobile-first Node.js dashboard monitoring Binance USDⓈ-M USDT perpetual markets using public market data only. It does not use Binance account API keys and cannot place trades.

## Alert definition
Alerts when the current 1-minute candle's live price is at least +2% or -2% from that candle's open. This is NOT a rolling 60-second return. One alert per symbol/direction/candle is sent. Price can reverse before candle close.

## Deploy
1. Use a Node.js 20+ host that keeps the service running and permits outbound WebSockets.
2. Set the service root directory to `pump-dump-alert` (or deploy this directory as its own repo).
3. Build: `npm install`; start: `npm start`.
4. Copy `.env.example` values into host environment settings. Never commit secrets.
5. Generate VAPID keys with `npx web-push generate-vapid-keys`; set public/private keys and VAPID_SUBJECT. HTTPS is required for browser push.
6. Telegram: message @BotFather, run `/newbot`, save the token as TELEGRAM_BOT_TOKEN; open the bot and send `/start`; obtain chat ID via `https://api.telegram.org/bot<TOKEN>/getUpdates` and set TELEGRAM_CHAT_ID. Keep token private.
7. Open the HTTPS site on iPhone and tap Enable browser alerts. Depending on iOS version, add the site to Home Screen for web push support.

## Important
- Requires a continuously running backend; GitHub Pages alone cannot run this Node service.
- The server connects to Binance Futures combined WebSocket streams in groups of up to 200 streams and reconnects on close. Verify current Binance stream limits if deployment shows connection errors.
- Browser push subscriptions are saved in local JSON; use persistent disk or a database for reliable production use. Ephemeral hosts may lose them after restart.
- Dashboard currently has no authentication; deploy privately or add access control before broader sharing.
- Not a trading signal or price prediction.

## TradePulse Alert + News update

The dashboard home now has two sections: **Alert** and **News**.

- **Alert:** watches Binance USDⓈ-M USDT perpetual symbols using public 1-minute candle streams. A move of ±2% from the current candle open creates an alert; it is not a rolling 60-second return.
- **News:** aggregates recent headlines from public RSS feeds (CoinDesk, Cointelegraph, CNBC Markets, and WSJ Markets), with source links, a region filter, estimated potential impact, and a heuristic “Potential catalyst” label for headlines mentioning upcoming/scheduled events.
- The News endpoint caches responses for 5 minutes. Feed availability and RSS formats can change; failed feeds are skipped.
- The region, impact, and catalyst labels are automatic text-based classifications, not verified predictions. Check original sources and official calendars before acting.

## Current deployment state

Code is committed to this repository under `pump-dump-alert/`. It is **not automatically a live website** until the Node.js service is deployed to an always-on host with HTTPS and environment variables configured. GitHub Pages alone cannot run the WebSocket backend.
