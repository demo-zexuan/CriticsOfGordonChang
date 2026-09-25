-- Track Gordon Chang's posts and our mockery responses
CREATE TABLE IF NOT EXISTS gordon_chang_posts (
  post_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  url TEXT NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Track which posts have been mocked and with what content
CREATE TABLE IF NOT EXISTS mockery_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_post_id TEXT NOT NULL,
  our_post_id TEXT,
  mockery_text_zh TEXT NOT NULL,
  mockery_text_en TEXT NOT NULL,
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (target_post_id) REFERENCES gordon_chang_posts(post_id),
  UNIQUE(target_post_id)
);

CREATE INDEX IF NOT EXISTS idx_gordon_chang_posts_created_at ON gordon_chang_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_gordon_chang_posts_author_id ON gordon_chang_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_mockery_records_target_post_id ON mockery_records(target_post_id);
CREATE INDEX IF NOT EXISTS idx_mockery_records_published_at ON mockery_records(published_at);
