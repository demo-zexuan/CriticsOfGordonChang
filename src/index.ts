interface Env {
  DB: D1Database;

  TARGET_USERNAME: string;
  TARGET_LOOKBACK_DAYS?: string;
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

type Fact = {
  id: number;
  topic: string;
  year: number;
  summary: string;
  keywords: string;
  source_title: string;
  source_url: string;
  priority: number;
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

async function upsertTargetPost(env: Env, post: XPost, summoned: boolean): Promise<boolean> {
  const url = `https://x.com/${env.TARGET_USERNAME}/status/${post.id}`;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO target_posts(post_id,created_at,text,url,summoned)
     VALUES(?,?,?,?,?)`
  ).bind(
    post.id,
    post.created_at ?? new Date().toISOString(),
    post.text,
    url,
    summoned ? 1 : 0
  ).run();

  return Boolean(result.meta.changes);
}

async function getKnownLatestPostId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT post_id FROM target_posts ORDER BY created_at DESC LIMIT 1"
  ).first<{ post_id: string }>();
  return row?.post_id ?? null;
}

async function determineSummoned(
  env: Env,
  post: XPost,
  includedTweets: XPost[]
): Promise<boolean> {
  const me = await getAuthenticatedUser(env);
  const meUsername = (me.username ?? "").toLowerCase();

  const mentioned = (post.entities?.mentions ?? []).some(
    (m) => (m.username ?? "").toLowerCase() === meUsername
  );
  if (mentioned) return true;

  if (post.in_reply_to_user_id === me.id) return true;

  const referenced = post.referenced_tweets ?? [];
  for (const ref of referenced) {
    if (ref.type !== "quoted") continue;
    const quoted = includedTweets.find((t) => t.id === ref.id);
    if (quoted?.author_id === me.id) return true;
  }

  return false;
}

async function fetchTargetPosts(env: Env): Promise<{ posts: XPost[]; includesTweets: XPost[] }> {
  const userId = await getTargetUserId(env);
  const token = await getAccessToken(env);
  const latestId = await getKnownLatestPostId(env);

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
    expansions: "referenced_tweets.id",
  });

  if (latestId) qs.set("since_id", latestId);

  const r = await xFetch(`/2/users/${userId}/tweets?${qs.toString()}`, token);
  const data = await r.json() as {
    data?: XPost[];
    includes?: { tweets?: XPost[] };
    errors?: unknown;
    meta?: unknown;
  };

  if (!r.ok) throw new Error(`X timeline lookup failed: ${JSON.stringify(data)}`);

  return {
    posts: data.data ?? [],
    includesTweets: data.includes?.tweets ?? [],
  };
}

function compact(text: string, max = 900): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max - 1) + "…" : normalized;
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

const GORDON_CHANG_TARGET_PATTERNS = [
  "gordongchang",
  "gordon chang",
  "gordon g chang",
  "gordonchang",
  "章家敦",
  "@gordongchang",
  "@gordonchang",
];

const MOCKERY_PATTERNS = [
  "laughable",
  "ridiculous",
  "nonsense",
  "absurd",
  "failed",
  "failure",
  "wrong",
  "clown",
  "stupid",
  "foolish",
  "笑死",
  "荒唐",
  "可笑",
  "失败",
  "失算",
  "笑话",
  "糊弄",
  "蠢",
  "荒谬",
  "误导",
  "骗人",
  "屎",
  "无知",
  "可怜",
  "失败者",
];

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[@#]/g, " ").replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isTargetingGordonChang(text: string, targetUsername?: string): boolean {
  const normalized = normalizeForMatch(text);
  const targetName = normalizeForMatch(targetUsername ?? "");

  if (targetName && normalized.includes(targetName)) return true;
  return GORDON_CHANG_TARGET_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isLikelyMockery(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return MOCKERY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function getLookbackDays(env: Env): number {
  const value = Number(env.TARGET_LOOKBACK_DAYS ?? "30");
  return Number.isFinite(value) && value > 0 ? Math.min(value, 365) : 30;
}

async function getRecentMockeryWindow(env: Env): Promise<number> {
  const windowMs = getLookbackDays(env) * 24 * 60 * 60 * 1000;
  return Math.floor((Date.now() - windowMs) / 1000);
}

async function upsertMyPost(env: Env, postId: string, text: string, createdAt: string, url: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO my_posts(post_id,text,created_at,url,processed_at)
     VALUES(?,?,?,?,unixepoch())
     ON CONFLICT(post_id) DO UPDATE SET
       text=excluded.text,
       created_at=excluded.created_at,
       url=excluded.url,
       processed_at=unixepoch()`
  ).bind(postId, text, createdAt, url).run();
}

async function recordMyMockeryDecision(
  env: Env,
  myPostId: string,
  targetAccount: string,
  text: string,
  matchedKeywords: string[],
  isMocking: boolean,
  confidence: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO my_mockery_history(my_post_id,target_account,matched_keywords,is_mocking,confidence,created_at,processed_at)
     VALUES(?,?,?,?,?,?,unixepoch())
     ON CONFLICT(my_post_id) DO UPDATE SET
       target_account=excluded.target_account,
       matched_keywords=excluded.matched_keywords,
       is_mocking=excluded.is_mocking,
       confidence=excluded.confidence,
       processed_at=unixepoch()`
  ).bind(
    myPostId,
    targetAccount,
    matchedKeywords.join(","),
    isMocking ? 1 : 0,
    confidence,
    Math.floor(Date.now() / 1000)
  ).run();

  if (isMocking) {
    logStructured("info", "mockery_history_recorded", {
      my_post_id: myPostId,
      target_account: targetAccount,
      matched_keywords: matchedKeywords,
      confidence,
      snippet: text.slice(0, 120),
    });
  }
}

async function hasRecentMockeryForTarget(env: Env, targetAccount: string): Promise<boolean> {
  const cutoff = await getRecentMockeryWindow(env);
  const row = await env.DB.prepare(
    `SELECT 1 AS hit
     FROM my_mockery_history h
     JOIN my_posts p ON p.post_id = h.my_post_id
     WHERE h.target_account = ?
       AND h.is_mocking = 1
       AND p.created_at >= datetime(?,'unixepoch')
     LIMIT 1`
  ).bind(targetAccount, String(cutoff)).first<{ hit: number }>();

  return Boolean(row?.hit);
}

async function classifyMyHistoryForTarget(env: Env, postId: string, text: string, createdAt: string): Promise<void> {
  const targetAccount = env.TARGET_USERNAME;
  const url = `https://x.com/i/web/status/${postId}`;
  await upsertMyPost(env, postId, text, createdAt, url);

  const normalized = normalizeForMatch(text);
  const keywords = GORDON_CHANG_TARGET_PATTERNS.filter((k) => normalized.includes(k));
  const isTargeted = isTargetingGordonChang(text, targetAccount);
  const isMocking = isTargeted && isLikelyMockery(text);

  if (!isTargeted && !isMocking) return;

  const matched = Array.from(new Set([...keywords, ...MOCKERY_PATTERNS.filter((k) => normalized.includes(k))]));
  const confidence = Math.min(1, 0.5 + matched.length * 0.1 + (isMocking ? 0.2 : 0));

  await recordMyMockeryDecision(
    env,
    postId,
    targetAccount,
    text,
    matched,
    isMocking,
    confidence
  );
}

async function getRelevantFacts(env: Env, postText: string): Promise<Fact[]> {
  const rows = await env.DB.prepare(
    "SELECT id,topic,year,summary,keywords,source_title,source_url,priority FROM facts ORDER BY priority DESC, id ASC"
  ).all<Fact>();

  const t = postText.toLowerCase();
  return (rows.results ?? []).filter((fact) => {
    const keywords = fact.keywords
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);

    return keywords.some((k) => t.includes(k));
  }).slice(0, 6);
}

