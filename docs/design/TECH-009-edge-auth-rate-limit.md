# TECH-009 設計 — worker 邊緣授權、速率限制與狀態端點改 POST

- 票號：TECH-009（P1 / 3 SP）｜AC：`docs/ac/TECH-009.md`｜交付文：`docs/deliverable/2026-10-09-TECH-009-邊緣授權與速率限制.md`
- 相關：`system-design.md §5.2`（`AUTH_INVALID` 的預先規劃）、`DESIGN.md §5.1`（UI 對照）、
  `worker/src/index.ts`、`worker/src/cors.ts`、`worker/src/meeting-do.ts`、`app/ui/src/lib/session/api.ts`
- 上游來源：`docs/ac/M01-US-101.md` §待辦第 2 條（checker 第 1 輪 **P2-6**）、`docs/backlog.md:214`

## 問題的精確形狀

M01-US-101 只做到「CORS 正確性」（`cors.ts` 決定**瀏覽器讀不讀得回應**），沒有做到「誰可以打」。
三個具體缺口，每一個都有現在的程式碼位置：

1. **沒有認證**：`worker/src/index.ts:56` 只做 pathname 比對，之後直接 `stub.fetch(forwarded)`。
   白名單外的來源照樣被處理（只差「讀不到回應」），而**寫入與副作用已經發生**。
2. **會改狀態的 simple GET**：`GET /m/:id/wake`（`meeting-do.ts:171-207`）驗完 `ms` 就 `setAlarm()`。
   simple request **不觸發 preflight**，所以任何網站的 `<img src="…/wake?ms=0">` 或
   `fetch(url, {mode:"no-cors"})` 都能讓它成真；`GET /m/:id/release`（`meeting-do.ts:229-232`）同一類。
3. **沒有速率限制**：重試風暴（裝置端退避失效、或外部腳本）可以直接把請求打到 DO，
   每個請求都是真實的 CPU／DO 成本。

**使用者可見的後果**：不是「資料外洩」這種戲劇性的畫面，而是「有人按了開始、錄音卻起不來」、
「會議被別人提前 release／alarm 被別人推走」——**症狀全都長得像 bug**。

## 設計決定

### D1 — 威脅模型（先寫下「不防誰」，否則後面的邊界沒有意義）

| 編號 | 對手 | 本票是否防 |
| --- | --- | --- |
| S1 | 第三方網站（瀏覽器內、跨來源；simple request 或 `no-cors`）| ✅ 防（D5 擋來源、D2/D3 擋憑證）|
| S2 | 網路上亂掃的（打 `/m/任意/health` 建 DO、燒 CPU）| ✅ 防（D3 擋在認證，D6 擋在速率）|
| S3 | 同機器的另一個使用者（共用瀏覽器／讀到本機檔案）| ❌ 不防（v1 前提 R5「單人自用」）|
| S4 | 拿到 app 二進位、逆出內嵌 token 的人 | ❌ 不防（真解＝每裝置配對與獨立憑證，屬 v2）|

**為什麼要誠實寫出 S3／S4**：v1 的憑證是**內嵌在 app 建置產物裡的共用字串**。
它把「網頁上的隨機第三方」與「網路掃描」擋在門外（這正是 TECH-009 的缺口），
但**不構成**對抗有心的逆向者。用一句話記住：**這是門鎖，不是保險箱**。

### D2 — 憑證走 `Authorization: Bearer <token>`

- 不走 query（`?token=`）：會進 access log、瀏覽器歷史、`Referer`，而且這些地方我們都無法回收。
- 不走 body：`GET` 沒有 body，而且上傳音檔的 body 是原始位元組。
- `Authorization` 是標準欄位、觸發 preflight、且未來若要換成簽章（HMAC）不必改傳輸方式。
- 名稱沿用 `system-design.md §5.2` 已定的 **device token**（R5 的「無帳號系統」前提），
  **不**發明新名詞。

**可推翻條件**：若未來要支援每裝置獨立憑證（S4），`Bearer <token>` 仍可用，只需讓 Worker 查表；
本票把「單一共用字串」這個事實寫在 `DEVICE_TOKEN` 這個名字與文件裡，不假裝它是多租戶。

### D3 — 失效即關（fail-closed）：`DEVICE_TOKEN` 沒設 → 一律 500 `AUTH_NOT_CONFIGURED`

