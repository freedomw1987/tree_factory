# TECH-004 — DO 內 Harness 生命週期封裝（驗收標準）

- **票號**：TECH-004（P0 / 3 SP / 依賴 SPIKE-003）
- **目標**：把 `Harness` 在 Cloudflare Durable Object 內的生命週期固定下來——**單例、懶初始化、
  alarms 接力、憑證繫結、重啟後同一場會議讀得回**——讓 M02 之後的票都站在同一套骨架上。
- **實作**：`worker/src/storage/do-sqlite.ts`、`worker/src/harness/lifecycle.ts`、
  `worker/src/harness/meeting-harness.ts`、`worker/src/meeting-do.ts`、`worker/src/index.ts`
- **測試**：`worker/test/do-sqlite.test.ts`（12）、`worker/test/lifecycle.test.ts`（13）、
  `worker/test/meeting-do.test.ts`（15）、`worker/test/meeting-harness.test.ts`（5）、
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
| 13 | `wrangler dev --var KEY=VALUE` **靜默無效** | 等號形式不報錯也不生效，DO 仍讀 `wrangler.toml` 的 provider → 冒煙全線 401 `AUTH_INVALID`（看起來像程式壞了）| 用冒號 `--var HARNESS_PROVIDER:faux`（wrangler 4.148.0 實測）|
| 14 | `/wake?ms=` 的 `+` 是空白，trim 後放行 | 第二輪加了整數檢查，但**先 trim**；`?ms=+5` → `" 5"` → 放行成 5ms，而測試用 `encodeURIComponent` 測不到 | 見 §追加驗收 **R4-1**：格式檢查改看**原字串**（不 trim）；測試改加未編碼 raw query |

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

> **編號慣例**：`R{k}-n` 為本專案**第 k 批處理**的第 n 條發現（第一輪 = R1；第一輪未修 = R2；第二輪 = R3；第三輪 = R4；第四輪 = R5；第五輪 = R6；第六輪 = R7；第七輪 = R8）。
> **目前狀態：Gate 4 已通過**（2026-10-08 用戶裁決；第七輪 verdict 0 P0 / 0 P1 / 3 P2，程式面自第二輪起零新缺陷，
> 依封頂規則停止 loop、不跑第八輪）。第七輪 3 條修正為自我複驗，已如實記於交付物風險欄。

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
| R4-2 | P2 | 文件數字/敘述與現實不符（第二輪 NEW-P2-3 同族，本票內**反覆復發**；清單見 deliverable「已知問題 5」的 ①–⑪）：deliverable 一處寫「12 個陷阱」一處寫「13 個」；「皆寫進 AC 文件」為假（AC 表只有 #1–#10）；變更清單仍寫 `do-sqlite.test.ts` 6 項／`lifecycle.test.ts` 12 項 | 已修：陷阱統一為 **14 條** 且 **AC/deliverable 兩張表同步**（#13 `--var` / #14 `+5`）；變更清單測試數改為現值 | —（文件）|

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

### 第四輪稽核（修正後重跑）— 新發現與處置

**verdict：`0 P0 / 0 P1 / 3 P2`**；Task A 複驗：第三輪的 R4-1 **確認真的修好**（21/21 probe 綠 + 沒有修過頭）、
R4-2 **只部分修**（陷阱表與變更清單已同步，但前置表頭漏改）→ 即 R5-1。
**第四輪的 3 條全是文件數字/敘述一致性，程式面無新缺陷。**

| # | 等級 | 發現 | 處置 | 測試 |
| --- | --- | --- | --- | --- |
| R5-1 | P2 | AC 文件**前置「測試」表頭** `meeting-do.test.ts`（14）未同步（實際 15；R4-1 加測試只改了變更清單與對帳式）| 已修：前置表頭 14→**15** | —（文件）|
| R5-2 | P2 | AC 與 deliverable 兩張陷阱表 **#13/#14 編號對調**，但 deliverable 宣稱「同步」→ 交叉引用會拿到錯條目 | 已修：統一同一序（#13 = `--var`、#14 = `+5`）| —（文件）|
| R5-3 | P2 | 同一 commit 內對同類缺陷的次數自相矛盾（「第三次復發」vs「四度復發」）| 已修：**不再寫序數**，敘述改為指向 deliverable「已知問題 5」的 **①–⑪ 十一處清單**——以後復發只需改一處 | —（文件）|

