# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在瀏覽器中一鍵把預先建置好的應用部署到你自己的 Cloudflare 帳戶。**
[English](README.md) | 繁體中文

發布者分享一個連結；使用者打開連結、登入 Cloudflare 一次、檢視將要建立的內容，然後確認。TapDeploy 會把發布者預先建置好的 Workers 與 Pages release，連同儲存與 binding，部署到使用者自己的帳戶，使用者想要的話也可以綁定自己的網域。整個流程在瀏覽器中進行；所有對 Cloudflare 的呼叫都由安裝器的伺服器代使用者發出（頁面無法直接呼叫 Cloudflare 的 API）。

> **狀態：尚未達到正式發布標準。** 測試與 CI 全部通過，主要功能已在真實帳戶上跑過；TapDeploy 自身託管在 Cloudflare Workers 上的驗證進行中。公開 demo 實例規劃中。

## 為什麼用 TapDeploy

**1. 只要有 Cloudflare 帳戶就能部署。** 部署的人不需要 GitHub 帳戶、Node.js、`wrangler`、終端機，也不用 fork 任何 repo。打開連結、登入 Cloudflare 一次、按確認就完成。發布者交付的是預先建置好的檔案，所以不會在任何人的電腦或伺服器上編譯。

**2. 一份設定檔變成一個有引導、有驗證的表單。** 發布者用一個小小的 JSON 描述安裝內容，TapDeploy 把它呈現成單一的 Configure 步驟，使用者不會填錯：

- **有型別、有驗證的輸入：** 文字、數字、日期、單選、多選、secret；格式、範圍、允許值在瀏覽器與伺服器各檢查一次；每一項可設為必填或選填，升級時可以再問一次或直接沿用（升級時可更換 secret，例如管理員密碼）。每個值都會以環境變數的形式進到 Worker。
- **資源命名與規則集中在一處：** R2、D1、KV、Queues、Vectorize 都有建議名稱，使用者可以修改；每個資源各自設定升級規則：沿用（資料庫）或讓使用者更換（快取）。
- **網域與服務一次搞定：** 每個 Worker 或 Pages 網站的自訂網域、各自的名稱、帳戶的 Hyperdrive 設定，都在同一個表單裡選好，然後一次規劃、一次套用。每一步都先向 Cloudflare 讀回確認才進行下一步，不會在背後回滾或刪除任何東西。

```json
{
  "schemaVersion": 3,
  "app": { "id": "you/notes", "name": "Notes" },
  "source": { "defaultUrl": "https://github.com/you/notes/releases/latest/download/notes.zip" },
  "capabilities": ["workers", "r2", "d1"],
  "resources": [
    { "kind": "d1", "name": "notes-db" },
    { "kind": "r2", "name": "notes-cache", "upgradeKeep": false }
  ],
  "inputs": [
    { "key": "REGION", "type": "select", "label": "Region", "options": ["eu", "us"] },
    { "key": "ADMIN_PASSWORD", "type": "secret", "label": "Admin password", "validation": { "minLength": 12 } }
  ]
}
```

## 可部署的內容

- **運算：** Workers（模組、Wasm、cron、Durable Objects、Workflows）與 Pages 靜態網站。
- **儲存與 binding：** R2、D1、KV、Queues、Vectorize、Workers AI、Browser Rendering、Hyperdrive 與 Secrets Store（使用者選擇的既有資源）。
- **網域：** 使用者可把自己的網域綁到任一 Worker 或 Pages 網站，升級時可修改。
- **不支援：** 編譯原始碼（release 必須預先建置）、Pages Functions、Cloudflare 以外的平台。

## 運作方式

1. **打開連結** `https://<實例>/?config=<設定檔網址>`；設定檔說明應用、release ZIP 與需要的 Cloudflare 權限。
2. **登入 Cloudflare 一次。** 授權頁只列出這些權限；token 永遠不會進到頁面的 JavaScript。
3. **選擇 release ZIP**（公開網址或本機檔案）。瀏覽器會先檢查，錯誤的檔案在上傳前就會被拒絕；接著由伺服器驗證每一個位元組，以伺服器的檢查為準。不做任何編譯。檔案在瀏覽器中處理，但所有 Cloudflare 呼叫都經由安裝器的伺服器（Cloudflare 的 API 不允許瀏覽器直接呼叫）。
4. **設定：** 全新安裝或升級，然後是設定檔描述的表單（必填項在前，選填項預設摺疊）：它的輸入欄位、每個 Worker、Pages 網站與資源的名稱（發布者的名稱只是建議），以及每個 Worker 或 Pages 網站可選的網域。升級時沿用目前使用中的資源，除非設定檔允許使用者更換。
5. **檢視並確認。** 計畫列出所有將建立或變更的內容與可能的費用；每一步都會先向 Cloudflare 讀回確認才進行下一步，不會在背後回滾或刪除任何東西。

## 自行架設實例

可跑在 **Cloudflare Workers** 或 **Node.js / Docker**，只需三個設定：`PUBLIC_ORIGIN`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`。

1. 註冊 Cloudflare OAuth client，Redirect URL 為 `https://<你的網域>/api/auth/callback`，scope 依指南勾選。公開實例需要自己的網域（Cloudflare 會驗證網域所有權）。
2. 部署：
   - **Workers：** 在主控台匯入本 repo（**Workers & Pages → Create → Import a repository**，Build command 填 `npm run build`），並在 **Settings → Runtime variables and secrets** 加入三個設定。
   - **Node / Docker：** `npm ci && npm run build && node dist/node/server.mjs`，或 `docker compose up -d --build`，前面放一個 TLS 反向代理。

指南：[docs/self-hosting.md](docs/self-hosting.md)。

## 發布應用

1. **建置：** 用你自己的工具鏈（Worker：`npx wrangler deploy --dry-run --outdir build`；網站：框架自己的 build）。
2. **整理目錄：** 每個 Worker 或 Pages 網站一個目錄，各帶一個最終版的 `wrangler.jsonc`（`main` 指向建置後的檔案）與它用到的檔案，再打包成 ZIP。單一 Worker 可以直接放在 ZIP 根目錄：

   ```text
   notes.zip
   ├── wrangler.jsonc     # name、main: worker/main.mjs、bindings
   └── worker/main.mjs    # 建置輸出
   ```
3. **描述安裝內容：** 在 `tapdeploy.config.json` 寫下資源、輸入欄位、unit 與能力（capabilities），範例見上方。
4. **發布：** 發布 ZIP（例如 GitHub release），分享 `https://<實例>/?config=<設定檔網址>`，例如做成 README 按鈕。

指南含各種情況的目錄範例、自動打包 ZIP 的 CI workflow 與完整設定檔參考：[docs/publishing.md](docs/publishing.md)。

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

Worker 靜態資源（`assets.directory`）目前不支援：在具備 server-authoritative bytes 驗證前預設封鎖。Pages 靜態網站仍可使用。
