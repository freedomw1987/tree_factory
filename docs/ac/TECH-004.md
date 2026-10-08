# TECH-004 — DO 內 Harness 生命週期封裝（驗收標準）

- **票號**：TECH-004（P0 / 3 SP / 依賴 SPIKE-003）
- **目標**：把 `Harness` 在 Cloudflare Durable Object 內的生命週期固定下來——**單例、懶初始化、
  alarms 接力、憑證繫結、重啟後同一場會議讀得回**——讓 M02 之後的票都站在同一套骨架上。
- **實作**：`worker/src/storage/do-sqlite.ts`、`worker/src/harness/lifecycle.ts`、
  `worker/src/harness/meeting-harness.ts`、`worker/src/meeting-do.ts`、`worker/src/index.ts`
- **測試**：`worker/test/do-sqlite.test.ts`（12）、`worker/test/lifecycle.test.ts`（13）、
  `worker/test/meeting-do.test.ts`（14）、`worker/test/meeting-harness.test.ts`（5）、
  `worker/test/harness-persistence.test.ts`（10）；另加真 workerd 冒煙 `worker/scripts/do-smoke.mjs`

## 背景（為什麼要有這一票）

SPIKE-003 證明「Pi Harness 能在 DO 上跑」，但只跑了單次腳本。產品要的是**連續兩小時的會議**，
而 DO 有三個平台事實會咬人：

1. DO 隨時可能被回收 → 記憶體中的 harness 會消失。
2. DO constructor **不能 await** → 不能在建立時就把 harness 開好。
3. `harness.close()` **會一併關掉 storage** → 重建必須是整條鏈（adapter → storage → harness）。

再加上一個非平台問題：**憑證**。Workers 沒有 `process.env`，pi-ai 的 provider 授權卻要透過
`AuthContext.env()` 讀 `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`；不處理就是「本機測試會過、
部署後 401」。

## 驗收標準（BDD）

### AC-1 單例與懶初始化

- **Given** 一個 DO 實例、尚未有人請求
- **When** 沒有任何呼叫
- **Then** 不得開啟 harness（`stats.opens === 0`）
- **And When** 連續（含同時 5 個）呼叫 `current()`
- **Then** 只開一次、所有呼叫拿到同一個 harness（`stats.opens === 1`）
- **And When** 有一個 `open()` 還在飛的時候呼叫 `release()`
- **Then** **不得**把「即將交出去」的那一隻 harness 關掉；改回 `{released: false, deferred: true}`，
  並計入 `stats.deferredReleases`（下一次 `release()` 才真的放掉）

### AC-2 憑證繫結

- **Given** provider 為 `cloudflare-workers-ai`
- **When** `CLOUDFLARE_API_KEY` 或 `CLOUDFLARE_ACCOUNT_ID` 任缺
- **Then** 丟出 `MissingCredentialError`，`code === "AUTH_INVALID"`、`recoverable === false`
  （system-design §5.2 中唯一允許阻斷錄音的錯誤碼）
- **And** 憑證改由 **Worker 綁定**提供（`AuthContext.env()` 讀綁定物件），不讀 `process.env`；
  空字串視為未設定
- **And** `HARNESS_PROVIDER=faux` 時完全不需要憑證（離線測試）

### AC-3 alarms 接力

- **Given** 一個 DO 實例
- **When** 呼叫 `wakeIn(ms)`
- **Then** 設定 alarm 於 `now + ms`
- **And** 若已有**更早**的 alarm，**不得**改動它（只往前不往後，避免長工作被延後）
- **And** `ms` 缺漏／空字串／只有空白 → 400 `MS_REQUIRED`（**不得**退化成 0，
  否則會變成立即 alarm 的忙迴圈）
- **And** `ms` 只接受**十進位整數字串**（看原字串，**不 trim**）：`0.5`／`0x1f`／`1e3`／`+5`／
  `-1`／`abc`／超出安全整數 → 400 `MS_INVALID`
  （注：query 裡的 `+` 會被解成空白；若先 trim 就等於放行 `?ms=+5` 的 5ms alarm）
- **And** `ms=0` 是**明確**的「立刻接力」（刻意放行，與「沒帶 `ms`」的退化不同）
- **And** `ms > 300000`（`MAX_ALARM_DELAY_MS`）→ 400 `MS_TOO_LARGE`（一次醒來最多再往前排 5 分鐘，醒來後再接力）
- **And When** alarm 醒來（`alarm()`）
- **Then** 若 harness 已被釋放（等價 DO 被回收）→ 重建後仍指向**同一場會議**

### AC-4 重啟後同一場會議讀得回

- **Given** 一場會議已有內容（已跑完至少一個 turn）
- **When** harness 被關閉、整條鏈重建（模擬 DO 被回收後的下一次請求）
- **Then** `conversationId` 不變、entries 數量不變、且可以**繼續**同一場會議跑下一個 turn

### AC-5 DO 入口（一場會議 = 一個 DO 實例）

- **Given** 兩個不同會議 id
- **When** 各自請求 `/m/:meetingId/health`
- **Then** 對到**不同的 DO 實例**（`doId` 不同），各自獨立開 harness
- **And** DO 入口只做平台接線（storage / alarm / HTTP），壽命與 harness 細節都在可單測的模組裡

