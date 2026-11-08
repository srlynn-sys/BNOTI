import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const usernames = (process.env.SQUARE_USERNAMES || process.env.SQUARE_USERNAME || "BTCxiao6")
  .split(",").map(s => s.trim()).filter(Boolean);
const cli = process.env.SQUARE_CLI_PATH || "/tmp/binance-square-cli/dist/index.js";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

function runCli(...args) {
  const raw = execFileSync("node", [cli, ...args, "--pretty"], {
    encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw);
}

function runProfileVisit(username) {
  console.log(`Trying profile-page network capture fallback for ${username}...`);
  const profileUrl = `https://www.binance.com/en/square/profile/${encodeURIComponent(username)}`;
  const raw = execFileSync("node", [
    cli, "visit", profileUrl, "--settle", "12", "--debug",
  ], {
    encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "inherit"],
  });
  const captures = JSON.parse(raw);
  if (!Array.isArray(captures)) throw new Error("Profile capture returned an unexpected response.");
  const profileCaptures = captures.filter(c =>
    /\/bapi\/composite\/v\d+\/friendly\/pgc\/user\/client/i.test(c.url)
  );
  const profileCapture = profileCaptures.find(c =>
    JSON.stringify(c.requestBody || {}).toLowerCase().includes(username.toLowerCase())
  ) || profileCaptures[0];
  const profileData = profileCapture?.body?.data;
  const squareUid = profileData?.squareUid || profileData?.uid || profileData?.userId || profileData?.id;
  if (!squareUid) {
    console.log("Captured " + captures.length + " API responses for " + username + ":");
    for (const c of captures.slice(0, 20)) {
      console.log(JSON.stringify({
        url: c.url, status: c.status, method: c.method,
        requestBody: c.requestBody,
        bodyKeys: c.body && typeof c.body === "object" ? Object.keys(c.body) : [],
        dataKeys: c.body?.data && typeof c.body.data === "object" ? Object.keys(c.body.data) : [],
        message: c.body?.message || c.body?.messageDetail || null,
      }));
    }
    throw new Error("Profile fallback could not find the creator ID in captured Binance responses.");
  }

  const postCapture = captures.find(c => /queryUserProfilePageContentsWithFilter/i.test(c.url));
  const data = postCapture?.body?.data;
  const rawPosts = Array.isArray(data?.contents) ? data.contents : Array.isArray(data?.posts) ? data.posts : [];
  const posts = rawPosts.map(p => ({
    ...p,
    id: p?.id == null ? null : String(p.id),
    title: p?.title || p?.subTitle || p?.bodyTextOnly || p?.body || "(No title)",
    time: p?.createTime || p?.firstReleaseTime || null,
    url: p?.webLink || p?.shareLink || `https://www.binance.com/en/square/profile/${encodeURIComponent(username)}`,
  })).filter(p => p.id);
  console.log(`Profile fallback resolved creator ID: ${squareUid}; captured posts: ${posts.length}`);
  return { squareUid, posts };
}

function htmlEscape(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function sendTelegram(username, post) {
  if (!token || !chatId) throw new Error("Telegram secrets are not configured. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in GitHub Actions secrets.");
  const title = post.title || "(No title)";
  const url = post.url || `https://www.binance.com/en/square/profile/${encodeURIComponent(username)}`;
  const rawTime = post.time ? Number(post.time) : NaN;
  const timeValue = Number.isFinite(rawTime) ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : post.time;
  const when = timeValue ? new Date(timeValue).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" }) : "Time unavailable";
  const message = [
    "🔔 <b>New Binance Square post</b>",
    `👤 Creator: <b>${htmlEscape(username)}</b>`,
    `🕒 ${htmlEscape(when)}`,
    `📝 ${htmlEscape(title).slice(0, 800)}`,
    `🔗 <a href="${htmlEscape(url)}">Open post</a>`,
  ].join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram send failed: ${result.description || response.status}`);
}

async function readCreator(username) {
  console.log(`Checking Binance Square creator: ${username}`);
  try {
    const user = runCli("user", username);
    const squareUid = user?.squareUid;
    if (!squareUid) throw new Error(`Could not resolve Square creator username: ${username}`);
    console.log(`Resolved creator ID for ${username}: ${squareUid}`);
    const result = runCli("user-posts", squareUid);
    return { squareUid, posts: Array.isArray(result?.posts) ? result.posts.filter(p => p?.id) : [] };
  } catch (primaryError) {
    console.error(`Primary reader failed for ${username}: ${primaryError?.message || primaryError}`);
    return runProfileVisit(username);
  }
}

async function main() {
  const state = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : {};
  if (!state.creators || typeof state.creators !== "object") state.creators = {};
  const errors = [];

  for (const username of usernames) {
    try {
      const { squareUid, posts } = await readCreator(username);
      if (!posts.length) {
        console.log(`No posts returned for ${username}; leaving this creator's state unchanged.`);
        continue;
      }

      const creatorState = state.creators[username] || (
        username === "BTCxiao6" && Array.isArray(state.seenIds) ? { seenIds: state.seenIds, initializedAt: state.initializedAt } : {}
      );
      const previousIds = new Set(Array.isArray(creatorState.seenIds) ? creatorState.seenIds.map(String) : []);
      const isFirstRun = !Array.isArray(creatorState.seenIds) || creatorState.seenIds.length === 0;

      if (isFirstRun) {
        state.creators[username] = {
          squareUid,
          seenIds: posts.map(p => String(p.id)).slice(0, 200),
          initializedAt: new Date().toISOString(),
        };
        console.log(`Initial baseline saved for ${username} (${state.creators[username].seenIds.length} recent post IDs); no old posts notified.`);
        continue;
      }

      const fresh = posts.filter(p => !previousIds.has(String(p.id))).reverse();
      for (const post of fresh) {
        await sendTelegram(username, post);
        console.log(`Notified ${username} post ${post.id}`);
      }
      state.creators[username] = {
        squareUid,
        seenIds: [...new Set([...posts.map(p => String(p.id)), ...previousIds])].slice(0, 200),
        initializedAt: creatorState.initializedAt || new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
      };
      console.log(`Done for ${username}. New posts detected: ${fresh.length}`);
    } catch (error) {
      console.error(`Creator check failed for ${username}: ${error?.stack || error}`);
      errors.push(username);
    }
  }

  writeFileSync("state.json", JSON.stringify(state, null, 2) + "\n");
  if (errors.length) throw new Error(`Failed to check creator(s): ${errors.join(", ")}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
