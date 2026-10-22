# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在瀏覽器中一鍵把預先建置好的應用部署到你自己的 Cloudflare 帳戶。**
[English](README.md) | 繁體中文

發布者分享一個連結；使用者打開連結、登入 Cloudflare 一次、檢視將要建立的內容，然後確認。TapDeploy 會把發布者預先建置好的 Workers 或 Pages release，連同 R2、D1、KV、Queues、Vectorize 等 binding，直接部署到使用者自己的帳戶，並可綁定使用者自己的網域。使用者只需要瀏覽器和 Cloudflare 帳戶，不需要 Node、Wrangler、Git 或 GitHub 帳戶。

本文件是唯一的中文說明；完整細節以英文文件為準（連結見下文）。

## 目前狀態

> **尚未達到正式發布標準。** 本機測試與 CI 全部通過，自訂網域與平台 binding 已從本機實例對真實帳戶實際跑過一次；**TapDeploy 自身託管在 Cloudflare Workers 上的端對端驗證正在進行中**。已證實與未證實的範圍見 [docs/release-status.md](docs/release-status.md)。

## Demo

公開的 demo 實例**規劃中（待定）**。Workers 驗證完成後，會在這裡公布網址與範例應用連結。

## 可部署的內容

| | |
|---|---|
| 運算 | Workers（ESM 模組、Wasm、靜態資源、cron、`workers.dev`、Durable Objects、Workflows、rate limit、service binding）、Pages 靜態網站 |
| 儲存 | R2、D1、KV、Queues（producer 與 consumer）、Vectorize |
| 平台 binding | Workers AI、Browser Rendering、Hyperdrive（使用者選擇的既有設定）、Secrets Store（既有 secret） |
| 網域 | 使用者安裝時可把自己的網域綁到任一 Worker 或 Pages 網站，升級時可修改 |
| 不支援 | 編譯原始碼（release 必須預先建置）、Pages Functions、Cloudflare 以外的平台 |

## 運作方式

1. **打開連結**：連結帶有應用的設定檔（`?config=https://…/tapdeploy.config.json`），其中說明應用名稱、release 來源，以及需要的 Cloudflare 能力。
2. **登入 Cloudflare 一次**：授權頁只列出該設定檔需要的權限。Token 只存在伺服器端密封的 HttpOnly cookie 中，頁面 JavaScript 永遠拿不到。
3. **選擇 release ZIP**：下載發布者公開的 HTTPS ZIP（GitHub release 會經安全的轉送通道下載），或選擇本機檔案。由伺服器（而非瀏覽器）驗證每一個位元組；不做任何編譯。
4. **設定**：選擇全新安裝或升級，可為每個 Worker 或 Pages 網站選擇綁定自己的網域（升級時會列出目前已綁定的網域並可修改）；若應用使用 Hyperdrive，在此選擇你的 Hyperdrive 設定。
5. **檢視並確認**：計畫會列出將建立或更新的每個 Worker、Pages 專案與資源，以及可能的費用風險。每一步都會先向 Cloudflare 讀回確認才進行下一步；永遠不會自動回滾，除了你選擇解除綁定的網域外不會刪除任何東西。

各功能的驗證程度與明確拒絕的項目：[docs/supported-resources.md](docs/supported-resources.md)。安全模型：[docs/security.md](docs/security.md)。終端使用者操作說明：[docs/install.md](docs/install.md)。

## 自行架設實例

TapDeploy 可以跑在 **Cloudflare Workers**（UI 為 Static Assets）或 **Node.js**（直接執行或用 Docker），兩者是同一份程式碼，都不需要資料庫。

### 1. Cloudflare OAuth client（必要）

詳細步驟：[docs/deployment/cloudflare-oauth.md](docs/deployment/cloudflare-oauth.md)