### AC-6 模型與壓縮政策（D15 落地）

- **Given** 預設綁定
- **When** 解析即時／會後階段的模型
- **Then** 兩者的 id 都必須存在於 pi-ai 的 Workers AI 目錄（含 `@cf/` 前綴）
- **And** 會後模型窗口 ≥ 128k（D15 修訂：成本與窗口問題用**模型選擇**解，不靠壓縮硬撐）
- **And** 壓縮政策依**該模型實際窗口**推導，可用綁定或參數覆寫
- **And** `HARNESS_PROVIDER` 不在支援清單（`cloudflare-workers-ai` / `faux`）時 → 丟 `PROVIDER_UNKNOWN`，
  **不得**用別的 provider 頂替、也不得因此跳過憑證檢查
- **And** 模型 id 在目錄裡查不到時 → 丟 `MODEL_UNAVAILABLE`，**不得**靜默使用 24k 保守窗口
  （`FALLBACK_CONTEXT_WINDOW` 只保留給「目錄有這模型但沒標窗口」）

## 介面契約（重點）

| 介面 | 契約 |
| --- | --- |
| `HarnessLifecycle.current()` | 單例；併發安全；開啟失敗可重試（不會永久壞掉）；成功後清掉 in-flight 狀態 |
| `HarnessLifecycle.release()` | 回 `{released, deferred}`；沒開過時是 no-op；**有 open 在飛時延後不關** |
| `HarnessLifecycle.wakeIn(ms)` | 只往前；回傳 `{scheduled, at, previous}`；非有限／負數丟錯 |
| `HarnessLifecycle.onAlarm()` | 累計 `wakes`；確保 harness 可用（必要時重建） |
| `DoSqliteDatabase` | 官方 `SqliteDatabase` 六方法；交易佔住佇列（`SerialOperationQueue`）、交易回呼用**獨立 handle 且回呼結束後失效**、回呼失敗先 rollback、**回滾也失敗時丟 `AggregateError`** |
| `resolveModel(bindings, phase)` | 缺憑證 → `AUTH_INVALID`；未知 provider → `PROVIDER_UNKNOWN`；faux → 免憑證 |
| `openMeeting(storage, options)` | **先驗模型存在再碰 storage**（fail fast）；查不到 → `MODEL_UNAVAILABLE` |

## 已知陷阱（本輪實測抓到，已修；共 14 條）

| # | 陷阱 | 症狀 | 修法 |
| --- | --- | --- | --- |
| 1 | `url.pathname` 不含 query | 轉發給 DO 時 `?ms=1500` 消失 → `Number(null) = 0` → alarm 立刻觸發 | `pathname + url.search` |
| 2 | 缺參數退化成 0 | `wakeIn(0)` 造成立即 alarm（潛在忙迴圈） | 缺 `ms` 回 400 `MS_REQUIRED` |
| 3 | 交易中的工作未排隊 | 交易外的 `run()` 插進交易中間（假 storage 測試抓到）| 見 §追加驗收 **R1-1**：原本的 `#tail` 閘門只擋得住「同步到達」的操作；`await` 期間到達的會被放行 → 改成移植官方 `SerialOperationQueue` |
| 4 | pi-ai 不匯出 `AuthContext` 型別 | `import type` 深連結失敗 | 從 `createModels` 參數推導型別 |
| 5 | 自行縮寫的模型 id | `llama-3.3-70b-fp8-fast` 解析不到 | 用目錄完整 id `@cf/meta/...` |
| 6 | 工作區「conversationId 跨會議唯一」的假設 | 兩個會議都回 `1`（根對話 id 固定） | 比 DO 身分（`doId`），不比 conversationId |
| 7 | `/wake?ms=` 空字串 | `Number("") === 0`，通過 `raw !== null` 檢查 → 立即 alarm（忙迴圈）| 空字串／只有空白視同缺參數，回 400 `MS_REQUIRED` |
| 8 | `release()` 撞上「正在開」的 harness | 舊版等 `open()` 完再關 → 等待者拿到**已經關閉**的 harness（而且 storage 一起被關）| `release()` 改回 `ReleaseDecision`：此時**延後不關**；`current()` 成功後清 `#opening` |
| 9 | 未知 provider／打錯的模型 id | 靜默換 provider、靜默用 24k 窗口算壓縮政策（**靜默失敗族**）| provider 白名單 + 先驗目錄，查不到就丟 `PROVIDER_UNKNOWN` / `MODEL_UNAVAILABLE` |
| 10 | 宣告了卻沒有效果的常數／函式 | `MAX_ALARM_DELAY_MS`、`DEFAULT_ALARM_DELAY_MS`、`currentConversationId` 無人使用（讀者誤以為有防護）| `/wake` 真的套上限、範例字串用 `DEFAULT_ALARM_DELAY_MS`、刪掉 dead export |
| 11 | 交易 handle 的失效時機比官方晚一個 commit 窗口 | 回呼結束後、`COMMIT` 前再用 handle，竟會**真的執行**下去（不丟錯）| 見 §追加驗收 **R3-1**：`scope.active = false` 移進回呼 settle 後、`COMMIT` 前（對齊官方 `node.js:117`）|
| 12 | 自己寫的假替身測試「自我實現」 | 假 storage 把**平台自己的 tx 物件**交給探針（沒 `.exec` → 一定 throw）→ 測試假通過 | 測試必須把**我方 handle** 從回呼裡抓出來；先證明探針打到受測物件再看紅燈 |
| 13 | `/wake?ms=` 的 `+` 是空白，trim 後放行 | 第二輪加了整數檢查，但**先 trim**；`?ms=+5` → `" 5"` → 放行成 5ms，而測試用 `encodeURIComponent` 測不到 | 見 §追加驗收 **R4-1**：格式檢查改看**原字串**（不 trim）；測試改加未編碼 raw query |
| 14 | `wrangler dev --var KEY=VALUE` **靜默無效** | 等號形式不報錯也不生效，DO 仍讀 `wrangler.toml` 的 provider → 冒煙全線 401 `AUTH_INVALID`（看起來像程式壞了）| 用冒號 `--var HARNESS_PROVIDER:faux`（wrangler 4.148.0 實測）|