function fallbackDraft(post: XPost, facts: Fact[]): { zh: string; en: string } {
  if (facts.length > 0) {
    const f = facts[0];
    return {
      zh: `⏰ 又到了核对旧预测的时间：${f.year}年的公开记录给出了明确时间点。日期已经过去，原始来源还在。`,
      en: `⏰ Time for a forecast check: the ${f.year} record gave a specific timeline. The date has passed; the source is still there.`,
    };
  }

  return {
    zh: `🔎 先看原文、日期和后来发生的事情。预测可以大胆，核验还是要看记录。`,
    en: `🔎 Check the original claim, the date, and what happened afterward. Bold forecasts still need to be tested against the record.`,
  };
}

async function generateDraft(
  env: Env,
  post: XPost,
  facts: Fact[]
): Promise<{ zh: string; en: string }> {
  return fallbackDraft(post, facts);
}

function isLikelyWithinXLimit(text: string): boolean {
  // Conservative pre-check. X's official character weighting is more nuanced;
  // this intentionally rejects obviously long drafts rather than silently truncating them.
  return text.length <= 260;
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

async function sendNewPostNotice(
  env: Env,
  post: XPost,
  summoned: boolean,
  draft: { zh: string; en: string },
  facts: Fact[]
): Promise<void> {
  const sources = facts.length
    ? "\n\nSources:\n" + facts.map(f => `• ${f.year} — ${f.source_title}\n${f.source_url}`).join("\n")
    : "\n\nSources: none matched in local database.";

  const warning = summoned
    ? "✅ This post appears to have summoned your account. The bot will publish a direct reply automatically."
    : "⚠️ This post does NOT appear to have summoned your account; it will be recorded without publishing.";

  const text = [
    "🚨 New target post",
    "",
    `@${env.TARGET_USERNAME}`,
    post.created_at ?? "",
    post.text,
    "",
    `🔗 https://x.com/${env.TARGET_USERNAME}/status/${post.id}`,
    "",
    warning,
    "",
    "🇨🇳 Draft",
    draft.zh,
    "",
    "🇺🇸 Draft",
    draft.en,
    sources,
  ].join("\n");

  await sendTelegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    text,
    disable_web_page_preview: true,
  });

  logStructured("info", "telegram_notice_sent", {
    post_id: post.id,
    target_username: env.TARGET_USERNAME,
    summoned,
    fact_count: facts.length,
    draft_len_zh: draft.zh.length,
    draft_len_en: draft.en.length,
  });
}

