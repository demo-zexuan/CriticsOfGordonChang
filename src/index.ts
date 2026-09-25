import criticsList from './critics.json';

interface Env {
  DB: D1Database;

  TARGET_USERNAME: string;
  CRITICS_LOOKBACK_DAYS?: string;
  POLL_MAX_RESULTS?: string;
  PUBLIC_BASE_URL: string;

  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ADMIN_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;

  APP_ENCRYPTION_KEY: string;
}

type XPost = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  entities?: {
    mentions?: Array<{ username: string; id?: string }>;
  };
  referenced_tweets?: Array<{ type: string; id: string }>;
};

type XUser = {
  id: string;
  name?: string;
  username?: string;
};

type Mockery = {
  zh: string;
  en: string;
};

const X_API = "https://api.x.com";
const X_AUTHORIZE = "https://x.com/i/oauth2/authorize";
const X_TOKEN = "https://api.x.com/2/oauth2/token";
const TELEGRAM_API = (token: string) => `https://api.telegram.org/bot${token}`;

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

async function sha256Base64url(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

async function getAesKey(env: Env): Promise<CryptoKey> {
  const raw = fromBase64url(env.APP_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(env: Env, plaintext: string): Promise<string> {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  return `${base64url(iv)}.${base64url(cipher)}`;
}

async function decryptText(env: Env, packed: string): Promise<string> {
  const [ivB64, cipherB64] = packed.split(".");
  if (!ivB64 || !cipherB64) throw new Error("Invalid encrypted value");
  const key = await getAesKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(ivB64) },
    key,
    fromBase64url(cipherB64)
  );
  return dec.decode(plain);
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at)
     VALUES(?,?,unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`
  ).bind(key, value).run();
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function getTargetUserId(env: Env): Promise<string> {
  const stored = await getSetting(env, "target_user_id");
  if (stored) return stored;

  const token = await getAccessToken(env);
  const r = await xFetch(
    `/2/users/by/username/${encodeURIComponent(env.TARGET_USERNAME)}?user.fields=id,name,username`,
    token
  );
  const data = await r.json() as { data?: XUser; errors?: unknown };

  if (!r.ok || !data.data?.id) {
    throw new Error(`Failed to resolve target user: ${JSON.stringify(data)}`);
  }

  await setSetting(env, "target_user_id", data.data.id);
  return data.data.id;
}

async function getAuthenticatedUser(env: Env): Promise<XUser> {
  const storedId = await getSetting(env, "x_user_id");
  const storedUsername = await getSetting(env, "x_username");
  if (storedId) {
    return {
      id: storedId,
      username: storedUsername ?? undefined,
    };
  }

  const token = await getAccessToken(env);
  const r = await xFetch("/2/users/me?user.fields=id,name,username", token);
  const data = await r.json() as { data?: XUser; errors?: unknown };
  if (!r.ok || !data.data?.id) throw new Error(`Failed to resolve authenticated user: ${JSON.stringify(data)}`);

  await setSetting(env, "x_user_id", data.data.id);
  if (data.data.username) await setSetting(env, "x_username", data.data.username);
  return data.data;
}

async function saveTokens(
  env: Env,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number
): Promise<void> {
  const access = await encryptText(env, accessToken);
  const refresh = refreshToken ? await encryptText(env, refreshToken) : null;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  await env.DB.prepare(
    `INSERT INTO x_tokens(id,access_token_enc,refresh_token_enc,expires_at,updated_at)
     VALUES(1,?,?,?,unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       access_token_enc=excluded.access_token_enc,
       refresh_token_enc=excluded.refresh_token_enc,
       expires_at=excluded.expires_at,
       updated_at=unixepoch()`
  ).bind(access, refresh, expiresAt).run();
}

async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  const r = await fetch(X_TOKEN, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await r.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!r.ok || !data.access_token) {
    throw new Error(`X refresh failed: ${JSON.stringify(data)}`);
  }

  await saveTokens(
    env,
    data.access_token,
    data.refresh_token ?? refreshToken,
    data.expires_in ?? 7200
  );
  return data.access_token;
}

async function getAccessToken(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT access_token_enc, refresh_token_enc, expires_at FROM x_tokens WHERE id=1"
  ).first<{
    access_token_enc: string;
    refresh_token_enc: string | null;
    expires_at: number;
  }>();

  if (!row) {
    throw new Error("X not authorized. Visit /auth/x first.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at > now + 90) {
    return decryptText(env, row.access_token_enc);
  }

  if (!row.refresh_token_enc) {
    throw new Error("X access token expired and no refresh token is available.");
  }

  const refreshToken = await decryptText(env, row.refresh_token_enc);
  return refreshAccessToken(env, refreshToken);
}

async function xFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  return fetch(`${X_API}${path}`, { ...init, headers });
}

function logStructured(level: "info" | "warn" | "error", event: string, context: Record<string, unknown> = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

function getLookubackDays(env: Env): number {
  const value = Number(env.CRITICS_LOOKBACK_DAYS ?? "7");
  return Number.isFinite(value) && value > 0 ? Math.min(value, 365) : 7;
}

function getRandomMockery(): Mockery {
  const idx = Math.floor(Math.random() * criticsList.length);
  return criticsList[idx] as Mockery;
}

async function fetchTargetPosts(env: Env): Promise<XPost[]> {
  const userId = await getTargetUserId(env);
  const token = await getAccessToken(env);

  const qs = new URLSearchParams({
    max_results: String(Math.min(Math.max(Number(env.POLL_MAX_RESULTS ?? "20"), 5), 100)),
    exclude: "retweets",
    "tweet.fields": [
      "id",
      "text",
      "created_at",
      "author_id",
      "conversation_id",
      "in_reply_to_user_id",
      "entities",
      "referenced_tweets"
    ].join(","),
  });

  const r = await xFetch(`/2/users/${userId}/tweets?${qs.toString()}`, token);
  const data = await r.json() as {
    data?: XPost[];
    errors?: unknown;
    meta?: unknown;
  };

  if (!r.ok) throw new Error(`X timeline lookup failed: ${JSON.stringify(data)}`);

  return data.data ?? [];
}

async function findUnmockedPost(env: Env): Promise<XPost | null> {
  const lookbackDays = getLookubackDays(env);
  const cutoffTime = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const posts = await fetchTargetPosts(env);

  for (const post of posts) {
    if (!post.created_at || post.created_at < cutoffTime) continue;

    // Check if already mocked
    const record = await env.DB.prepare(
      `SELECT id FROM mockery_records WHERE target_post_id = ?`
    ).bind(post.id).first<{ id: number }>();

    if (!record) {
      return post;
    }
  }

  return null;
}

async function recordGordonPost(env: Env, post: XPost): Promise<void> {
  const url = `https://x.com/${env.TARGET_USERNAME}/status/${post.id}`;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO gordon_chang_posts(post_id,author_id,text,created_at,url,last_checked_at)
     VALUES(?,?,?,?,?,unixepoch())`
  ).bind(
    post.id,
    post.author_id ?? "",
    post.text,
    post.created_at ?? new Date().toISOString(),
    url
  ).run();
}

async function publishMockery(
  env: Env,
  post: XPost,
  mockery: Mockery
): Promise<{ id: string }> {
  const token = await getAccessToken(env);

  // Try English first (usually more likely to be understood broadly)
  let text = mockery.en;
  if (!isLikelyWithinXLimit(text)) {
    text = mockery.zh;
  }

  if (!isLikelyWithinXLimit(text)) {
    throw new Error("Mockery text too long for X limits");
  }

  const r = await xFetch("/2/tweets", token, {
    method: "POST",
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: post.id }
    }),
  });

  const data = await r.json() as { data?: { id?: string }; errors?: unknown };
  if (!r.ok || !data.data?.id) {
    logStructured("error", "x_publish_failed", {
      post_id: post.id,
      response: data,
      status: r.status,
    });
    throw new Error(`X publish failed: ${JSON.stringify(data)}`);
  }

  return { id: data.data.id };
}

async function recordMockery(
  env: Env,
  targetPostId: string,
  ourPostId: string,
  mockery: Mockery
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mockery_records(target_post_id,our_post_id,mockery_text_zh,mockery_text_en)
     VALUES(?,?,?,?)`
  ).bind(targetPostId, ourPostId, mockery.zh, mockery.en).run();
}

async function processMockeryRound(env: Env): Promise<{ mocked: boolean; postId?: string; error?: string }> {
  try {
    const post = await findUnmockedPost(env);

    if (!post) {
      logStructured("info", "no_unmocked_posts_found", {
        target_username: env.TARGET_USERNAME,
      });
      return { mocked: false };
    }

    await recordGordonPost(env, post);

    const mockery = getRandomMockery();
    const published = await publishMockery(env, post, mockery);
    await recordMockery(env, post.id, published.id, mockery);

    logStructured("info", "mockery_published", {
      target_post_id: post.id,
      our_post_id: published.id,
      target_username: env.TARGET_USERNAME,
    });

    return { mocked: true, postId: post.id };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logStructured("error", "mockery_processing_failed", {
      error: errorMsg,
      target_username: env.TARGET_USERNAME,
    });
    return { mocked: false, error: errorMsg };
  }
}

async function sendTelegram(
  env: Env,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const r = await fetch(`${TELEGRAM_API(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await r.json() as { ok?: boolean; description?: string };
  if (!r.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

async function notifyMockeryResult(
  env: Env,
  result: { mocked: boolean; postId?: string; error?: string }
): Promise<void> {
  if (result.mocked) {
    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: `✅ Mocked Gordon Chang's post ${result.postId}
https://x.com/${env.TARGET_USERNAME}/status/${result.postId}`,
    });
  } else if (result.error) {
    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: `⚠️ Mockery failed: ${result.error}`,
    });
  }
}

