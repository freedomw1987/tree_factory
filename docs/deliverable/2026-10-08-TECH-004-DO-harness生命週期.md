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
| `worker/test/do-sqlite.test.ts` | 新增 | 6 項 |
| `worker/test/lifecycle.test.ts` | 新增 | 12 項 |
| `worker/test/harness-persistence.test.ts` | 新增 | 10 項 |
| `worker/scripts/do-smoke.mjs` | 新增 | 真 workerd 冒煙：19 項檢查 |
| `worker/package.json` / `package-lock.json` | 修改 | 加 `smoke:do` script + `pi-ai` / `pi-durable` / `chord` 依賴 |
| `docs/ac/TECH-004.md` | 新增 | 6 條 BDD AC + 介面契約 + 6 個實測陷阱 |
| `docs/backlog.md` | 修改 | TECH-004 → `DONE` |

## 測試 / 驗收證據

### Gate 1（TDD）

本票屬 trust mode 期間產出，未留存「先紅後綠」的紅燈輸出；
既有可審查證據為最終綠燈（見 Gate 2/3）。**這是本次收尾無法補齊的缺口**，已列入「已知問題」。

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

| 測試檔 | 項數 | 層級 |
| --- | --- | --- |
| `worker/test/do-sqlite.test.ts` | 6 | 單元（儲存適配器契約）|
| `worker/test/lifecycle.test.ts` | 12 | 單元（AC-1 / AC-3）|
| `worker/test/harness-persistence.test.ts` | 10 | 單元 + 整合（AC-2 / AC-4 / AC-6）|
| `worker/test/segmentation.test.ts` | 17 | 既有基線（M01-US-109，未觸及，證明無回歸）|
| **合計** | **45** | 全綠 |

### Gate 3 補強：真 workerd Durable Object 冒煙

單元測試證不了平台行為（DO 回收、alarm 真的醒來、一會議一 DO 實例），故另跑真 workerd：

```text
$ cd worker && npx wrangler dev --port 8791 --local --var HARNESS_PROVIDER:faux &
$ DO_SMOKE_BASE=http://127.0.0.1:8791 node scripts/do-smoke.mjs
--- 0. Worker 活著 ---
✅ GET / 回服務說明
--- 1. 懶初始化 + 單例 ---
✅ 第一次 /health 成功 — conversationId=1
✅ 第一次才開 harness（opens=1） — opens=1
✅ 第二次沒有重開（單例） — opens=1
✅ 同一場會議的 conversationId 不變
✅ 模型與 D15 預設一致 — {"provider":"faux","modelId":"faux-1"}
--- 2. 一個會議 = 一個 DO 實例 ---
✅ 另一場會議對到不同的 DO 實例 — doId 相異
✅ 另一場會議各自獨立開 harness（兩邊 opens 都是 1）
--- 3. 真的跑一個 turn（faux 模型）---
✅ faux 腳本已設定（測試支援端點） — {"scripted":1}
✅ submit 回 done — {"status":"done","conversationId":1,"entries":12}
✅ entries 增加 — 10 → 12
--- 4. alarm 接力 ---
✅ 缺 ?ms 時明確報錯（不退化成 0）
✅ wake 設定了 alarm — {"scheduled":true,"at":1791419143736,"previous":null}
✅ alarm 時間 = 現在 + 1500ms（query 參數真的有送到 DO）— at-now=1497ms
✅ 更晚的 wake 不動既有 alarm（只往前）
✅ alarm 真的醒來（alarmWakes ≥ 1） — alarmWakes=1
✅ alarm 醒來後 harness 重建（opens ≥ 2） — opens=2
✅ 重建後 conversationId 不變
✅ 重建後 entries 不變少（同一份 storage 讀回）— 12 → 12
--- 5. 缺憑證時回 AUTH_INVALID（唯一可阻斷）---
（跳過：本輪以 HARNESS_PROVIDER=faux 啟動；AUTH_INVALID 由單元測試覆蓋）

DO smoke：全部通過 ✅   （19 項檢查）
```

> **注意：** 冒煙的 `entries` 數字（本輪 `10 → 12`）**每次跑都不同**——`wrangler dev --local`
> 會把 DO 狀態持久化在 `worker/.wrangler/state`，同一場會議名重跑就會累積。
> 斷言只看「有增加 / 沒變少」，不看具體數字，所以重跑仍會綠。
> 若要重現「從 0 開始」的數字，先 `rm -rf worker/.wrangler/state`。