- 公開的只有兩條：`OPTIONS`（preflight 不帶憑證，瀏覽器規格如此）與**不匹配 `/m/<meetingId>` 的路徑**
  （例如 `GET /` 的服務說明，無會議資料；**不限方法**——`POST /foo` 也是 200，Gate 4 oracle F1）。
  其餘 `/m/**` 全部要憑證——**包含 `/health`**（它會回 `conversationId` 與壽命統計）。
- 沒設 token 時**不放行**任何請求。理由：一個「沒設定就等於不檢查」的開關，
  遲早會在正式環境以「忘了設 secret」的形式靜默失效；那正是本票要消滅的失敗模式。
- 回 **500**`AUTH_NOT_CONFIGURED`而非 401：401 會讓 `DESIGN.md §5.1` 的 UI 顯示
  「裝置授權已失效，請重新配對」，但真相是**伺服器自己沒設定**——把伺服器錯誤講成使用者問題
  是本專案一貫拒絕的事（同 `TECH-008` 給 `SESSION_CORRUPT` 自己的 code 的理由）。
- **代價（誠實）**：dev / 首次部署多一道手續（設 `DEVICE_TOKEN`／`VITE_DEVICE_TOKEN`）
  與一次「忘記設 → 全紅」的經驗，換「不會靜默裸奔」。這個代價寫進 `docs/env-setup.md`。

**可推翻條件**：若要支援「本機開發免憑證」，正確做法是**顯式**的 `ALLOW_ANONYMOUS=1` 並在啟動時印警告，
而不是「沒設就放行」。本票不做（多一個可誤開的開關不划算）。

### D4 — 憑證比對用常數時間函式（`worker/src/edge-auth.ts`）

- 逐字元 `===` 的短路比較會洩漏「前綴對了幾個字元」的資訊；對共用字串而言這是免費的旁通道。
- 實作：長度差先折進 `diff`，再對 `max(len)` 逐位元 XOR；**不依賴** `crypto.subtle.timingSafeEqual`
  （workerd 有、Node 沒有，測試會在 Node 跑；自寫版本在兩邊行為一致、且可測）。
- **誠實界線**：JS 層的「常數時間」是**盡力而為**（JIT、字串實作不受我們控制）。
  它擋掉的是「用回應時間逐字元猜字串」這種自動化攻擊，不是側通道研究的對手。
- **可推翻條件**：若未來憑證改成 HMAC 簽章，時間比較就不重要（簽章本身無法逐字元猜），
  這支函式可以退場。

### D5 — Origin 不在白名單 → 403 `ORIGIN_FORBIDDEN`（不再只是「不給標頭」）

- 判定：`origin !== null && !allowed.includes(origin)` → 403，**不進 DO**。
- `origin === null`（curl、原生層、伺服器間呼叫、`do-smoke.mjs`）→ **放行**，再過憑證關。
  為什麼不能一律要求 Origin：本專案的 worker 也被原生層與工具鏈呼叫，它們不送 Origin；
  用「沒有 Origin 就拒」會把正常路徑一起殺掉。
- 為什麼要 403 而不是沿用「不給 CORS 標頭」：後者只擋「讀」，**副作用照樣發生**
  （D1 清單裡最貴的那一種）。TECH-010 的診斷標頭保留了「看得到自己被擋」的能力。
- 與 `AUTH_INVALID` 的順序：**先判 Origin、再判憑證**。理由：來源不對時，
  回應不該透露「你的 token 對不對」（避免把 403 當成 token 探測管道）。
- **可推翻條件**：若未來 app 需要在多個動態來源（例如 `*.preview.example`）下運作，
  白名單要比對樣式而不是字串——那時改的是 `allowedOrigins` 的解析，不是這條判定。

### D6 — 速率限制：邊緣固定窗、per-isolate、key = token 指紋 + 用戶端 IP

- **位置**：`index.ts` 的 `/m/**` 分支，**憑證通過之後**。未通過的請求由 D3/D5 便宜地擋掉，
  不佔權重（否則外面的洪水會把合法裝置的桶喝光）。
- **key**：`sha256(token) 前 16 hex` + `CF-Connecting-IP ?? "-"`。
  - 用指紋不用原字串：這個 key 會活在 isolate 記憶體與（未來的）log 裡，原字串不該出現在那裡。
  - 帶 IP：同一顆 token 從不同 IP 來＝不同桶（行動網路換 IP 是常態，換了就重來，可接受）；
    這也讓「token 外流後被另一台機器狂打」不會擠掉本機裝置的桶。
