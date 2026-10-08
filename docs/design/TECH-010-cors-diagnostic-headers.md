# TECH-010 設計 — CORS 埠漂移的診斷標頭與重播腳本

- 票號：TECH-010（P2 / 1 SP）｜AC：`docs/ac/TECH-010.md`｜交付文：`docs/deliverable/2026-10-09-TECH-010-CORS埠漂移診斷.md`
- 相關：TECH-006（`DEBUG_ORIGINS` 的事件記錄）、`worker/src/cors.ts`、`worker/src/index.ts`

## 問題的精確形狀

TECH-006 讓 worker 在 `DEBUG_ORIGINS=1` 時，每個請求印一行
`[cors] origin="…" allowed=… method=… path="…"`。這解決了「伺服器端完全安靜」，
但**證據落點錯**：

- CORS 失敗時 **JS 讀不到回應**（`fetch` reject、`response.headers` 不存在），所以前端無法自助。
- 開發者的第一現場是 **DevTools Network 面板**，而 wrangler 的 log 可能在另一個視窗／另一台機器。
- 埠漂移（1420 → 1421）與「請求根本沒送到」在前端都是 `Failed to fetch`。

## 設計決定

### D1 — 診斷走「回應標頭」，不走 body、不改 status

- 三條路都不完美，選標頭的理由是**唯一在「請求有到、但被擋」時還留在現場的資訊**：
  DevTools 一定顯示 response headers（即使是 CORS 失敗的回應）。
- 改 status（例如被擋回 403）會把「白名單沒中」變成伺服器端語意錯誤，
  破壞既有契約並讓既有測試的路徑假設失效。
- 回錯誤 body 對 JS 無效（CORS 失敗時讀不到），只對人有用；而標頭同時對人**與** DevTools 有用。
- **可推翻條件**：若未來有任一瀏覽器在 CORS 失敗時連 response headers 都不顯示，D1 的前提消失，
  那時要改用別名通道（例如 DevTools 之外的自家代理）。

### D2 — 沿用 `DEBUG_ORIGINS=1`，不新增旗標

- 觀測（log）與診斷（標頭）是同一件事的兩種呈現，分成兩個旗標必然出現
  「開了一個、忘了另一個」的假陰性。
- 保持「未開旗標 ＝ 與 TECH-006 前逐位元相同」這條不變式，讓正式環境零足跡可斷言（AC-1）。
- **可推翻條件**：若診斷標頭的流量成本被證實不可忽略（例如每個回應多 60 bytes 影響帳單），
  再拆旗標——目前只有 dev 會開。

### D3 — 標頭只回「對方自己送的 Origin」與一個布林

- 回白名單＝免費送攻擊者清單（TECH-006 的安全立場：明列、不公開）。
- 沒帶 `Origin` 時用 `(none)`（HTTP 標頭值必須是 ASCII；`(none)` 沿用 `corsDebugLine` 的既有寫法）。
- 值域只有 `true` / `false` / 原始 Origin 字串，**沒有伺服器端組出來的字串**，
  因此沒有「回顯時把內部資訊帶出去」的路。
- **可推翻條件**：若未來要回「差幾個字元才命中」（例如建議值），就必須先評估資訊洩漏，
  本票不做。

### D4 — 只加標頭：不改 status / body / 既有 CORS 標頭；空 map 原樣回傳

- `withDiagnostics(response, {})` **原樣回傳同一個物件**（測試用 `toBe` 斷言），
  避免「沒開旗標卻製造了新 Response」這種看不出來的行為差異。
- 與 `withCors` 的順序：先 `withCors`（可能不改）再 `withDiagnostics`，兩者都只 `set` 標頭、不改 body。
- **可推翻條件**：若未來要在被擋時也送 `vary: origin`（快取正確性），需重新討論順序與快取語意。

### D5 — 腳本 `cors-probe.mjs`：清單從原始檔解析、預設附漂移對照組、離開碼三段語意

