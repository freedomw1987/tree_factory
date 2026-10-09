# TECH-009 — worker 邊緣授權、速率限制與狀態端點改 POST（AC）

- 票號：TECH-009（P1 / 3 SP），模組：—（跨模組，worker 側為主）
- 前置：M01-US-101（CORS）、TECH-012（跨請求聚段）、TECH-013（逐字稿分頁）
- 來源：`docs/ac/M01-US-101.md` §待辦第 2 條（checker 第 1 輪 **P2-6**）、`docs/backlog.md:214`
- 設計：`docs/design/TECH-009-edge-auth-rate-limit.md`（D1–D10）
- 交付文：`docs/deliverable/2026-10-09-TECH-009-邊緣授權與速率限制.md`

## 背景（為什麼要這一票）

`worker/src/index.ts:56` 只做 pathname 比對就轉進 Durable Object，**沒有任何認證**；
`worker/src/cors.ts` 只決定「瀏覽器讀不讀得到回應」，被擋的來源**請求本身照常被處理**。
而 `GET /m/:id/wake`（`meeting-do.ts:171-207`）與 `GET /m/:id/release`（`:229-232`）
是**會改狀態的 simple request**——simple request 不觸發 preflight，
所以任何網站的 `<img src="…/wake?ms=0">` 都能讓它成真。
`GET /m/:id/session/start`、`GET /m/:id/session/stop` 是**同一個形狀**（不必帶 body 就能改狀態），
一併收斂（Gate 4 第 1 輪 reviewer **P2-2**）。

## 目的

1. `/m/**` 全路由都要憑證（device token，`system-design.md §5.2` 的 `AUTH_INVALID` 就是為此預先規劃）。
2. 白名單外的 `Origin` **不只要讀不到，連副作用都不能發生**。
3. 會改狀態且不必帶 body 的端點收斂成 `POST`（不再有 simple request 觸發的狀態變更）。
4. 對重試風暴／掃描有第一層（per-isolate）速率限制，並誠實標明它的界線。

## 驗收標準（AC）

