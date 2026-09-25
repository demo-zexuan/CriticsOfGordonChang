# 🚨 Critics of Gordon Chang

[English](README.md) | [中文](README.zh.md)

A monitoring bot for tracking, fact-checking, and analyzing Gordon Chang–related discourse on X.

This project is designed as a direct-response monitoring workflow: it watches, records, matches facts, generates a draft, and publishes automatically when the target post still qualifies as a summon.

---

## 📌 Overview

The system is a Cloudflare Worker that:

- polls a configured X account on a schedule
- resolves target user metadata and stores it in D1
- deduplicates incoming posts
- matches content against a local fact library
- prepares bilingual draft replies
- sends draft + evidence to Telegram for operational visibility
- publishes automatically when the target still qualifies as a valid summon

The goal is not indiscriminate trolling. The goal is evidence, automatic response, and fact-based discipline.

---

## 🧠 What this project does

### 1) Monitoring

The Worker runs on a cron schedule and checks for new posts from the target account. It stores them in D1 and ensures they are not processed repeatedly.

### 2) Juncture detection

It detects whether the target post mentions, quotes, replies to, or otherwise summons your account. Only those conversations are eligible for intervention.

### 3) Evidence matching

The app compares post content against a local fact list and attaches relevant fact records to the draft generation path.

### 4) Direct response

Once a post still qualifies as a summon, the bot generates a draft and publishes the reply automatically without a separate approval step.

### 5) Safety gate

Before publishing, the app re-checks the target post to confirm it still exists and still qualifies as a summon.

---

## 🏛️ Architecture

```text
X API ──► Cloudflare Worker ──► D1 Database
           │
           ├── Telegram notifications
           ├── fact library matching
           ├── draft generation
           └── auto-publish safety checks
```

Key components:

- Cloudflare Worker: request handling, cron polling, and automatic response logic
- D1: persistence for posts, drafts, OAuth state, settings, and fact records
- X API: live source of truth for target activity
- Telegram: operational notifications and admin commands
- Optional OpenAI: drafting enhancement

---

## 🧪 Operational model

This is a monitor-and-respond system, not a free-form attack bot.

It is designed to:

- collect evidence
- preserve a historical record
- reduce duplicate noise
- publish only when the target still qualifies as a summon

---

## 🚩 Gordon Chang lore, with a professional filter

This project was built around a very specific category of content: repetitive, grandiose, abstract, and often self-referential geopolitical claims that sound definitive but frequently arrive with more certainty than evidence.

It includes a lightweight mockery-detection layer for patterns like:

- “everything is collapsing, but nobody is paying attention”
- “a single prediction somehow explains the entire future”
- “the same thesis gets sprayed in a new wrapper every season”
- “this is not speculation, this is inevitable history”
- “the story is a warning, but the warning is just recycled panic”

The project does not worship that style. It records it, matches it against evidence, and answers only when the pattern still qualifies as a valid summon.

---

## ⚙️ Local setup

### Requirements

- Node.js 18+
- pnpm
- Cloudflare account
- D1 database
- X Developer App
- Telegram Bot

### Install

```bash
pnpm install
```

### Type check

```bash
pnpm run check
```

---

## ☁️ Cloudflare configuration

The Worker config lives in `wrangler.jsonc`, which is **committed on purpose** —
it holds only non-secret settings (name, cron trigger, non-secret vars and the D1
binding). Credentials never belong in it. Cloudflare's build environment checks
out the repo, so a gitignored config would make `wrangler deploy` fail.

Copy the local env template before filling real values:

```bash
cp .dev.vars.example .dev.vars
```

Then configure:

- D1 `database_id`
- `PUBLIC_BASE_URL`
- `TARGET_USERNAME`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `APP_ENCRYPTION_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- optional `OPENAI_API_KEY`

> Never commit real secrets to GitHub. Keep them in local `.dev.vars` or Cloudflare Worker secrets.

---

## 🗃️ D1 and migrations

Create the database:

```bash
npx wrangler d1 create critics-of-gordon-chang
```

Apply migrations:

```bash
npx wrangler d1 migrations apply critics-of-gordon-chang --remote
```

Seed the fact library if needed:

```bash
npx wrangler d1 execute critics-of-gordon-chang --remote --file=seed.sql
```

---

## 🔐 X OAuth and Telegram setup

### X

- enable OAuth 2.0 in your X Developer App
- set callback URL to:

```text
https://YOUR-WORKER.workers.dev/auth/x/callback
```

Set Cloudflare secrets:

```bash
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
npx wrangler secret put APP_ENCRYPTION_KEY
```

### Telegram

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Then set the webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://YOUR-WORKER.workers.dev/webhook/telegram",
    "secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET"
  }'
```

---

## 🚀 Deploy

```bash
npx wrangler deploy
```

Health route:

```bash
curl https://YOUR-WORKER.workers.dev/health
```

Authorize X:

```text
https://YOUR-WORKER.workers.dev/auth/x
```

Then trigger a manual monitor cycle from Telegram with `/check`.

---

## 🧾 GitHub and repo hygiene

This repo is intended for public GitHub hosting, but secrets must stay local.

Use:

- `.dev.vars` for local runtime values (never committed)
- Worker Secrets in Cloudflare for production credentials
- `wrangler.jsonc` in Git — it carries no secrets, only non-secret settings

The repo includes:

- [.gitignore](.gitignore)
- [.dev.vars.example](.dev.vars.example)
- [wrangler.jsonc](wrangler.jsonc)

---

## ✅ Status

The project is operational as a monitoring-and-response pipeline with structured logs, D1 persistence, OAuth handling, Telegram admin notifications, and protected publication gates.

---

## 🌍 Languages

- [English](README.md)
- [中文](README.zh.md)

---

## 📝 License

This project is for personal or project-level deployment and should be used responsibly in line with X API, Telegram, and Cloudflare platform policies.


## License / 许可证

This repository is intended for personal or project-specific deployment. Use it responsibly and in accordance with X API and Telegram policies.

本仓库用于个人或项目级部署。使用前请遵守 X API、Telegram 及相关平台政策，并保持安全边界清晰。