## 測試與證據對照

| AC | 單元 / 整合測試 | 冒煙（真 workerd）|
| --- | --- | --- |
| AC-1（單例與懶初始化）| `lifecycle.test.ts` 7 項（懶初始化／單例／併發／失敗重試／release 重建／release no-op／**併發 release 不得關掉正在交付的 harness**）；`meeting-do.test.ts` 2 項（`/release` 沒東西可放／**撞上正在交付中的 harness**→`deferred:true`）| `do-smoke.mjs` 4 項 |
| AC-2（憑證繫結）| `harness-persistence.test.ts` 4 項（缺憑證 `AUTH_INVALID`／憑證齊全與綁定覆寫／faux 免憑證／`AuthContext` 讀綁定）；`meeting-do.test.ts` 1 項（DO 這一層回 401 `AUTH_INVALID`）| —（faux 啟動下跳過，由單元覆蓋）|
| AC-3（alarms 接力）| `lifecycle.test.ts` 6 項（設定 alarm／只往前／拒絕非法值／onAlarm 重建／onAlarm 重用／缺 `getAlarm`）；`meeting-do.test.ts` 9 項（缺 `ms`／空字串／只有空白／非法值／超上限 `MS_TOO_LARGE`／邊界值與正常值／**`ms=0` 明確語意**／**非整數字串一律 `MS_INVALID`**／**未編碼 `+5` 與 `%201500`**）| `do-smoke.mjs` 8 項（含重建後 conversationId／entries 不變）|
| AC-4（重啟後同一場會議）| `harness-persistence.test.ts` 2 項（重開同 conversation、真跑一個 turn）| `do-smoke.mjs` 3 項 |
| AC-5（一場會議 = 一個 DO）| `meeting-do.test.ts` 1 項（未知路徑 404，DO 的 HTTP 介面契約）| `do-smoke.mjs` 2 項（兩會議不同 DO、各自 opens=1）|
| AC-6（模型與壓縮政策 D15）| `harness-persistence.test.ts` 4 項（模型在目錄／可覆寫／壓縮政策推導／自訂壓縮政策）；`meeting-harness.test.ts` 5 項（未知 provider／支援清單／打錯 id 不碰 storage／未知 provider 不碰 storage／窗口與政策）；`meeting-do.test.ts` 2 項（`PROVIDER_UNKNOWN`／`MODEL_UNAVAILABLE`）| `do-smoke.mjs` 1 項 |
| （儲存適配器契約）| `do-sqlite.test.ts` 12 項（繫結轉換／cursor 兩形狀／**交易排隊**／handle 失效／**handle 在 COMMIT 之前就失效**／回滾 `AggregateError`／未知 cursor 丟錯…）| — |
| （冒煙基礎設施）| — | `do-smoke.mjs` 1 項（Worker 活著）|

**對帳**：單元 + 整合 = 9+5+15+2+1+11+12 = **55 項**（TECH-004 自身）；冒煙 = 4+8+3+2+1+1 = **19 項**。

**總計**：`worker` 測試 72 項（含 M01-US-109 的 17 項；TECH-004 自身 55 項）；
真 workerd DO 冒煙 **19 項檢查全綠**（另 1 項 `AUTH_INVALID` 由單元測試覆蓋，
冒煙以 faux 啟動故跳過）。

### Gate 1（TDD）紅燈 → 綠燈證據

追加的測試全部是**先寫紅燈、再寫實作**（另見 §追加驗收）：