- **窗**：固定窗，`RATE_LIMIT_WINDOW_MS` 預設 `60_000`、`RATE_LIMIT_MAX` 預設 `300`。
  - 300 的來源：UI 逐字稿輪詢約 1.5–2 秒一次（≈30–40/min）＋ 音檔每 10–15 秒一段（≈4–6/min）
    ＋ 每隔幾秒的 session 狀態 → 尖峰 < 100/min；300 給約 **3 倍餘裕**，
    但擋得住「一秒幾百發」的重試風暴。
  - 兩個都可被 env 覆寫（正式環境要調不必改程式），**但沒有「關掉」的開關**：
    要放寬就設一個很大的數字，那個值會留在配置裡、看得見。
  - 環境變數讀不到／不合法（負數、0、非整數）→ **用預設值**，不靜默變成「無限制」
    （`0` 當成「每窗 0 次」會讓整個服務全 429，比預設更糟）。
- **回應**：`429` + `Retry-After: <秒（無條件進位）>` +
  `{error:"RATE_LIMITED", message, retryAfterMs, limit, windowMs, recoverable:true}`。
  `recoverable:true` 是**契約要求**：`system-design.md §5.2` 規定 `recoverable=true` 的錯誤
  **不得**導致錄音中止——裝置端會退避重試（`uploader.ts` 既有退避，上限 30 秒）。
- **記憶體上限誠實揭露**：`Map` 最多 1000 個 key；滿了先清過期、再丟最舊（FIFO）。
  這表示**洪水期間**攻擊者可以把別人的桶擠掉。這是「per-isolate 盡力而為」的必然結果，
  不是可以靠調參解決的問題——權威解法是 **Cloudflare 平台的 Rate limiting rules**
  （部署層、需要 API 憑證，本票**不做**，寫進「未驗／後續」）。
- **為什麼不放在 DO**：DO 是「一場會議一個實例」，速率限制要保護的是**被大量會議 id 掃**的路徑
  （S2 可以自己發明無限多個 meeting id）。DO 層的限制擋不住「每個 id 各打一次」。
- **可推翻條件**：若之後有共用的 KV / Durable Object 當集中計數器（或用平台規則），
  這支 per-isolate 限流器就應該退成「第二層」或直接拿掉。

### D7 — 會改狀態且「不必帶 body」的端點改成 POST-only（非 POST → 405 + `Allow: POST`）

- 票只點名 `/wake`；`/release` 是**同一個形狀的洞**（會改狀態的 simple GET）。
  只修一半，等於保證下一輪再開一張票做同樣的事，所以**一併修**，並在交付文標明這是縮放範圍。
- 405 要帶 `Allow: POST`：機讀（客戶端／掃描工具）不該靠猜。
- **同類但不在本票範圍**：`GET /health`、`GET /session`、`GET /transcript/*`、`GET /audio/chunks`
  是**唯讀** GET，維持 GET（改成 POST 只是把唯讀查詢變成不可快取、不利除錯）。
  「唯讀」講的是**使用者可見狀態**：`GET /session` 在會議已到點時會走 `#readSession` 的到期落地
  （`meeting-do.ts:426` 的 `store.write(next)`），那是**時間驅動的冪等收斂**、不是呼叫端能選的
  狀態變更（Gate 4 第 2 輪 reviewer **P3-3** 校正措辭）。
