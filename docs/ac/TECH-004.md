# TECH-004 — DO 內 Harness 生命週期封裝（驗收標準）

- **票號**：TECH-004（P0 / 3 SP / 依賴 SPIKE-003）
- **目標**：把 `Harness` 在 Cloudflare Durable Object 內的生命週期固定下來——**單例、懶初始化、
  alarms 接力、憑證繫結、重啟後同一場會議讀得回**——讓 M02 之後的票都站在同一套骨架上。
- **實作**：`worker/src/storage/do-sqlite.ts`、`worker/src/harness/lifecycle.ts`、
  `worker/src/harness/meeting-harness.ts`、`worker/src/meeting-do.ts`、`worker/src/index.ts`
- **測試**：`worker/test/do-sqlite.test.ts`（6）、`worker/test/lifecycle.test.ts`（12）、
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
- **And** `ms` 缺漏／非有限／負數 → 明確報錯（**不得**退化成 0，否則會變成立即 alarm 的忙迴圈）
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

## 介面契約（重點）

| 介面 | 契約 |
| --- | --- |
| `HarnessLifecycle.current()` | 單例；併發安全；開啟失敗可重試（不會永久壞掉） |
| `HarnessLifecycle.release()` | 關閉並清空；未開過時是 no-op |
| `HarnessLifecycle.wakeIn(ms)` | 只往前；回傳 `{scheduled, at, previous}` |
| `HarnessLifecycle.onAlarm()` | 累計 `wakes`；確保 harness 可用（必要時重建） |
| `DoSqliteDatabase` | 官方 `SqliteDatabase` 六方法；**交易外的操作排隊**、交易回呼用**獨立 handle**、回呼失敗先 rollback |
| `resolveModel(bindings, phase)` | 缺憑證 → `AUTH_INVALID`；faux → 免憑證 |

## 已知陷阱（本輪實測抓到，已修）

| # | 陷阱 | 症狀 | 修法 |
| --- | --- | --- | --- |
| 1 | `url.pathname` 不含 query | 轉發給 DO 時 `?ms=1500` 消失 → `Number(null) = 0` → alarm 立刻觸發 | `pathname + url.search` |
| 2 | 缺參數退化成 0 | `wakeIn(0)` 造成立即 alarm（潛在忙迴圈） | 缺 `ms` 回 400 `MS_REQUIRED` |
| 3 | 交易中的工作未排隊 | 交易外的 `run()` 插進交易中間（假 storage 測試抓到） | `#tail` 閘門 + 交易 handle 直通 |
| 4 | pi-ai 不匯出 `AuthContext` 型別 | `import type` 深連結失敗 | 從 `createModels` 參數推導型別 |
| 5 | 自行縮寫的模型 id | `llama-3.3-70b-fp8-fast` 解析不到 | 用目錄完整 id `@cf/meta/...` |
| 6 | 工作區「conversationId 跨會議唯一」的假設 | 兩個會議都回 `1`（根對話 id 固定） | 比 DO 身分（`doId`），不比 conversationId |

## 測試與證據對照

| AC | 單元 / 整合測試 | 冒煙（真 workerd）|
| --- | --- | --- |
| AC-1（單例與懶初始化）| `lifecycle.test.ts` 6 項（懶初始化／單例／併發／失敗重試／release 重建／release no-op）| `do-smoke.mjs` 4 項 |
| AC-2（憑證繫結）| `harness-persistence.test.ts` 4 項（缺憑證 `AUTH_INVALID`／憑證齊全與綁定覆寫／faux 免憑證／`AuthContext` 讀綁定）| —（faux 啟動下跳過，由單元覆蓋）|
| AC-3（alarms 接力）| `lifecycle.test.ts` 6 項（設定 alarm／只往前／拒絕非法值／onAlarm 重建／onAlarm 重用／缺 `getAlarm`）| `do-smoke.mjs` 8 項（含重建後 conversationId／entries 不變）|
| AC-4（重啟後同一場會議）| `harness-persistence.test.ts` 2 項（重開同 conversation、真跑一個 turn）| `do-smoke.mjs` 3 項 |
| AC-5（一場會議 = 一個 DO）| — | `do-smoke.mjs` 2 項（兩會議不同 DO、各自 opens=1）|
| AC-6（模型與壓縮政策 D15）| `harness-persistence.test.ts` 4 項（模型在目錄／可覆寫／壓縮政策推導／自訂壓縮政策）| `do-smoke.mjs` 1 項 |
| （儲存適配器契約）| `do-sqlite.test.ts` 6 項 | — |
| （冒煙基礎設施）| — | `do-smoke.mjs` 1 項（Worker 活著）|

**對帳**：單元 + 整合 = 6+4+6+2+4+6 = **28 項**（TECH-004 自身）；冒煙 = 4+8+3+2+1+1 = **19 項**。

**總計**：`worker` 測試 45 項（含 M01-US-109 的 17 項；TECH-004 自身 28 項）；
真 workerd DO 冒煙 **19 項檢查全綠**（另 1 項 `AUTH_INVALID` 由單元測試覆蓋，
冒煙以 faux 啟動故跳過）。

### 冒煙重跑指令（可審查）

```bash
cd worker && npx wrangler dev --port 8791 --local --var HARNESS_PROVIDER:faux &
DO_SMOKE_BASE=http://127.0.0.1:8791 node scripts/do-smoke.mjs   # 19 項全綠
```