function isLikelyWithinXLimit(text: string): boolean {
  return text.length <= 260;
}

async function webhookTelegram(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    logStructured("warn", "telegram_webhook_rejected", {
      reason: "secret_mismatch",
      path: "/webhook/telegram",
    });
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json() as any;
  const chatId =
    update?.message?.chat?.id?.toString() ??
    update?.callback_query?.message?.chat?.id?.toString() ??
    "";

  if (chatId !== env.TELEGRAM_ADMIN_CHAT_ID) {
    // Logged (id only, no message text) so the correct admin chat id can be
    // recovered from the logs when it is misconfigured.
    logStructured("warn", "telegram_unknown_chat", {
      chat_id: chatId,
      configured_admin_chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    });
    return new Response("ok");
  }

  if (update?.message?.text === "/start") {
    logStructured("info", "telegram_command_start", {
      chat_id: chatId,
      target_username: env.TARGET_USERNAME,
    });

    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: [
        "✅ Chang Mockery Bot online.",
        "",
        "/mockery — mock one post now",
        "/status — show bot status",
        "/auth — get the X authorization URL"
      ].join("\n")
    });
    return new Response("ok");
  }

  if (update?.message?.text === "/mockery") {
    try {
      logStructured("info", "telegram_command_mockery_started", {
        chat_id: chatId,
        target_username: env.TARGET_USERNAME,
      });

      const result = await processMockeryRound(env);
      await notifyMockeryResult(env, result);

      logStructured("info", "telegram_command_mockery_completed", {
        chat_id: chatId,
        mocked: result.mocked,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("error", "telegram_command_mockery_failed", {
        chat_id: chatId,
        error: message,
      });

      // A notification failure must not turn the webhook call into a 500.
      await sendTelegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
        text: `❌ Mockery failed:
${message}`
      }).catch((notifyError) => {
        logStructured("error", "telegram_failure_notify_failed", {
          error: notifyError instanceof Error ? notifyError.message : String(notifyError),
        });
      });
    }
    return new Response("ok");
  }

  if (update?.message?.text === "/status") {
    const initialized = await getSetting(env, "initialized");
    const targetId = await getSetting(env, "target_user_id");
    const auth = await env.DB.prepare("SELECT expires_at FROM x_tokens WHERE id=1").first<{ expires_at: number }>();

    logStructured("info", "telegram_command_status", {
      chat_id: chatId,
      initialized: Boolean(initialized),
      target_user_id: targetId,
      token_present: Boolean(auth),
    });

    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: [
        "📊 Status",
        `Target: @${env.TARGET_USERNAME}`,
        `Target ID: ${targetId ?? "not resolved"}`,
        `Initialized: ${initialized ?? "0"}`,
        `X token: ${auth ? "present" : "missing"}`,
        `Lookback: ${getLookubackDays(env)} days`,
        `Public URL: ${env.PUBLIC_BASE_URL}`
      ].join("\n")
    });
    return new Response("ok");
  }

  if (update?.message?.text === "/auth") {
    logStructured("info", "telegram_command_auth", {
      chat_id: chatId,
      target_username: env.TARGET_USERNAME,
    });

    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: `Authorize X here:
${env.PUBLIC_BASE_URL}/auth/x`
    });
    return new Response("ok");
  }

  logStructured("info", "telegram_webhook_processed", {
    chat_id: chatId,
    callback: Boolean(update?.callback_query),
    message_text: update?.message?.text ?? null,
  });

  return new Response("ok");
}

