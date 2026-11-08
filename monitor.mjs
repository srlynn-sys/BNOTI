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
  console.log(`Trying expanded public Square feeds for ${username}...`);
  const feeds = [
    {
      name: "latest articles",
      maxPages: 50,
      url: page => `https://www.binance.com/bapi/composite/v3/friendly/pgc/content/article/list?pageIndex=${page}&pageSize=20&type=2`
    },
    {
      name: "news feed",
      maxPages: 10,
      url: page => `https://www.binance.com/bapi/composite/v4/friendly/pgc/feed/news/list?pageIndex=${page}&pageSize=20`
    },
    {
      name: "trending articles",
      maxPages: 5,
      url: page => `https://www.binance.com/bapi/composite/v3/friendly/pgc/content/article/list?pageIndex=${page}&pageSize=20&type=1`
    }
  ];
  const wanted = username.toLowerCase();
  const errors = [];
  const knownPostIds = { "BTCxiao6": ["385892861015833"], "C-H-I-N-A-": ["385914677072715"] };
  const resolvedAuthorIds = new Set();
  for (const postId of (knownPostIds[username] || [])) {
    try {
      const detailResponse = await fetch("https://www.binance.com/bapi/composite/v3/friendly/pgc/special/content/detail/" + postId, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "referer": "https://www.binance.com/en/square/",
          "user-agent": "Mozilla/5.0"
        },
        signal: AbortSignal.timeout(12000)
      });
      const detailText = await detailResponse.text();
      if (!detailResponse.ok) throw new Error("HTTP " + detailResponse.status);
      const payload = JSON.parse(detailText);
      const d = payload && payload.data;
      const author = d && (d.author || d.creator || d.user || {});
      const authorId = d && (d.squareAuthorId || d.authorId || d.uid || d.userId || author.squareAuthorId || author.uid);
      const authorName = d && (d.username || d.authorName || d.displayName || author.username || author.authorName || author.displayName);
      console.log("Known post detail " + postId + ": " + JSON.stringify({authorName: authorName || null, authorId: authorId || null, code: payload.code || null, keys: d && typeof d === "object" ? Object.keys(d).slice(0, 35) : []}));
      if (authorId != null) resolvedAuthorIds.add(String(authorId));
      if (typeof authorName === "string" && authorName.toLowerCase() === wanted) {
        const id = String(d.id || d.postId || postId);
        return { squareUid: authorId == null ? username : String(authorId), posts: [{
          ...d,
          id,
          title: d.title || d.content || d.bodyTextOnly || "(No title)",
          time: d.date || d.createTime || null,
          url: d.webLink || d.shareLink || "https://www.binance.com/en/square/post/" + id
        }] };
      }
    } catch (e) {
      console.log("Known post detail lookup failed for " + postId + ": " + (e && e.message || e));
    }
  }
  for (const feed of feeds) {
    for (let page = 1; page <= feed.maxPages; page++) {
      try {
        const response = await fetch(feed.url(page), {
          headers: {
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9",
            "referer": "https://www.binance.com/zh-CN/square/trending",
            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
          },
          signal: AbortSignal.timeout(15000)
        });
        const bodyText = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 120)}`);
        let payload;
        try { payload = JSON.parse(bodyText); }
        catch { throw new Error("returned non-JSON content (possibly a security check)"); }
        const data = payload?.data;
        const list = Array.isArray(data) ? data
          : Array.isArray(data?.list) ? data.list
          : Array.isArray(data?.articles) ? data.articles
          : Array.isArray(data?.contents) ? data.contents
          : Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.vos) ? data.vos
          : Array.isArray(data?.feeds) ? data.feeds : [];
        console.log(`${feed.name} page ${page}: ${list.length} candidate items`);
        if (page === 1 && list.length) {
          const sample = list[0];
          const authorFields = Object.fromEntries(
            Object.entries(sample).filter(([key]) => /author|user|creator|profile|nick|name|handle/i.test(key))
              .map(([key, value]) => [key, value && typeof value === "object" ? JSON.stringify(value).slice(0, 250) : value])
          );
          console.log(`Feed schema ${feed.name}: ${JSON.stringify({keys:Object.keys(sample),authorFields})}`);
        }
        const matches = list.filter(p => {
          const candidates = [
            p?.username, p?.handle, p?.authorUsername, p?.authorHandle,
            p?.creatorName, p?.authorName, p?.nickname, p?.userName,
            p?.displayName, p?.screenName, p?.authorDisplayName,
            p?.author?.username, p?.author?.handle, p?.author?.nickname,
            p?.author?.displayName, p?.user?.username, p?.user?.handle,
            p?.user?.nickname, p?.user?.displayName, p?.creator?.username,
            p?.creator?.handle, p?.creator?.displayName
          ].filter(v => typeof v === "string").map(v => v.toLowerCase());
          const authorIds = [p?.squareAuthorId, p?.authorId, p?.uid, p?.userId, p?.author?.squareAuthorId, p?.author?.uid]
            .filter(v => v != null).map(String);
          return candidates.includes(wanted) || authorIds.some(id => resolvedAuthorIds.has(id));
        }).map(p => {
          const id = p?.id ?? p?.postId ?? p?.contentId;
          const link = p?.webLink || p?.shareLink || p?.url || (id ? `https://www.binance.com/en/square/post/${id}` : null);
          return {
            ...p,
            id: id == null ? null : String(id),
            title: p?.title || p?.content || p?.bodyTextOnly || p?.body || "(No title)",
            time: p?.date || p?.createTime || p?.publishTime || null,
            url: link
          };
        }).filter(p => p.id && p.url);
        if (matches.length) {
          console.log(`Public ${feed.name} matched ${matches.length} posts for ${username}`);
          return { squareUid: username, posts: matches };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${feed.name} page ${page}: ${msg}`);
        console.log(`Public ${feed.name} fallback issue: ${msg}`);
        break;
      }
    }
  }
  throw new Error(`No exact public-feed author match for ${username} across latest/news/trending feeds. ${errors.slice(0, 3).join(" | ")}`);
}

// Profile-page fallbacks intentionally removed; use public feeds only.

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
  console.log(`Checking public Binance Square feeds for creator: ${username}`);
  return await runPublicFeed(username);
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
