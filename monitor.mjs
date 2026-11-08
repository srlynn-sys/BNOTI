import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const username = process.env.SQUARE_USERNAME || "BTCxiao6";
const cli = process.env.SQUARE_CLI_PATH || "/tmp/binance-square-cli/dist/index.js";
const statePath = "state.json";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

function runCli(...args) {
  const raw = execFileSync("node", [cli, ...args, "--pretty"], {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw);
}

function htmlEscape(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function sendTelegram(post) {
  if (!token || !chatId) {
    console.log("Telegram secrets are not configured; skipping notification.");
    return;
  }
  const title = post.title || "(No title)";
  const url = post.url || `https://www.binance.com/en/square/profile/${username}`;
  const when = post.time ? new Date(post.time).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" }) : "Time unavailable";
  const message = [
    "🔔 <b>New Binance Square post</b>",
    `👤 Creator: <b>${htmlEscape(username)}</b>`,
    `🕒 ${htmlEscape(when)}`,
    `📝 ${htmlEscape(title).slice(0, 800)}`,
    `🔗 <a href="${htmlEscape(url)}">Open post</a>`,
  ].join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram send failed: ${result.description || response.status}`);
}

async function main() {
  console.log(`Checking Binance Square creator: ${username}`);
  const user = runCli("user", username);
  if (!user?.squareUid) throw new Error(`Could not resolve Square creator username: ${username}`);
  console.log(`Resolved creator ID: ${user.squareUid}`);

  const result = runCli("user-posts", user.squareUid);
  const posts = Array.isArray(result?.posts) ? result.posts.filter(p => p?.id) : [];
  if (!posts.length) {
    console.log("No posts returned; leaving state unchanged.");
    return;
  }

  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const previousIds = new Set(Array.isArray(state.seenIds) ? state.seenIds : []);
  const isFirstRun = !Array.isArray(state.seenIds) || state.seenIds.length === 0;

  if (isFirstRun) {
    state.seenIds = posts.map(p => String(p.id)).slice(0, 200);
    state.initializedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(`Initial baseline saved (${state.seenIds.length} recent post IDs); no old posts notified.`);
    return;
  }

  const fresh = posts.filter(p => !previousIds.has(String(p.id))).reverse();
  for (const post of fresh) {
    await sendTelegram(post);
    console.log(`Notified post ${post.id}`);
  }

  state.seenIds = [...new Set([...posts.map(p => String(p.id)), ...previousIds])].slice(0, 200);
  state.lastCheckedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log(`Done. New posts detected: ${fresh.length}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
