# Binance Square → Telegram alert bot

This repository checks public posts from the Binance Square creator **BTCxiao6** and sends a Telegram message when it detects a new post.

## How it works

- GitHub Actions runs on a schedule (every 5 minutes) and can also be started manually.
- It uses the read-only, unofficial [binance-square-cli](https://github.com/QuantProcessing/binance-square-cli) reader to resolve the creator profile and fetch recent posts.
- The first successful run stores a baseline and does **not** send alerts for older posts.
- Later runs send Telegram alerts for unseen post IDs and save those IDs to `state.json` to avoid duplicate notifications.

**Important:** Binance Square does not currently provide an official public real-time read/webhook API for arbitrary creator posts. This bot relies on an unofficial reader and can break if Binance changes its website or internal endpoints. GitHub's schedule is best-effort, not guaranteed to run exactly on time; expect possible delays. It is not a true instant/real-time service.

## One-time setup

### 1. Create a Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token and keep it private. Do not put it in source code or send it in public chats.
4. Open the new bot chat and press **Start** (or send `/start`).

### 2. Get your Telegram chat ID

The simplest method is to message your bot first, then open this URL in a browser after replacing `YOUR_BOT_TOKEN` with your token:

```
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

In the JSON response, find `message.chat.id`. That number is your chat ID. Keep the token private; do not share screenshots or the URL containing it. If the response has no messages, send another message to your bot and refresh.

### 3. Add GitHub Actions secrets

In this repository, open **Settings → Secrets and variables → Actions → New repository secret** and add these two secrets:

- `TELEGRAM_BOT_TOKEN` — your BotFather token
- `TELEGRAM_CHAT_ID` — the chat ID from step 2

Never commit either value into a file.

### 4. Start the monitor

Open **Actions → Binance Square Telegram Monitor → Run workflow**. The first run saves a baseline and does not alert for older posts. If it succeeds, later scheduled runs will notify on newly detected posts.

## Troubleshooting

- **No alert on first run:** expected; the first run only records recent post IDs.
- **No alerts afterward:** check the latest run under **Actions**. The creator's posts may not have changed, or the unofficial reader may need an update.
- **Telegram error:** check that both secrets are correct and that you started the bot chat.
- **Schedule not running:** GitHub scheduled workflows are best-effort and can be delayed. Ensure Actions are enabled for the repository.

## Privacy and safety

The monitor only reads public creator posts. It does not need your Binance login, cookies, trading API keys, or Firebase credentials. Do not add those secrets.