> ⚠️ 第四輪 checker 這次**沒有**寫出「沒找到更多問題」（因為它列了 3 條發現），
> 報告內部無矛盾，故本票**必須再跑第五輪**才能真正結案。

#### 第四輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 3 P2`（本輪只讀；暫存均存 `/tmp`，repo 未動）。
>
> **[A-1]** R4-1 → **已修好**：`raw === null || raw.trim() === ""`（空值）與 `/^\d+$/`（原字串、不 trim）
> 兩段分開；21/21 probe 斷言綠：`+5`／`%2B5`／`%201500` → 400 `MS_INVALID`；`%20%20`／`%09`／`?ms=+` → 400 `MS_REQUIRED`；
> `0001500`／`0`／`1500`／`300000`／`0300000` → 200；`300001`／`0300001` → 400 `MS_TOO_LARGE`；
> 20 位數／`9007199254740993` → 400（**無 500/NaN**）；全形／`%C2%A0`／en-space → 400。**沒有修過頭。**
>
> **[A-2]** R4-2 → **部分修**：✓ 14 列 #1–#14 連續、✓ deliverable 變更清單 12/13/15/5/10、
> ✓ 逐 AC 對帳 9+5+15+2+1+11+12 = **55** = 72 − 17、✓ backlog「55 單元 + 19 冒煙」；
> ✗ **前置表頭 `meeting-do.test.ts`（14）**（實際 15）、✗ 兩表 #13/#14 對調。
>
> **[R5-1]** 根因：第三輪把 meeting-do 由 14→15，改到變更清單與對帳式，**卻漏改前置表頭**；
> 與 R1-8 / R3-3 / NEW-3-2 同族（同類缺陷第四次）。影響：低（純文件），但這是可被讀者當事實的數字，且本文件自身前後矛盾。
>
> **[R5-2]** 兩表內容集合相同、各自編號連續，但 `#13/#14` 跨檔指涉不同陷阱，與「同步寫進 AC 文件陷阱表」的敘述不符。
>
> **[R5-3]** deliverable `:392`（第三次）與 `:513`（四度）皆由第三輪 commit 同時加入；影響：低（純敘述）。
>
> **[Task B 其他（無新缺陷）]** `raw.trim() === ""` 與 `/^\d+$/` 交界：tabs／全形／`\u00a0`／en-space + 數字 → 全 400 `MS_INVALID`，純空白 → `MS_REQUIRED`，
> **無漏洞、無 500/NaN**。新測試**真會紅**：HEAD 測試對舊 src 重跑 → `f8e0c86` = `1 failed | 14 passed (15)`
> （紅的正是 `?ms=+5`）、`800063d` = `9 failed | 6 passed (15)`；非自我實現（打真 `MeetingDurableObject`）、無時間依賴。
> 逐 AC bucket = `lifecycle 13 = 7+6`、`meeting-do 15 = 2+1+9+1+2`、`harness-persistence 10 = 4+2+4`、
> `meeting-harness 5`、`do-sqlite 12`——**每 bucket 都對得上**。
>
> **〔沒驗到〕** 真 workerd 平台行為（未起 dev server；19 項冒煙未執行，僅以 `grep -c '^check('` = 19 證實數量，
> 並用單元等價驗證 `?ms=1500` → 200）；歷史紅綠燈無法重現；冒煙「真 alarm 醒來」未驗；Gate 1 先紅後綠時序無法從最終樹回溯；
> 未逐一人工歸屬每個 `it(` 到 AC bucket（只驗到逐檔總數與 AC 級加總相符）；
> 第三輪紅燈 `1 failed | 14 passed (15)` 以「HEAD 測試對 `f8e0c86` src 重跑」得同數字佐證，但無法還原當時確切 test set 時序。
> （上列 6 條與 deliverable 保留的原文 6 條一致，**無省略**。）
>
> **[結論]** R4-1 確實修好；R4-2 只部分修。Gate 4 第四輪**不建議直接判定通過**，建議修完上述文件數字後即可（A-1 已無程序缺陷）。

### 第五輪稽核（修正後重跑）— 新發現與處置

**verdict：`0 P0 / 0 P1 / 2 P2`**（本輪新發現；皆文件─現實不一致，低衝擊，**程式面零變動**——
`git diff ee38c94 b5c2a85 -- worker/` = **0 bytes**）。Task A 複驗：R5-1 / R5-2 / R5-3 三條**全數確認已修**。

