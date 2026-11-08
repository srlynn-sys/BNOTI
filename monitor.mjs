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


async function runPublicFeed(username) {
  console.log(`Trying browserless public Square feed fallback for ${username}...`);
  const url = "https://www.binance.com/bapi/composite/v3/friendly/pgc/content/article/list?pageIndex=1&pageSize=20&type=2";
  const response = await fetch(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://www.binance.com/zh-CN/square/trending",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    },
    signal: AbortSignal.timeout(20000)
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Public feed HTTP ${response.status}: ${bodyText.slice(0, 180)}`);
  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { throw new Error("Public feed returned non-JSON content (possibly a security check)."); }
  const data = payload?.data;
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.list) ? data.list
    : Array.isArray(data?.articles) ? data.articles
    : Array.isArray(data?.contents) ? data.contents
    : Array.isArray(data?.items) ? data.items : [];
  if (!list.length) {
    throw new Error("Public feed returned no recognized posts; response keys: " + JSON.stringify(Object.keys(payload || {})) + "; data keys: " + JSON.stringify(data && typeof data === "object" ? Object.keys(data) : []));
  }
  const wanted = username.toLowerCase();
  const matches = list.filter(p => {
    const candidates = [
      p?.username, p?.handle, p?.authorUsername, p?.authorHandle,
      p?.creatorName, p?.authorName, p?.nickname, p?.userName,
      p?.author?.username, p?.author?.handle, p?.author?.nickname,
      p?.user?.username, p?.user?.handle, p?.user?.nickname
    ].filter(v => typeof v === "string").map(v => v.toLowerCase());
    return candidates.includes(wanted);
  }).map(p => ({
    ...p,
    id: p?.id == null ? null : String(p.id),
    title: p?.title || p?.content || p?.bodyTextOnly || p?.body || "(No title)",
    time: p?.date || p?.createTime || p?.publishTime || null,
    url: p?.webLink || p?.shareLink || (p?.id ? `https://www.binance.com/en/square/post/${p.id}` : null)
  })).filter(p => p.id && p.url);
  console.log(`Public feed returned ${list.length} posts; exact handle matches for ${username}: ${matches.length}`);
  if (!matches.length) {
    console.log("Public feed author-field sample: " + JSON.stringify(list.slice(0, 3).map(p => ({
      id: p?.id, authorName: p?.authorName, username: p?.username,
      authorUsername: p?.authorUsername, handle: p?.handle,
      authorKeys: p?.author && typeof p.author === "object" ? Object.keys(p.author) : []
    }))));
    throw new Error("Public feed has no exact username match; refusing to send unrelated posts.");
  }
  return { squareUid: username, posts: matches };
}

function runProfileVisit(username) {
  console.log(`Trying profile-page network capture fallback for ${username}...`);
  const profileUrl = `https://www.binance.com/zh-CN/square/profile/${encodeURIComponent(username)}`;
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

function runProfileDom(username) {
  console.log(`Trying rendered-page DOM fallback for ${username}...`);
  const script = String.raw`
    import { chromium } from "/tmp/binance-square-cli/node_modules/playwright/index.mjs";
    const username = process.argv[1];
    const url = "https://www.binance.com/zh-CN/square/profile/" + encodeURIComponent(username);
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] });
    try {
      const page = await browser.newPage({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 1000 },
        locale: "en-US"
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(9000);
      const pageInfo = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        bodyText: (document.body?.innerText || "").slice(0, 1200),
        postLinks: document.querySelectorAll('a[href*="/square/post/"]').length
      }));
      console.log("Profile page diagnostics for " + username + ": " + JSON.stringify(pageInfo));
      const result = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/square/post/"]'));
        const seen = new Set();
        return anchors.map(a => {
          const href = new URL(a.getAttribute("href"), location.origin).href;
          const match = href.match(/\/square\/post\/(\d+)/);
          if (!match || seen.has(match[1])) return null;
          seen.add(match[1]);
          const card = a.closest("article") || a.parentElement?.parentElement?.parentElement || a;
          const text = (card.innerText || a.innerText || "").trim().replace(/\s+/g, " ");
          return { id: match[1], title: text.slice(0, 1000) || "(Post text unavailable)", url: href, time: null };
        }).filter(Boolean).slice(0, 30);
      });
      console.log("Rendered DOM posts found: " + result.length);
      process.stdout.write(JSON.stringify({ posts: result }));
    } finally {
      await browser.close();
    }
  `;
  const raw = execFileSync("node", ["--input-type=module", "-e", script, username], {
    encoding: "utf8", timeout: 75000, stdio: ["ignore", "pipe", "inherit"],
  });
  const diagnosticLines = raw.split("\n").filter(line => line.includes("Profile page diagnostics") || line.includes("Rendered DOM posts found"));
  for (const line of diagnosticLines) console.log(line);
  const jsonStart = raw.lastIndexOf('{"posts":');
  if (jsonStart < 0) throw new Error("Rendered-page reader returned no post JSON. Output: " + raw.slice(-1200));
  const parsed = JSON.parse(raw.slice(jsonStart).trim());
  if (!Array.isArray(parsed.posts) || parsed.posts.length === 0) {
    throw new Error("Rendered Binance profile page exposed no public post links.");
  }
  return { squareUid: username, posts: parsed.posts };
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

async function sendMonitorError(username, errorText) {
  if (!token || !chatId) throw new Error("Telegram secrets are not configured.");
  const message = [
    "⚠️ BNOTI monitor could not read Binance Square",
    `Creator: ${username}`,
    `Reason: ${String(errorText).slice(0, 700)}`,
    "No new-post check was completed for this creator. This is a monitoring error, not a new-post alert."
  ].join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram monitor-error alert failed: ${result.description || response.status}`);
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
    try {
      return await runPublicFeed(username);
    } catch (feedError) {
      console.error(`Browserless public-feed fallback failed for ${username}: ${feedError?.message || feedError}`);
      try {
        return runProfileVisit(username);
      } catch (captureError) {
        console.error(`Network-capture fallback failed for ${username}: ${captureError?.message || captureError}`);
        return runProfileDom(username);
      }
    }
  }
}

async function main() {
  const state = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : {};
  if (!state.creators || typeof state.creators !== "object") state.creators = {};
  if (!state.monitorErrors || typeof state.monitorErrors !== "object") state.monitorErrors = {};
  const errors = [];

  for (const username of usernames) {
    try {
      const { squareUid, posts } = await readCreator(username);
      delete state.monitorErrors[username];
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
      const errorText = String(error?.message || error).slice(0, 500);
      console.error(`Creator check failed for ${username}: ${error?.stack || error}`);
      if (state.monitorErrors[username] !== errorText) {
        try {
          await sendMonitorError(username, errorText);
          state.monitorErrors[username] = errorText;
          console.log(`Sent one Telegram warning for the current ${username} monitoring error.`);
        } catch (alertError) {
          console.error(`Could not send monitoring-error alert for ${username}: ${alertError?.message || alertError}`);
        }
      } else {
        console.log(`Same monitoring error already alerted for ${username}; suppressing duplicate Telegram warning.`);
      }
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
