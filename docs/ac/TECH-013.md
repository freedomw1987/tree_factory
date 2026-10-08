# TECH-013 — 逐字稿讀取分頁／增量 ＋ 串流部分寫入的計數一致（驗收標準）

- **票號**：TECH-013（P2 / 2 SP / 依賴 M01-US-103；由 US-103 Gate 4 的 P2-4／F5 轉出）
- **目標**：把兩件「帳本是對的、但**介面**會誤導人」的債還掉：
  ① `GET /transcript/segments` 一次回傳整場 → 加上 `since`（增量）與 `limit`（分頁），
  且**截斷必須看得出來**（`hasMore` / `total`），不得靜默少給。
  ② 串流請求**中途**失敗（前面已落地的列留著）時 `transcriptWrites` 停留在舊值，
  以及同一時間兩個請求互相覆蓋計數（read-modify-write）→ 讓「每一列新落地的段落恰好 +1」
  在失敗與併發下都成立。
- **實作**：`worker/src/storage/transcript-store.ts`（`listPage`）、`worker/src/meeting-do.ts`
  （GET 參數守門、回應欄位、`#addTranscriptWrites`、`#writeWithCatchUp`、US-101 舊 `/transcript` 也走同一個計數）
- **測試**：`worker/test/transcript-read-paging.test.ts`（新增）、
  `worker/scripts/do-smoke.mjs` §9（真 workerd）

## 背景（為什麼要有這一票）

US-103 把逐字稿真的寫進 DO SQLite 帳本，但讀取端只有一個「整場一次回傳」的出口。
兩小時的會議依真跡段長（約 200 bytes/句）換算約 0.4 MB，還擠得住，可是 US-104 要在**會議進行中**顯示逐字稿：
每幾秒重抓整場，等於把同一批句子一再下載，而且**越到後面越貴**。
真正要的是「我已經看到 `seq=N`，給我 N 之後的」——也就是增量讀取。

第二件事更隱蔽：計數（`transcriptWrites`）是**先讀 session、再加、再寫**。
① 串流請求處理到一半遇到 400（例如後面的句子落在未來時間），前面已經落地的列**留著**，
但那次請求從此中斷，計數停在舊值 → 帳本 5 列、計數 3。
② 兩個請求交錯（`await request.json()` 期間對方先寫），後寫的人拿**自己的舊基底**去覆蓋 →
少算一次。
兩者都不會讓資料消失，但會讓「計數」變成一個**看起來像事實的猜測**。這種欄位比沒有更糟。

## 驗收標準（BDD）

### AC-1 增量與分頁（`since` / `limit`）

- **Given** 帳本裡有 3 列（`seq` = 1,2,3）
- **When** `GET /transcript/segments?since=2&limit=1`
- **Then** 回 **1** 列且是 `seq=3`（`since` 是**排他**下界：`seq > since`）
- **And** 回應含 `count`（本次回傳列數）、`total`（帳本總列數）、`hasMore`（還有沒有更後面的）、
  `nextSince`（本頁最後一列的 `seq`；空頁為 `null`）
- **And** 用 `nextSince` 當下一次的 `since` 可以**不漏不重**地走完整場
  （AC 的驗法：從 `?limit=2` 起連續抓，兩趟之後 `hasMore=false` 且收集到的 `seq` 恰為 1,2,3）
- **And** `since` 超過最後一列 → `segments: []`、`count: 0`、`hasMore: false`、`nextSince: null`
  （不是 404、也不是回最後一頁）
- **And** 未帶任何參數時，既有欄位 `meetingId` / `count` / `segments` 的語意與 US-103 相同
  （`count` ＝ `segments.length`）
- **And** `limit` 預設 `SEGMENT_PAGE_LIMIT_MAX`（500）且上限就是它——
  **預設會截斷，但截斷一定看得見**（`hasMore:true` + `total`）。
  （單元測試將上限注入成 50，用 51 列驗「預設真的來自上限常數」；`limit=511` → 400。
  生產值 500 由冒煙脚本驗。）

### AC-2 參數驗證（不合法要指名，不得靜默夾住）