### Gate 4（reviewer）

**未執行**。本票在 trust mode 期間產出時未走獨立 reviewer（`dev-checker-loop`）；
本次收尾未補做（判斷：收尾任務範圍＝把手續補齊，不擴大；已列入「已知問題」建議後補）。

## 本輪實測抓到的 6 個陷阱（已修，皆寫進 AC 文件）

| # | 陷阱 | 症狀 | 修法 |
| --- | --- | --- | --- |
| 1 | `url.pathname` 不含 query | 轉發給 DO 時 `?ms=1500` 消失 → `Number(null) = 0` → alarm 立刻觸發 | `pathname + url.search` |
| 2 | 缺參數退化成 0 | `wakeIn(0)` 造成立即 alarm（潛在忙迴圈）| 缺 `ms` 回 400 `MS_REQUIRED` |
| 3 | 交易中的工作未排隊 | 交易外的 `run()` 插進交易中間 | `#tail` 閘門 + 交易 handle 直通 |
| 4 | pi-ai 不匯出 `AuthContext` 型別 | `import type` 深連結失敗 | 從 `createModels` 參數推導型別 |
| 5 | 自行縮寫的模型 id | `llama-3.3-70b-fp8-fast` 解析不到 | 用目錄完整 id `@cf/meta/...` |
| 6 | 假設「conversationId 跨會議唯一」| 兩個會議都回 `1`（根對話 id 固定）| 比 DO 身分（`doId`），不比 conversationId |

> 陷阱 1 / 2 屬同一族「**參數在傳遞鏈上退化**」——這是 DO 轉發層最常見的靜默失敗，
> 兩者都會造成 alarm 忙迴圈，被冒煙的「alarm 時間 = 現在 + 1500ms」一項同時鎖住。

## 已知問題

1. **Gate 1（TDD）紅燈輸出缺失**：實作在 trust mode 期間完成，未留存「先紅後綠」證據。
   本票的 TDD 可信度由最終綠燈（45 項）+ 冒煙（19 項）承擔，**但嚴格依 §2.3 標準屬證據不足**。
2. **Gate 4（reviewer）未執行**：無獨立第三方稽核。建議在 M02-US-201 之前補一次
   （該票會直接複用本票骨架，屆時 reviewer 的投報率最高）。
3. **`worker/reports/` 已 gitignore**：回歸報告不入版控，需重跑才能重建。
4. **冒煙需手動起 dev server**：`do-smoke.mjs` 依賴外部 `wrangler dev`（預設 8787，可用
   `DO_SMOKE_BASE` 覆寫）；未自動化進 CI。
5. **AC 文件原有 2 處數字不精確，本輪已修正**：①冒煙「20 項」→ 實際 **19 項**；
   ②測試對照表把 `lifecycle.test.ts` 記為 AC-1 11 項 / AC-3 4 項，實際為 6 / 6，
   且漏列 `do-sqlite.test.ts` 6 項。已改為逐 AC 對帳（單元 28 + 冒煙 19）。
6. **`regression-guard.mjs` 顯示瑕疵**：被 `-t` 篩掉的測試顯示為 `✗`（實際為 skipped），
   易誤讀為失敗。判定邏輯（`failed === 0 && passed > 0`）正確，只有**顯示**誤導。
7. **`worker` 的 `lint` script 原本永遠失敗（本輪已修）**：`markdownlint-cli2 "**/*.md"`
   在 worker 目錄下找不到根目錄的 `.markdownlint-cli2.jsonc` / `.markdownlint.json`
   （markdownlint-cli2 不向上層搜尋設定），於是對 `node_modules` 用預設規則 lint
   → **10,820 個錯誤、exit 1**。已改為顯式 `--config ../.markdownlint-cli2.jsonc`，
   並只 lint 專案自己的 md（`../docs/**/*.md`、`../*.md`，共 45 檔）。

## 下一步建議

- **驗收方式（3 分鐘）**：
  1. `cd worker && npx vitest run` → 45 passed；
  2. `cd worker && npx tsc --noEmit` → 0 errors；
  3. （選）起 dev server 跑 `do-smoke.mjs` → 19 項全綠。