> ⚠️ 本節及下方引用段中的**行號均為 `b5c2a85` 時的行號**；本輪編輯後行號已位移，請以內容而非行號對照。

| # | 等級 | 發現 | 處置 | 測試 |
| --- | --- | --- | --- | --- |
| R6-1 | P2 | 第四輪**處置欄以引號呈現「新文字」**，但該字串在敘述裡不存在（`deliverable:392` / 本文件 `:344`，均為 `b5c2a85` 行號）：宣稱 `反覆復發（清單見已知問題 5，①–⑥）`，實際敘述無 `，①–⑥`（當時清單 6 項，現為 ①–⑪） | 已修：兩處處置欄**不再用引號冒充引文**（改為描述）；敘述補上具體指向「已知問題 5 的 ①–⑪」 | —（文件）|
| R6-2 | P2 | 同一份第四輪 checker 原文的〔沒驗到〕條數**跨檔不一致**：本文件 5 條 vs deliverable 6 條 vs canonical 6 條；且標頭宣稱「數字未改」但未標省略 | 已修：本文件補回缺少的那條（現為 6 條）並註明「與原文 6 條一致、無省略」 | —（文件）|

> ✓ 第五輪 checker 另指出**我在第五輪任務描述裡的前提有誤**：我寫「第四輪報告有 **8 條**沒驗到」，
> canonical 報告實際是 **6 條 bullet**（`8` 應是字串出現次數誤記）——已採納。
>
> ⚠️ 第五輪 checker 這次**沒有**寫「沒找到更多問題」（它列了 2 條 P2），報告內部無矛盾，
> 故本票**必須再跑第六輪**才能真正結案。

#### 第五輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 2 P2`（本輪新發現；皆文件─現實不一致，低衝擊，**程式面零變動**）。
>
> **[Task A]** R5-1 **已修 ✓**（`:9` = `meeting-do.test.ts（15）`；vitest 15；`grep -c it(` = 15）；
> R5-2 **已修 ✓**（`:117` #13=`--var`、`:118` #14=`+5`；deliverable 同序；跨檔引用皆指到正確條目）；
> R5-3 **已修 ✓**（敘述段零序數；序數僅殘留於 checker 原文引用區塊；當時清單 ①–⑥ = **6 項**，與當時宣稱相符；本輪已擴為 ①–⑪）。
>
> **[R6-1]** 處置欄宣稱 `改為「反覆復發（清單見已知問題 5，①–⑥）」`；實際敘述無 `，①–⑥`。
> 影響：低（純敘述引文），但這是本票第五次同族「文件─現實不符」。
>
> **[R6-2]** 缺少條目：`「第三輪紅燈 1 failed | 14 passed (15)」：用 HEAD 測試對 f8e0c86 src 重跑得同數字，可佐證；
> 但無法還原當時確切 test set 時序`（deliverable `:551` 有、本文件原本缺）。標頭宣稱「數字未改」卻未以 `…` 標示 6→5。
>
> **[觀察（不列為新 P2）]** 本文件狀態句與 `R{k}-n` 編號慣例先前被放在第二輪區塊內、且慣例定義晚於 R1/R2/R3 首次使用
> （屬 pre-existing，非事實錯誤，未計入）→ 本輪已把兩者移到 §追加驗收 開頭。
> deliverable `:231`「逐字貼回，未節錄」的第二輪引用省去原報告的 `acceptance-report` JSON 區塊並清掉 `td{0}` 汙染 → 良性、pre-existing。
>
> **〔沒驗到〕** 真 workerd 平台行為（未起 `wrangler dev`，19 項冒煙**未執行**，僅以 `grep -c '^check('` = 19 佐證數量）；
> 第四輪 21/21 raw-query probe 本輪**未重跑**；歷史紅綠燈無法重現；逐 AC bucket 只驗逐檔總數與 AC 級加總；
> 冒煙逐 AC 歸屬（4/8/3/2/1/1）只驗總數 19；已知殘留非 TECH-004 範圍，未重驗。
>
> **[結論]** Task A 三條全數確認已修；Task B 找到 2 條低衝擊文件─現實不一致，**故不寫「沒找到更多問題」**。

### 第六輪稽核（修正後重跑）— 新發現與處置