- **範圍註記（Gate 4 第 1 輪 oracle F2 實測 + reviewer P2-2 收斂）**：判準是「**不必帶 body 就能改狀態**」，
  因此覆蓋 **4 條**：`/wake`、`/release`、`/session/start`、`/session/stop`
  （真 workerd 實測：帶正確憑證的 `GET /m/x/session/start` 從前會回 **201**，是與 `/wake` 同一個形狀的洞）。
  跨站不可利用——simple request 帶不了 `Authorization`，帶了憑證的請求必先 preflight，
  白名單外來源在入口就被 403——但一致性與縱深防禦上都該一起收斂，所以第 1 輪 reviewer 把它列為 P2。
  **`/session/stop` 其實需要 `reason`**（缺了回 400 `REASON_INVALID`，`meeting-do.ts:489`）：
  它進這個集合靠的是更寬的判準「**會改狀態的路由一律 POST-only**」，不是「不必帶 body」
  （Gate 4 第 2 輪 reviewer **P3-2**）。
  其餘寫入路由（`/transcript`、`/transcript/gap`、`/audio/chunk`、`/submit`、`/debug/faux`）
  都需要 body 才改得動，**維持現狀**。它們「沒有 body 會怎樣」已實測，不要寫得比事實大
  （Gate 4 第 2 輪 oracle **P3**）：**沒有 active session** 時 `GET /transcript/gap` → **409**、
  `GET /audio/chunk` → **404**（先撞 session 檢查，不是 body 驗證）、`GET /submit` → **500**；
  **有 session** 時前兩者 → 400（`GAP_INVALID`／`SEQ_INVALID`），`/submit` **仍是 500**
  （`meeting-do.ts:275` 的 `await request.json()` 沒有 `.catch`，空 body 直接拋進外層 catch；
  其他路由如 `:739`、`:860` 都有）。**實質主張不變**（session 沒被改動、沒有副作用），
  但原本寫的「會先被各自的驗證擋成 400」是錯的敘述，已改掉；`/submit` 的 500 列為已知殘留（交付文 §6）。
- **可推翻條件**：若未來要支援「不帶 body 的一鍵喚醒」給 cron／外部排程，
  仍然是 POST（空 body 的 POST 是合法的），不需要把 GET 加回來。

### D8 — 錯誤碼分類規則（哪些進「協定錯誤碼表」，哪些不進）

規則：**會出現在裝置端（UI）判斷流程裡、或屬於握手期的碼，進 `system-design.md §5.2` 的表；
「這個請求本身不合法」的傳輸層碼不進**（它們從不出現在 WS 下行訊息裡）。

| 碼 | 進表？ | 理由 |
| --- | --- | --- |
| `AUTH_NOT_CONFIGURED` | ✅ | 握手期、裝置端要看得到（且必須與 `AUTH_INVALID` 分開）|
| `ORIGIN_FORBIDDEN` | ✅ | 同上；`DESIGN.md §5.1` 已規劃 CORS 相關呈現 |
| `RATE_LIMITED` | ✅ | `recoverable:true`，裝置端要據此退避、但**不得**中止錄音 |
| `METHOD_NOT_ALLOWED`（405）| ❌ | 傳輸層／呼叫端寫錯（同 `404 NOT_FOUND`、`400 MS_REQUIRED` 的既有處理）|

新增三個碼之後 `system-design.md §5.2` 的表從 **10 碼 → 13 碼**，
且必須同步 `DESIGN.md §5.1`（該檔自己寫的規則：「新增碼必須同步更新此表與 `DESIGN.md §5.1`」）。

### D9 — UI 端：只做三件事，且不假裝做了第四件

1. **注入憑證**：`HttpSessionClient` 新增 `token?: string`（有值才送 `Authorization` 標頭）；
   `app.svelte.ts` 由 `import.meta.env.VITE_DEVICE_TOKEN` 取（與 `VITE_WORKER_BASE_URL` 同一個機制）。
   `dev/cors-probe.ts` 也要帶——否則它驗到的是 auth 而不是 CORS（探針會說謊）。
2. **401 的文案**：現在 `app.svelte.ts` 的 catch 會顯示
   「伺服端沒有接受這場會議（`AUTH_INVALID`）。請確認網路後再試。」——**「請確認網路」是誤導**
   （token 錯了不是網路問題）。改成指名 `DESIGN.md §5.1` 已規劃的文案：「裝置授權已失效，請重新配對」。
3. **429 走既有退避**：`ChunkApiError("SERVER")` → `uploader.ts` 既有指數退避（1s→30s 上限）。
   **本票不實作**「依 `Retry-After` 微調退避」，並明說：429 的 60 秒窗比 30 秒上限長，
   極端情況下會多打幾輪（每輪都被 429，不會壞資料）。留痕而非假裝沒這回事。
4. **不做**：配對／重新配對的 UI 流程（缺這個流程，`AUTH_INVALID` 畫面只能顯示文字＋返回，
   所以本票只改**文案**、不加畫面）。列進交付文「未做／後續」。

