# TECH-004 — DO 內 Harness 生命週期封裝（收尾交付）

**日期**：2026-10-08
**Backlog ID**：TECH-004（P0 / 3 SP / 依賴 SPIKE-003）
**作者**：Agent（trust mode 實作；2026-10-08 08:2x 收尾補完手續）
**狀態**：✅ 完成（程式碼 + 測試 + AC 文件 + 提交）

## 摘要

把 SPIKE-003 驗證過的「Pi Harness 能在 Cloudflare Durable Object 上跑」升格成
**產品骨架**：`HarnessLifecycle`（單例 / 懶初始化 / alarms 接力）+ `DoSqliteDatabase`（官方
`SqliteDatabase` 六方法、交易排隊）+ `MeetingDurableObject`（一場會議 = 一個 DO）+ 憑證走 Worker
綁定（不讀 `process.env`，避免「本機測試過、部署 401」）。

**核心洞見**：DO 有三個平台事實會咬人 —— ①隨時被回收（記憶體 harness 會消失）；
②constructor 不能 `await`（不能建立時就開 harness）；③`harness.close()` 會一併關掉 storage
（重建必須是整條鏈 adapter → storage → harness）。本票把這三件事固定成骨架，
讓 M02 之後的票都站在同一套基礎上。

## 為什麼做這個改動（§1.2）

**為什麼做**：`docs/system-design.md` 把「一場會議 = 一個 DO」定為架構前提，但 DO 的生命週期
（隨時被回收、constructor 不能 `await`、`close()` 連 storage 一起關）與 Pi Harness（需要 storage +
非同步初始化）天然衝突。這個衝突若不在骨架層解掉，後續 M02/M03 每一張票都要各自重猜一次，
且會各自踩到不同的坑。本票把「怎麼活下來」變成可測的封裝。

**為什麼這樣設計**：①**單例 + 懶初始化**——DO 可能被喚醒多次，若每個 entrypoint 都新建 harness，
會出現兩個 harness 搶同一份 storage；②**alarms 接力**——DO 被回收後記憶體狀態消失，
只能靠平台 alarm 重新喚醒並由 storage 還原狀態；③**憑證走 Worker 綁定**——`process.env` 在本機
（vitest）與 worker runtime 語意不同，讀它會出現「本機綠、部署 401」的假信心。

**為什麼放棄其他選項**：①**不做「記憶體 harness 單例」**——本機看起來對，但 DO 回收即失效，
是最典型的假綠；②**不用 `release()` 立即關閉**——會讓正在開的請求拿到已關閉的 harness
（第二輪 P1-2 的 Design B' 改成非阻塞延後釋放）；③**不自創交易排隊**——自創版本只擋住同步到達的操作，
官方契約要求「在交易回呼 `await` 期間到達的操作」也要排隊，故改為移植官方 `SerialOperationQueue`。

## ⚠️ 收尾說明（誠實紀錄）

本票的**實作與驗證在 trust mode 期間（2026-10-08 約 04:00–04:08）完成**，
但當時**未 commit、未標 DONE、未產 deliverable**，成果暴露在丟失風險長達數小時。

2026-10-08 08:18 用戶詢問進度時發現此事，於 08:2x 執行收尾（本檔即為收尾產物）：
重新實測驗證 → 修正 AC 文件 2 處數字不精確 → 提交 → 補本 deliverable。

## 變更清單

| 檔案 | 狀態 | 說明 |
| --- | --- | --- |
| `worker/wrangler.toml` | 新增 | DO 綁定（`new_sqlite_classes`）+ 模型 env（`HARNESS_PROVIDER` / `REALTIME_MODEL_ID` / `NOTES_MODEL_ID`）|
| `worker/src/index.ts` | 新增 | Worker 入口：`/m/:meetingId/*` 轉發到 DO |
| `worker/src/meeting-do.ts` | 新增 | `MeetingDurableObject`：HTTP / alarm / storage 接線 |
| `worker/src/harness/lifecycle.ts` | 新增 | `HarnessLifecycle`：單例、懶初始化、alarms 只往前 |
| `worker/src/harness/meeting-harness.ts` | 新增 | `openMeeting()`、`resolveModel()`、憑證繫結、壓縮政策推導 |
| `worker/src/storage/do-sqlite.ts` | 新增 | `DoSqliteDatabase`：官方介面六方法 + 交易排隊 |
| `worker/test/do-sqlite.test.ts` | 新增 | 12 項（儲存適配器契約 + handle 失效時機）|
| `worker/test/lifecycle.test.ts` | 新增 | 13 項（AC-1 / AC-3，含併發 release）|
| `worker/test/meeting-do.test.ts` | 新增 | 15 項（DO HTTP 入口 / 參數驗證 / 錯誤映射 / `/release`）|
| `worker/test/meeting-harness.test.ts` | 新增 | 5 項（模型解析 / 目錄驗證 / 壓縮政策）|
| `worker/test/harness-persistence.test.ts` | 新增 | 10 項 |
| `worker/scripts/do-smoke.mjs` | 新增 | 真 workerd 冒煙：19 項檢查 |
| `worker/package.json` / `package-lock.json` | 修改 | 加 `smoke:do` script + `pi-ai` / `pi-durable` / `chord` 依賴 |
| `docs/ac/TECH-004.md` | 新增 | 6 條 BDD AC + 介面契約 + **14 個實測陷阱**（#1–#10 原始 + R3/R4 追加）|
| `docs/deliverable/2026-10-08-TECH-004-DO-harness生命週期.md` | 新增 | 本文件（含**第二～七輪** checker 原文，共 6 個引用區塊；第一輪為 verdict 摘要 + 表格）|
| `docs/trust-log.md` | 修改 | trust mode 收尾紀錄（+34 行，含於 `800063d`）|
| `docs/backlog.md` | 修改 | TECH-004 → `DONE` |

### 改動背後的理由（§2.4）

| 改動 | 為什麼是這個做法 |
| --- | --- |
| `DoSqliteDatabase` 移植官方 `SerialOperationQueue` | 官方契約（`pi-durable/dist/storage/sqlite/database.d.ts`）明定排隊語意；自創閘門漏掉「回呼 `await` 期間到達的操作」 |
| `scope.active = false` 移進平台回呼（`node.js:117` 對齊）| 官方在 `COMMIT` **前**就讓 handle 失效；不逐行對齊會留一個「已失效卻還能寫入」的窗口 |
| rollback 失敗回 `AggregateError([callbackError, rollbackError])` | 只丟 callback 錯誤會讓 rollback 失敗**靜默消失**，之後查帳查不出來 |
| `release()` 改非阻塞延後（Design B'）| 阻塞會讓 DO 的請求處理卡住；立即關閉則讓等待者拿到死物件 |
| 非法輸入一律丟錯／400／500（`MS_REQUIRED`、`PROVIDER_UNKNOWN`、`MODEL_UNAVAILABLE`）| 靜默退化（`Number("")→0`、換 provider、用 24k 窗口）會讓裝置**繼續跑但跑錯** |
| 先驗 provider/model 再開 storage | 先開 storage 再失敗，會留下半開的資源（DO 被回收前不會有人清）|

## 測試 / 驗收證據

### Gate 1（TDD）

依 gates.json 規範，Gate 1 (TDD) 需要：測試先紅後綠，並在對話貼出「測試執行指令 + 失敗輸出 + 通過輸出」。

**① 原始 TECH-004 實作（trust mode 期間）未留存紅燈**——這是無法回溯補齊的缺口，已列入「已知問題」。

**② 本次追加稽核修正（Gate 4 第一輪之後）全部先紅後綠**：把 checker 的重現腳本翻譯成測試
（4 個 storage 契約測試 + 1 個併發 release + 10 個 DO 入口 + 5 個模型解析），確認對舊實作**紅**，才動手改。

**③ 第二輪稽核的修正也是先紅後綠**（handle 失效時機 + 非整數 `ms`）：

```text
$ cd worker && npx vitest run          # 實作前（第一輪修正）
Test Files  4 failed | 2 passed (6)
     Tests  16 failed | 49 passed (65)

$ cd worker && npx vitest run          # 實作後（第一輪修正）
Test Files  6 passed (6)
     Tests  66 passed (66)             # 另補的 cursor 形狀測試也是紅→綠各一次

$ npx vitest run test/do-sqlite.test.ts test/meeting-do.test.ts   # 實作前（第二輪修正）
Test Files  2 failed (2)
     Tests  2 failed | 24 passed (26)  # handle-在-commit-窗口 + 非整數 ms

$ cd worker && npx vitest run          # 實作後（第二輪修正）
Test Files  6 passed (6)
     Tests  71 passed (71)

$ npx vitest run test/meeting-do.test.ts      # 實作前（第三輪修正）
Test Files  1 failed (1)
     Tests  1 failed | 14 passed (15)  # 未編碼 ?ms=+5 → 200（應 400）

$ cd worker && npx vitest run          # 實作後（第三輪修正）
Test Files  6 passed (6)
     Tests  72 passed (72)
```

> ⚠️ **誠實記錄**：第二輪那兩個測試的**第一版**都是「假綠」：① 非整數 `ms` 那個一開始被
> 我誤寫成對的（真紅燈才抓到）；② handle 那支第一版讓假 storage 把**平台自己的 tx 物件**
> 交給探針（該物件沒有 `.exec` → 一定 throw → 假通過）。改成用回呼把**我方 handle** 抓出來
> 後才真的紅（`EXECUTED`）。教訓已寫進陷阱 12。

### Gate 2（lint / 型別）

```text
$ cd worker && npm run lint
> tsc --noEmit && npx --yes markdownlint-cli2 --config ../.markdownlint-cli2.jsonc "../docs/**/*.md" "../*.md"
tsc: 0 errors
Finding: ../docs/**/*.md ../*.md !**/.venv/** !**/node_modules/** !**/target/**
Linting: 45 files
Summary: 0 issues in 0 files
exit=0
```

> 本輪一併修掉 `worker` 的 `lint` script 缺陷（見「已知問題 7」）：原本的
> `markdownlint-cli2 "**/*.md"` 在 worker 目錄下**找不到根目錄設定**
> （不套用規則也不套用忽略清單），結果對 `node_modules` 用預設規則 lint
> ——**10,820 個幻覺錯誤、`npm run lint` 永遠 exit 1**。現已改為顯式 `--config`，
> 並只 lint 專案自己的 md（45 檔）。

### Gate 3（regression）

依 gates.json 規範，Gate 3 (regression) 需要：baseline 與修改後的探針結果對照。

```text
$ cd worker && REGRESSION_MODE=true REGRESSION_REPORT_PATH=reports/tech-004-regression.json \
    npm run regression
[regression-guard] REGRESSION_MODE=true REGRESSION_MODULE=(all)
  → npx vitest run --reporter=json --outputFile=…/reports/tech-004-regression.json
[regression-guard] 結果：passed=45 failed=0
[regression-guard] ✅ 通過
```

（下表為該輪 45 項的組成；下列第二段是本次稽核修正後的數字。）

```text
$ cd worker && npm run regression      # 第三輪稽核修正後
[regression-guard] 結果：passed=72 failed=0
[regression-guard] 報告：/Users/apple/Sites/localhost/tree_factory/worker/reports/regression.json
[regression-guard] ✅ 通過
```

| 測試檔 | 項數 | 層級 |
| --- | --- | --- |
| `worker/test/do-sqlite.test.ts` | 12 | 單元（儲存適配器契約，含交易排隊 4 項 + handle 失效時機）|
| `worker/test/lifecycle.test.ts` | 13 | 單元（AC-1 / AC-3，含併發 release）|
| `worker/test/harness-persistence.test.ts` | 10 | 單元 + 整合（AC-2 / AC-4 / AC-6）|
| `worker/test/meeting-do.test.ts` | 15 | 單元（DO HTTP 入口 / 參數驗證 / 錯誤映射 / `/release`）|
| `worker/test/meeting-harness.test.ts` | 5 | 單元（模型解析 / 目錄驗證 / 壓縮政策）|
| `worker/test/segmentation.test.ts` | 17 | 既有基線（M01-US-109，未觸及，證明無回歸）|
| **合計** | **72** | 全綠（TECH-004 自身 55；M01-US-109 基線 17）|