- 位置：Cloudflare 主控台 **Manage Account → OAuth clients → Create client**。
- 新建的 client 預設為**私有**，只有建立它的帳戶成員能授權（適合測試）。
- 要讓任何 Cloudflare 使用者都能使用，必須改為**公開**；在此之前 Cloudflare 會要求**驗證 client URL 的網域所有權**（在 DNS 新增以 `cloudflare_oauth_client_publisher=` 開頭的 `TXT` 記錄）。改為公開後不可改回私有，驗證過的網域也不可更改。
- 因此公開實例需要**自己的獨立網域**（例如 `deploy.example.com`），不能用共用的 `*.workers.dev`。Client URL、Redirect URL 與 `TAPDEPLOY_PUBLIC_ORIGIN` 請使用同一個 origin。
- Redirect URL：`https://<你的網域>/api/auth/callback`（必須完全一致）。
- Token endpoint 驗證方式：`client_secret_basic`（TapDeploy 以 HTTP Basic 送出 secret，並一律使用 PKCE `S256`）。
- Client Secret 只會顯示一次，請立即存成 Worker secret 或伺服器環境變數，不要放進程式庫或網址。它同時用來推導加密 session cookie 的金鑰，更換 secret 會讓所有人登出。
- 所有 scope 請保持 **Required**，不要設成 optional：TapDeploy 遇到部分授權會直接拒絕（`scope_denied`），不會要求第二次授權。

Scope 設定（只需在 Cloudflare 的 client 上註冊，TapDeploy 沒有自己的 scope 設定；每次安裝只會請求該設定檔需要的子集，client 沒註冊的 scope 會由 Cloudflare 在授權頁回報 `invalid_scope`）：

| 主控台名稱 | Scope ID | TapDeploy 目前狀態 |
|---|---|---|
| Workers Admin | `workers-scripts.admin` | 已實作（合約測試）；每個 Worker 安裝都需要 |
| Pages Write | `page.write` | 已實作（合約測試） |
| D1 Write | `d1.write` | 已實作（合約測試） |
| Workers KV Storage Write | `workers-kv-storage.write` | 已實作（合約測試） |
| Workers R2 Storage Write | `workers-r2.write` | 已實作（合約測試） |
| Queues Write | `queues.write` | 已實作（合約測試） |
| Workers Routes Write | `workers-routes.write` | 已實作（合約測試），尚未實機執行 |
| Zone Read | `zone.read` | 已實作（合約測試，已在本機實例實機執行一次）；設定檔含 Worker 或 Pages unit 時**自動請求**（列出網域供綁定） |
| DNS Write | `dns.write` | 已實作（合約測試，已在本機實例實機執行一次）；設定檔含 Worker 或 Pages unit 時**自動請求**（綁定自訂網域） |
| Hyperdrive Write | `query-cache.write` | 已實作（合約測試）；只綁定使用者選擇的既有設定，不會建立 |
| Vectorize Write | `vectorize.write` | 已實作（合約測試，已在本機實例實機執行一次）；綁定既有 index，或由 resources unit 以 `dimensions` + `metric` 建立 |
| Secrets Store Write | `secrets-store.write` | 已實作（合約測試，已在本機實例實機執行一次）；只綁定既有 secret（一般 Worker secret 由 Workers Admin 處理） |
| Workers AI Write | `ai.write` | 已實作（合約測試，已在本機實例實機執行一次）；`ai` binding |
| Browser Run Write | `browser-rendering.write` | 已實作（合約測試，已在本機實例實機執行一次）；`browser` binding |

「合約測試」指以模擬的 Cloudflare API 驗證；實機驗證範圍見 [docs/release-status.md](docs/release-status.md)。因為含 Worker 或 Pages 的設定檔一定會請求 `zone.read` 與 `dns.write`，OAuth client **必須註冊這兩個 scope**。

### 2. 部署到 Cloudflare Workers（驗證中）

詳細步驟：[docs/deployment/workers.md](docs/deployment/workers.md)

1. 從 GitHub repo 部署（Workers Builds）：fork 或 push 本 repo，在主控台 **Workers & Pages → Create → Import a repository** 選擇它；Build command 填 `npm run build`，Deploy command 用預設的 `npx wrangler deploy`，Root directory 留空。之後每次 push 都會自動重新建置與部署。或從 clone 部署：`npm ci && npm run build && npx wrangler deploy --name <Worker 名稱>`。
2. 在 Worker 的 **Settings → Variables and Secrets**（或用 `npx wrangler secret put <名稱> --name <Worker 名稱>`）設定 `TAPDEPLOY_PUBLIC_ORIGIN`、`TAPDEPLOY_OAUTH_CLIENT_ID`、`TAPDEPLOY_OAUTH_CLIENT_SECRET` 這三個值（依提示輸入，避免留在 shell 歷史中）。
3. 在主控台為 Worker 加上自訂網域（Settings → Domains & Routes）。
4. 檢查 `GET /api/health` 回傳 `{"ok":true,"runtime":"workers",…}`，再用測試帳戶實際登入安裝一次。