- **Given** 任意進行中的會議
- **When** `since` 或 `limit` 是「非整數／負數／0（limit）／超過上限／重複帶兩次／空字串」
- **Then** 回 400 `TRANSCRIPT_INVALID`，且訊息**指出是哪個欄位與為什麼**
  （例：`limit 必須是 1~500 的整數`、`since 不得重複`）
- **And** **不得**默默夾到合法範圍（`limit=0` 回預設值＝對呼叫端撒謊）也不能回 500
- **And** 這條路徑是唯讀：壞參數**不得**改變帳本（列數、`seq` 都不動）
- **And** 守門順序與寫入路徑一致：先看有沒有進行中的會議（沒有 → 409 `SESSION_NOT_STARTED`），
  再驗參數（400）
- **And** 未知參數（例：`?cursor=3`）一律忽略——本票沒有承諾的參數不該讓請求失敗

### AC-3 部分寫入的計數一致

- **Given** 一次 `POST /transcript/stream`，裡面第 1 句合法、第 2 句的 `startMs` 落在未來
  （超過 `已過時間 + 容差`）
- **When** 該請求回 400 `TRANSCRIPT_INVALID`
- **Then** 第 1 句**留在帳本**（已落地的列不該被回滾），帳本 `total` = 1
- **And** `transcriptWrites` = **1**（帳本有幾列、計數就該有幾次；失敗的那句不計）
- **And** 錯誤碼與訊息與本票之前**完全相同**（只補計數，不改對外行為）
- **And** 同一條規則也適用於**批次**寫入（`POST /transcript/segments`）：前置的整批驗證只擋得下
  **邏輯性**壞資料；**儲存層**錯誤（INSERT／讀回失敗）發生在第 k 列時，前 k-1 列已落地，
  計數亦須跟上（第二輪獨立審查以真 workerd 探針推翻「批次不可能中途拋」後補上）

### AC-4 併發寫入不得少算

- **Given** 兩個請求幾乎同時寫入同一場會議（A 讀完 session 後、寫入前，B 已經落地一列）
- **When** 兩個請求都回 200
- **Then** `transcriptWrites` = **2**、帳本 `total` = 2
- **And** 回應裡的 `transcriptWrites` 是**寫入當下重新讀到的最新值**（不是「請求開頭的快照 + 本次」）
- **And** 併發只影響計數的讀寫時序，**不得**影響列的可見性（兩列都要在，`seq` 不重號）
- **And** **三條寫入路徑**（US-101 的 `/transcript`、批次 `/transcript/segments`、串流 `/transcript/stream`）
  都不得用「請求開頭的快照」當基底寫回——舊路徑 × 帳本路徑的競態也適用本條
  （第二輪審查用探針證明它確實會少算：帳本 2 列、計數被寫回 1）

### AC-5 分頁不得動到帳本

- **Given** 帳本有 N 列
- **When** 任意合法／非法的 GET（含 `since`、`limit` 各種組合）連續讀取
- **Then** 列數與每列的 `seq` 完全不變（`append-only` 的讀取端保證）

## DoD（完成定義）

- [x] Gate 1：測試先紅後綠（`transcript-read-paging.test.ts` 全綠；紅的內容貼在交付文 §3）
- [x] Gate 2：`worker` `tsc --noEmit` 通過 ＋ `markdownlint`（含本檔與設計檔）0 issues
- [x] Gate 3：`worker` 全量測試 ＋ `REGRESSION_MODULE=M01` 回歸全綠；UI 未動仍跑一次 E2E 回歸
- [x] Gate 4：獨立 `reviewer` ＋ `oracle` 子代理（fresh context）審查，逐條處置 P0/P1/P2 並留痕
- [x] 真 workerd（`wrangler dev --local --var HARNESS_PROVIDER:faux`）冒煙：分頁／增量／
      壞參數 400／部分寫入計數／併發計數
- [x] 突變測試：把每一條新斷言對應的守門拿掉，確認**真的紅**再還原
- [x] 文件：設計檔（D 編號）、`docs/backlog.md` 轉 DONE、交付文（含未驗事項誠實聲明）、`trust-log`
- [x] 未驗事項明講：兩小時真會議的份量、真 STT、以及「併發在真 workerd 上是否真的交錯」
      （單元層用注入方式**保證**交錯，真環境只是壓力測試）
