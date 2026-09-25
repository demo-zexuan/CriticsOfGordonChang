CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS x_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS target_posts (
  post_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  summoned INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS drafts (
  post_id TEXT PRIMARY KEY,
  zh TEXT NOT NULL,
  en TEXT NOT NULL,
  matched_fact_ids TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  published_post_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (post_id) REFERENCES target_posts(post_id)
);

CREATE TABLE IF NOT EXISTS my_posts (
  post_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  url TEXT,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS my_mockery_history (
  my_post_id TEXT PRIMARY KEY,
  target_account TEXT NOT NULL,
  matched_keywords TEXT NOT NULL,
  is_mocking INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (my_post_id) REFERENCES my_posts(post_id)
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  year INTEGER NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_target_posts_created_at ON target_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_my_posts_created_at ON my_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_my_mockery_history_target_time ON my_mockery_history(target_account, created_at);