```text
# 紅燈（第一輪修正前）：cd worker && npx vitest run
Test Files  4 failed | 2 passed (6)
     Tests  16 failed | 49 passed (65)

# 綠燈（第一輪修正後）：cd worker && npx vitest run
Test Files  6 passed (6)
     Tests  66 passed (66)          # 含後來補的 cursor 形狀一項（紅→綠各一次）

# 紅燈（第二輪修正前）：npx vitest run test/do-sqlite.test.ts test/meeting-do.test.ts
Test Files  2 failed (2)
     Tests  2 failed | 24 passed (26)   # handle-在-commit-窗口 + 非整數 ms

# 綠燈（第二輪修正後）：cd worker && npx vitest run
Test Files  6 passed (6)
     Tests  71 passed (71)

# 紅燈（第三輪修正前）：npx vitest run test/meeting-do.test.ts
Test Files  1 failed (1)
     Tests  1 failed | 14 passed (15)   # 未編碼的 ?ms=+5 → 200（應為 400）

# 綠燈（第三輪修正後）：cd worker && npx vitest run
Test Files  6 passed (6)
     Tests  72 passed (72)
```

### 冒煙重跑指令（可審查）

```bash
cd worker && npx --yes wrangler@4 dev --port 8791 --local --var HARNESS_PROVIDER:faux &
DO_SMOKE_BASE=http://127.0.0.1:8791 node scripts/do-smoke.mjs   # 19 項全綠
```

> 本次稽核用 `wrangler@4`（未 pin 版本，見 §追加驗收 R2 未修）；`rm -rf .wrangler/state`
> 可重置 DO 狀態（`--local` 會把狀態寫進 `worker/.wrangler/state`，entries 數會跨次累計）。

## 追加驗收：Gate 4 獨立稽核（reviewer subagent）與修正

**稽核方式**：`dev-checker-loop` 的 checker 角色——獨立 subagent、read-only、fresh context，
對象是 `worker/src/harness/*`、`worker/src/storage/*`、`worker/src/meeting-do.ts`。
**第一輪 verdict：0 P0 / 2 P1 / 9 P2**（原文見下方「稽核結論」）。

### 已修正（全部先紅燈再實作）

| # | 等級 | 問題 | 修法 | 鎖住它的測試 |
| --- | --- | --- | --- | --- |
| R1-1 | P1 | `do-sqlite.ts` 的 `#inTransaction` 布林會在交易 `await` 期間放行無關操作（違反官方契約第 2 條）| 移植官方 `SerialOperationQueue`；handle 回呼結束後失效；回滾失敗丟 `AggregateError` | `do-sqlite.test.ts` ×4 |
| R1-2 | P1 | `lifecycle.ts` 的 `release()` 會關掉正在交付中的 harness；`#opening` 成功後未清（永久洩漏）| `ReleaseDecision`（延後不關）+ 成功後清 `#opening` + `stats.deferredReleases`；`/release` 照實回報 | `lifecycle.test.ts` 併發 release 1 項 |
| R1-3 | P2→P1（jev 建議升級）| `/wake?ms=` 空字串 → `Number("") === 0` → 立即 alarm 忙迴圈 | 空字串／空白視同缺參數 → 400 `MS_REQUIRED` | `meeting-do.test.ts` ×3（缺 ms／空字串／只有空白）|
| R1-4 | P2→P1（jev 建議升級）| 未知 `HARNESS_PROVIDER` 靜默改用 Cloudflare、並因此跳過憑證檢查 | provider 白名單 → `UnknownProviderError`（`PROVIDER_UNKNOWN`）| `meeting-harness.test.ts` ×2、`meeting-do.test.ts` ×1 |
| R1-5 | P2→P1（jev 建議升級）| 打錯的模型 id 靜默用 24k 窗口算壓縮政策 | `openMeeting()` 先驗目錄再碰 storage → `ModelUnavailableError`（`MODEL_UNAVAILABLE`）| `meeting-harness.test.ts` ×2、`meeting-do.test.ts` ×1 |
| R1-6 | P2 | dead code：`MAX_ALARM_DELAY_MS`／`DEFAULT_ALARM_DELAY_MS`／`currentConversationId` 無人使用 | `/wake` 真的套上限（`MS_TOO_LARGE`）、範例字串改用 `DEFAULT_ALARM_DELAY_MS`、刪除 `currentConversationId` | `meeting-do.test.ts` ×2 |
| R1-7 | P2 | `rows()` 遇到不認得的 cursor 形狀靜默回 `[]`（「查不到」與「讀不出來」長得一樣）| 丟錯 | `do-sqlite.test.ts` ×1 |
| R1-8 | P2 | AC 文件兩處數字不精確（AC-1/AC-3 項數與實際不符、漏列 `do-sqlite.test.ts`）| 本文件改成逐 AC 對帳（以上表格即為結果）| —（文件）|

### 未修正（記錄為已知，未在本次範圍）

| # | 等級 | 問題 | 為什麼不收 |
| --- | --- | --- | --- |
| R2-1 | P2 | 冒煙對 alarm 的部分斷言用 `>=`（例如 `alarmWakes >= 1`）| 真 alarm 的次數與平台排程有關，寫死會 flaky；已有 `at-now=1497ms` 的嚴格斷言蓋住主要行為 |
| R2-2 | P2 | `wrangler` 未 pin 版本（文件用 `npx wrangler`）| 不在 TECH-004 範圍；建議另開小票把它列進 devDependencies |
| R2-3 | P2 | AC-6 只驗「模型 id 在目錄裡 + 政策依窗口推導」，沒驗「壓縮真的發生」| 屬 M02-US-219（分階段模型 / 壓縮行為）範圍 |