**verdict：`0 P0 / 0 P1 / 3 P2`**（本輪新發現；皆文件─現實／跨檔一致性，低衝擊，**程式面零變動**——
`git diff b5c2a85 2acd96b -- worker/` = **0 bytes**）。Task A 複驗：NEW-5-1 / NEW-5-2 / 自我一致性三條**全數確認已修**。

> ⚠️ 本節及下方第六輪引用段中的**行號皆為 `2acd96b` 時的行號**（本輪編輯後已位移）。

| # | 等級 | 發現 | 處置 | 測試 |
| --- | --- | --- | --- | --- |
| R7-1 | P2 | 同一份 deliverable 對「含幾輪 checker 原文」自相矛盾（`:46` 寫五輪、`:762` 寫兩輪；當時 `#### 第N輪` 區塊 = 4 個，第二～五輪）| 已修：兩處統一（修此條時為「第二～五輪」；本輪新增第六輪引用段後已同步為「第二～六輪」，即 **5 個**區塊；其後第七輪再新增第七輪引用段 → **6 個**） | —（文件）|
| R7-2 | P2 | 同一段第五輪原文的跨檔引用逐字不一致（本文件 `:487` 「程**試**面」vs deliverable `:586` 「程**式**面」）| 已修：統一「程式面」（錯字孤例） | —（文件）|
| R7-3 | P2 | deliverable 變更清單**漏列 `docs/trust-log.md`**（`800063d` 確實含此檔 +34 行）| 已修：補一列（修改 / trust mode 收尾紀錄） | —（文件）|

> ✓ 第六輪 checker 又指出**我任務描述的前提錯誤**（我寫「本票共跨 5 個 commit」卻列了 7 個 hash；
> 第六輪 checker 當時數為 8 個，**第七輪複核 `git log --grep=TECH-004` = 9 個**，含 `844f247`）——已採納。**這是它連續第二輪抓到我的輸入前提有誤。**
>
> ⚠️ 第六輪 checker 同樣**沒有**寫「沒找到更多問題」（它列了 3 條 P2）。
> **用戶已裁決**：修完這 3 條再跑第七輪；**若第七輪仍只出同族文件 P2（≤3 條），即停止 loop**，
> 將六～七輪 verdict 併同交付物交用戶裁決 Gate 4 是否接受（避免無限循環）。

#### 第六輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 3 P2`（本輪新發現；皆文件─現實／跨檔一致性，低衝擊；`worker/` 程式碼零變動）。
> 前置硬性確認：`git diff b5c2a85 2acd96b -- worker/` = **0 bytes**。
>
> **[A-1]** NEW-5-1（引文不實）→ **已修 ✓**：`反覆復發` 確實存在；`①–⑥` 僅出現於第五輪引用段（歷史例外），
> 當前狀態敘述一律 `①–⑧`；已知問題 5 = **8 項**；抽樣「…」引號內 ≥6 字 **12/12 存在**；兩處處置欄已無引號冒充。
>
> **[A-2]** NEW-5-2（條數跨檔不一致）→ **已修 ✓**：本文件第四輪〔沒驗到〕**6 條**、deliverable **6 條**，集合一致（僅順序不同）；
> 另附第五輪〔沒驗到〕兩檔亦皆 6 條。
>
> **[A-3]** `2acd96b` 的自我一致性宣稱→ **為真 ✓**：全票指向「已知問題 5」的敘述皆 ①–⑧，清單確實 8 項。
>
> **[R7-1]** `deliverable:46`（含五輪）vs `:762`（含兩輪）；實際 `#### 第N輪` 區塊 = 4 個（第二～五輪）；
> `git blame` 顯示 `:762` 由 `f8e0c86` 引入後從未更新。影響：低（純敘述），但兩句不可能同時為真。
>
> **[R7-2]** `docs/ac/TECH-004.md:487` 「程試面」vs `deliverable:586` 「程式面」；兩檔同時在 `81aaca2` 加入時就已分歧。
> 影響：極低（單字錯字），但與 NEW-5-2 同族（引用段跨檔不一致）。
>
> **[R7-3]** 變更清單 16 列中無 `docs/trust-log.md`；`git show --stat 800063d` 顯示 `docs/trust-log.md | 34 +`。
>
> **〔沒驗到〕**（7 條）真 workerd 平台行為未驗（未起 `wrangler dev`，冒煙 19 項未執行）；歷史紅綠燈無法重現；
> 第四輪 21/21 raw-query probe 未重跑；canonical 第五輪報告未取得（只能證明兩檔不一致）；
> 逐 AC `it(` 語意歸屬未逐一人工核對；`worker/.wrangler/state` 汙染未驗；第六輪未來的原文回寫行為無法預驗。
>
> **[數字類複驗（未發現新問題）]** 單元 72（`Tests 72 passed (72)`）、TECH-004 自身 55（9+5+15+2+1+11+12）、
> 冒煙 19（`grep -cE '^\s*check\('`）、陷阱 14（兩表各 14 列）、lint 45 檔、追加 27（21+5+1）；
> 各檔 12/13/15/5/10/17 全數相符；輪次敘述與各輪 verdict 串（0/2/9、0/0/4、0/0/2、0/0/3、0/0/2）全位置一致，
> **無**殘留「第四輪進行中」等舊狀態。
>
> **📝 附註（非 checker 原文）**：本段引用時（`2acd96b`）清單為 8 項；第六輪新增 3 條後為 **11 項（①–⑪）**。
>
> **[結論]** Task A 三條全數確認已修；Task B 找到 3 條 P2，**故不寫「沒找到更多問題」**；建議修完後再跑第七輪。