- **可推翻條件**：若裝置端要支援「token 過期自動更新」，`HttpSessionClient` 的 `token` 就要改成
  「可回傳目前 token 的函式」；本票刻意用字串，因為沒有更新機制。

### D10 — 這票驗不到什麼（先寫下來，免得驗收時被當成已驗）

| 項目 | 為什麼驗不到 | 留給誰 |
| --- | --- | --- |
| 真機 webview 的 `Origin` 值 | E2E 跑 `http://localhost:1420`，不是 `tauri://localhost` | TECH-006 的既有缺口（同一條）|
| Cloudflare 平台層的 Rate limiting rules | 沒有 `CLOUDFLARE_API_KEY` / `ACCOUNT_ID`（TECH-003 同一原因） | 部署階段 |
| 多 isolate / 多 colo 下的「全域」速率 | 本機 wrangler 是單一 instance | 上線後實測 |
| 對抗逆向者的 token 保密 | 見 D1 的 S4 | v2（每裝置憑證）|
| `Retry-After` 被 UI 採用 | 見 D9-3 | 後續（若實測發現多打幾輪真的痛）|

## 變更範圍

| 檔案 | 性質 |
| --- | --- |
| `worker/src/edge-auth.ts` | 新增：`bearerToken()`、`constantTimeEquals()`、`authDecision()`（純函式）|
| `worker/src/rate-limit.ts` | 新增：`FixedWindowLimiter`（注入 `now()`、可測）|
| `worker/src/index.ts` | 入口順序：log → preflight → Origin → 憑證 → 速率 → 轉發；路由清單 wake/release 改 POST |
| `worker/src/cors.ts` | `access-control-allow-headers` 加 `authorization` |
| `worker/src/meeting-do.ts` | `POST_ONLY_PATHS`（`/wake`、`/release`、`/session/start`、`/session/stop`）非 POST → 405 + `Allow: POST` |
| `worker/test/edge-auth.test.ts` | 新增（常數時間比較、憑證解析與判定）|
| `worker/test/rate-limit.test.ts` | 新增（窗、邊界、淘汰、指紋不外洩）|
| `worker/test/index-auth.test.ts` | 新增（入口層：順序、403/401/500/429、preflight 仍公開）|
| `worker/test/cors.test.ts`、`index-routing.test.ts`、`meeting-do.test.ts` | 既有測試依新契約更新（見 AC）|
| `worker/scripts/do-smoke.mjs` | 真 workerd：wake/release 改 POST + 憑證 + 三條 auth 段 |
| `app/ui/src/lib/session/api.ts` | `token` 選項 + `Authorization` 標頭 |
| `app/ui/src/lib/app.svelte.ts` | `workerToken()` + 401 文案 |
| `app/ui/src/lib/dev/cors-probe.ts` | 探針帶憑證（否則探針會說謊）|
| `app/ui/playwright.config.ts` | 兩顆 webServer 都帶同一組 dev 憑證 |
| `system-design.md`、`DESIGN.md` | 錯誤碼表同步（D8）|
| `docs/env-setup.md` | 新增 `DEVICE_TOKEN` / `VITE_DEVICE_TOKEN` 的設定步驟（D3 的代價）|

## 測試策略（Gate 1）

- **順序**：先寫新測試（紅）→ 實作 → 綠；既有測試若斷言到舊行為（例如
  `index-routing.test.ts` 的「清單外來源**仍會被處理**」），**改成新契約的嚴格版**
  （`seen` 長度 0：請求不再進 DO）——這是**收緊**，不是放寬。
- **三層**：
  1. **純函式層**（`edge-auth`、`rate-limit`）：`worker/test/*.test.ts`，注入 `now()` 與壞配置。
  2. **入口層**（`index.ts`）：假 `MEETING` namespace（同 `index-routing.test.ts` 的做法），
     驗「順序」與「有沒有進 DO」——這一層才是本票的產品行為。
  3. **真 workerd**（`do-smoke.mjs`）：帶憑證能打、不帶憑證 401、錯憑證 401、
     Origin 不在白名單 403、`GET /wake` 405、`POST /wake` 200。
- **不做突變測試的藉口**：本票仍要跑突變（把 `constantTimeEquals` 改成 `===`、
  把 403 判定拿掉、把 429 換成 200、把 POST 檢查拿掉），並誠實記錄哪幾個突變
  E2E 抓不到（只有單元／入口層抓得到）。