### Gate 3 補強：真 workerd Durable Object 冒煙

單元測試證不了平台行為（DO 回收、alarm 真的醒來、一會議一 DO 實例），故另跑真 workerd：

```text
$ cd worker && npx --yes wrangler@4 dev --port 8787 --local --var HARNESS_PROVIDER:faux &
$ npm run smoke:do
DO smoke：base=http://127.0.0.1:8787
--- 0. Worker 活著 ---
✅ GET / 回服務說明
--- 1. 懶初始化 + 單例 ---
✅ 第一次 /health 成功 — conversationId=1
✅ 第一次才開 harness（opens=1） — opens=1
✅ 第二次沒有重開（單例） — opens=1
✅ 同一場會議的 conversationId 不變
✅ 模型與 D15 預設一致 — {"provider":"faux","modelId":"faux-1"}
--- 2. 一個會議 = 一個 DO 實例 ---
✅ 另一場會議對到不同的 DO 實例 — 3cfc4d28…f226dc2 vs ffb9228e…531d76e
✅ 另一場會議各自獨立開 harness（兩邊 opens 都是 1） — opens=1
--- 3. 真的跑一個 turn（faux 模型）---
✅ faux 腳本已設定（測試支援端點） — {"scripted":1}
✅ submit 回 done — {"status":"done","conversationId":1,"entries":2}
✅ entries 增加 — 0 → 2
--- 4. alarm 接力 ---
✅ 缺 ?ms 時明確報錯（不退化成 0）
✅ wake 設定了 alarm — {"scheduled":true,"at":1791421309980,"previous":null}
✅ alarm 時間 = 現在 + 1500ms（query 參數真的有送到 DO） — at-now=1497ms
✅ 更晚的 wake 不動既有 alarm（只往前） — {"scheduled":false,"at":1791421368485,"previous":1791421309980}
✅ alarm 真的醒來（alarmWakes ≥ 1） — alarmWakes=1
✅ alarm 醒來後 harness 重建（opens ≥ 2） — opens=2
✅ 重建後 conversationId 不變
✅ 重建後 entries 不變少（同一份 storage 讀回） — 2 → 2
--- 5. 缺憑證時回 AUTH_INVALID（唯一可阻斷）---
（跳過：本輪以 HARNESS_PROVIDER=faux 啟動；AUTH_INVALID 由單元測試覆蓋）

DO smoke：全部通過 ✅
```

> **這是 Gate 4 修正後重跑的那一次**（先 `rm -rf worker/.wrangler/state` 重置）。
> **逐字性說明**：除了兩處 64 字元 `doId` 雜湊用 `3cfc4d28…f226dc2` 縮寫（可讀性），
> 其餘逐字貼回。
>
> **注意：** 冒煙的 `entries` 數字（本輪 `0 → 2`）**每次跑都不同**——`wrangler dev --local`
> 會把 DO 狀態持久化在 `worker/.wrangler/state`，同一場會議名重跑就會累積。
> 斷言只看「有增加 / 沒變少」，不看具體數字，所以重跑仍會綠。
> 若要重現「從 0 開始」的數字，先 `rm -rf worker/.wrangler/state`。

### Gate 4（reviewer）

依 gates.json 規範，Gate 4 (reviewer) 需要：`dev-checker-loop` 的 checker subagent 回傳
「沒找到更多問題」+ playwright-cli E2E 綠。**本票為純後端 / CLI / 腳本任務，無 UI，故
playwright-cli 不適用**（依 gate-4 notes：可跳過，但要明示理由）。

**第一輪（2026-10-08，獨立 subagent、read-only、fresh context）**：
verdict **0 P0 / 2 P1 / 9 P2**——即「有找到更多問題」，故本票當時**不得進入 §2.4 反省**，
已依 `fail_action` 交用戶裁決。用戶選擇「修 P1×2 + 靜默失敗族×3」。

**修正（2026-10-08 本輪）**：P1×2 + P2-1/P2-2/P2-3（靜默失敗族）+ P2-4（dead code）+ P2-6（cursor 靜默回空）
全部修掉，每項都先寫紅燈測試。完整清單與測試對應見 `docs/ac/TECH-004.md` 的「§追加驗收」。

| 第一輪發現 | 等級 | 處置 |
| --- | --- | --- |
| P1-1 交易 `await` 期間無關操作插隊（違反官方契約第 2 條）| P1 | ✅ 改移植官方 `SerialOperationQueue` |
| P1-2 `release()` 關掉正在交付中的 harness；`#opening` 洩漏 | P1 | ✅ 改 `ReleaseDecision`（延後不關）+ 清 `#opening` |
| P2-1 `/wake?ms=` 空字串 → 立即 alarm | P2→P1（jev 建議）| ✅ 400 `MS_REQUIRED` |
| P2-2 未知 `HARNESS_PROVIDER` 靜默改用 Cloudflare | P2→P1（jev 建議）| ✅ 白名單 + `PROVIDER_UNKNOWN` |
| P2-3 打錯的模型 id 靜默用 24k 窗口 | P2→P1（jev 建議）| ✅ 先驗目錄 + `MODEL_UNAVAILABLE` |
| P2-4 dead code（`MAX_ALARM_DELAY_MS` 等）| P2 | ✅ 真的套上限 / 刪除 |
| P2-5 冒煙 alarm 斷言偏鬆 | P2 | ⏸️ 已知（真 alarm 次數取決於平台，寫死會 flaky）|
| P2-6 `rows()` 未知 cursor 靜默回 `[]` | P2 | ✅ 改丟錯 |
| P2-7 AC 文件數字不精確 | P2 | ✅ 改逐 AC 對帳 |
| P2-8 `wrangler` 未 pin 版本 | P2 | ⏸️ 已知（建議另開小票）|
| P2-9 AC-6 未驗「壓縮真的發生」 | P2 | ⏸️ 已知（屬 M02-US-219 範圍）|

**第二輪（2026-10-08，同一 checker 契約、read-only、fresh context）**：
verdict **0 P0 / 0 P1 / 4 P2（本輪新發現）**；Task A 複驗：第一輪 11 條中 7 已修、1 部分修（P2-7）、
3 條照已知不收。**4 條新發現全部已修**（程式 3 條先紅後綠，文件 1 條）：

| 第二輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| NEW-P2-1 handle 失效時機比官方晚一個 commit 窗口（`scope.active = false` 位置錯）| P2 | ✅ 移進回呼 settle 後、平台 `COMMIT` 前（鏡射官方 `node.js` 順序）+ 紅燈測試 |
| NEW-P2-2 `/wake?ms=0`／`0.5`／`0x1f` 仍可立即 alarm（忙迴圈家族沒補完）| P2 | ✅ 只收十進位整數字串；`ms=0` 依用戶裁決保留為明確語意並鎖測試 |
| NEW-P2-3 AC 文件表頭 `do-sqlite.test.ts`（10）與對帳表（11）自相矛盾（R1-8 只部分修）| P2 | ✅ 表頭改 12 + 逐 AC 對帳重算（TECH-004 自身 54、總 71）|
| NEW-P2-4 `/release`（R1-2 的使用者介面）零測試 | P2 | ✅ 補 2 項（fresh／撞上在飛的 open）|

> **Gate 4 已通過（2026-10-08 用戶裁決）**：第七輪 verdict 0 P0 / 0 P1 / 3 P2（全為文件同步；程式面從第二輪起已無新缺陷），
> 依用戶封頂規則停止 loop；用戶選擇「接受 Gate 4 通過 → 進入 §2.4 反省」。
> （歷程：第五輪仍是「有找到更多問題」（2 P2，全為文件引用/一致性），
> 故已修正並跑**第七輪**；第七輪 3 條已修，**2026-10-08 經用戶裁決接受 Gate 4 通過**（不再跑第八輪）。
> ⚠️ 誠實註記：七輪皆未出現 checker「沒找到更多問題」字樣；通過是**用戶在知情下的裁決**（見 gate-4 `remediation: ask_user`），不是自動通過。
> ⚠️ 第三輪的結語曾寫「沒找到更多問題」但同時列了 2 條 P2，**該輪不採計為通過**。

#### 第二輪 checker 原文（逐字貼回，未節錄）

````text
delegate:
# 第二輪 adversarial checker 稽核報告 — TECH-004（DO 內 Harness 生命週期封裝）

**稽核身分**：`dev-checker-loop` 第二輪、獨立 subagent、read-only（未改 repo 任何檔案；所有 probe 都在 `/tmp/`）。
**稽核對象**：`worker/src/{storage/do-sqlite.ts,harness/lifecycle.ts,harness/meeting-harness.ts,meeting-do.ts,index.ts}`、`docs/ac/TECH-004.md`。
**基準 commit**：`42f7466`（第一輪修正已提交；工作樹乾淨）；舊版比對用 `800063d`。

> 註：稽核期間 parent 將修正從工作樹提交為 `42f7466`（其後 `844f247` 只動 `docs/backlog.md`）。所以「舊版」必須用 `800063d`，不能用 `HEAD`。下文重現皆以 `800063d` 為準。

## Verdict

**0 P0 / 0 P1 / 4 P2（本輪新發現）**
Task A：11 條第一輪發現中 **7 條已修**、**1 條部分修（P2-7）**、**3 條照已知不收（P2-5/P2-8/P2-9）**。

---

## Task B — 本輪修正自身引入的新缺陷

### NEW-P2-1（P2）交易 handle 的失效時機比官方契約晚一個 commit 窗口

- **檔案**：`worker/src/storage/do-sqlite.ts:247-248`（`} finally { scope.active = false; ... }`）
- **對照官方**：`worker/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js:117`（`scope.active = false` 在 `COMMIT` **之前**）、`:122`（rollback 前）。官方在 `await callback(...)` settle 後**立刻**失效 handle；本專案是在平台 `storage.transaction` 整個 promise resolve 後（即 COMMIT 之後）才失效。
- **重現指令**：
  ```bash
  cd worker && node_modules/.bin/vite-node /tmp/probe-handle-window.ts
  ```
- **實際輸出**：
  ```
  [handle-window] handle used after callback resolved, before commit => EXECUTED-WITHOUT-ERROR
  [handle-window] final order= ["begin","sql:IN_TX","callback-resolved","sql:AFTER_CALLBACK_BEFORE_COMMIT","commit"]
  ```
  （另一支 probe `/tmp/probe-queue.ts` 的 P8 顯示「交易已結束後」的 handle 會 reject，非 sync-throw，這點與官方一致：`syncThrew= false isPromise= true`。）
- **建議修法**：把 `scope.active = false` 移進平台回呼內、`await callback(handle)` 之後（成功）與 `catch`（失敗）各一次，鏡射官方順序；外層 `finally` 可保留為保險。
- **影響**：低。這是「回呼結束後失效」契約的實質違反（官方與本專案自己的註解/AC 都這樣寫）。實務上 Harness 不保留 handle，且窗口只有一個 commit，故不升 P1；但若有呼叫端把 handle 存起來，會在 commit 窗口內**靜默執行**而非丟錯。
- **性質**：這是**本輪新引入**的 `scope` 機制（舊版 handle 完全沒有失效檢查）在移植時細節沒對齊官方，不是舊 bug。

### NEW-P2-2（P2）`/wake?ms=0`（及小數、十六進位）仍可立即觸發 alarm

- **檔案**：`worker/src/meeting-do.ts:85-111`（`/wake` 路由；只擋 `null`/空字串/非有限/負數/超大）
- **重現指令**：
  ```bash
  cd worker && node_modules/.bin/vite-node /tmp/probe-do.ts
  ```
- **實際輸出**：
  ```
  [/wake?ms=0] 200 {"scheduled":true,"at":1791421683548,"previous":null} alarms= [1791421683548]
  [/wake?ms=0.5] 200 {"scheduled":true,"at":1791421683548.5,...} alarms= [1791421683548.5]
  [/wake?ms=0x1f] 200 {"scheduled":true,"at":1791421683579,...} alarms= [1791421683579]
  [/wake?ms=Infinity] 400 {"error":"MS_INVALID","value":"Infinity"}
  ```