注意：Workers Free 方案每個請求的 CPU 上限為 10 ms，ZIP 驗證是否能在此限制內完成**尚未量測**；在量測前請把 Free 方案視為不支援，改用 Paid 方案或 Node / Docker。

### 3. 部署到 Node.js 或 Docker

詳細步驟：[docs/deployment/node-docker.md](docs/deployment/node-docker.md)

已驗證：Playwright 對建置後 Node server 的完整 UI 流程、本機 Node 實例的真實 Cloudflare 登入與安裝、Docker image 可建置且容器以 `node` 使用者執行並回報 `healthy`。尚未驗證：透過 Docker 實例進行真實 Cloudflare 登入。

- **Node.js（≥ 24）**：`npm ci && npm run build && npm prune --omit=dev` → 設定環境變數（`NODE_ENV=production`、三個 `TAPDEPLOY_*`、可選的 `PORT`）→ `node dist/node/server.mjs`。伺服器監聽所有網路介面的 `PORT`（預設 8787），請用防火牆限制只讓前面負責 TLS 的反向代理（Nginx、Caddy 等）連到這個 port。TapDeploy 只信任 `TAPDEPLOY_PUBLIC_ORIGIN`，不讀 `Host` 或 `X-Forwarded-*`。
- **Docker**：在 `compose.yaml` 旁建立 `.env`（不要提交，可參考 `.env.example`），填入三個 `TAPDEPLOY_*` 值，然後 `docker compose up -d --build`；`docker compose ps` 應顯示 `(healthy)`。

## 為 TapDeploy 發布應用

1. 用你自己的工具鏈建置（Worker：`npx wrangler deploy --dry-run --outdir build`）。
2. 把最終輸出打包成 ZIP，每個 Worker 或 Pages unit 各帶一個 `wrangler.jsonc`（`main` 指向建置後的檔案）。
3. 撰寫 `tapdeploy.config.json`，列出各 unit 與需要的能力（capabilities）。
4. 發布 ZIP（例如 GitHub release），設定檔放在支援 CORS 的位置（例如 `raw.githubusercontent.com`），再分享 `https://<實例>/?config=<設定檔網址>`，例如做成 README 按鈕。

完整步驟（TypeScript Worker + Pages 網站範例）：[Release 發布者指南](docs/release-publisher-guide.md#quick-start-from-a-wrangler-project-to-a-one-click-link)。同一份指南也包含完整的設定檔與 release ZIP 參考；設定檔 JSON Schema：[`schemas/tapdeploy.config.v3.schema.json`](schemas/tapdeploy.config.v3.schema.json)。

## 開發

```bash
npm run deps:install         # 依賴安裝在可拋棄的 temp/deps
cp .env.example .env.local   # 填入你的 OAuth client；切勿提交任何 .env*
npm run dev:node             # Node runtime -> http://127.0.0.1:8787
npm run build && npm test
```

變數說明見 [變數表](docs/development.md#environment-variables)，更多說明見 [docs/development.md](docs/development.md)。

CI（`.github/workflows/ci.yml`）在每次 push 與 pull request 時執行 typecheck、lint、build、Vitest、三種 runtime 的 Playwright；不需要任何 secret，也不會連線到 Cloudflare 帳戶。

## 路線圖

- 完成並公布 Cloudflare Workers 託管驗證。
- 公開 demo 實例（待定）。
- 之後可能支援其他提供授權部署 API 的平台（例如 Vercel）；目前沒有任何一個已支援或已開始實作。

## 授權

[MIT](LICENSE) © lpyedge。原始碼：<https://github.com/lpyedge/TapDeploy>。