### 第七輪稽核（修正後重跑）— 新發現與處置（loop 封頂點）

**verdict：`0 P0 / 0 P1 / 3 P2`**（本輪新發現；皆文件─現實／跨檔一致性，同族；**程式碼零變動**——
`git diff 2acd96b eefe848 -- worker/` = **0 bytes**）。Task A 五條**全數確認**（NEW-6-1 / NEW-6-2 / NEW-6-3 已修且為真、
`eefe848` 自我一致性為真、附註標示得當）。checker 另複核 TECH-004 相關 commit 數 = **9 個**。

| # | 等級 | 發現 | 處置 | 測試 |
| --- | --- | --- | --- | --- |
| R8-1 | P2 | 本文件 R6-1（第六輪）的**處置欄漏改**：全票都已是 `①–⑪`，唯此處寫 `①–⑧`（同檔自我矛盾，與 NEW-6-1 同族）| 已修：改 `①–⑪`，並補註「當時清單 6 項，現為 ①–⑪」 | —（文件）|
| R8-2 | P2 | deliverable 的 **Gate 4 歷程狀態列**未隨輪次同步（`:229-230` 仍寫「已修正並跑**第六輪**；第六輪 verdict 回來前…」，同檔別處已是第七輪）| 已修：改「跑**第七輪**；第七輪 verdict 回來前…」 | —（文件）|
| R8-3 | P2 | 本文件第六輪節**缺行號基準標註**，且自指行號 `:487` 在 `eefe848` 後已失效（deliverable 同節有警告，本文件沒有）| 已修：本節補「行號皆為 `2acd96b` 時的行號」警告 | —（文件）|

> **📝 附註（非 checker 原文）**：另 2 條 checker 判為**觀察、不計入 P2**（我仍一併修）：
> ① deliverable「第四、五輪為純文件修正」漏列第六輪 → 已改「第四～六輪」；
> ② 我的筆記原本承接第六輪 checker 的「相關 commit 8 個」，第七輪複核實為 **9 個** → 已更正。
>
> **⛔ loop 到此封頂（依用戶裁決）**：連續六輪（第二～七輪）都只出同族文件 P2，程式面自第二輪起零新缺陷。
> 第七輪 verdict（0 P0 / 0 P1）已達用戶設定的停止條件，**不再跑第八輪**；Gate 4 是否接受**由用戶裁決**。
> 本輪 3 條修正為**自我複驗**（`npm run lint` 0 issue、`vitest` 72 passed、`git grep` 全掃），**未經獨立 checker 複驗**——
> 此事已如實寫進交付物「已知問題 / 風險」。
>
> **✅ Gate 4 裁決紀錄（2026-10-08）**：用戶聽取「七輪 verdict（0 P0 / 2 P1→已修 / 26 條 P2→全數處置、程式面自第二輪起零新缺陷）」後，
> 選擇「**接受 Gate 4 通過 → 進入 §2.4 反省**」。gate-4 `notes` 之 playwright-cli 項**不適用**（本票為純後端 / DO / CLI 任務，無 UI）。