- **建議修法**：明確決定「顯式 0 是否合法」。若要延續「不得忙迴圈」的意圖，加一個下限（例如 `ms < 1` → 400，或另給 `MS_TOO_SMALL`）並在 AC-3 寫明；小數/十六進位若要精確，用正則先驗整數字串。
- **影響**：低-中。與 P2-1（空字串）是同一族「參數退化造成忙碌 alarm」；`ms=0` 可讓已驗證的呼叫端連續觸發 alarm → harness 反覆 open/close。屬「同一意圖沒補完」而非新機制。**註**：AC-3 現行文字只列「缺漏／空字串／空白／非有限／負數」，0 是刻意放行還是漏想，文件未表態——所以我列為 P2 而非 P0。

### NEW-P2-3（P2）`docs/ac/TECH-004.md` 表頭測試數仍錯（do-sqlite 10 vs 實際 11）→ R1-8 只部分修好

- **檔案**：`docs/ac/TECH-004.md:8`（`do-sqlite.test.ts`（10））；同檔「對帳」表卻寫 `do-sqlite.test.ts` **11 項**。
- **重現指令**：
  ```bash
  cd worker && REGRESSION_OUTPUT=json-only REGRESSION_REPORT_PATH=/tmp/reg-check.json npm run regression
  node -e 'const r=require("/tmp/reg-check.json");const b={};for(const t of r.testResults){const n=t.name.split("/").pop();b[n]=(b[n]||0)+t.assertionResults.length;}console.log(JSON.stringify(b))'
  ```
- **實際輸出**：
  ```
  {"do-sqlite.test.ts":11,"harness-persistence.test.ts":10,"lifecycle.test.ts":13,"meeting-do.test.ts":10,"meeting-harness.test.ts":5,"segmentation.test.ts":17}
  total 66 passed 66 failed 0
  ```
  表頭合計 10+13+10+5+10=48（+segmentation 17 = **65**），與同檔綠燈寫的 **66** 自相矛盾；對帳表才是對的。
- **建議修法**：把表頭 `（10）` 改成 `（11）`；順帶把同段的「R1-3 `meeting-do.test.ts` ×2」對齊實際 3 項（缺 ms／空字串／只有空白）。
- **影響**：低（純文件），但這是 R1-8 指名的**同一類錯誤在同一次修正裡復發**，且 R1-8 被標記為「✅ 改逐 AC 對帳」。因此 R1-8 應改為「部分修」。

### NEW-P2-4（P2）`/release` 這條 R1-2 的使用者介面完全沒有測試鎖住

- **檔案**：`worker/src/meeting-do.ts:112-116`（`/release` 回 `{...decision, ...this.stats}`，含 `deferredReleases`）
- **重現指令**：
  ```bash
  cd worker && grep -c "release" test/meeting-do.test.ts scripts/do-smoke.mjs
  ```
- **實際輸出**：`test/meeting-do.test.ts` → `0`；`scripts/do-smoke.mjs` → `0`（`meeting-do.ts` 內有 1 個 `/release` 路由）。`meeting-do.test.ts` 的 10 個 `it()` 標題裡沒有任何一個碰 `/release`。
- **佐證可運作**：`/tmp/probe-do.ts` 顯示 `[/release fresh] 200 {"released":false,"deferred":false,...,"deferredReleases":0,...}` —— 回應形狀正確，只是**沒有測試**。
- **建議修法**：加 1-2 個 DO 層測試：① fresh `/release` 回 `{released:false,deferred:false}`；② mock `open` 在飛時 `/release` 回 `{released:false,deferred:true,deferredReleases:1}`（或至少對 `lifecycle` 以外的 stats 傳遞做斷言）。AC-1/對帳寫「`/release` 照實回報」，目前無紅燈測試。
- **影響**：低（測試覆蓋缺口）。R1-2 的修正邏輯本身有 `lifecycle.test.ts` 覆蓋（見 Task A），缺的是 DO 轉接層。

---

## Task A — 第一輪 11 項逐條複驗

| 第一輪 | 等級 | 複驗結論 | 證據（指令／輸出） |
| --- | --- | --- | --- |
| P1-1 交易 `await` 期間無關操作插隊 | P1 | ✅ **已修** | 舊版重現成功：`vite-node /tmp/oldcheck/repro-old.ts` → `A order: [... "sql:UNRELATED_OUTSIDE","outside-done","tx:end" ...]`、`unrelated ran INSIDE transaction: true`。新版：`/tmp/probe-queue.ts` → `[P5] unrelated ran INSIDE tx: false`；order 為 `...tx:end, commit, sql:UNRELATED_OUTSIDE`。`SerialOperationQueue` 移植與官方 pending/barrier/tail-rejection 等價。 |
| P1-2 `release()` 關掉交付中的 harness／`#opening` 洩漏 | P1 | ✅ **已修** | 舊版重現：`repro-old.ts` → `B caller got an already-closed harness: true`、`closed: [1]`。新版：`/tmp/probe-lifecycle.ts` → `[deferred] first release: {"released":false,"deferred":true}`、`closes=[]`、交付的 harness 未被關；`lifecycle.test.ts` 併發 release 測試綠。 |
| P2-1 `/wake?ms=` 空字串 → 0 | P2→P1 | ✅ **已修** | `meeting-do.ts:88` 以 `raw.trim()===""` 擋掉；`test/meeting-do.test.ts:66,74` 空字串／空白兩案綠。 |
| P2-2 未知 `HARNESS_PROVIDER` 靜默用 Cloudflare | P2→P1 | ✅ **已修** | `/tmp/probe-harness.ts` → `provider="" => UnknownProviderError code=PROVIDER_UNKNOWN`、`provider=" "` 同；`provider=undefined => MissingCredentialError AUTH_INVALID`。 |
| P2-3 打錯模型 id 靜默用 24k 窗口 | P2→P1 | ✅ **已修（cf provider）** | `/tmp/probe-harness.ts` → `options.model missing => ModelUnavailableError MODEL_UNAVAILABLE`、`other-provider => MODEL_UNAVAILABLE`。**但** faux catalog 對任何 id 都給 `contextWindow:128000`（連 typo 都放行），故 faux 啟動下此檢查被繞過（見下方已知殘留）。 |
| P2-4 dead code | P2 | ✅ **已修** | `MAX_ALARM_DELAY_MS` 在 `meeting-do.ts:103` 真的套用（`MS_TOO_LARGE`）；`DEFAULT_ALARM_DELAY_MS` 用於範例字串；`currentConversationId` 已不在 `meeting-harness.ts`。 |
| P2-5 冒煙 alarm 斷言用 `>=` | P2 | ⏸️ **維持不收（理由成立）** | `do-smoke.mjs` 確實仍有 `>=` 形式；理由「真 alarm 次數受平台排程影響，寫死會 flaky」我複核成立，且另有 `at-now=1497ms` 嚴格斷言。 |
| P2-6 `rows()` 未知 cursor 靜默回 `[]` | P2 | ✅ **已修** | `do-sqlite.ts` `rows()` 對未知形狀改丟錯；`do-sqlite.test.ts` 有 1 個紅→綠測試；`do-sqlite.test.ts` 共 11 項。 |
| P2-7 AC 文件數字不精確 | P2 | ⚠️ **部分修** | 對帳表已改逐 AC 且總數 49 正確，但**表頭 `do-sqlite.test.ts`（10）未同步**（實際 11），與自身對帳表矛盾（見 NEW-P2-3）。R1-8 應降為「部分修」。 |
| P2-8 `wrangler` 未 pin | P2 | ⏸️ **維持不收（理由為範圍判定）** | 專案刻意不在 devDependencies 放 wrangler；理由「另開小票」屬 scope 決定，非事實錯誤，我接受。 |
| P2-9 AC-6 未驗「壓縮真的發生」 | P2 | ⏸️ **維持不收（理由成立）** | `harness-persistence.test.ts` 只驗政策推導/覆寫；實際壓縮行為確實屬 M02-US-219 範圍，理由成立。 |

**Task A 額外波及其他「第一輪已修」的重跑**（green 現況）：`npx vitest run` → **66 passed / 6 files**；`npm run regression` → **passed=66 failed=0**；`npm run lint` → **0 issues / 45 files**；`npx tsc --noEmit` → **exit 0**。

---

## 已知殘留（本輪不計為新 P2；文件已自承）