async function oauthStart(env: Env): Promise<Response> {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await sha256Base64url(verifier);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;

  await env.DB.prepare(
    "INSERT INTO oauth_states(state,code_verifier,expires_at) VALUES(?,?,?)"
  ).bind(state, verifier, expiresAt).run();

  const redirectUri = `${env.PUBLIC_BASE_URL}/auth/x/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "tweet.read tweet.write users.read offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  return Response.redirect(`${X_AUTHORIZE}?${params.toString()}`, 302);
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return new Response(`X authorization error: ${error}`, { status: 400 });
  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  const stateRow = await env.DB.prepare(
    "SELECT code_verifier,expires_at FROM oauth_states WHERE state=?"
  ).bind(state).first<{ code_verifier: string; expires_at: number }>();

  if (!stateRow || stateRow.expires_at < Math.floor(Date.now() / 1000)) {
    logStructured("warn", "x_oauth_state_invalid", {
      state,
      has_state_row: Boolean(stateRow),
      target_username: env.TARGET_USERNAME,
    });
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_BASE_URL}/auth/x/callback`,
    code_verifier: stateRow.code_verifier
  });

  const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  const r = await fetch(X_TOKEN, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await r.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!r.ok || !data.access_token) {
    logStructured("error", "x_oauth_token_exchange_failed", {
      target_username: env.TARGET_USERNAME,
      response: data,
      status: r.status,
    });
    return json({ error: data }, 400);
  }

  await saveTokens(
    env,
    data.access_token,
    data.refresh_token ?? null,
    data.expires_in ?? 7200
  );

  const me = await getAuthenticatedUser(env);
  await setSetting(env, "x_user_id", me.id);
  if (me.username) await setSetting(env, "x_username", me.username);

  logStructured("info", "x_oauth_success", {
    target_username: env.TARGET_USERNAME,
    x_user_id: me.id,
    x_username: me.username ?? null,
  });

  const target = await xFetch(
    `/2/users/by/username/${encodeURIComponent(env.TARGET_USERNAME)}?user.fields=id,name,username`,
    data.access_token
  );
  const targetData = await target.json() as { data?: XUser };

  if (target.ok && targetData.data?.id) {
    await setSetting(env, "target_user_id", targetData.data.id);
  }

  return new Response(
    [
      "X authorization succeeded.",
      `Authenticated as @${me.username ?? me.name ?? me.id}.`,
      "",
      `Now monitoring: @${env.TARGET_USERNAME}`,
      "",
      "Next: use /mockery in Telegram or wait for the next Cron Trigger."
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

async function health(env: Env): Promise<Response> {
  const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();

  // Presence-only self check: never echo credential values.
  const bindings = {
    DB: Boolean(env.DB),
    X_CLIENT_ID: Boolean(env.X_CLIENT_ID),
    X_CLIENT_SECRET: Boolean(env.X_CLIENT_SECRET),
    TELEGRAM_BOT_TOKEN: Boolean(env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_ADMIN_CHAT_ID: Boolean(env.TELEGRAM_ADMIN_CHAT_ID),
    TELEGRAM_WEBHOOK_SECRET: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    APP_ENCRYPTION_KEY: Boolean(env.APP_ENCRYPTION_KEY),
  };

  return json({
    ok: db?.ok === 1,
    target: env.TARGET_USERNAME,
    cron: "*/5 * * * * (UTC)",
    mockeries_available: criticsList.length,
    bindings,
    bindings_ready: Object.values(bindings).every(Boolean),
  });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await processMockeryRound(env);

        if (result.mocked) {
          // Report successes so the cron is observable from Telegram.
          await notifyMockeryResult(env, result).catch((error) => {
            console.error("Cron notify failed:", error);
          });
          return;
        }

        // Failures are logged only: a persistent problem (for example X not
        // authorized) would otherwise send a message every 5 minutes.
        if (result.error) {
          console.error("Cron round failed:", result.error);
        }
      })()
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        logStructured("info", "http_root_accessed", {
          method: request.method,
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });

        return new Response(
          "Chang Mockery Bot is running. Use /health for status or /auth/x to authorize X.",
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      if (request.method === "GET" && url.pathname === "/health") {
        logStructured("info", "health_check_requested", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return await health(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/x") {
        logStructured("info", "oauth_start_requested", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return await oauthStart(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/x/callback") {
        logStructured("info", "oauth_callback_received", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
          query_params: Object.fromEntries(new URL(request.url).searchParams.entries()),
        });
        return await oauthCallback(request, env);
      }

      if (request.method === "POST" && url.pathname === "/webhook/telegram") {
        logStructured("info", "telegram_webhook_received", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return await webhookTelegram(request, env);
      }

      logStructured("warn", "http_route_not_found", {
        method: request.method,
        path: url.pathname,
      });
      return json({ error: "not_found" }, 404);
    } catch (error) {
      logStructured("error", "request_handler_exception", {
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return json({
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }
};