### 稽核結論（checker subagent 原文回傳）

> 第一輪：**0 P0 / 2 P1 / 9 P2**（P1-1 = 交易排隊、P1-2 = release 競態；與本節 R1-1、R1-2 對應）。
> P1-1 的重現指令與輸出：`A order: ["begin","tx:start","sql:UNRELATED_OUTSIDE","outside-done","tx:end","sql:TX_WRITE","commit"]`、
> `unrelated ran INSIDE transaction: true`；P1-2：`B caller got an already-closed harness: true`、`closed: [1] isOpen: false`。

### 第二輪稽核（修正後重跑）— 新發現與處置

**第二輪 verdict：0 P0 / 0 P1 / 4 P2**（本輪新發現）；Task A 複驗：第一輪 11 條中 **7 條已修**、
**1 條部分修（R1-8）**、**3 條照已知不收（R2-1～R2-3）**。

| # | 等級 | 問題（第二輪新發現）| 處置 | 鎖住它的測試 |
| --- | --- | --- | --- | --- |
| R3-1 | P2 | handle 失效時機比官方晚**一個 commit 窗口**（官方在 `await callback(...)` 後、`COMMIT` 前就 `scope.active = false`，本專案拖到平台整個 promise resolve）| 已修：`scope.active = false` 移進回呼 settle 之後、平台 `COMMIT` 之前（鏡射官方順序）| `do-sqlite.test.ts` ×1 |
| R3-2 | P2 | `/wake?ms=0`／`0.5`／`0x1f` 都能立即觸發 alarm（忙迴圈家族沒補完；文件也未表態 0 是故意還是漏想）| 已修：只收十進位整數字串（`0.5`／`0x1f`／`1e3` → 400 `MS_INVALID`）；`ms=0` 依用戶裁決**保留**為明確的「立刻接力」並在程式註解寫明 | `meeting-do.test.ts` ×2 |
| R3-3 | P2 | 本文件表頭 `do-sqlite.test.ts`（10）與對帳表（11）自相矛盾（R1-8 只部分修）| 已修：表頭 10→**12**、對帳表補新項，兩處以測試輸出對帳 | —（文件）|
| R3-4 | P2 | `/release` 這條 R1-2 的使用者介面**零測試**（DO 轉接層沒鎖）| 已補 2 項（fresh／撞上在飛的 open）| `meeting-do.test.ts` ×2 |

**自我實現的假測試（本輪自查抓到，特別記錄）**：R3-1 的第一版測試讓假 storage 的
`transaction()` 把**平台自己的 tx 物件**交給探針，該物件沒有 `.exec`，所以「一定 throw」——
測試假通過。改成用回呼把**我方 handle** 抓出來後才真的紅燈（`EXECUTED`）。
教訓：假替身測試必須確認探針打到的是受測物件。

#### 第二輪 checker 原文引用（verdict + Task B 四條新發現 + Task A 複驗；以 `…` 標示被我精簡掉的重複詞句）