| 編號 | 條件（可驗） | 證據 |
| --- | --- | --- |
| **AC-1** | 未設定 `DEVICE_TOKEN`（或空字串）時，除 `OPTIONS`（preflight）與**不匹配 `/m/<meetingId>` 的路徑**（例如 `GET /` 的服務說明；**不限方法**，`POST /foo` 同理）外，**一律** 500 `AUTH_NOT_CONFIGURED`（`recoverable:false`），且**不進 DO**（不得放行任何會議資料路徑） | `worker/test/edge-auth.test.ts`、`index-auth.test.ts`；真 workerd（未帶 secret 的 instance）實測 |
| **AC-2** | 憑證為 `Authorization: Bearer <DEVICE_TOKEN>`：正確 → 放行；缺失／非 `Bearer`／值錯 → 401 `AUTH_INVALID`（`recoverable:false`），且**不進 DO**；比對走 `constantTimeEquals`（長度不同也走完全部位元，不短路） | `edge-auth.test.ts`（10 條：解析 3、常數時間 3、判定 4）；`index-auth.test.ts` 入口 3 條；真 workerd 實測 |
| **AC-3** | `Origin` 存在且不在允許清單 → 403 `ORIGIN_FORBIDDEN`，**不進 DO**；`Origin` 缺席（curl／原生／腳本）或命中清單 → 繼續走憑證關。順序必須是**先 Origin 後憑證**（403 不得洩漏 token 對不對）。`OPTIONS`（preflight）例外：仍回 204 且不帶 CORS 標頭（由瀏覽器擋，見設計 D5） | `index-auth.test.ts`；真 workerd 實測（`curl -H 'Origin: https://evil.example'`）|
| **AC-4** | 同一 `token 指紋 + client IP` 在 `RATE_LIMIT_WINDOW_MS`（預設 60_000）內超過 `RATE_LIMIT_MAX`（預設 300）→ 429 `RATE_LIMITED` + `Retry-After`（秒，向上取整）+ `recoverable:true`；窗過後恢復；env 值不合法（`0`／負數／非整數／空字串）→ **用預設**（不得變成無限制，也不得變成全部 429）；`Map` 上限 1000，先清過期再 FIFO 淘汰 | `worker/test/rate-limit.test.ts`（11 條：設定 3、計數 6、鍵 2）；`index-auth.test.ts` 入口 4 條；真 workerd 實測 |
| **AC-5** | （**範圍**：四條「會改狀態且不必帶 body」——`/session/stop` 其實需要 `reason`，是靠「會改狀態的路由一律 POST-only」一起收斂的；需要 body 的寫入路由見設計 D7 的範圍註記）`/m/:id/wake`、`/m/:id/release`、`/m/:id/session/start`、`/m/:id/session/stop` 只收 `POST`：其他方法 → 405 `METHOD_NOT_ALLOWED` + `Allow: POST` 且**無副作用**（不設 alarm、不建 session、不放掉 harness）；`POST` 行為與原本一致（`ms` 驗證、`MAX_ALARM_DELAY_MS` 上限、`lifecycle.wakeIn`／`release`） | `meeting-do.test.ts`（1 條新增 + 2 條改寫）；`index-routing.test.ts` 路由清單更新；真 workerd + `do-smoke.mjs` 實跑 |
| **AC-6** | 裝置端：`HttpSessionClient` 有 `token` 才送 `Authorization` 標頭（無 token 不得送出空標頭）；`401` 的提示文案是「裝置授權已失效，請重新配對」（**不得**再說「請確認網路」）；`429` 分兩條路徑：**上傳路徑**走既有退避重試、**不得**中止錄音（`recoverable:true` 契約），而 **`session/start`** 收到 429 時**應該**中止開場並提示可重試（此時還沒有錄音可中止）；建置期設定 `VITE_DEVICE_TOKEN` 沒設／空字串／只有空白 → 不送標頭，**不得**退化成內建預設憑證（`deviceTokenFrom`） | `app/ui/src/lib/session/auth-token.test.ts`（新增，11 條，含 `deviceTokenFrom`）、`app/ui/src/lib/recorder/store.test.ts`（2 條新增：拒絕往上拋、權限不往上拋）、E2E 全套（帶 token）|
| **AC-7** | 新碼同步到兩個表：`system-design.md §5.2`（10 碼 → 13 碼，含 `AUTH_NOT_CONFIGURED` / `ORIGIN_FORBIDDEN` / `RATE_LIMITED`）與 `DESIGN.md §5.1`（UI 對照）；`METHOD_NOT_ALLOWED` **不進**表（傳輸層，同 404）並寫下分類規則 | 兩份文件的 diff；`docs/design/TECH-009-*.md` D8 的規則表 |
| **AC-8** | 設定步驟有紀錄：`docs/env-setup.md` 寫明 `wrangler secret put DEVICE_TOKEN`（正式）與 `VITE_DEVICE_TOKEN`（app 建置）＋ dev 的一行指令，並註明「沒設＝全紅」是刻意行為 | `docs/env-setup.md` 新增段落；`app/ui/playwright.config.ts` 的 webServer 指令（dev 憑證來源）；`worker/scripts/cors-probe.mjs --token`（開發檢查流程也不得被自己的認證噎住）|
| **AC-9** | **誠實留痕**：交付文必須列出①S1–S4 威脅模型與「不防 S3/S4」②速率限制是 per-isolate、記憶體上限、可被洪水擠掉，權威解（平台 Rate limiting rules）未做③`Retry-After` 未被 UI 採用（仍用既有 30s 上限退避）④真機 webview 的 `Origin` 值仍未實測 | 交付文的「未驗證／留痕」段；`docs/design/TECH-009-*.md` D1／D6／D10 |

## 誠實的範圍界定（這一票**沒有**解決的事）

- **這不是帳號系統。** v1 的前提是 `docs/backlog.md:20` 的 R5「單人自用，無帳號系統（device token）」：
  全 app 共用**一個**字串。它擋得住「網頁上的隨機第三方」與「網路掃描」，
  **擋不住**把 app 二進位解開、逆出內嵌字串的人。用一句話記住：**這是門鎖，不是保險箱**。
- **速率限制是「一顆 isolate 的記憶體」，不是「全世界共用」。** Cloudflare 會在多台機器上跑同一個
  Worker；每顆只算自己看到的請求。權威解法是平台的 Rate limiting rules（部署層、需要 API 憑證），
  本票不做（與 TECH-003 同一個阻塞原因）。洪水期間，`Map` 上限（1000）也會讓別人的桶被擠掉——
  這是「盡力而為」的必然結果，不是調參能修掉的。