async function saveDraft(
  env: Env,
  post: XPost,
  draft: { zh: string; en: string },
  facts: Fact[]
): Promise<void> {
  const factIds = facts.map(f => f.id).join(",");
  await env.DB.prepare(
    `INSERT INTO drafts(post_id,zh,en,matched_fact_ids,status,created_at,updated_at)
     VALUES(?,?,?,?, 'pending', unixepoch(), unixepoch())
     ON CONFLICT(post_id) DO UPDATE SET
       zh=excluded.zh,
       en=excluded.en,
       matched_fact_ids=excluded.matched_fact_ids,
       updated_at=unixepoch()`
  ).bind(post.id, draft.zh, draft.en, factIds).run();
}

async function processNewPosts(env: Env): Promise<{ count: number }> {
  const { posts, includesTweets } = await fetchTargetPosts(env);

  const initialized = await getSetting(env, "initialized");
  const newPosts: XPost[] = [];

  logStructured("info", "poll_cycle_started", {
    target_username: env.TARGET_USERNAME,
    fetched_post_count: posts.length,
    initialized: Boolean(initialized),
    lookback_days: getLookbackDays(env),
  });

  for (const post of [...posts].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  )) {
    const summoned = await determineSummoned(env, post, includesTweets);
    const inserted = await upsertTargetPost(env, post, summoned);

    if (!inserted) {
      logStructured("info", "post_skipped_duplicate", {
        post_id: post.id,
        target_username: env.TARGET_USERNAME,
      });
      continue;
    }
    newPosts.push(post);

    logStructured("info", "target_post_detected", {
      post_id: post.id,
      target_username: env.TARGET_USERNAME,
      summoned,
      created_at: post.created_at,
    });

    // On first run, record recent posts but do not generate notifications.
    if (!initialized) continue;

    const facts = await getRelevantFacts(env, post.text);
    const draft = await generateDraft(env, post, facts);
    await saveDraft(env, post, draft, facts);
    await sendNewPostNotice(env, post, summoned, draft, facts);

    if (summoned) {
      try {
        const published = await publishReply(env, post.id, "en");
        await sendTelegram(env, "sendMessage", {
          chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
          text: `✅ Auto-published English reply:\nhttps://x.com/i/web/status/${published.id}`,
        });

        logStructured("info", "auto_reply_published", {
          post_id: post.id,
          language: "en",
          published_post_id: published.id,
          target_username: env.TARGET_USERNAME,
        });
      } catch (error) {
        logStructured("error", "auto_reply_publish_failed", {
          post_id: post.id,
          error: error instanceof Error ? error.message : String(error),
          target_username: env.TARGET_USERNAME,
        });

        await sendTelegram(env, "sendMessage", {
          chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
          text: `❌ Auto-publish failed:\n${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    logStructured("info", "draft_ready_for_publish", {
      post_id: post.id,
      summoned,
      fact_count: facts.length,
      draft_len_zh: draft.zh.length,
      draft_len_en: draft.en.length,
    });
  }

  if (!initialized) {
    await setSetting(env, "initialized", "1");
    logStructured("info", "bot_initialized", {
      target_username: env.TARGET_USERNAME,
    });
  }

  logStructured("info", "poll_cycle_completed", {
    target_username: env.TARGET_USERNAME,
    new_post_count: newPosts.length,
  });

  return { count: newPosts.length };
}

async function verifyTargetPostExists(
  env: Env,
  postId: string
): Promise<{ post: XPost; includesTweets: XPost[] } | null> {
  const token = await getAccessToken(env);
  const qs = new URLSearchParams({
    "tweet.fields": "id,text,author_id,created_at,entities,referenced_tweets,in_reply_to_user_id",
    expansions: "referenced_tweets.id",
  });

  const r = await xFetch(
    `/2/tweets/${encodeURIComponent(postId)}?${qs.toString()}`,
    token
  );
  if (r.status === 404) return null;

  const data = await r.json() as {
    data?: XPost;
    includes?: { tweets?: XPost[] };
    errors?: unknown;
  };

  if (!r.ok) throw new Error(`Post lookup failed: ${JSON.stringify(data)}`);
  if (!data.data) return null;

  return {
    post: data.data,
    includesTweets: data.includes?.tweets ?? [],
  };
}

async function publishReply(
  env: Env,
  postId: string,
  language: "zh" | "en"
): Promise<{ id: string }> {
  const row = await env.DB.prepare(
    `SELECT d.zh,d.en,t.summoned,t.text
     FROM drafts d JOIN target_posts t ON t.post_id=d.post_id
     WHERE d.post_id=?`
  ).bind(postId).first<{
    zh: string;
    en: string;
    summoned: number;
    text: string;
  }>();

  if (!row) throw new Error("Draft not found.");
  if (!row.summoned) {
    throw new Error("Safety guard: target post did not summon your account.");
  }

  const verified = await verifyTargetPostExists(env, postId);
  if (!verified) throw new Error("Target post no longer exists.");
  if (verified.post.author_id === undefined) throw new Error("Target author cannot be verified.");

  const nowSummoned = await determineSummoned(
    env,
    verified.post,
    verified.includesTweets
  );
  if (!nowSummoned) {
    throw new Error("Safety guard: current target post no longer appears to summon your account.");
  }

  const text = language === "zh" ? row.zh : row.en;
  if (!isLikelyWithinXLimit(text)) {
    throw new Error("Draft rejected: too long for conservative X pre-check.");
  }

  const token = await getAccessToken(env);
  const r = await xFetch("/2/tweets", token, {
    method: "POST",
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: postId }
    }),
  });

  const data = await r.json() as { data?: { id?: string }; errors?: unknown };
  if (!r.ok || !data.data?.id) {
    logStructured("error", "x_publish_failed", {
      post_id: postId,
      language,
      response: data,
      status: r.status,
    });
    throw new Error(`X publish failed: ${JSON.stringify(data)}`);
  }

  await env.DB.prepare(
    `UPDATE drafts
     SET status='published', published_post_id=?, updated_at=unixepoch()
     WHERE post_id=?`
  ).bind(data.data.id, postId).run();

  logStructured("info", "x_reply_published", {
    in_reply_to_post_id: postId,
    published_post_id: data.data.id,
    language,
    target_username: env.TARGET_USERNAME,
  });

  return { id: data.data.id };
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

  if (chatId !== env.TELEGRAM_ADMIN_CHAT_ID) return new Response("ok");

  if (update?.message?.text === "/start") {
    logStructured("info", "telegram_command_start", {
      chat_id: chatId,
      target_username: env.TARGET_USERNAME,
    });

    await sendTelegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      text: [
        "✅ Chang Watch Bot online.",
        "",
        "/check — run an immediate timeline check",
        "/status — show bot status",
        "/auth — get the X authorization URL"
      ].join("\n")
    });
    return new Response("ok");
  }

  if (update?.message?.text === "/check") {
    try {
      logStructured("info", "telegram_command_check_started", {
        chat_id: chatId,
        target_username: env.TARGET_USERNAME,
      });

      const result = await processNewPosts(env);
      await sendTelegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
        text: `🔎 Check complete. New posts recorded: ${result.count}`
      });

      logStructured("info", "telegram_command_check_completed", {
        chat_id: chatId,
        new_posts: result.count,
      });
    } catch (error) {
      logStructured("error", "telegram_command_check_failed", {
        chat_id: chatId,
        error: error instanceof Error ? error.message : String(error),
      });

      await sendTelegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
        text: `❌ Check failed:\n${error instanceof Error ? error.message : String(error)}`
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
      text: `Authorize X here:\n${env.PUBLIC_BASE_URL}/auth/x`
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
      `Target: @${env.TARGET_USERNAME}`,
      "",
      "Next: use /check in Telegram or wait for the next Cron Trigger."
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

async function health(env: Env): Promise<Response> {
  const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return json({
    ok: db?.ok === 1,
    target: env.TARGET_USERNAME,
    cron: "*/5 * * * * (UTC)",
  });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      processNewPosts(env).catch((error) => {
        console.error("Cron failed:", error);
      })
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
          "Chang Watch Bot is running. Use /health for status or /auth/x to authorize X.",
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      if (request.method === "GET" && url.pathname === "/health") {
        logStructured("info", "health_check_requested", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return health(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/x") {
        logStructured("info", "oauth_start_requested", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return oauthStart(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/x/callback") {
        logStructured("info", "oauth_callback_received", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
          query_params: Object.fromEntries(new URL(request.url).searchParams.entries()),
        });
        return oauthCallback(request, env);
      }

      if (request.method === "POST" && url.pathname === "/webhook/telegram") {
        logStructured("info", "telegram_webhook_received", {
          path: url.pathname,
          target_username: env.TARGET_USERNAME,
        });
        return webhookTelegram(request, env);
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