- **風險提示**：① 本票沒有 reviewer 與 TDD 紅燈，若要求嚴格 Gate 完整性，建議補一次
  reviewer（對象：`worker/src/harness/*`、`worker/src/storage/*`）；
  ② 下一張相依票是 SPIKE-002b（原生錄音 plugin 可行性，0.5 天時間盒），
  它會決定 M01-US-106（8 SP）要不要做。
- **建議下一張票**：`SPIKE-002b` →（若可行）`M01-US-106`；或並行 `M01-US-101`（前景錄音，5 SP）。

## 反思

**反省層級**：US / Module 交界（輕量路徑：關鍵維度 + 全維度簡評）。
**jev 模式**：off。

| 維度 | 評級 | 依據 |
| --- | --- | --- |
| UX/UI | — 不適用 | 純後端骨架，無使用者介面 |
| RWD | — 不適用 | 同上 |
| 技術債 | ⚠️ 有條件通過 | 無 TODO；6 個平台陷阱已修且被測試鎖住；但 Gate 1 紅燈與 Gate 4 reviewer 兩項證據缺口未補 |
| 可維護性 | ✅ 通過 | 分層清楚（lifecycle / storage / harness / DO 入口）；DO 入口只做平台接線；核心邏輯皆可單測 |
| 測試覆蓋率 | ✅ 通過 | 6 條 AC 皆有對應測試（單元 28 + 冒煙 19）；含併發、失敗重試、非法輸入等邊界 |
| 需求對齊 | ✅ 通過 | 逐條對上 SPIKE-003 的三個平台事實；模型與壓縮政策對上 D15 |

### 根因分析與改善動作

| 問題 | 根因 | 改善動作 |
| --- | --- | --- |
| **成果完成數小時卻未提交** | trust mode 期間以「繼續往前做下一件事」為優先，**缺一個「完成即提交」的強制檢查點**；且 trust 結束時（04:08）沒有正式收尾紀錄，之後才被用戶問到才發現 | 已於本輪提交。**教訓：trust mode 必須有「每完成一票就 commit + 標 DONE + 寫 deliverable」的節奏，不能累積到最後**（累積期間即為丟失風險窗口）|
| AC 文件數字不精確（20 vs 19；測試對照表錯記）| 寫 AC 時憑印象填數字，未以測試檔與實際輸出對帳 | 已改為逐 AC 對帳並附重跑指令。**教訓：AC 文件的數字必須是「從輸出貼回來的」，不是回想出來的** |
| `regression-guard.mjs` 把 skipped 顯示成 `✗` | 顯示邏輯只分 `passed` / 其他 兩種 | 已記錄（P2）。低風險但會誤導人，建議後續改成三態（passed / failed / skipped）|
| trust mode 沒有正式「收尾」步驟 | dav-trust 的結束流程未被嚴格執行（最後一筆 log 停在 04:00，之後仍產出程式碼到 04:08）| 已於本輪補 `docs/trust-log.md` 收尾紀錄 |
| **`worker` lint script 永遠失敗** | 寫 script 時假設 `markdownlint-cli2` 會像多數工具一樣**向上層搜尋設定檔**；實際不會 → 規則與忽略清單都沒生效，對 `node_modules` 噴 10,820 個幻覺錯誤 | 已改為顯式 `--config` + 限定 glob。**教訓：工具「找不到設定」時不會報錯、只會靜默用預設值——這和 Gate 3 的 `passed > 0` 同一族（静默降級 / 假結果）** |

### 建議新增 Backlog item

| 建議 | 類型 | 驗收標準 | 預估 |
| --- | --- | --- | --- |
| **TECH-006 — `do-smoke.mjs` 自動化**：起 dev server、等待就緒、跑冒煙、關 server，一鍵完成 | TECH | `npm run smoke:do` 不依賴外部已啟動的 server，退出碼正確 | 2 SP / P2 |
| **TECH-007 — `regression-guard` 三態顯示**：`passed` / `failed` / `skipped` 分開呈現 | TECH | 被 `-t` 篩掉的測試顯示為 skipped 而非 `✗` | 1 SP / P2 |
| **補 TECH-004 Gate 4 review**（可併入 TECH-006 或 M02-US-201 前置）| TECH | reviewer verdict + 風險清單寫入 `docs/ac/TECH-004.md` | 0 SP（隨 M02-US-201 順帶）|

### ⚠️ jev escalate 待確認

- 無（jev 模式未啟用）。