- **`429` 的 `Retry-After` 目前沒有被 UI 採用。** `uploader.ts` 走既有的指數退避（1s→30s 上限），
  而 `Retry-After` 可能更大（60 秒窗），所以極端情況下會多打幾輪（每輪都被 429，資料不會壞）。
  留痕，不假裝同步。
- **JS 層的「常數時間比較」是盡力而為。** JIT 與字串實作不受我們控制；它擋掉的是
  「用回應時間逐字元猜字串」的自動化攻擊，不是側通道研究的對手。
- **`AUTH_INVALID` 這一個碼現在有兩個意思。** `system-design.md §5.2` 把它定義成「device token 失效或
  不相符」（本票的用法），但 `worker/src/harness/meeting-harness.ts:74` 的 `MissingCredentialError`
  **早就在用同一個碼**表示「伺服端的模型供應商憑證沒設定」（v1 之前的既有用法）。兩者都是 401 +
  `recoverable:false`，所以裝置端**分不出**「我的憑證錯了」與「伺服器沒設 `CLOUDFLARE_API_KEY`」——
  後者會被顯示成「裝置授權已失效，請重新配對」，是誤導。實測（第 2 輪補驗）：帶正確憑證的
  `GET /m/x/health` 在 `HARNESS_PROVIDER` 非 `faux` 且缺模型憑證時，回的就是
  `401 AUTH_INVALID` ＋「provider 需要 `CLOUDFLARE_API_KEY`」。本票刻意不動 harness 的碼
  （會擴大到另一條路徑），列為已知殘留（交付文 §6）；要收斂需要新碼（例如
  `HARNESS_NOT_CONFIGURED`）＋兩張表同步。
- **真機 webview 的 `Origin` 仍未實測。** E2E 跑的是 `http://localhost:1420`，
  不是 Tauri／WKWebView 的 `tauri://localhost`——這是 TECH-006 留下的同一個缺口，不是本票造成的。

## 刻意不做

| 不做 | 為什麼 |
| --- | --- |
| 帳號系統／配對流程 UI／每裝置獨立憑證 | R5 的 v1 前提是單人自用；那是一個獨立模組（會動 `docs/backlog.md:20` 的前提），不是 3 SP 的票 |
| Cloudflare 平台 Rate limiting rules | 沒有 `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`（TECH-003 同一個阻塞），無法驗證的設定不能聲稱已交付 |
| 「沒設 `DEVICE_TOKEN` 就放行」的開發模式 | 一個會靜默失效的開關，正是本票要消滅的失敗模式；要免憑證的 dev 流程應是**顯式**旗標（本票不做） |
| 把需要 body 的寫入路由（`/transcript`、`/transcript/gap`、`/audio/chunk`、`/submit`、`/debug/faux`）也收斂成 `POST` | 它們不是 simple request 可達（simple request 帶不了 `Authorization`，而入口已強制憑證），且沒有 body 的 `GET` **沒有副作用**；但**回的碼不一致**：有 session 時 `/transcript/gap`、`/audio/chunk` 是 400，無 session 時是 409／404，而 **`/submit` 是 500**（`await request.json()` 沒有 `.catch`）。實測與殘留寫在設計 D7（Gate 4 oracle **F2** 實測、reviewer **P2-2** 收斂、第 2 輪 oracle **P3** 校正敘述）|
| 把唯讀的 `GET /health`、`GET /session`、`GET /transcript/*` 也改成 POST | 它們不改變**使用者可見狀態**（`GET /session` 在會議到點時的到期落地是時間驅動的冪等收斂，`meeting-do.ts:426`；第 2 輪 reviewer **P3-3** 校正措辭）；改掉只是讓請求不可快取、不利除錯（`/wake`、`/release`、`/session/start`、`/session/stop` 才是會改狀態的那四條）|
| 依 `Retry-After` 微調裝置端退避 | 需要先有「真的被 429 打到」的實測資料才有調整依據；先留痕（AC-9-③）|
| 把 token 放進 query string 或 body | query 會進 access log／歷史／`Referer` 且無法回收；`GET` 沒有 body |