> **Verdict**
>
> **0 P0 / 0 P1 / 4 P2（本輪新發現）**
> Task A：11 條第一輪發現中 **7 條已修**、**1 條部分修（P2-7）**、**3 條照已知不收（P2-5/P2-8/P2-9）**。
>
> ### NEW-P2-1（P2）交易 handle 的失效時機比官方契約晚一個 commit 窗口
>
> - **檔案**：`worker/src/storage/do-sqlite.ts:247-248`（`} finally { scope.active = false; ... }`）
> - **對照官方**：`worker/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js:117`
>   （`scope.active = false` 在 `COMMIT` **之前**）、`:122`（rollback 前）。官方在 `await callback(...)`
>   settle 後**立刻**失效 handle；本專案是在平台 `storage.transaction` 整個 promise resolve 後
>   （即 COMMIT 之後）才失效。
> - **重現指令**：`cd worker && node_modules/.bin/vite-node /tmp/probe-handle-window.ts`
> - **實際輸出**：
>
>   ```text
>   [handle-window] handle used after callback resolved, before commit => EXECUTED-WITHOUT-ERROR
>   [handle-window] final order= ["begin","sql:IN_TX","callback-resolved","sql:AFTER_CALLBACK_BEFORE_COMMIT","commit"]
>   ```
>
> - **建議修法**：把 `scope.active = false` 移進平台回呼內、`await callback(handle)` 之後（成功）
>   與 `catch`（失敗）各一次，鏡射官方順序；外層 `finally` 可保留為保險。
> - **影響**：低。這是「回呼結束後失效」契約的實質違反（官方與本專案自己的註解/AC 都這樣寫）。
>   實務上 Harness 不保留 handle，且窗口只有一個 commit，故不升 P1；但若有呼叫端把 handle
>   存起來，會在 commit 窗口內**靜默執行**而非丟錯。
> - **性質**：這是**本輪新引入**的 `scope` 機制在移植時細節沒對齊官方，不是舊 bug。
>
> ### NEW-P2-2（P2）`/wake?ms=0`（及小數、十六進位）仍可立即觸發 alarm
>
> - **檔案**：`worker/src/meeting-do.ts:85-111`（只擋 `null`/空字串/非有限/負數/超大）
> - **重現指令**：`cd worker && node_modules/.bin/vite-node /tmp/probe-do.ts`
> - **實際輸出**：
>
>   ```text
>   [/wake?ms=0] 200 {"scheduled":true,"at":1791421683548,"previous":null} alarms= [1791421683548]
>   [/wake?ms=0.5] 200 {"scheduled":true,"at":1791421683548.5,...} alarms= [1791421683548.5]
>   [/wake?ms=0x1f] 200 {"scheduled":true,"at":1791421683579,...} alarms= [1791421683579]
>   [/wake?ms=Infinity] 400 {"error":"MS_INVALID","value":"Infinity"}
>   ```
>
> - **影響**：低-中。與 P2-1（空字串）是同一族「參數退化造成忙碌 alarm」。
>   **註**：AC-3 現行文字只列「缺漏／空字串／空白／非有限／負數」，0 是刻意放行還是漏想，
>   文件未表態——所以我列為 P2 而非 P0。
>
> ### NEW-P2-3（P2）`docs/ac/TECH-004.md` 表頭測試數仍錯（do-sqlite 10 vs 實際 11）→ R1-8 只部分修好
>
> - **實際輸出**（`node -e` 解析 regression JSON）：
>
>   ```text
>   {"do-sqlite.test.ts":11,"harness-persistence.test.ts":10,"lifecycle.test.ts":13,"meeting-do.test.ts":10,"meeting-harness.test.ts":5,"segmentation.test.ts":17}
>   total 66 passed 66 failed 0
>   ```
>
> - 表頭合計 10+13+10+5+10=48（+segmentation 17 = **65**），與同檔綠燈寫的 **66** 自相矛盾。
> - **影響**：低（純文件），但這是 R1-8 指名的**同一類錯誤在同一次修正裡復發**。
>
> ### NEW-P2-4（P2）`/release` 這條 R1-2 的使用者介面完全沒有測試鎖住
>
> - **重現指令**：`cd worker && grep -c "release" test/meeting-do.test.ts scripts/do-smoke.mjs`
> - **實際輸出**：`test/meeting-do.test.ts` → `0`；`scripts/do-smoke.mjs` → `0`。
> - **佐證可運作**（但只是人手跑）：`[/release fresh] 200 {"released":false,"deferred":false,...,"deferredReleases":0,...}`。
>
> #### Task A — 第一輪 11 項逐條複驗（原文）
>
> | 第一輪 | 等級 | 複驗結論 | 證據（指令／輸出） |
> | --- | --- | --- | --- |
> | P1-1 交易 `await` 期間無關操作插隊 | P1 | ✅ **已修** | 舊版重現成功：`vite-node /tmp/oldcheck/repro-old.ts` → `unrelated ran INSIDE transaction: true`。新版：`/tmp/probe-queue.ts` → `[P5] unrelated ran INSIDE tx: false`。`SerialOperationQueue` 移植與官方 pending/barrier/tail-rejection 等價。 |
> | P1-2 `release()` 關掉交付中的 harness／`#opening` 洩漏 | P1 | ✅ **已修** | 舊版：`repro-old.ts` → `caller got an already-closed harness: true`、`closed: [1]`。新版：`/tmp/probe-lifecycle.ts` → `first release: {"released":false,"deferred":true}`、`closes=[]`。 |
> | P2-1 `/wake?ms=` 空字串 → 0 | P2→P1 | ✅ **已修** | `meeting-do.ts:88` 以 `raw.trim()===""` 擋掉；`test/meeting-do.test.ts:66,74` 空字串／空白兩案綠。 |
> | P2-2 未知 `HARNESS_PROVIDER` 靜默用 Cloudflare | P2→P1 | ✅ **已修** | `/tmp/probe-harness.ts` → `provider="" => UnknownProviderError code=PROVIDER_UNKNOWN`；`provider=undefined => MissingCredentialError AUTH_INVALID`。 |
> | P2-3 打錯模型 id 靜默用 24k 窗口 | P2→P1 | ✅ **已修（cf provider）** | `options.model missing => ModelUnavailableError`。**但** faux catalog 對任何 id 都給 `contextWindow:128000`（連 typo 都放行），faux 啟動下此檢查被繞過（見已知殘留）。 |
> | P2-4 dead code | P2 | ✅ **已修** | `MAX_ALARM_DELAY_MS` 在 `meeting-do.ts:103` 真的套用（`MS_TOO_LARGE`）；`currentConversationId` 已不在 `meeting-harness.ts`。 |
> | P2-5 冒煙 alarm 斷言用 `>=` | P2 | ⏸️ **維持不收（理由成立）** | 確實仍有 `>=`；理由「真 alarm 次數受平台排程影響，寫死會 flaky」複核成立，另有 `at-now=1497ms` 嚴格斷言。 |
> | P2-6 `rows()` 未知 cursor 靜默回 `[]` | P2 | ✅ **已修** | `rows()` 對未知形狀改丟錯；`do-sqlite.test.ts` 有 1 個紅→綠測試。 |
> | P2-7 AC 文件數字不精確 | P2 | ⚠️ **部分修** | 對帳表已改逐 AC 且總數 49 正確，但表頭 `do-sqlite.test.ts`（10）未同步（見 NEW-P2-3）。 |
> | P2-8 `wrangler` 未 pin | P2 | ⏸️ **維持不收（範圍判定）** | 專案刻意不在 devDependencies 放 wrangler；屬 scope 決定，非事實錯誤。 |
> | P2-9 AC-6 未驗「壓縮真的發生」 | P2 | ⏸️ **維持不收（理由成立）** | 實際壓縮行為屬 M02-US-219 範圍。 |
>
> **Task A 額外重跑（green 現況）**：`npx vitest run` → **66 passed / 6 files**；
> `npm run regression` → **passed=66 failed=0**；`npm run lint` → **0 issues / 45 files**；
> `npx tsc --noEmit` → **exit 0**。
>
> #### 「沒驗到 / 無法驗證」（原文，誠實列舉）
>
> - **紅燈歷史輸出** `16 failed | 49 passed (65)`：要重現必須回退整組修正，且當時 test set
>   與現在不同，**無法重現**；只能說數字與「do-sqlite=10 時代」自洽，**不等於屬實**。
> - **TDD「先紅後綠」的時序**：從最終樹無法驗證；只能確認測試存在且鎖住行為。
> - **真 workerd 冒煙 19 項**：未跑 `wrangler dev`（依 read-only 與 steering 明確不要起 dev server）。
>   僅以 `grep -c` 確認 `do-smoke.mjs` 有 19 個 `check(`，與文件「19 項」一致；未驗平台行為。
> - **實際 Workers AI catalog 與 `pi-ai` 打包 catalog 是否逐位元一致**：未對雲端 catalog 驗證。
> - **`/release` 在「open 在飛」情境下的 DO 層回應**：僅用 lifecycle 層 probe + 程式碼閱讀
>   佐證（這也是 NEW-P2-4 建議補測的原因）。
>
> **完整原文**（含 15 條指令與結果、已知殘留 4 項）見交付文件
> `docs/deliverable/2026-10-08-TECH-004-DO-harness生命週期.md` 的「Gate 4 第二輪」段落。

