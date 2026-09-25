# 🚨 章家敦观察器

[English](README.md) | [中文](README.zh.md)

这是一个监控与自动回应机器人，用于追踪、事实核对以及分析 X 上与 Gordon Chang（章家敦）相关的内容。

这个项目被设计成一个直接响应的工作流：它会观察、记录、匹配事实、生成草稿，并在目标帖子仍符合召唤条件时自动发布。

---

## 📌 项目概览

这个系统由 Cloudflare Worker 负责：

- 按计划轮询指定 X 账号的新帖子
- 解析目标用户信息并保存到 D1
- 对新内容去重
- 将内容与本地 fact 库进行匹配
- 生成中英双语草稿
- 将草稿和证据发给 Telegram 进行运维可见性通知
- 仅在目标帖子仍然满足召唤条件时才自动发布

它不是随手乱骂的自动机器人，而是一套证据、自动回应和比例化策略的工作流。

---

## 🧠 这个项目到底在做什么

### 1) 监控

Worker 会按 cron 调度定期检查目标账号的新帖子，并写入 D1，避免重复处理同一条内容。

### 2) 召唤判断

系统会判断目标帖子是否提及、引用、回复，或否则“召唤”了你的账号。只有这类内容才具备后续干预资格。

### 3) 事实匹配

应用会把帖子内容与本地 facts 表中已有的事实记录做比对，并在生成草稿时附上相关证据。

### 4) 直接回应

一旦目标帖子仍然符合召唤条件，机器人会直接生成草稿并自动发布，不再需要额外审批步骤。

### 5) 安全门槛

发布前，系统会重新检查目标帖子是否仍然存在，并确认它依然符合“召唤”条件。

---

## 🏛️ 架构

```text
X API ──► Cloudflare Worker ──► D1 Database
           │
           ├── Telegram 通知
           ├── 事实库匹配
           ├── 草稿生成
           └── 自动发布安全检查
```

关键组件：

- Cloudflare Worker：处理 HTTP、定时任务和自动回应逻辑
- D1：保存帖子、草稿、OAuth 状态、配置和事实记录
- X API：目标账号活动的实时数据源
- Telegram：运维通知与管理员命令
- 可选 OpenAI：提升草稿生成质量

---

## 🧪 运行模型

这是“监控 + 自动回应”系统，不是无限制的攻击机器人。

它的设计目标是：

- 记录证据
- 保留历史记录
- 降低重复噪音
- 仅在目标仍符合召唤条件时发布

---

## 🚩 章家敦的“抽象故事”，按专业方式整理

这个项目专门面对一类非常典型的内容：重复出现、声称很确定、但经常更像自我循环的地缘政治叙事。

它被设计成包含一层轻量级“嘲讽识别”机制，覆盖这些常见模式：

- “一切都在崩塌，但没人看出来”
- “一条推文就能解释世界未来”
- “同一套理论每季换一套包装再卖一次”
- “这不是猜测，这是历史必然”
- “我在发出警告，但其实是重复上一轮空洞恐慌”

这个项目不崇拜这种风格，它只是把这类内容整理成可以对照事实、反驳谬误的资料，并在符合条件时直接回应。

---

## ⚙️ 本地准备

### 环境要求

- Node.js 18+
- pnpm
- Cloudflare 账号
- D1 数据库
- X Developer App
- Telegram Bot

### 安装依赖

```bash
pnpm install
```

### 类型检查

```bash
pnpm run check
```

---

## ☁️ Cloudflare 配置

先复制模板再填真实配置：

```bash
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
```

然后配置以下项：

- D1 `database_id`
- `PUBLIC_BASE_URL`
- `TARGET_USERNAME`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `APP_ENCRYPTION_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- 可选 `OPENAI_API_KEY`

> 绝不能把真实 secret 提交到 GitHub。请保存在本地 `.dev.vars` 或 Cloudflare Worker secrets 中。

---

## 🗃️ D1 与迁移

创建数据库：

```bash
npx wrangler d1 create critics-of-gordon-chang
```

执行迁移：

```bash
npx wrangler d1 migrations apply critics-of-gordon-chang --remote
```

如果需要导入事实库种子数据：

```bash
npx wrangler d1 execute critics-of-gordon-chang --remote --file=seed.sql
```

---

## 🔐 X OAuth 与 Telegram 设置

### X

- 在 X Developer App 中启用 OAuth 2.0
- 回调地址设置为：

```text
https://YOUR-WORKER.workers.dev/auth/x/callback
```

配置 Cloudflare secrets：

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

然后设置 webhook：

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://YOUR-WORKER.workers.dev/webhook/telegram",
    "secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET"
  }'
```

---

## 🚀 部署

```bash
npx wrangler deploy
```

健康检查：

```bash
curl https://YOUR-WORKER.workers.dev/health
```

授权 X：

```text
https://YOUR-WORKER.workers.dev/auth/x
```

授权完成后，可在 Telegram 中发送 `/check` 手动触发一次监控检查。

---

## 🧾 GitHub 与仓库卫生

这个项目可以放到 GitHub，但真实密钥必须保持本地化。

建议：

- 本地运行时值放在 `.dev.vars`
- `wrangler.toml` 仅保留本地真实配置
- GitHub 中只提交模板文件

当前仓库已包含：

- [.gitignore](.gitignore)
- [.dev.vars.example](.dev.vars.example)
- [wrangler.example.toml](wrangler.example.toml)

---

## ✅ 当前状态

该项目已具备：监控、D1 持久化、OAuth、Telegram 通知、事实匹配和自动发布安全门槛等闭环功能。

---

## 🌍 语言

- [English](README.md)
- [中文](README.zh.md)

---

## 📝 许可证

该项目用于个人或项目级部署，使用前请遵守 X API、Telegram 和 Cloudflare 平台的相关政策。