- **單一真相來源**：`DEV_ORIGINS` 只在 `src/cors.ts` 定義。腳本不 import（TS 檔 node 跑不動，
  且本專案刻意不引入 build 步驟，`do-smoke.mjs` 同理），改**讀檔解析**；解析不到就 exit 2 並說明
  「清單搬家了」——**不猜、不內建第二份清單**。
- **預設清單 = dev 白名單 + 一個刻意漂移來源**（`http://localhost:1421`）：
  只檢查「應該要過的」看不出漂移；對照組才能讓「埠漂移長什麼樣」變成可重播的輸出。
- **離開碼**：`0` 全部在白名單、`1` 有來源被擋、`2` 打不到 worker。
  這樣「埠漂移」可以被自動化流程當成失敗訊號，而不是只有人看 log。
- **可推翻條件**：若 `DEV_ORIGINS` 之後改成由環境／配置檔提供，解析式會失效——
  那時改成讀同一個配置來源（仍不得在腳本內複製清單）。

### D6 — 適用範圍與殘留限制

- 腳本重播 **wire**：同一個 worker、同一個 `Origin`、同一個路徑。它**不**取代真的 webview 實測
  （Tauri / iOS WKWebView 的 scheme 差異正是 TECH-006 存在的理由）。
- 「同症狀」不是被消滅，而是**降級**：從「前端與伺服器兩邊都看不出來」變成
  「DevTools 一眼可辨」。**前端程式仍然無法自動分辨**（AC 的「誠實的範圍界定」段）。
- 診斷標頭在正式環境不存在 ⇒ 正式環境的埠漂移（若 `ALLOWED_ORIGINS` 設錯）
  **仍只能靠 log** 或改用 `cors-probe.mjs` 主動探測（腳本在正式環境一樣可用，只是沒有 `x-cors-allowed` 可看，
  腳本會退回看 `access-control-allow-origin`，並在輸出標明「未開旗標」）。

### D7 — 要回顯的 `Origin` 必須淨化（Gate 4 oracle P2-1）

`Origin` 是**對手可控**的字串，而本票新增的行為正是把它寫進回應標頭。
oracle 用 raw socket 實測：workerd 會擋掉含 CR/LF（obs-fold）與 NUL 的請求（`400`），
但**垂直 tab（`0x0B`）會被原樣寫進標頭**——不構成 response splitting（沒有換行），
但違反 RFC 9110 的 field-value 文法，且下游若有寬鬆 parser/proxy 把 VT 當行終止，理論上可被拆行。

決定：白名單放行（只允許 `\x20`–`\x7e`、長度 ≤255），其餘回 `(invalid)`；
白名單比對仍用**原始** `Origin`（淨化不能改變放行判斷）。
**可推翻條件**：若某天要支援非 ASCII 的 Origin（IDN / punycode 混合寫法），
這個白名單就會擋掉合法值——那時要改成 RFC 允許的字元集，而不是放寬成「什麼都收」。

### D8 — 診斷標頭非空時一併帶 `Vary: origin`（Gate 4 oracle P2-2）

診斷標頭的**值**隨請求的 `Origin` 變動，若回應沒有 `Vary: origin`，
共享快取（CDN / 反向代理）可能按 URL 快取，把 A 來源的 `x-cors-origin` 回給 B。
`corsHeaders` 在白名單命中時本來就送 `Vary: origin`，但漂移來源的回應沒有——
而漂移現場正是這一票要處理的路徑。

決定：`withDiagnostics` 在標頭非空時確保 `Vary` 含 `origin`（已含就不重複、其他值保留）。
**可推翻條件**：若 diagnostics 之後改成「值與 Origin 無關」（例如只回一個固定字串），
這條 `Vary` 反而會不必要地降低快取命中率，屆時應移除。

### D9 — 判斷邏輯抽成可測的純函式（Gate 4 oracle P1）

