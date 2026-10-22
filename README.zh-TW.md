# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在瀏覽器中一鍵把預先建置好的應用部署到你自己的 Cloudflare 帳戶。**
[English](README.md) | 繁體中文

發布者分享一個連結；使用者打開連結、登入 Cloudflare 一次、檢視將要建立的內容，然後確認。TapDeploy 會把預先建置好的 Workers 與 Pages release，連同儲存與 binding，部署到使用者自己的帳戶，並可綁定使用者自己的網域。使用者只需要瀏覽器和 Cloudflare 帳戶。

> **狀態：尚未達到正式發布標準。** 測試與 CI 全部通過，主要功能已在真實帳戶上跑過；TapDeploy 自身託管在 Cloudflare Workers 上的驗證進行中。公開 demo 實例規劃中。

## 可部署的內容

- **運算：** Workers（模組、Wasm、靜態資源、cron、Durable Objects、Workflows）與 Pages 靜態網站。
- **儲存與 binding：** R2、D1、KV、Queues、Vectorize、Workers AI、Browser Rendering、Hyperdrive 與 Secrets Store（使用者選擇的既有資源）。
- **網域：** 使用者可把自己的網域綁到任一 Worker 或 Pages 網站，升級時可修改。
- **不支援：** 編譯原始碼（release 必須預先建置）、Pages Functions、Cloudflare 以外的平台。

## 運作方式

1. **打開連結** `https://<實例>/?config=<設定檔網址>`；設定檔說明應用、release ZIP 與需要的 Cloudflare 權限。
2. **登入 Cloudflare 一次。** 授權頁只列出這些權限；token 永遠不會進到頁面的 JavaScript。
3. **選擇 release ZIP**（公開網址或本機檔案）。由伺服器驗證每一個位元組，不做任何編譯。
4. **設定：** 全新安裝或升級、每個 Worker 或 Pages 網站可選擇綁定網域，應用使用 Hyperdrive 時選擇你的設定。
5. **檢視並確認。** 計畫列出所有將建立或變更的內容與可能的費用；每一步都會先向 Cloudflare 讀回確認才進行下一步，不會在背後回滾或刪除任何東西。

## 自行架設實例

可跑在 **Cloudflare Workers** 或 **Node.js / Docker**，只需三個設定：`PUBLIC_ORIGIN`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`。

1. 註冊 Cloudflare OAuth client，Redirect URL 為 `https://<你的網域>/api/auth/callback`，scope 依指南勾選。公開實例需要自己的網域（Cloudflare 會驗證網域所有權）。
2. 部署：
   - **Workers：** 在主控台匯入本 repo（**Workers & Pages → Create → Import a repository**，Build command 填 `npm run build`），並在 **Settings → Runtime variables and secrets** 加入三個設定。
   - **Node / Docker：** `npm ci && npm run build && node dist/node/server.mjs`，或 `docker compose up -d --build`，前面放一個 TLS 反向代理。

指南：[docs/self-hosting.md](docs/self-hosting.md)。

## 發布應用

1. 用你自己的工具鏈建置（Worker：`npx wrangler deploy --dry-run --outdir build`）。
2. 把輸出打包成 ZIP，每個 Worker 或 Pages 網站各帶一個最終版的 `wrangler.jsonc`。
3. 撰寫 `tapdeploy.config.json`，列出各 unit 與需要的能力（capabilities）。
4. 發布 ZIP（例如 GitHub release），分享 `https://<實例>/?config=<設定檔網址>`，例如做成 README 按鈕。

含完整範例與參考的指南：[docs/publishing.md](docs/publishing.md)。

## 開發

```bash
npm ci
cp .env.example .env.local   # 填入對應 http://localhost:8787 的 OAuth client
npm run build && node dist/node/server.mjs
npm test
```

指南：[docs/development.md](docs/development.md)。

## 授權

[MIT](LICENSE) © lpyedge。更多：[支援範圍](docs/support.md)、[安全模型](docs/security.md)、[架構](docs/ARCHITECTURE.md)。之後可能支援其他提供授權部署 API 的平台（例如 Vercel）。