**第三輪已處理完畢，第四輪稽核進行中**；Gate 4 是否通過以第四輪 verdict 為準。

### 第三輪稽核（修正後重跑）— 新發現與處置

**第三輪 verdict：0 P0 / 0 P1 / 2 P2（本輪新發現）**；Task A：第二輪 4 條**全部確實修好**；
另用 `git show 800063d` / `42f7466` 把新測試 checkout 到 `/tmp` 重跑，證明**新測試真會紅**
（`800063d` → 14 failed / 12 passed；`42f7466` → 2 failed / 24 passed）。

> ⚠️ **Verdict 判定說明（誠實記錄）**：本輪 checker **同時**給了「2 P2」與最後一行
> 「沒找到更多問題」——兩者矛盾。我不把它當作「乾淨通過」，而是**修完這 2 條再跑第四輪**，
> 避免用一句制式結語掩蓋實際發現。

| # | 等級 | 問題（第三輪新發現）| 處置 | 鎖住它的測試 |
| --- | --- | --- | --- | --- |
| R4-1 | P2 | `/wake?ms=+5`（未編碼）被當成 5ms——「只收十進位整數字串」有 URL 編碼破口：格式檢查**先 trim**，而 query 裡的 `+` 就是空白；且原本測試用 `encodeURIComponent` 把 `+` 編成 `%2B`，**測不到原始 URL** | 已修：格式檢查改看**原字串**（不 trim；只有「空／只有空白」走 `MS_REQUIRED`）；測試補未編碼 `?ms=+5` 與 `%201500` 兩案 | `meeting-do.test.ts` ×1（內含 2 案）|
| R4-2 | P2 | 文件數字/敘述與現實不符（第二輪 NEW-P2-3 同族**第三次**復發）：deliverable 一處寫「12 個陷阱」一處寫「13 個」；「皆寫進 AC 文件」為假（AC 表只有 #1–#10）；變更清單仍寫 `do-sqlite.test.ts` 6 項／`lifecycle.test.ts` 12 項 | 已修：陷阱統一為 **14 條** 且 **AC/deliverable 兩張表同步**；變更清單測試數改為現值 | —（文件）|

#### 第三輪 checker 原文引用（verdict + 2 條新發現；以 `…` 標示精簡處）