1. `PROVIDER_UNKNOWN` 未進 `system-design.md` §5.2 / `DESIGN.md` §5.1（deliverable「已知問題 8」明載）。
2. `recoverable:true` 但 HTTP 500 的語意落差（deliverable「已知問題 9」明載，無整合測試）。
3. `FALLBACK_CONTEXT_WINDOW` 在現行 catalog 下實質不可達（`/tmp/probe-harness.ts` 顯示 cf 目錄 18 個模型都有 `contextWindow`，例 `@cf/ibm-granite/granite-4.0-h-micro`=131000、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`=24000）；AC-6 措辭像活路徑，實際是死路徑。
4. faux catalog 對任意 id 給 128000（`custom-x => contextWindow:128000`），使 faux 啟動下的 `MODEL_UNAVAILABLE` 形同虛設——這是測試支援設計，但會讓人誤以為冒煙驗過模型驗證。

---

## 沒驗到 / 無法驗證（誠實列舉）

- **紅燈歷史輸出** `16 failed | 49 passed (65)`：要重現必須回退整組修正，且當時 test set 與現在不同，**無法重現**；只能說數字與「do-sqlite=10 時代」自洽，不等於屬實。
- **TDD「先紅後綠」的時序**：從最終樹無法驗證；只能確認測試存在且鎖住行為。
- **真 workerd 冒煙 19 項**：未跑 `wrangler dev`（依 steering 明確不要起 dev server，且會寫入 `worker/.wrangler/state`，違反 read-only）。僅以 `grep -c` 確認 `do-smoke.mjs` 有 19 個 `check(`，與文件「19 項」一致；未驗平台行為。
- **deliverable 的「Gate 4 第二輪」段落是否含 checker 原文**：稽核當下該段是 `進行中` 佔位（`docs/deliverable/2026-10-08-TECH-004-...md:191`），所以 `docs/ac/TECH-004.md:188-189` 的指向是「前瞻」而非已存在的第二輪原文。
- **實際 Workers AI catalog 與 `pi-ai` 打包 catalog 是否逐位元一致**：我用的是 `pi-ai` 本地目錄，未對雲端 catalog 驗證。
- **`/release` 在「open 在飛」情境下的 DO 層回應**：無法用真 DO 插隊重現（open 太快），僅用 lifecycle 層 probe + 程式碼閱讀佐證；這也是 NEW-P2-4 建議補測的原因。

---

## 所有執行過的指令與結果

| # | 指令（於 `worker/`） | 結果 |
| --- | --- | --- |
| 1 | `npx vitest run` | 66 passed / 6 files（do-sqlite 11、lifecycle 13、meeting-do 10、meeting-harness 5、harness-persistence 10、segmentation 17） |
| 2 | `npx tsc --noEmit` | exit 0 |
| 3 | `npm run lint` | exit 0；markdownlint 0 issues in 45 files |
| 4 | `REGRESSION_REPORT_PATH=/tmp/reg-check.json REGRESSION_OUTPUT=json-only npm run regression` | passed=66 failed=0，exit 0 |
| 5 | `vite-node /tmp/oldcheck/repro-old.ts`（800063d 舊碼） | P1-1 `unrelated ran INSIDE transaction: true`；P1-2 `already-closed harness: true` |
| 6 | `vite-node /tmp/probe-queue.ts` | nested-tx 無死鎖；close-vs-tx 無死鎖；P4 不毒化；P5 unrelated 在 commit 後；P6 BEGIN 失敗非 AggregateError；P7 AggregateError `['callback failed','rollback threw']`；P8 reject 非 sync-throw；P9 無 pending 洩漏 |
| 7 | `vite-node /tmp/probe-handle-window.ts` | `handle used after callback resolved, before commit => EXECUTED-WITHOUT-ERROR` |
| 8 | `vite-node /tmp/probe-harness.ts` | provider ""/" "→PROVIDER_UNKNOWN；faux→faux-1；undefined→AUTH_INVALID；missing model→MODEL_UNAVAILABLE；cf 目錄全有 contextWindow；政策 24000/128000 正確 |
| 9 | `vite-node /tmp/probe-order.ts` | 佇列順序正確，`X after T2:end: true` |
| 10 | `vite-node /tmp/probe-do.ts` | `/wake?ms=0` 200；`0.5` 200；`0x1f` 200；`Infinity` 400；`/release fresh` 200；faux typo 被接受 |
| 11 | `vite-node /tmp/probe-lifecycle.ts` | deferred release 無後續 release → 永不關（isOpen true）；open 失敗仍 +1 deferredReleases；close 中 current() 建新 harness |
| 12 | `vite-node /tmp/probe-reject-queue.ts` | 交易失敗時交易期間排入的 op 仍會執行（`queued op ran: true`） |
| 13 | `git show 800063d:...` / `git diff 800063d 42f7466 --stat` | 確認舊碼與本輪 diff 範圍 |
| 14 | `node -e` 解析 `/tmp/reg-check.json` | 每檔測試數（見 NEW-P2-3） |
| 15 | `grep -n`（meeting-do.ts、test、smoke、TECH-004.md） | 行號與覆蓋率佐證 |

---

## 結論

本輪修正**沒有引入 P0/P1**：P1-1（交易排隊）與 P1-2（release 競態）經「舊碼重現 → 新碼驗證」確認真的修好，佇列移植與官方 `SerialOperationQueue` 語意等價，AggregateError 順序正確，錯誤注入路徑（BEGIN 失敗、rollback 失敗）行為正確，交易失敗不會丟掉已排入的操作。

但有 **4 個 P2**：handle 失效時機比官方晚一個 commit 窗口（契約細節未對齊）、`ms=0` 仍可立即 alarm（忙迴圈家族沒補完）、AC 文件表頭數字復發錯誤（R1-8 只部分修）、`/release` 的使用者介面零測試。另有 4 項文件已自承的殘留（§5.2 表缺 `PROVIDER_UNKNOWN`、recoverable/500 落差、FALLBACK 死路徑、faux 繞過模型驗證）。
````

**第三輪補完（2026-10-08，verdict 0 P0 / 0 P1 / 2 P2）**：

| 第三輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| NEW-3-1 `/wake?ms=+5`（未編碼）被當成 5ms——格式檢查先 `trim`，而 query 的 `+` 就是空白；且測試用 `encodeURIComponent` 測不到 | P2 | ✅ 格式檢查改看**原字串**（不 trim）＋補未編碼 raw query 測試 |
| NEW-3-2 deliverable 同檔「12 個／13 個陷阱」自相矛盾、宣稱「皆寫進 AC 文件」為假、變更清單測試數仍舊值（第二輪 NEW-P2-3 同族，本票內**反覆復發**；清單見「已知問題 5」的 ①–⑪）| P2 | ✅ 兩張表同步為 **14 條**；變更清單改現值（12／13／15／5／10）|

> ⚠️ **verdict 矛盾處理**：第三輪 checker 同時給了「2 P2」與結語「沒找到更多問題」。
> 我不把它當作「乾淨通過」，而是**修完 2 條再跑第四輪**——避免用一句制式結語掩蓋已列在報告裡的發現。

#### 第四輪新發現與處置（verdict 0 P0 / 0 P1 / 3 P2）

| 第四輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| NEW-4-1 AC 文件**前置表頭** `meeting-do.test.ts`（14）未同步（實際 15；第三輪加了一條測試卻漏改前置清單）| P2 | ✅ 前置表頭改 15 |
| NEW-4-2 AC 與 deliverable 兩張陷阱表 **#13/#14 編號對調**（卻宣稱「同步」）| P2 | ✅ 統一同一序（#13 `--var`／#14 `+5`）|
| NEW-4-3 同一 commit 內「第三次復發」與「四度復發」自相矛盾 | P2 | ✅ **不再寫序數**：敘述改為指向「已知問題 5」的 **①–⑪ 十一處清單**，以後復發只需改一處 |

> **A-1 複驗**：第三輪 R4-1（`/wake?ms=+5`）確認**真的修好**：21/21 probe 綠——
> `+5`／`%2B5`／`%201500`／tab／全形／nbspan → 400；`%20%20`／`%09` → `MS_REQUIRED`；
> `0`／`0001500`／`=MAX` → 200；20 位數與 `9007199254740993` → 400，**無 500/NaN**，且**沒有修過頭**。
> **A-2 複驗**：R4-2 **只部分修**（陷阱表、變更清單已同步；前置表頭漏改）→ 即 NEW-4-1。

#### 第五輪新發現與處置（verdict 0 P0 / 0 P1 / 2 P2）

> ⚠️ 本節與下方第五輪引用段中的**行號皆為 `b5c2a85` 時的行號**（本輪編輯後已位移）。

| 第五輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| NEW-5-1 處置欄以引號呈現「新文字」，但該字串在敘述裡不存在（引文不實；同族一員）| P2 | ✅ 兩處處置欄不再用引號冒充引文（改為描述）；敘述補上具體指向「已知問題 5 的 ①–⑪」 |
| NEW-5-2 同一份第四輪原文的〔沒驗到〕條數 AC 5 條 vs deliverable 6 條（少 1 條、且未標省略）| P2 | ✅ AC 補回缺少的那條（現為 6 條）並註明「與原文 6 條一致、無省略」 |

> **A 複驗**：R5-1（前置表頭 15）✓、R5-2（兩表 #13/#14 同序）✓、R5-3（零序數）✓；
> `git diff ee38c94 b5c2a85 -- worker/` = **0 bytes**（程式碼零變動）。
> checker 另指出**我在第五輪指令裡的前提有誤**（我寫「第四輪報告有 8 條沒驗到」，canonical 報告實際是 **6 條**）——已採納。

#### 第六輪新發現與處置（verdict 0 P0 / 0 P1 / 3 P2）

> ⚠️ 本節與下方第六輪引用段中的**行號皆為 `2acd96b` 時的行號**（本輪編輯後已位移）。

| 第六輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| NEW-6-1 同一份 deliverable 對「含幾輪 checker 原文」自相矛盾（`:46` 五輪 / `:762` 兩輪；當時 `#### 第N輪` 區塊 4 個）| P2 | ✅ 兩處統一（修此條時為「含**第二～五輪**」；本輪新增第六輪引用段後同步為「含**第二～六輪**」，即 **5 個**區塊；其後第七輪再新增第七輪引用段 → **6 個**）|
| NEW-6-2 同一段第五輪原文跨檔逐字不一致（AC「程**試**面」vs 本檔「程**式**面」）| P2 | ✅ 統一「程式面」（錯字孤例） |
| NEW-6-3 本檔變更清單**漏列 `docs/trust-log.md`**（`800063d` 含此檔 +34 行）| P2 | ✅ 補一列（修改 / trust mode 收尾紀錄） |

> **A 複驗**：NEW-5-1（引文不實）、NEW-5-2（條數跨檔不一致）、`2acd96b` 自我一致性——**三條全數確認已修**；
> `git diff b5c2a85 2acd96b -- worker/` = **0 bytes**（仍為純文件）。
> checker 又指出**我任務描述的前提錯誤**（我寫「本票共跨 5 個 commit」卻列了 7 個 hash；實際相關 commit 為 **8 個**）
> ——**連續第二輪抓到我的輸入前提有誤**，已採納。

**第七輪**：進行中（同一 checker 契約）。第七輪原文一樣**只貼在此處**，不以口頭摘要代替。

> **用戶已裁決**（第六輪 verdict 後）：修完這 3 條再跑第七輪；**若第七輪仍只出同族文件 P2（≤3 條），即停止 loop**，
> 將六～七輪 verdict 併同交付物交用戶裁決 Gate 4 是否接受（避免無限循環）。

#### 第三輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

````text
[Verdict] 0 P0 / 0 P1 / 2 P2（本輪新發現）
Task A：第二輪 4 條新發現全部確實修好（僅 A-2 有 1 個表單編碼破口，列為新 P2），
所有新測試經「對 800063d / 42f7466 舊碼重跑」證明真會紅。

[A-1] scope.active = false 確實在「回呼 settle 後、平台 COMMIT 前」，順序與官方 node.js:117/:122 一致。
  [P1 success] commit-window=THREW order=["begin","callback-settled","REJECTED","commit"]
  [P4 commit-fail] rejected=platform COMMIT failed handle-after=inactive
  [P5 rollback-fail] isAggregate=true order=["callback failed","rollback failed"]
  [P6 nested-tx] race=[null,"nested-done"] order=["begin","sql:NESTED","commit","begin","sql:OUTER","commit"]

[A-2] 0.5／0x1f／1e3／" 1500x"／-0／Infinity／NaN／1e309／20 位數／9007199254740992／١٢٣
  → 全部 400 MS_INVALID；0／0001500／" 1500" → 200；沒有任何 500 / NaN 路徑。
  但 +5（未編碼）→ 200（見 NEW-3-1）；%2B5 → 400。
  AC-3 當時文字仍只列「缺漏／空字串／空白／非有限／負數」，未明文寫出「0 是刻意放行」。

[A-3] 表頭（12／14）與逐 AC 對帳（9+5+14+2+1+11+12 = 54）與實際 it( 數完全對得上；
  舊數字只出現在「歷史紅綠燈／第二輪原文引用」內（合理保留）；backlog 的 54 單元 + 19 冒煙 正確。
  但 deliverable 的變更清單（非引用段）仍留舊數，且同一份文件「12 個／13 個陷阱」自相矛盾。

[A-4] 真紅測試：/tmp/oldworker（800063d）→ Tests 14 failed | 12 passed (26)；
  （42f7466）→ Tests 2 failed | 24 passed (26)。
  「探針打到真 MeetingDurableObject，deferred 分支由 current() 同步設 #opening 觸發，非時間相關 flake」。

[NEW-3-1 P2] /wake?ms=+5（未編碼）被當成 5ms 接受——「只收十進位整數字串」有 URL 編碼破口
  檔案：worker/src/meeting-do.ts:101-105（raw.trim() 先於 /^\d+$/）；
  測試 worker/test/meeting-do.test.ts:150-152 用 encodeURIComponent(raw) 把 + 編成 %2B，測不到原始 URL 的 +。
  實際輸出：
    [/wake?ms=+5] 200 {"scheduled":true,"at":1791424711921,"previous":null} alarms=[1791424711921]
    [/wake?ms=%2B5] 400 {"error":"MS_INVALID","value":"+5"} alarms=[]
  影響：低—中。呼叫端打 /wake?ms=+5 會得到 5ms 的近似立即 alarm；且測試宣稱 +5 → 400
  只在 percent-encoded 形式成立，形成「測試假通過」的同族盲點。
  建議修法：(a) 明說前後空白被容忍；或 (b) 不再 trim、要求整個原字串精確符合 ^[0-9]+$。
  無論哪個，測試都應加「未編碼 raw query」一案。→ 本專案採 (b)（fail-loud）。

[NEW-3-2 P2] 文件數字/敘述與現實不符（第二輪 NEW-P2-3 的同族第三次復發）
  檔案：deliverable:41-43, 379、docs/ac/TECH-004.md:99-110
  deliverable:43  ... 6 條 BDD AC + 介面契約 + 12 個實測陷阱（含第二輪）
  deliverable:379 ## 本輪實測抓到的 13 個陷阱（已修，皆寫進 AC 文件）
  AC 文件陷阱表實際只有 10 列（#1–#10）
  不一致點：①同一份文件「12 個/13 個」；②「皆寫進 AC 文件」為假（#11/#12/#13 當時不在 AC 表）；
  ③變更清單仍寫 do-sqlite.test.ts 6 項（實際 12）、lifecycle.test.ts 12 項（實際 13）。
  已知問題欄位 1–9 項與內容一致（無誤）。

[沒驗到 / 無法驗證]
  - 真 workerd 平台行為未驗（依只讀紀律未起 dev server）：19 項冒煙未執行，
    僅以 grep -c '^check(' = 19 證實數量與文件相符。
  - 歷史紅燈 16 failed | 49 passed (65) 無法重現（test set 已不同）——未驗。
  - /wake 的 MS_REQUIRED/MS_INVALID/MS_TOO_LARGE 不在 §5.2 十碼表，
    但 /wake 是 DO 維運端點、非裝置 WS 協定，不計為新 P2。
  - 已知殘留復核：與文件描述一致，未發現比文件更嚴重。
  - /wake?ms=0 忙迴圈：刻意保留，未驗「呼叫端連續打 0 是否真的造成 open/close 風暴」。

[指令表]
  1. cd worker && npx vitest run → 6 files / 71 passed（第三輪修正前）
  2. vite-node /tmp/probe-handle-window3.ts → 如上 [A-1]
  3. vite-node /tmp/probe-handle-window3b.ts → 同步/await throw 時 handle 皆 inactive；巢狀 tx 排隊無死鎖
  4. vite-node /tmp/probe-do3.ts → ms 族如 [A-2]；+5 未編碼 → 200；/release fresh → {released:false,deferred:false}
  5. node -e URLSearchParams → ?ms=+5 → " 5"；?ms=%2B5 → "+5"
  6. /tmp/oldworker（800063d）跑新測試 → 14 failed / 12 passed
  7. /tmp/oldworker（42f7466）跑新測試 → 2 failed / 24 passed
  8. grep -c '^check(' scripts/do-smoke.mjs → 19
  9. grep -n（AC / deliverable / backlog / §5.2）→ 數字對帳如 [A-3] / NEW-3-2
 10. git status --short → 空（未動 repo；暫存只在 /tmp/）

[最後一行] 沒找到更多問題。
  → 注：同一份報告列了 2 條 P2，與此結語矛盾，故本專案不視為通過（已修完再跑第四輪）。
````

#### 第四輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

````text
Verdict：0 P0 / 0 P1 / 3 P2
（本輪只讀；所有暫存物在 /tmp，repo 未動。git status --short 乾淨。）

[A-1] R4-1（/wake?ms=+5）→ 已修好（satisfied）
  程式現況（worker/src/meeting-do.ts:88-108）：空值判斷 raw === null || raw.trim() === ""，
  格式判斷 /^\d+$/.test(raw)（看原字串、不 trim），Number(raw) + Number.isSafeInteger。
  實測（/tmp/tfcheck 複本，直接打真 MeetingDurableObject.fetch，raw query 用真 URL）：
    ?ms=+5（未編碼）            400 {"error":"MS_INVALID","value":" 5"}
    ?ms=%2B5                     400 {"error":"MS_INVALID","value":"+5"}
    ?ms=%201500                  400 {"error":"MS_INVALID","value":" 1500"}
    ?ms=%20%20（只有空白）        400 {"error":"MS_REQUIRED",...,"example":"/wake?ms=60000"}
    ?ms=+（+→空白）              400 MS_REQUIRED（合理）
    ?ms=%09%091500（tab）         400 MS_INVALID
    ?ms=%09／%C2%A0（只有空白）    400 MS_REQUIRED
    ?ms=0001500                  200 {"scheduled":true,...}
    ?ms=0                        200（刻意）
    ?ms=1500                     200（冒煙等價路徑）
    ?ms=300000（=MAX）            200；?ms=0300000（前導零＝MAX） 200
    ?ms=300001／0300001          400 {"error":"MS_TOO_LARGE","value":"300001","max":300000}
    ?ms=99999999999999999999     400 MS_INVALID（無 500/NaN）
    ?ms=9007199254740993         400 MS_INVALID（無 500/NaN）
    ?ms=9007199254740991         400 MS_TOO_LARGE
    全形１５００、%C2%A01500、en-space → 400 MS_INVALID
  21/21 probe 斷言綠。?ms=1500 冒煙等價路徑仍 200（真 workerd 未起 server，見「沒驗到」）。
  沒有修過頭；無 500/NaN 路徑。

[A-2] R4-2（文件數字/敘述）→ 部分修（not-satisfied，殘留 1 項新 stale 數字）
  AC 陷阱表列數/編號 ✓ 14 列、#1–#14 連續（docs/ac/TECH-004.md:104-118）
  deliverable 陷阱表 ✓ 14 列；變更清單測試數 ✓ 12/13/15/5/10；大標題陷阱數 ✓ 皆 14
  逐 AC 對帳 ✓ 9+5+15+2+1+11+12 = 55；55 = 72 − 17 ✓；backlog:208 ✓「55 單元測試 + 19 項 workerd 冒煙」
  ✗ AC 文件前置「測試」表頭 meeting-do.test.ts（14），實際 15（AC :9）
  ✗ AC/deliverable 兩表 #13/#14 編號對調（AC :117/#13=+5、:118/#14=wrangler；del :486/#13=wrangler、:487/#14=+5）
  舊數字（49/54/66/71 等）僅出現在「歷史紅綠燈／各輪 checker 原文引用」段落，判為合理保留。

[NEW-4-1｜P2] AC 文件前置「測試」表頭 meeting-do.test.ts（14）與現實不符（第三輪新增測試後未同步）
  repro：grep -n 'meeting-do.test.ts' docs/ac/TECH-004.md | head -1；cd worker && npx vitest run
  實際：文件寫（14）；vitest → ✓ test/meeting-do.test.ts (15 tests)；同檔逐 AC 對帳自身也加總為 2+1+9+1+2 = 15。
  根因：第三輪把 meeting-do 由 14 → 15，改到變更清單與對帳式，卻漏改前置表頭。與 R1-8/R3-3/NEW-3-2 同族（同一類缺陷第四次）。
  影響：低（純文件），但這是可被讀者當事實的數字，且 AC 文件自身前後矛盾；正是 R4-2 這條「已修」宣稱沒蓋到的殘留。

[NEW-4-2｜P2] AC 與 deliverable 兩張陷阱表 #13/#14 編號對調，但 deliverable 宣稱「同步」
  AC：#13 = /wake?ms=+5 trim 破口；#14 = wrangler --var
  deliverable：#13 = wrangler --var；#14 = /wake?ms=+5 trim 破口
  影響：低。兩表內容集合相同、各自編號連續，但 #13/#14 跨文件指涉不同陷阱，與「同步寫進 AC 文件陷阱表」的敘述不符；交叉引用會拿到錯的條目。

[NEW-4-3｜P2] deliverable 同一 commit 內對同一類缺陷的次數自相矛盾（「第三次」vs「四度」）
  deliverable :392（同族第三次復發）與 :513（同一類缺陷四度復發）；docs/ac/TECH-004.md:342 亦寫「第三次」
  兩句皆由第三輪 commit ee38c94 同時加入。影響：低（純敘述一致性）。

其他 Task B 檢查（無新缺陷）：
  - raw.trim() === "" 與 /^\d+$/(原字串) 的交界："\t1500"、%09 1500、全形、\u00a01500、en-space + 數字 → 全 400 MS_INVALID；
    純空白/tab/nbsp/+ → MS_REQUIRED。無漏洞、無 500/NaN。錯誤碼二分與註解一致。
  - 新測試真會紅：把 HEAD 的 meeting-do.test.ts 對舊 src 重跑——f8e0c86 → Tests 1 failed | 14 passed (15)
    （紅的正是 ?ms=+5 那條）；800063d → 9 failed | 6 passed (15)。非自我實現（對真實 MeetingDurableObject）。
    無時間依賴（只用 fake storage + 同步斷言），不 flake。
  - 逐 AC bucket 對 it( 數：lifecycle 13 = AC-1 7 + AC-3 6；meeting-do 15 = 2+1+9+1+2；
    harness-persistence 10 = 4+2+4；meeting-harness 5；do-sqlite 12。每 bucket 都對得上。
  - 已知殘留複核後與文件描述一致，未發現比文件更嚴重。

[沒驗到 / 無法驗證]
  - 真 workerd 平台行為：未起 wrangler dev。do-smoke.mjs 的 19 項未執行；
    僅以 grep -c '^check(' = 19 證實數量與文件相符，並用單元等價驗證 ?ms=1500 → 200 scheduled:true。
  - 歷史紅綠燈輸出（如 16 failed | 49 passed (65)）：test set 已不同，無法重現；只能確認現況 72/72。
  - 「第三輪紅燈 1 failed | 14 passed (15)」：用 HEAD 測試對 f8e0c86 src 重跑得同數字，可佐證；
    但無法還原當時確切 test set 時序。
  - 冒煙的「真 alarm 醒來／at-now」平台行為：未驗。
  - Gate 1「先紅後綠」時序：無法從最終樹回溯。
  - 未逐一閱讀 harness-persistence.test.ts／meeting-harness.test.ts 內部以人工歸屬每個 it( 到 AC bucket；
    只驗到逐檔總數與表格 AC 級加總相符（檔內分組未逐條語意核對）。

[指令表]
  git show --stat ee38c94 / git show ee38c94 -- src test → 確認第三輪只動 5 檔
  cd worker && npx vitest run → 72 passed / 6 files（meeting-do 15）
  for f in test/*.test.ts; grep -c '^\s*it(' → 12/13/15/5/10/17
  /tmp/tfcheck probe（21 案，真 URL raw query）→ 21 passed
  /tmp/tfold_f8e0c86 跑 HEAD 測試 → 1 failed | 14 passed (15)
  /tmp/tfold_800063d 跑 HEAD 測試 → 9 failed | 6 passed (15)
  npx tsc --noEmit → exit 0；markdownlint-cli2（45 檔）→ 0 issues；npm run regression → passed=72 failed=0 ✅
  grep -c '^check(' scripts/do-smoke.mjs → 19；git status --short → 乾淨

[結論] R4-1 確實修好；R4-2 只部分修（三者皆同一「文件數字與現實不符」家族）。
  Gate 4 第四輪不建議直接判定通過，建議修完上述文件數字後即可（A-1 已無程序缺陷）。
````

#### 第五輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 2 P2`（本輪新發現；皆文件─現實不一致，低衝擊，**程式面零變動**）。
> 稽核基準 `b5c2a85`；`git diff ee38c94 b5c2a85 -- worker/` = **0 bytes**。
>
> **[A] 第四輪 3 條複驗**：R5-1 **已修 ✓**（AC `:9` = `meeting-do.test.ts（15）`；vitest 15；`grep -c it(` = 15）；
> R5-2 **已修 ✓**（AC `:117` #13=`--var`、`:118` #14=`+5`；deliverable 同序；跨檔引用皆指到正確條目）；
> R5-3 **已修 ✓**（敘述段零序數；序數僅殘留於各輪 checker 原文引用區塊；①–⑥ = **6 項**，與宣稱相符）。
> 補充釐清：交付任務描述的「第四輪報告有 **8 條**沒驗到」為**錯誤前提**——canonical 第四輪報告為 **6 條 bullet**。
>
> **[NEW-5-1｜P2] 第四輪「處置」欄引文與實際寫入文字不符**
> 處置欄宣稱 `改為「反覆復發（清單見已知問題 5，①–⑥）」`，但實際敘述（deliverable `:392`／AC `:344`）
> 為 `（…本票內**反覆復發**；清單見「已知問題 5」）`，引號內 `，①–⑥` **不存在**。
> 影響：低（純敘述引文），但這是本票第五次同族「文件─現實不符」——處置欄以引號呈現「新文字」，讀者核對會拿不到該字串。
> 建議：把兩處處置欄引文改成實際文字，或在敘述後補 `（①–⑥）` 使三者一致。→ 兩者都做了（清單其後由 ①–⑥ 擴為 ①–⑪）。
>
> **[NEW-5-2｜P2] 同一份第四輪 checker 原文的〔沒驗到〕條數，AC 與 deliverable 不一致且未標省略**
> AC `:460-462` = 5 條 vs deliverable `:547-552` = 6 條 vs canonical = 6 條；缺少的是
> 「第三輪紅燈 `1 failed | 14 passed (15)`：用 HEAD 測試對 `f8e0c86` src 重跑得同數字，可佐證；但無法還原當時確切 test set 時序」。
> 標頭 `:434` 宣稱「判定與數字未改」，但 6→5 未以 `…` 標示，與本文件自訂規範（第二輪引用「以 `…` 標示精簡處」）不一致。
> 影響：低（純引用）；讀者可能誤以為 AC 的 5 條即全部。
>
> **[觀察（不列為新 P2）]** `docs/ac/TECH-004.md:327` 狀態句與 `R{k}-n` 編號慣例被放在第二輪區塊內，
> 且慣例定義晚於 R1/R2/R3 的首次使用；屬 pre-existing（`ee38c94` 引入），非事實錯誤，未計入。
> deliverable `:231`「逐字貼回，未節錄」的第二輪引用省去原報告的 `acceptance-report` JSON 區塊並清掉 `td{0}` 汙染字串 → 良性、pre-existing。
>
> **〔沒驗到〕** 真 workerd 平台行為（未起 `wrangler dev`，19 項冒煙**未執行**，僅以 `grep -c '^check('` = 19 佐證數量）；
> 第四輪 21/21 raw-query probe 本輪**未重跑**（只依 canonical 報告 + 靜態閱讀核對）；歷史紅綠燈無法重現；
> 逐 AC bucket 歸屬只驗逐檔總數與 AC 級加總（未逐一人工歸屬每個 `it(`）；冒煙逐 AC 歸屬（4/8/3/2/1/1）只驗總數 19；
> 已知殘留（`PROVIDER_UNKNOWN`／`recoverable:true` 配 500／`FALLBACK_CONTEXT_WINDOW`／faux 128000）非 TECH-004 範圍，未重驗。
>
> **[結論]** Task A 三條全數確認已修；Task B 找到 2 條低衝擊文件─現實不一致，
> **故不寫「沒找到更多問題」**。

#### 第六輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 3 P2`（本輪新發現；皆文件─現實／跨檔一致性，低衝擊；`worker/` 程式碼零變動）。
> 前置硬性確認：`git diff b5c2a85 2acd96b -- worker/` = **0 bytes**（前兩輪確為純文件）。
>
> **[A-1]** NEW-5-1（引文不實）→ **已修 ✓**：`反覆復發` 確實存在（AC:343、本檔:393 等）；
> `①–⑥` 僅出現於第五輪 checker 原文引用段（歷史例外），當前狀態敘述一律 `①–⑧`；已知問題 5 = **8 項**；
> 抽樣「…」引號內 ≥6 字 **12/12 存在**；兩處處置欄已無引號冒充。
>
> **[A-2]** NEW-5-2（第四輪原文〔沒驗到〕條數跨檔不一致）→ **已修 ✓**：
> AC 文件 **6 條**、本檔保留原文 **6 條**，集合一致（僅順序不同）；另附第五輪〔沒驗到〕兩檔亦皆 **6** 條。
>
> **[A-3]** `2acd96b` 宣稱「清單擴為 ①–⑧ 後敘述已同步」→ **宣稱為真 ✓**：
> 7 處當前狀態指涉全部 `①–⑧`，`①–⑥` 零處落在敘述段；已知問題 5 確實 8 項。
>
> **[NEW-6-1｜P2]** 本檔對「含幾輪 checker 原文」自相矛盾：
> `$ grep -nE "^#### 第[一二三四五六]輪 checker 原文" …` → `232:第二輪 426:第三輪 497:第四輪 584:第五輪`（**4 個區塊**）；
> `$ grep -n "含.*輪 checker 原文" …` → `46: 含五輪`（於 `2acd96b` 由「含三輪」改）vs `762: 含兩輪`（`f8e0c86` 引入後從未更新）。
> 影響：低（純敘述），但任一解讀下兩句不可能同時為真。
>
> **[NEW-6-2｜P2]** 同一段第五輪原文的跨檔引用逐字不一致：
> `docs/ac/TECH-004.md:487` 「程**試**面」vs 本檔 `:586` 「程**式**面」（AC 自身敘述段 `:469` 亦作「程式面」，即 `:487` 是孤例）；
> `git show 81aaca2` 顯示兩版在該 commit 同時加入時就已分歧。影響：極低（單字錯字），但與 NEW-5-2 同族。
>
> **[NEW-6-3｜P2]** 變更清單漏列 `docs/trust-log.md`：
> `$ git show --stat 800063d | grep trust-log` → `docs/trust-log.md | 34 +`；
> `$ grep -n "trust-log" 本檔` → 只有 `:724`、`:762` 的敘述，16 列變更清單中無此列。影響：低（行政性）。
>
> **〔沒驗到〕**（7 條）真 workerd 平台行為未驗（未起 `wrangler dev`）；歷史紅綠燈無法重現；
> 第四輪 21/21 raw-query probe 未重跑；canonical 第五輪報告未取得；逐 AC `it(` 語意歸屬未逐一人工核對；
> `worker/.wrangler/state` 汙染未驗；第六輪原文回寫行為無法預驗。
>
> **〔數字類複驗〕（未發現新問題）** 單元 72、TECH-004 自身 55（9+5+15+2+1+11+12）、冒煙 19、陷阱 14、
> lint 45 檔、追加 27（21+5+1）；各檔 12/13/15/5/10/17 全數相符；
> 輪次敘述與各輪 verdict 串全位置一致，無殘留「第四輪進行中」等舊狀態。
>
> **📝 附註（非 checker 原文）**：本段引用時（`2acd96b`）清單為 8 項；第六輪新增 3 條後為 **11 項（①–⑪）**。
>
> **[結論]** Task A 三條全數確認已修；Task B 找到 **3 條 P2**（皆文件─現實／跨檔一致性，低衝擊，程式面零變動）
> ——故不寫「沒找到更多問題」，建議修正 NEW-6-1～3 後再跑第七輪。

#### 第七輪新發現與處置（verdict 0 P0 / 0 P1 / 3 P2 — loop 封頂點）

> ⚠️ 本節與下方第七輪引用段中的**行號皆為 `eefe848` 時的行號**（本輪編輯後已位移）。

| 第七輪新發現 | 等級 | 處置 |
| --- | --- | --- |
| R8-1 AC 文件 R6-1 處置欄漏改（全票皆 `①–⑪`，唯獨該處仍 `①–⑧`）| P2 | ✅ 改 `①–⑪` + 補註（當時清單 6 項、現為 ①–⑪）|
| R8-2 本檔 Gate 4 歷程狀態列未隨輪次同步（`:229-230` 仍寫「跑第六輪」）| P2 | ✅ 改「跑第七輪」；本輪再更新為「第七輪 verdict 已回、待用戶裁決」 |
| R8-3 AC 第六輪節缺行號基準標註、自指行號 `:487` 已失效 | P2 | ✅ AC 該節補「行號皆為 `2acd96b` 時的行號」警告 |

> **📝 附註（非 checker 原文）**：checker 判為「觀察、不計入 P2」的 2 條我也一併修：
> ① `:709`「第四、五輪為純文件修正」漏列第六輪 → 改「第四～六輪」；
> ②「我的筆記」原承接第六輪 checker 的「相關 commit 8 個」，第七輪複核 `git log --grep=TECH-004` = **9 個** → 已更正。
>
> **Task A 五條全數確認**（NEW-6-1 / NEW-6-2 / NEW-6-3 已修且為真、`eefe848` 自我一致性為真、附註標示得當）；
> `git diff 2acd96b eefe848 -- worker/` = **0 bytes**（第六輪仍為純文件）。
>
> **⛔ loop 封頂**：連續六輪（第二～七輪）都只出同族文件 P2，程式面自第二輪起零新缺陷。依用戶規則停止、不再跑第八輪。
> 本輪 3 條修正為**自我複驗**（`npm run lint` 45 檔 0 issue、`vitest` 72 passed、`git grep` 全掃），未經獨立複驗。

**Gate 4 最終交付狀態**：七輪稽核（0 P0 / 2 P1→已修 / 26 條 P2→全數處置）＋程式碼層級獨立驗證已完成；
**2026-10-08 經用戶裁決通過**（gate-4 `notes`：純後端／CLI 任務不適用 playwright-cli）。

#### 第七輪 checker 原文引用（結構重排、表格精簡；判定與數字未改）

> **[Verdict]** `0 P0 / 0 P1 / 3 P2`（3 條皆文件─現實／跨檔一致性，同族；`worker/` 程式碼零變動）。
> 版本界線：`git diff 2acd96b eefe848 -- worker/` → **0 bytes**；TECH-004 commit 數複核 **9**（`git log --grep=TECH-004 | wc -l`）。
>
> **[A-1]** ✅「含幾輪 checker 原文」全校準：兩檔各 **5 個**區塊（第二～六）；歷史引文忠實（`git show 2acd96b:<DL>` 實測 `46:含五輪`、`762:含兩輪`、區塊 4 個）。
>
> **[A-2]** ✅ `grep -rn "程試" docs/ worker/` → 全 repo 只剩 `AC:543`（描述舊 bug 的歷史引述）；第五輪 Verdict 行 AC:487 與本檔 `:605` **逐字相同**。
>
> **[A-3]** ✅ `docs/trust-log.md | 修改 | trust mode 收尾紀錄（+34 行，含於 800063d）` 已入變更清單；`git show --stat 800063d` 相符；列數 16 → 17。
>
> **[A-4]** ✅ 為真但有 1 處漏網（P2-1）：清單 **11 項**、指涉 5 處皆 `①–⑪`，唯一例外 `AC:476`。
>
> **[A-5]** ✅ 附註未濫用逐字性：獨立 blockquote 行、明標「非 checker 原文」、同區塊其它引文與 `2acd96b` 版逐行比對一字未動。
>
> **[P2-1]** `AC:476` 處置欄 `①–⑧` vs 全票 `①–⑪`；影響低但同檔自我矛盾、與 NEW-6-1 同族。
>
> **[P2-2]** `本檔:229-230` 仍寫「已修正並跑第六輪；第六輪 verdict 回來前…」，與同檔 `:425`／`:440`／`:442`／`:711`／`:778` 等矛盾；
> 該行每輪都會更新（`b5c2a85`＝跑第五輪、`81aaca2`＝跑第六輪），唯獨 `2acd96b` 與 `eefe848` 未再更新。影響：低→中。
>
> **[P2-3]** `AC:517` 自指「本文件 `:487`」；`git show 2acd96b:docs/ac/TECH-004.md | sed -n 487p` = 「程試面」，
> 但 HEAD 同一行已是「程式面」；AC 唯一行號警告（`:472`）用的是 `b5c2a85` 基準，
> 與第六輪節所用的 `2acd96b` 基準不符（本檔同節 `:427` 則有正確警告）。此條偏弱，可降為觀察。
>
> **〔沒驗到〕**（8 條）未跑 `vitest` / `tsc` / `markdownlint` / `regression-guard` / 冒煙（read-only 紀律），
> 故「全綠」未驗，只靜態證數量（`it()`=72、`.md`=45、`check()`=19）；真 workerd 平台行為未驗；歷史紅燈無法重現；
> 第四輪 21/21 probe 未重跑；canonical 各輪報告未取得；逐 AC `it(` 歸屬未逐一人工核對；`worker/.wrangler/state` 汙染未驗；未來輪次沿用附註無法預驗。
>
> **[數字類複驗（實測，未發現新問題）]** 單元 72、各檔 12/13/15/5/10/17、TECH-004 自身 55（=72−17）、冒煙 19、
> 陷阱各 14、lint 45（`git ls-files '*.md' | wc -l`）、追加 27（`git show` 實測 21/5/1）、commit 9、verdict 串全位置一致。
>
> **📝 我的筆記（非 checker 原文）**：checker 另指出**我任務描述的前提錯誤**（我寫「本票共跨 **5** 個 commit」卻列了 **7** 個 hash；
> 第六輪 checker 當時數為 **8** 個，**第七輪複核 `git log --grep=TECH-004` = 9 個**，含 `844f247`）——非文件缺陷，
> 但**連續兩輪**都是我的輸入前提出錯，已記錄在反思。

## 本輪實測抓到的 14 個陷阱（已修；#1–#10 與 R3/R4 追加同步寫進 AC 文件陷阱表）

| # | 陷阱 | 症狀 | 修法 |
| --- | --- | --- | --- |
| 1 | `url.pathname` 不含 query | 轉發給 DO 時 `?ms=1500` 消失 → `Number(null) = 0` → alarm 立刻觸發 | `pathname + url.search` |
| 2 | 缺參數退化成 0 | `wakeIn(0)` 造成立即 alarm（潛在忙迴圈）| 缺 `ms` 回 400 `MS_REQUIRED` |
| 3 | 交易中的工作未排隊 | 交易外的 `run()` 插進交易中間 | 見 Gate 4 第一輪 P1-1：舊的 `#tail` 閘門**只擋得住同步到達的操作** → 改成移植官方 `SerialOperationQueue` |
| 4 | pi-ai 不匯出 `AuthContext` 型別 | `import type` 深連結失敗 | 從 `createModels` 參數推導型別 |
| 5 | 自行縮寫的模型 id | `llama-3.3-70b-fp8-fast` 解析不到 | 用目錄完整 id `@cf/meta/...` |
| 6 | 假設「conversationId 跨會議唯一」| 兩個會議都回 `1`（根對話 id 固定）| 比 DO 身分（`doId`），不比 conversationId |
| 7 | `/wake?ms=` 空字串 | `Number("") === 0` → 立即 alarm（忙迴圈）| 空字串／只有空白視同缺參數 → 400 `MS_REQUIRED` |
| 8 | `release()` 撞上「正在開」的 harness | 等待者拿到**已關閉**的 harness（storage 一起被關）| `ReleaseDecision`（延後不關）+ 清 `#opening` |
| 9 | 未知 provider／打錯的模型 id | 靜默換 provider、靜默用 24k 窗口算壓縮政策 | provider 白名單 + 先驗目錄 → `PROVIDER_UNKNOWN` / `MODEL_UNAVAILABLE` |
| 10 | 宣告了卻沒有效果的常數／函式 | `MAX_ALARM_DELAY_MS`／`DEFAULT_ALARM_DELAY_MS`／`currentConversationId` 無人使用 | `/wake` 真的套上限、範例字串用它、刪掉 dead export |
| 11 | 交易 handle 的失效時機比官方晚一個 commit 窗口 | 回呼結束後、`COMMIT` 前的窗口內，已失效的 handle 竟**真的執行下去**（不丟錯）| 第二輪 NEW-P2-1：`scope.active = false` 移進回呼 settle 後、`COMMIT` 前（鏡射官方 `node.js:117`）|
| 12 | 自己寫的假替身測試「自我實現」 | 假 storage 把**平台自己的 tx 物件**交給探針（沒 `.exec` → 一定 throw）→ 測試假通過 | 測試必須把**我方 handle** 從回呼裡抓出來；先確認探針打到受測物件再看紅燈 |
| 13 | `wrangler dev --var KEY=VALUE` 靜默無效 | 等號形式**不報錯也不生效**，DO 仍讀 `wrangler.toml` 的 `HARNESS_PROVIDER=cloudflare-workers-ai` → 冒煙全線 401 `AUTH_INVALID` | 用冒號：`--var HARNESS_PROVIDER:faux`（wrangler 4.148.0 實測；文件要寫對形式）|
| 14 | `/wake?ms=+5` 的 `+` 在 query 裡是**空白** | 第二輪加了整數檢查但**先 trim** → `" 5"` 被當成合法 5ms（近似立即 alarm）；測試用 `encodeURIComponent` 編成 `%2B5`，**測不到原始 URL** | 第三輪 NEW-3-1：格式檢查改看**原字串**（不 trim）；測試補未編碼 raw query |

> 陷阱 1 / 2 / 7 / 14 屬同一族「**參數在傳遞鏈上退化**」——這是 DO 轉發層最常見的靜默失敗
> （第 14 條不只是程式，還包括「測試把它編碼掉、所以測不到」）；
> 陷阱 3 / 8 / 9 / 10 / 11 屬同一族「**契約/介面沒逐條落實**」；
> 陷阱 12 / 13 是**驗證方法本身**的陷阱（假綠測試、環境覆寫沒真的生效）。
> 陷阱 1/2/7 都會造成 alarm 忙迴圈，被冒煙的「alarm 時間 = 現在 + 1500ms」一項同時鎖住。

## 已知問題

1. **Gate 1（TDD）紅燈只補到「追加修正」那一段**：原始 TECH-004 實作在 trust mode 期間完成，
   紅燈無法回溯補齊。追加的 27 項測試（第一輪 +21、第二輪 +5、第三輪 +1；第四～六輪為純文件修正，**未新增測試**）有完整紅→綠證據（見 Gate 1）。
   第二輪 checker 也誠實指出：**舊的紅燈歷史輸出無法重現**（test set 已不同），只能確認測試存在且鎖住行為。
2. **Gate 4（reviewer）七輪均未回報「沒找到更多問題」；2026-10-08 經用戶裁決通過（知情裁決）**：
   第一輪 verdict 0 P0 / 2 P1 / 9 P2；第二輪 0 P0 / 0 P1 / **4 P2（新發現）**；
   第三輪 0 P0 / 0 P1 / **2 P2**；第四輪 0 P0 / 0 P1 / **3 P2**；第五輪 0 P0 / 0 P1 / **2 P2**；
   第六輪 0 P0 / 0 P1 / **3 P2**；**第七輪 0 P0 / 0 P1 / 3 P2**
   （第三輪之後全為文件數字/引用一致性，程式面從第二輪起無新缺陷）。
   七輪都「有找到更多問題」，依 `fail_action` 不得進入 §2.4；六輪發現已全數處置，
   **封頂規則（用戶裁決）已觸發：第七輪仍只出同族文件 P2（3 條），故停止 loop、不跑第八輪；
   用戶選擇接受 Gate 4 通過。⚠️ 本票「通過」不是因為出現『沒找到更多問題』字樣，而是用戶在知情下的裁決。**
   ⚠️ 第三輪的結語雖然寫了「沒找到更多問題」，但同一份報告列了 2 條 P2，**故不採計為通過**。
3. **`worker/reports/` 已 gitignore**：回歸報告不入版控，需重跑才能重建。
4. **冒煙需手動起 dev server**：`do-smoke.mjs` 依賴外部 `wrangler dev`（預設 8787，可用
   `DO_SMOKE_BASE` 覆寫）；未自動化進 CI。
5. **文件數字／引文反覆修正（本票內 14 處）**：①冒煙「20 項」→ 實際 **19 項**；②測試對照表把
   `lifecycle.test.ts` 記為 AC-1 11 項 / AC-3 4 項，實際為 6 / 6，且漏列 `do-sqlite.test.ts`；
   ③修成逐 AC 對帳（單元 49 + 冒煙 19），但**表頭仍留 `do-sqlite.test.ts`（10）**（實際 11）
   ——被第二輪 checker 抓為 NEW-P2-3；④第二輪再修為單元 54 + 冒煙 19 並逐項對帳；
   ⑤第三輪又抓到 deliverable 同檔「12 個／13 個陷阱」自相矛盾 + 變更清單舊數（NEW-3-2）→
   已統一為 14 條並兩表同步；⑥第四輪再抓到 AC 文件**前置表頭** `meeting-do.test.ts`（14）未同步（實際 15）、
   兩張陷阱表 #13/#14 編號對調（NEW-4-1 / NEW-4-2）→ 已修；⑦第五輪再抓到**引文不實**（處置欄引號內字串在敘述裡不存在，NEW-5-1）；
   ⑧同一份第四輪原文的〔沒驗到〕條數跨檔不一致（AC 5 條 vs 原文 6 條，NEW-5-2）→ 已修；
   ⑨同一份 deliverable 對「含幾輪 checker 原文」自相矛盾（`:46` 五輪 vs `:762` 兩輪，NEW-6-1）→ 已統一；
   ⑩同一段第五輪原文的跨檔引用逐字不一致（「程**試**面」vs「程**式**面」，NEW-6-2）→ 已統一；
   ⑪變更清單漏列 `docs/trust-log.md`（NEW-6-3）→ 已補；
   ⑫AC 文件 R6-1 處置欄漏改（仍寫 `①–⑧`）（R8-1）→ 已修；
   ⑬deliverable「Gate 4 歷程狀態列」未隨輪次同步（仍寫「跑第六輪」）（R8-2）→ 已修；
   ⑭AC 第六輪節缺行號基準標註、自指行號已失效（R8-3）→ 已補。
   **同一類缺陷在本票內反覆復發（共 14 處，見上列 ①–⑭）**，故「數字／引文變動必須全域 `grep`（含前置清單、跨檔、引用段）」已寫進根因改善動作。
   **根因：寫文件時憑印象填數字／引文；同一類錯在修正中復發（⑨⑩ 發生在我修完前 8 處之後，⑫⑬⑭ 又發生在我修完 11 處之後）。**
6. **`regression-guard.mjs` 顯示瑕疵**：被 `-t` 篩掉的測試顯示為 `✗`（實際為 skipped），
   易誤讀為失敗。判定邏輯（`failed === 0 && passed > 0`）正確，只有**顯示**誤導。
7. **`worker` 的 `lint` script 原本永遠失敗（本輪已修）**：`markdownlint-cli2 "**/*.md"`
   在 worker 目錄下找不到根目錄的 `.markdownlint-cli2.jsonc` / `.markdownlint.json`
   （markdownlint-cli2 不向上層搜尋設定），於是對 `node_modules` 用預設規則 lint
   → **10,820 個錯誤、exit 1**。已改為顯式 `--config ../.markdownlint-cli2.jsonc`，
   並只 lint 專案自己的 md（`../docs/**/*.md`、`../*.md`，共 45 檔）。
8. **`PROVIDER_UNKNOWN` 尚未進 `system-design.md` §5.2 錯誤碼表**：它是 DO 診斷碼，
   目前只在 code comment 說明「要發給裝置前必須先補表」。`system-design.md` §5.2 明訂
   「新增碼必須同步更新此表與 `DESIGN.md` §5.1」——**目前靠註解提醒，沒有機器檢查**。
9. **`recoverable: true` 但 HTTP 500 的語意落差**：`PROVIDER_UNKNOWN` / `MODEL_UNAVAILABLE`
   依 §5.2 協定語意回 `recoverable: true`（＝「裝置可繼續錄音，不中止」），但 HTTP 狀態是 500。
   裝置端**必須以 body 的 `recoverable` 為準**，不可用 HTTP 碼推論；此約定已寫進 code comment，
   但還沒有對應的整合測試鎖住（要等 M01 裝置端接通才驗得到）。

## 下一步建議

- **驗收方式（3 分鐘）**：
  1. `cd worker && npx vitest run` → 72 passed；
  2. `cd worker && npx tsc --noEmit && npm run lint` → 0 errors / 0 issues；
  3. （選）`npx --yes wrangler@4 dev --port 8787 --local --var HARNESS_PROVIDER:faux &`
     然後 `npm run smoke:do` → 19 項全綠。
     ⚠️ `--var` 必須用**冒號**（`KEY:VALUE`）；用等號 `KEY=VALUE` 會**靜默不生效**（見陷阱 13）。
- **風險提示**：① 第七輪的 3 條文件修正是**自我複驗**（lint/tests/grep 全掃），**未經第八輪獨立複驗**（依用戶封頂規則停 loop）；
  ② `PROVIDER_UNKNOWN` 未進 §5.2 表，若要下發裝置端必須先補（見已知問題 8）；
  ③ 下一張相依票是 SPIKE-002b（原生錄音 plugin 可行性，0.5 天時間盒），
  它會決定 M01-US-106（8 SP）要不要做。
- **建議下一張票**：`SPIKE-002b` →（若可行）`M01-US-106`；或並行 `M01-US-101`（前景錄音，5 SP）。
- **建議（尚未進 backlog，依用戶裁決「只記錄、不進 SOP」）**：工具鏈有兩個瑕疵：
  ① `dev-checker-loop` Step 0 用 `which jev-use` 探測可用性——pi 是 npm 安裝
  （`~/.pi/agent/npm/node_modules/.bin/jev-use`），`which` 回 false-negative；
  ② `jev-use install` 走 git 版時會 `npm install --omit=dev` → `prepare: npm run build` →
  `tsc: command not found`（typescript 是 devDependency）→ exit 127。
  **兩者都不影響本票**（pi 端 jev 實測可用、claude 端 `✔ Connected`）；修 skill 需走 V03 二審，故只記錄。

## 反思

**反省層級**：US / Module 交界（輕量路徑：關鍵維度 + 全維度簡評）。
**jev 模式**：on（`jev-use` v0.8.0；校驗前快篩 + 校驗後驗證）。
**Gate 4 狀態**：2026-10-08 用戶裁決**通過**（第七輪 0 P0 / 0 P1；26 條 P2 全數處置）→ 進入本反省。
**Action Items 狀態**：下表建議**待用戶確認**（本票為 US 級別，Agent 依 §2.4 Step 5 列出、不自行進 backlog）。

| 維度 | 評級 | 依據 |
| --- | --- | --- |
| UX/UI | — 不適用 | 純後端骨架，無使用者介面 |
| RWD | — 不適用 | 同上 |
| 技術債 | ⚠️ 有條件通過 | 無 TODO；14 個陷阱已修且被測試鎖住；Gate 1 紅燈補到追加段；Gate 4 七輪（11 + 4 + 2 + 3 + 2 + 3 + 3 項）全數處置（程序面零缺陷自第二輪起；第七輪 3 條為自我複驗、未經獨立複驗）。殘留：`PROVIDER_UNKNOWN` 未進 §5.2 表、faux catalog 繞過 `MODEL_UNAVAILABLE`、`FALLBACK_CONTEXT_WINDOW` 實質死路徑 |
| 可維護性 | ✅ 通過 | 分層清楚（lifecycle / storage / harness / DO 入口）；DO 入口只做平台接線；核心邏輯皆可單測 |
| 測試覆蓋率 | ✅ 通過 | 6 條 AC 皆有對應測試（單元 55 + 冒煙 19）；另含合約測試（交易排隊、handle 失效時機、`AggregateError` 順序）與 DO HTTP 入口測試（含 `/release` 與 raw query 編碼）|
| 需求對齊 | ✅ 通過 | 逐條對上 SPIKE-003 的三個平台事實；模型與壓縮政策對上 D15 |

### 根因分析與改善動作

| 問題 | 根因 | 改善動作 |
| --- | --- | --- |
| **成果完成數小時卻未提交** | trust mode 期間以「繼續往前做下一件事」為優先，**缺一個「完成即提交」的強制檢查點**；且 trust 結束時（04:08）沒有正式收尾紀錄，之後才被用戶問到才發現 | 已於本輪提交。**教訓：trust mode 必須有「每完成一票就 commit + 標 DONE + 寫 deliverable」的節奏，不能累積到最後**（累積期間即為丟失風險窗口）|
| AC 文件數字不精確（20 vs 19；測試對照表錯記）| 寫 AC 時憑印象填數字，未以測試檔與實際輸出對帳 | 已改為逐 AC 對帳並附重跑指令。**教訓：AC 文件的數字必須是「從輸出貼回來的」，不是回想出來的** |
| `regression-guard.mjs` 把 skipped 顯示成 `✗` | 顯示邏輯只分 `passed` / 其他 兩種 | 已記錄（P2）。低風險但會誤導人，建議後續改成三態（passed / failed / skipped）|
| trust mode 沒有正式「收尾」步驟 | dav-trust 的結束流程未被嚴格執行（最後一筆 log 停在 04:00，之後仍產出程式碼到 04:08）| 已於本輪補 `docs/trust-log.md` 收尾紀錄 |
| **本輪修正自己引入的「引文不實」**（第五輪 NEW-5-1 / NEW-5-2）| 我拿「打算寫的文字」當成「已寫的文字」去做引號；跨檔引用同一份 checker 報告時只複製一部分（6 條→5 條）卻仍聲稱「數字未改」 | 已改成「不再用引號冒充引文」＋AC 補回第 6 條並註明「與原文一致、無省略」。**教訓：引用別人的報告時，要麼完整、要麼明寫省略了什麼——「差不多」就是造假** |
| **`worker` lint script 永遠失敗** | 寫 script 時假設 `markdownlint-cli2` 會像多數工具一樣**向上層搜尋設定檔**；實際不會 → 規則與忽略清單都沒生效，對 `node_modules` 噴 10,820 個幻覺錯誤 | 已改為顯式 `--config` + 限定 glob。**教訓：工具「找不到設定」時不會報錯、只會靜默用預設值——這和 Gate 3 的 `passed > 0` 同一族（靜默降級 / 假結果）** |
| **交易排隊自己發明機制（P1-1）** | 讀官方契約時只抓到「交易外的操作要排隊」，沒抓到第 2 條「**在交易回呼 `await` 期間到達的**操作也要排隊」，於是自創 `#inTransaction` 布林放行 | 已改為移植官方參考實作（`SerialOperationQueue`）。**教訓：外部契約要逐條抄進測試裡；沒抄的條文等於沒讀** |
| **靜默失敗族（P2-1/2/3/6）** | 四個地方在「輸入不合法」時都選了**最安靜的退化路徑**（`Number("")→0`、未知 provider → 換 Cloudflare、未知模型 → 24k 窗口、未知 cursor → `[]`）| 全部改成丟錯或明確 400/500。**教訓：非法輸入一律走「吵鬧」路徑；退化只能用於明確可接受的預設值** |
| **P2→P1 的嚴重性分了兩輪才定** | 第一輪各項自評偏低（全列 P2），是 jev 快篩把靜默失敗族扶正的 | 已把「**靜默失敗是否會讓裝置繼續跑而錯**」寫進分級自檢。**教訓：分級要看「錯了會怎樣」不是「錯得大不大」** |
| **移植契約時只抄了「看到的那一條」（第二輪 P2-1）** | 把官方 `SerialOperationQueue` 移植過來時，只對齊了「排隊」與「回呼後失效」兩個大行為，**沒逐行比對「失效發生的確切位置」**（官方在 `COMMIT` 前就失效）| 已移進回呼 settle 後。**教訓：移植參考實作要逐行對齊，不是只對齊「看起來像」的行為；移植時「差一個窗口」等於契約沒落實** |
| **修正清單裡「文件類」項目自己復發（第二輪 P2-3 → 第三輪 NEW-3-2）** | 第一輪明明被點名「AC 數字不精確」，修正時只改了對帳表、漏了表頭——**沒有全域搜尋同一個數字**；第二輪又只改 AC 文件、沒同步 deliverable（**同檔內就自相矛盾**）| 已修並改為「以實際測試輸出逐 AC 對帳」+「數字類修改要 `grep` 全部出現處」。**教訓：文件類缺陷不會自動停，它會復發到你把「搜尋」變成動作** |
| **URL 編碼破口（第三輪 R4-1）** | 把「query 參數」當成一般字串：`URLSearchParams` 已把 `+` 解成空白，程式再 `trim` 就等於放行；且**測試自己用 `encodeURIComponent` 把要驗的字元編掉了** | 改看原字串（fail-loud）+ 測試改加未編碼 raw query。**教訓：驗「非法輸入」時，測試必須用與真實呼叫端**完全一樣的原始形式**——測試自己做的編碼/轉義會把破口藏起來** |
| **驗證方法本身出錯（第二輪 P2-3/P2-4 + 陷阱 12/13）** | ① 假 storage 測試自我實現（探針打到平台物件）；② 冒煙用 `--var KEY=VALUE` 靜默不生效，**我還差點把它當成「程式壞了」**；③ `/release` 這條自己剛修的路徑零測試 | 已補測試 + 把「探針要打到受測物件」寫進測試準則；`--var` 改冒號形式。**教訓：假替身測試要先證明它會紅；環境覆寫要先證明它生效（否則紅燈可能在說謊）** |
| **任務前提（輸入）連續兩輪寫錯（第五、六輪）** | 第五輪我給 checker 的前提寫「第四輪報告有 **8 條**沒驗到」（canonical 是 6 條）；第六輪寫「本票共跨 **5** 個 commit」但列了 7 個 hash（實際 8 個）——**兩次都是 checker 反過來糾正我** | 我把檢查範圍從「查產品」擴到「也查我自己的指令」：凡捏造數字／條數／檔數前，**先跑一次 `grep` 數一遍再寫**。教訓：**指令也是證據，不能憑印象寫** |

### 建議新增 Backlog item

| 建議 | 類型 | 驗收標準 | 預估 |
| --- | --- | --- | --- |
| **TECH-006 — `do-smoke.mjs` 自動化**：起 dev server、等待就緒、跑冒煙、關 server，一鍵完成 | TECH | `npm run smoke:do` 不依賴外部已啟動的 server，退出碼正確 | 2 SP / P2 |
| **TECH-007 — `regression-guard` 三態顯示**：`passed` / `failed` / `skipped` 分開呈現 | TECH | 被 `-t` 篩掉的測試顯示為 skipped 而非 `✗` | 1 SP / P2 |
| **TECH-008 — 錯誤碼表同步探針**：檢程式碼中的錯誤碼常數與 `system-design.md` §5.2 / `DESIGN.md` §5.1 的表是否一致 | TECH | 新增或刪錯誤碼未同步更新文件時，探針轉紅 | 1 SP / P2 |
| **TECH-010 — 文件數字／引文一致性探針**（建議，**未進 backlog**；用戶於第七輪裁決時選擇「不加開」）：掃 `docs/**` 內可當事實的數字（測試數、陷阱數、輪數、清單項數、commit 數）與跨檔引文，不一致即轉紅 | TECH | 改一處數字/引文時，另一處未同步會被探針抓到 | 1–2 SP / P2 |
| **TECH-009 — 驗收工具鏈證據化（依用戶裁決「只記錄」）**：① `dev-checker-loop` Step 0 改用「可執行探測」而非 `which jev-use`（pi 為 npm 安裝，`which` 會 false-negative）；② `jev-use` git 安裝需全局 `tsc` 或移除 `--omit=dev` 的 `prepare` 失敗 | TECH | 探測結果與實際可用性一致；安裝失敗有可讀錯誤 | 1 SP / P3（**未進 backlog**）|

### ⚠️ jev escalate 待確認

- **JEV_AVAILABLE = true**：pi 已裝 `jev-use` v0.8.0（backend `typesafe`、model `jev-1.13.0`），
  `claude` 亦 `✔ Connected`。本次是「事前快篩（挑高風險點）+ 事後驗證（覆核結論）」。
- `which jev-use` 回 false 是 **PATH 瑕疵**（skill 的偵測方式），不影響功能；
  依 V03 僅記錄、未自行修改 SOP。

| jev 問的問題 | jev 的回答 | 信心 | extrapolation | 我的處置 |
| --- | --- | --- | --- | --- |
| 三個 P2 該不該升成 P1？| 「部分該升級：P2-1 / P2-2 / P2-3 是靜默失敗族」| 77% | ✅ 足夠 | 採納，按 P1 處理（已修）|
| 第一輪審查有沒有漏掉 P0？| 機率 0.35 | 30% ⚠️ | ⚠️ 待確認 | 不當證據（已修的不變）；但「樣本只有 1 輪」的風險已記在已知問題 2 |
| P1-1 在真實生產環境發生？| 機率 0.41 | 18% ⚠️ | ⚠️ 待確認 | 不管機率都該修（合約違反）；嚴重性待第二輪覆核 |
| P1-2 在真實生產環境發生？| 機率 0.49 | 2% ⚠️ | ⚠️ 待確認 | 同上 |

**這三筆 escalate 的意義**：「這三件事會不會真的在生產上咬人」——目前**未確認**。
它們不影響修不修的決定（都以合約為準修了），只影響「這件事該記多大的帳」。
**第二輪覆核結果**：P1-1 / P1-2 確認為真修好（舊碼重現 → 新碼驗證），但「會不會在生產咬人」
仍無實證（沒有生產流量），故保留「未確認」而不臆測；等 M01/M02 裝置端接通後才有真證據。
`docs/trust-log.md` 收尾紀錄已補（本輪）；本文件為**該票交付歷史的完整詳錄**（含第二～七輪 checker 原文，共 6 個引用區塊；第一輪為 verdict 摘要 + 表格）。