原版把參數解析、判讀、離開碼全寫在 `scripts/cors-probe.mjs`：`worker/tsconfig.json` 的
`include` 只有 `src/**/*.ts` 與 `test/**/*.ts`，所以 `scripts/**` **既不進 typecheck、
也沒有任何測試**。oracle 的突變 M5（`verdict()` 一律回 `"allowed"`）證實：
漂移來源被判成 allowed、離開碼 1 → 0，而 `npx vitest run` 仍全綠。

這是最壞的一種漏洞——AC-5 把「離開碼 0/1/2」寫成驗收條件，
但重構會**靜默**改變結論，最壞情況是把「埠漂移」誤報成「可以進 webview 實測了」。

決定：抽出 `scripts/cors-probe-lib.mjs`（純函式：`parseArgs` / `verdict` / `exitCodeFor` /
`devOrigins` / `resolveOrigins` / `DRIFTED_ORIGIN` / `USAGE`），IO 留在 `cors-probe.mjs`；
測試 `test/cors-probe-lib.test.mjs`（11 條，vitest 預設會收 `.mjs` 測試檔）。
**順帶修掉 oracle P2-3**：`devOrigins` 解析到區塊但 0 筆時，舊版靜默退化成「只剩漂移對照組」
並印出誤導訊息；現在 `resolveOrigins` 明確回錯誤 → `exit 2`。
**可推翻條件**：若未來腳本改用 `tsx`/bundler 直接跑 TS，這段拆檔就沒必要，可收回單一檔案。

## 變更範圍

| 檔案 | 性質 |
| --- | --- |
| `worker/src/cors.ts` | 新增 `corsDiagnosticHeaders`、`safeHeaderOrigin`、`withDiagnostics`（含 `Vary: origin`） |
| `worker/src/index.ts` | 入口計算一次 `diagnostic`，preflight / 首頁 / DO 轉發三條回傳路徑都套上 |
| `worker/test/cors.test.ts` | 新增 17 條（純函式 7、合併 4、入口 6） |
| `worker/scripts/cors-probe.mjs` | 新增（CLI 重播；IO 只在這裡） |
| `worker/scripts/cors-probe-lib.mjs` | 新增（純函式：參數／判讀／離開碼／清單解析，供測試 import） |
| `worker/test/cors-probe-lib.test.mjs` | 新增 11 條（D9：讓「離開碼 0/1/2」有自動化守門） |

## 測試策略（Gate 1）

- 先寫測試後寫程式：第一批紅燈 `10 failed | 15 passed (25)`（新 10 條全紅、既有 15 條綠），
  實作後 `25 passed`。
- Gate 4 reviewer（靜態）指出覆蓋細節、oracle（執行對抗）指出三條新引入的硬化空間 →
  再補 **7 條**：`debugFlag = "true"`／`"1 "` 仍回空（判斷不寬鬆）、白名單命中的 **OPTIONS** 要同時有
  `x-cors-allowed: true` 與 `access-control-allow-origin`、未開旗標時 **DO 轉發路徑**（POST）
  `x-cors-origin` 為 `null`、`safeHeaderOrigin` 對垂直 tab 回 `(invalid)` 且**比對仍用原始 Origin**、
  正常 Origin 原樣通過、非空診斷標頭要帶 `Vary: origin`、既有 `Vary` 不重複也不被覆蓋。
- 最終條數 **17 條**（純函式 7、合併 4、入口 6），另加 `test/cors-probe-lib.test.mjs` **11 條**。
- 對抗測試（Gate 4 oracle 的 M5 存活）→ 修法 D9 後重跑突變：M5（判讀一律 allowed）**5 紅**、
  M6（取消淨化）**1 紅**、M7（不加 `Vary`）**2 紅**、M8（清單 0 筆不報錯）**1 紅**；基線 43 綠。
- 入口層測試用假 `MEETING` namespace（與 `index-routing.test.ts` 同法）——驗「入口本身」的行為；
  真的 workerd 行為由 Gate 3 的兩顆 wrangler + 腳本實跑負責。