> **Verdict**：**0 P0 / 0 P1 / 2 P2（本輪新發現）**
> Task A：第二輪 4 條新發現**全部確實修好**（僅 A-2 有 1 個表單編碼破口，列為新 P2），
> 所有新測試經「對 800063d / 42f7466 舊碼重跑」證明**真會紅**。
>
> [A-1] `scope.active = false` 確實在「回呼 settle 後、平台 COMMIT 前」，順序與官方一致。
>
> ```text
> [P1 success] commit-window=THREW order=["begin","callback-settled","REJECTED","commit"]
> [P4 commit-fail] rejected=platform COMMIT failed handle-after=inactive
> [P5 rollback-fail] isAggregate=true order=["callback failed","rollback failed"]
> [P6 nested-tx] race=[null,"nested-done"] order=["begin","sql:NESTED","commit","begin","sql:OUTER","commit"]
> ```
>
> [A-2] `0.5`／`0x1f`／`1e3`／`" 1500x"`／`-0`／`Infinity`／`NaN`／`1e309`／20 位數／`9007199254740992`／
> `١٢٣` → 全部 400 `MS_INVALID`；`0`／`0001500`／`" 1500"` → 200；**沒有任何 500 / NaN 路徑**。
> 但 **`+5`（未編碼）→ 200**（見 NEW-3-1）；`%2B5` → 400。
> AC-3 目前文字仍只列「缺漏／空字串／空白／非有限／負數」，**未明文寫出「0 是刻意放行」**。
>
> [A-3] 表頭（12／14）與逐 AC 對帳（9+5+14+2+1+11+12 = 54）**與實際 `it(` 數完全對得上**；
> 舊數字只出現在「歷史紅綠燈／第二輪原文引用」內（合理保留）；backlog 的 `54 單元 + 19 冒煙` 正確。
> 但 deliverable 的**變更清單**（非引用段）仍留舊數，且同一份文件「12 個／13 個陷阱」自相矛盾。
>
> [A-4] 真紅測試證明：`/tmp/oldworker`（800063d）→ `Tests 14 failed | 12 passed (26)`；
> （42f7466）→ `Tests 2 failed | 24 passed (26)`。「探針打到真 `MeetingDurableObject`，
> deferred 分支由 `current()` 同步設 `#opening` 觸發，非時間相關 flake」。
>
> ### NEW-3-1（P2）`/wake?ms=+5`（未編碼）被當成 5ms 接受——「只收十進位整數字串」有 URL 編碼破口
>
> - **檔案**：`worker/src/meeting-do.ts:101-105`（`raw.trim()` 先於 `/^\d+$/`）；
>   測試 `worker/test/meeting-do.test.ts:150-152` 用 `encodeURIComponent(raw)` 把 `+` 編成 `%2B`，
>   **測不到原始 URL 的 `+`**。
> - **實際輸出**：
>
>   ```text
>   [/wake?ms=+5] 200 {"scheduled":true,"at":1791424711921,"previous":null} alarms=[1791424711921]
>   [/wake?ms=%2B5] 400 {"error":"MS_INVALID","value":"+5"} alarms=[]
>   ```
>
>   （`new URL("https://x/wake?ms=+5").searchParams.get("ms")` → `" 5"`；`+` 在 query 是空白，trim 後變合法 `"5"`。）
> - **影響**：低—中。這是本輪要關的「參數退化／忙迴圈家族」殘餘：呼叫端打 `/wake?ms=+5`
>   會得到 5ms 的近似立即 alarm；且測試宣稱 `+5 → 400` 只在 percent-encoded 形式成立，
>   形成「測試假通過」的同族盲點。
> - **建議修法**：二選一——(a) 文件與測試明說「前後空白被容忍，故 query 中的 `+` 等價空白」；
>   或 (b) 不再 trim、要求整個原字串精確符合 `^[0-9]+$`（則 `" 1500"` 也一併拒絕）。
>   無論哪個，測試都應加「未編碼 raw query」一案。→ **本專案採 (b)（fail-loud）**。
>
> ### NEW-3-2（P2）文件數字/敘述與現實不符（第二輪 NEW-P2-3 的同族第三次復發）
>
> - **檔案**：deliverable `:41-43, 379`、`docs/ac/TECH-004.md:99-110`
> - **實際輸出**：
>
>   ```text
>   deliverable:43  ... 6 條 BDD AC + 介面契約 + 12 個實測陷阱（含第二輪）
>   deliverable:379 ## 本輪實測抓到的 13 個陷阱（已修，皆寫進 AC 文件）
>   AC 文件陷阱表實際只有 10 列（#1–#10）
>   ```
>
> - **影響**：低（純文件），但與第二輪 NEW-P2-3 同類，且「皆寫進 AC 文件」是可被讀者當事實的錯誤敘述。
> - **處置**：陷阱統一 14 條（#1–#14 兩處同步）、變更清單數字改現值。
>
> #### 第三輪「沒驗到 / 無法驗證」＋ verdict 矛盾（原文）
>
> - 真 workerd 平台行為未驗（依只讀紀律未起 dev server）：19 項冒煙未執行，僅以
>   `grep -c '^check('` = **19** 證實數量與文件相符。
> - 歷史紅燈 `16 failed | 49 passed (65)` 無法重現（test set 已不同）——**未驗**。
> - `/wake` 的 `MS_REQUIRED/MS_INVALID/MS_TOO_LARGE` 不在 §5.2 的 10 碼表，
>   但 `/wake` 是 DO 維運端點、非裝置 WS 協定，**不計為新 P2**。
> - 已知殘留複核：與文件描述一致，**未發現比文件更嚴重**。
> - `/wake?ms=0` 忙迴圈：刻意保留，**未驗**「呼叫端連續打 0 是否真的造成 open/close 風暴」。
> - 最後一行寫「沒找到更多問題」，但同一份報告列了 2 條 P2——**兩者矛盾，故本專案不視為通過**。