#### 第七輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 3 P2`（3 條皆文件─現實／跨檔一致性，同族；`worker/` 程式碼零變動）。
> 版本界線：`git diff 2acd96b eefe848 -- worker/` → **0 bytes**。TECH-004 commit 數複核：`git log --grep=TECH-004 | wc -l` → **9**。
>
> **[A-1]** ✅ 已修：「含幾輪 checker 原文」全校準——AC 與 deliverable 各 **5 個** `#### 第N輪 checker 原文` 區塊（第二～六）；
> 現行敘述僅 `DL:46`／`DL:829` 兩處且皆「第二～六輪」；**歷史引用忠實**（`git show 2acd96b:<DL>` 實測 `46:含五輪`、`762:含兩輪`、區塊 4 個，與引文吻合）。
>
> **[A-2]** ✅ 已修：`grep -rn "程試" docs/ worker/` → 全 repo 只剩 `AC:543`，且為「描述舊 bug」的歷史引述；第五輪原文 Verdict 行 AC:487 與 DL:605 **逐字相同**（皆「程式面零變動」）。
>
> **[A-3]** ✅ 已修：`DL:47` 已列 `docs/trust-log.md | 修改 | trust mode 收尾紀錄（+34 行，含於 800063d）`；
> `git show --stat 800063d | grep trust-log` → `34 +` 相符；變更清單列數 16 → **17**。
>
> **[A-4]** ✅ 為真（但有 1 處漏網，即 P2-1）：「已知問題 5」清單 **11 項**；指涉 5 處為 `①–⑪`，唯一例外 `AC:476` = `①–⑧`。
>
> **[A-5]** ✅ 附註沒有濫用逐字性：兩處附註逐字相同、獨立 blockquote 行、明標「非 checker 原文」；同區塊其它 checker 引文與 `2acd96b` 版逐行比對**一字未動**。
>
> **[P2-1]** `docs/ac/TECH-004.md:476` 處置欄 `①–⑧` vs 全票 `①–⑪`
> （`grep -rn "已知問題 5" docs/ | grep "①–"` 顯示唯一非⑪即此處）；影響：低，但同檔自我矛盾、與 NEW-6-1 同族。
>
> **[P2-2]** `DL:229-230` 仍寫「已修正並跑**第六輪**；第六輪 verdict 回來前…」，
> 與同檔 `:425`／`:440`／`:442`／`:711`／`:778`、AC:186、`docs/backlog.md:208` 皆矛盾；
> 歷史顯示該行每輪都更新（`b5c2a85`＝跑第五輪、`81aaca2`＝跑第六輪），**唯獨 `2acd96b` 與 `eefe848` 未再更新**。影響：低→中。
>
> **[P2-3]** `AC:517`（R7-2 列）自指 `本文件 \`:487\``；`git show 2acd96b:docs/ac/TECH-004.md | sed -n 487p` = 「程試面」，但 HEAD 同一行已是「程式面」；
> AC 唯一行號警告在 `:472` 且寫的是 `b5c2a85` 基準，與第六輪節所用的 `2acd96b` 基準不符（deliverable 同節 `:427` 則有正確警告）。
>
> **〔沒驗到〕**（8 條）未跑 `vitest` / `tsc` / `markdownlint` / `regression-guard` / 冒煙（read-only 紀律），故「全綠」未驗，只靜態證數量（`it()`=72、`.md`=45、`check()`=19）；
> 真 workerd 平台行為未驗；歷史紅燈無法重現；第四輪 21/21 probe 未重跑；canonical 各輪報告未取得；逐 AC `it(` 歸屬未逐一人工核對；`worker/.wrangler/state` 汙染未驗；未來輪次沿用附註無法預驗。
>
> **[數字類複驗（實測，未發現新問題）]** 單元 72、各檔 12/13/15/5/10/17、TECH-004 自身 55（=72−17）、
> 冒煙 19、陷阱各 14、lint 45（`git ls-files '*.md' | wc -l`）、追加 27（`git show` 實測 21/5/1）、commit 9、
> verdict 串全位置一致。
>
> **[結論]** Task A 五條全數確認；Task B 找到 3 條 P2（P2-3 偏弱，可降為觀察）——**故本報告不寫 0-發現結語**，第七輪 verdict 交由用戶依封頂規則裁決。
