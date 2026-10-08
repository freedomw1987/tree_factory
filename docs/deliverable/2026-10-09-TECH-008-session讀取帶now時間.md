# TECH-008 交付：session 讀取帶入「現在時間」（擋下「時間軸被推到未來」的竊改）

- **票號**：TECH-008（P2 / 1 SP / 依賴 M01-US-101；由 US-101 §2.4 反思維度 3 轉票）
- **日期**：2026-10-09
- **範圍**：worker-only（`session.ts` / `session-store.ts` / `meeting-do.ts` + 2 個測試檔）
- **AC**：`docs/ac/TECH-008.md`｜**設計**：`docs/design/TECH-008-session-clock-validation.md`
- **Gate 4**：兩輪（第一輪 reviewer 靜態 + oracle 對抗式；第二輪 reviewer 複驗 F1 修正）

## 1. 這一票到底解決了什麼（Gate 4 oracle 實測後校正）

US-101 的 `meeting_session` 讀取層只驗**差值**：`ends_at_ms === started_at_ms + MEETING_MAX_MS`。
差值不是位置——兩欄**一起**平移，這條不變式照樣成立，但「2 小時上限」是用**絕對時間**在管的
（`acceptsTranscriptWrites` 比的是 `now < ends_at_ms`）。

本票把「現在時間」帶進讀取驗證（`started_at_ms` 不得在未來、`ends_at_ms` 不得超過現在 + 上限），
把「資料被竊改」與「程式 bug」在維運上分開（`SESSION_CORRUPT` vs `INTERNAL`）。

**真正的不變式（不要寫得比事實大）**：設 Δ = 兩欄一起平移的量、elapsed = 平移前的已錄時間，則

```
違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS
```

| 平移情境 | 本票擋得住嗎 |
| --- | --- |
| 推到未來（Δ > elapsed + 60s，例如 +10 年） | ✅ 擋下 → 500 `SESSION_CORRUPT` |
| 剛開始錄音時平移 1 小時 | ✅ 擋下 |
| **已錄 1 小時後再平移 1 小時（上限 2h→3h）** | ❌ **放行**（該情境正是原始轉票動機之一） |
| **已過期的會議被搬回現在** | ❌ **放行** |
| 往過去平移 | ❌ 放行（刻意） |

擋不掉的那一半需要「對手不能同步改寫的錨點」，而 DB 內欄位與 DO alarm 都做不到
（設計 D7 / oracle F6）→ 另立 **TECH-014**。

## 2. AC 對照與證據

| AC | 內容 | 證據 |
| --- | --- | --- |
| AC-1 | `started_at_ms > now + 60s` 一律擋下，且**不改動任何列** | DO 平移 +1h（elapsed 0）→ 500；store 層驗「非 SELECT 語句數不變」 |
| AC-2 | 容忍邊界 ±1ms 分得出來（**elapsed 0 的特例**，一般式見 AC-6）；回跳 30s 放行；**回跳 61s（elapsed 0）擋下** | 純函式邊界測試 + `read(STARTED - 30_000)` / `read(STARTED - 61_000)` |
| AC-3 | 合法舊會議（10h 後才讀）與「錄到上限沒人碰過」都放行 | 純函式 + DO `GET /session` → `phase=limit_reached` / `endedReason=limit`；rule2 獨立斷言 |
| AC-4 | `nowMs` 必填 → 編譯錯誤；`NaN`/`Infinity` → `SESSION_CORRUPT` | `read(nowMs: number)` 無預設值 + `read(Number.NaN)` 測試 |
| AC-5 | 不誤傷正常路徑 | `session-store.test.ts` 全綠；M01 回歸 `passed=214 failed=0` |
| AC-6 | 已知限制被釘樁（放行 2 條 + 真邊界 1 條 + 回跳代價 1 條 + 壞時鐘 1 條 + alarm 行為 1 條 = 6 條） | 檔尾釘樁群；**沒有任何單點突變能殺死「放行 2 條」**（第二輪 oracle 實測推翻 M8 判讀，見 §3 與 §4）|

### DoD 對照

1. **兩條上界規則**都有測試 —— ✅
2. **違規訊息指名欄位**（`started_at_ms` / `ends_at_ms` + 當時 `now` + 容忍值） —— ✅
3. **違規不改動任何列**（冷啟動的冪等 DDL 除外，措辭已在 AC/D5 校正） —— ✅
4. **明確的錯誤碼**：`{error:"SESSION_CORRUPT", recoverable:false}` 500 —— ✅
5. **容忍真實時鐘回調**：30 秒回調放行（並誠實記下 `elapsed + TOL` 的代價） —— ✅
6. **不擋過期收尾**：`expireSession` 路徑原樣 —— ✅
7. **突變 10 條全死**（其中 M8/M9/M10 是 Gate 4 之後才補的） —— ✅
8. **呼叫端全數帶時間**：`read(` 共 **13 處**（`meeting-do.ts` 1 + `session-store.test.ts` 7 + `session-clock.test.ts` 5） —— ✅

## 3. 驗收指令與結果（實際貼上）

```text
# Gate 1（TDD）：新檔先寫 → 先紅 → 後綠（Gate 4 第一輪後追加 6 條 → 16 條）
$ cd worker && npx vitest run test/session-clock.test.ts
 Tests  7 failed | 3 passed (10)          ← 動手前（/tmp/tech08-gate1-red.log）
 Tests  10 passed (10)                    ← 動手後（第一輪）
 Tests  16 passed (16)                    ← 第一輪修正後（含 6 條釘樁／邊界）

# Gate 3：worker 全量（21 檔；本票新增 1 檔）
$ npx vitest run
 Test Files  21 passed (21)
      Tests  263 passed (263)

# Gate 3：回歸探針（DoD）
$ REGRESSION_MODULE=M01 npm run regression
[regression-guard] 結果：passed=214 failed=0

# Gate 2：型別 + Markdown 樣式（65 檔，含本票新增/修改的 AC、設計與交付文）
$ npm run lint            # tsc --noEmit && markdownlint-cli2
Linting: 65 files
Summary: 0 issues in 0 files

# Gate 3：UI 回歸（本票未動 UI，跑的是回歸）
$ cd app/ui && npx vitest run
      Tests  188 passed (188)
$ npm run lint              # svelte-check + 圖示守門
掃描 48 檔 · 圖示表 3 個（原型 32 個）· 程式碼用到 3 個：chat, mic, ban
$ npx playwright test --output=/tmp/pw-tech08b
  35 passed (41.2s)                       ← /tmp/tech08-e2e.log / /tmp/tech08-e2e2.log

# 真 workerd 冒煙（TECH-004 的腳本；本票動到 DO 讀取路徑，屬回歸）
$ npx wrangler dev --port 8806 --local --var HARNESS_PROVIDER:faux &
$ DO_SMOKE_BASE=http://127.0.0.1:8806 DO_SMOKE_RUN_ID=tech08b node scripts/do-smoke.mjs
exit=0；66 項檢查全過（+1 行彙總 = 67 ✅ / 0 ❌；log /tmp/tech08-smoke2.raw）
```

### 突變驗證（證明探針不是空的）

腳本 `/tmp/tech08-mutations.sh`、log `/tmp/tech08-mutations.log`；每條都是「改檔 → 跑新檔 → 還原」，
**新檔 16 條**為基準。

| # | 突變 | 死了幾條 |
| --- | --- | --- |
| M1 | 移除 `read` 的時間檢查呼叫 | 5 |
| M2 | 容忍值改成 `Number.MAX_SAFE_INTEGER`（等於不驗） | 8 |
| M3 | 邊界由 `>` 改成 `>=`（+TOL 被誤擋） | 1 |
| M4 | 只驗 `ends_at`、不驗 `started_at` | 1 |
| M5 | DO 讀取不帶真實時鐘（傳 `0`） | 4 |
| M6 | 違規時仍把 snapshot 寫回（破壞唯讀） | 1 |
| M7 | 拿掉 `SESSION_CORRUPT` 專屬映射（退回 `INTERNAL`） | 2 |
| M8 | **偷偷補上下界**（未經設計的「好心修正」） | 2（**殺掉的是 AC-3 的放行護欄**，不是釘樁群；見下方更正）|
| M9 | 拿掉 `nowMs` 有限性檢查 | 1 |
| M10 | `alarm()` 提早返回（不再收 session） | 1 |
| — | 還原後基準 | **16 passed (16)** |

兩次「突變改變思考」：

- **M6（第一輪）**：原斷言「DB 欄位值不變」抓不到「把同一份壞資料寫回去」→ 改成
  「違規後非 SELECT 語句數不變」才殺掉。**測試通過了，卻在守一個它守不到的東西。**
- **M8（第二輪，已被第二輪 oracle 實跑推翻判讀）**：我原本以為「偷偷補上下界」能證明釘樁群不是空的。
  oracle 自己重跑同一突變兩次，殺掉的兩條其實是 **AC-3 的放行護欄**（`:140` 合法舊會議、`:145` 錄到上限沒人碰過），
  檔尾兩條釘樁（`:216` 已錄 1h 再推 1h、`:229` 過期復活）**全綠**。
  原因：釘樁兩條的 `started_at ≈ now`（`Δ = elapsed`），任何「位置型」上下界都不會命中。
  **結論（已知弱點，誠實列帳）**：目前的程式空間裡**沒有任何單點突變能殺死那兩條釘樁測試**；
  它們現在是「把已知限制寫成規格」的文件化斷言，效力要等 **TECH-014** 真的接上 DO 外錨點時才體現
  （屆時它們必須被改寫成「擋下」，那才是它們的紅燈路徑）。
  **這也修正了我的方法論**：宣稱「釘樁群非空」前，必須確認**死掉的是哪幾條**，不是只數死亡條數。

### 截圖

本票 worker-only、**沒有任何畫面改變** → 依「畫面文案與截圖一致性」規則，無需（也不該）重拍。

## 4. 誠實聲明：**沒有**被驗到／擋不住的部分

1. **擋不住的平移（本票最大限制）**：`Δ ≤ elapsed + 60s` 的平移一律放行 ——
   包含「已錄 1 小時後再推 1 小時」與「已過期會議被搬回現在」。AC-6 把它釘在測試裡；
   真正的補法需要 DO 外的錨點（TECH-014）。**不要引用本票說「同量平移已擋住」。**
2. **DO alarm 不能當第二錨點**：平移後 alarm 一度還是舊值，但到點後會跟著被改的 `ends_at` 重排
   （oracle F6 實測）→ 線索消失。
3. **壞資料的 DO 會被平台反覆喚醒**：`alarm()` 也拋 `SESSION_CORRUPT`（設計 D4），
   沒有重排、沒有伺服器端 log（`wrangler` log 內 `grep SESSION_CORRUPT` 為空）。
4. **裝置端的降級缺口**：`app/ui` 完全沒消費 `recoverable`，只顯示「請確認網路後再試」，
   音檔會無限退避重試；「讓使用者匯出已錄音檔」之類的降級屬 UI 決策 → 未做。
5. **其他欄位的寬鬆（既有、非本票引入）**：`transcript_writes=-5`、`meeting_id=''`、
   `state=ended` 但 `ended_at_ms=NULL`、`state=recording` 卻有 `ended_at_ms`、`started_at_ms` 是字串
   → 全部放行（oracle F8）。留給後續票，不混進這張。
6. **真兩小時會議 / 生產環境的時鐘回退頻率**：容忍值與上限的比例是算出來的，沒有現場資料。
7. **`rule2`（`ends_at` 上界）在正式路徑不可達**：它是 defense-in-depth（reviewer P2-5）。
8. **釘樁群沒有可用的殺手突變**：AC-6 的兩條「已知限制放行」測試在**目前程式空間內沒有任何單點突變能殺死**
   （M8 殺掉的是 AC-3 護欄；第二輪 oracle 實測）→ 它們現在是「把已知限制寫成規格」的文件化斷言，
   紅燈路徑要等 TECH-014 落地。
9. **真 workerd 的「竄改 DB」是 oracle 代跑的**：本票自己的冒煙腳本沒有這一項；
   oracle 在 8824 埠的真 workerd + 真 DO SQLite 上複驗了三條路由皆 500 `SESSION_CORRUPT`，
   並實測「同量平移 +63,426ms 被放行」。

## 5. 與審查（Gate 4）的關係

### 第一輪（reviewer 靜態 + oracle 對抗式並行）

| 通道 | 結論 | 主要發現 |
| --- | --- | --- |
| reviewer（靜態） | **可合併（含注意事項）** | P0/P1 = 0；P2-1 `alarm()` 會拋（會重試）；P2-2 唯一讀取入口只是慣例；P2-3「沒有非 SELECT 語句」措辭過度；P2-4 呼叫端數目寫成 7 實為 8；P2-5 rule2 不可達 |
| oracle（對抗式，真 workerd + 真 workerd SQLite） | **需修正後合併** | **F1（P1）**：宣稱過大 —— 真正的不變式是 `Δ > elapsed + TOL`，AC 自己描述的「錄 1h 後推 1h」情境**沒有被擋下**（實測 200 / `remainingMs=7,200,000`）；F2 壞 `nowMs` 靜默放行；F3 回跳容忍量也是 `elapsed + TOL`（會議開頭回跳 61s 就 500）；F4 UI 未消費 `recoverable`；F6 alarm 不能當錨點；F7 冷啟動 DDL；F9 交付文 64→65 檔 |

### 我怎麼處置（全部已落地）

| 發現 | 處置 |
| --- | --- |
| **F1（P1）** | AC 的目標段落與背景表重寫為 `Δ > elapsed + TOL` 的可驗證句子；設計 D3 保留「校正前（錯的）／校正後（對的）」痕跡；新增 **AC-6 釘樁群 6 條**（放行 2 + 真邊界 1 + 回跳代價 1 + 壞時鐘 1 + alarm 1）；交付文 §1/§4 同步；真正的補法另立 **TECH-014** |
| **F2（P2）** | `read()` 加 `Number.isFinite(nowMs)` → `SessionCorruptError`；新增 1 條測試；**突變 M9** 證明它有效 |
| **F3（P2）** | AC-2 明寫「回跳容忍量＝`elapsed + TOL`，會議開頭回跳 61s 會 500」；新增 1 條測試；交付文 §4 列為待決產品風險 |
| F4（P2） | 交付文 §4 記明（UI 未消費 `recoverable`、音檔無限重試）→ 屬 UI 決策 |
| F5 / P2-5 | 設計 D5 + AC-3 註明 rule2 是 defense-in-depth、正式路徑不可達 |
| F6（P3） | 設計 D7：三個候選錨點（含 alarm）都不可行，並記實測結果；**TECH-014 不要走 alarm** |
| F7 / P2-3 | AC-1 / D5 / 測試註解改為「不改動任何列；冷啟動的 `CREATE TABLE IF NOT EXISTS` 是冪等 DDL」 |
| P2-1 | 新增 alarm 行為測試（rejects `SESSION_CORRUPT`）；設計 D4 記明副作用與「目前沒有補償」；**突變 M10** 證明這條測試不是空的 |
| P2-2 | 設計 D1 增列**文件級不變式**：唯一讀 `meeting_session` 的入口是 `SessionStore.read(nowMs)` |
| P2-4 | 呼叫端數目改以 `grep` 實數為準：13 處（DO 1 + `session-store.test.ts` 7 + `session-clock.test.ts` 5）；第二輪 reviewer F-5 再抓到三處文件各寫 7／8／3 → 全部統一 |
| F9 | 交付文檔數 64 → 65（且 Gate 4 後再增為 65 檔 0 issues） |

### 第二輪（reviewer 只讀複驗 + oracle 執行複驗，並行）

修正只動 **1 行 runtime（`Number.isFinite`）+ 測試 + 文件**，未動 `session.ts` 的規則本身、
未動 `meeting-do.ts` 的路由行為；兩條通道都做**只讀複驗**。

| 通道 | 結論 | 主要發現與處置 |
| --- | --- | --- |
| reviewer2（只讀） | **OK with notes（0 P0）** | F1 的校正與程式**逐字等價**（`違規 ⟺ Δ > elapsed + TOL` 有代數推導、rule2 不可達有證明、釘樁斷言值推導成立、`alarm()` 沿途無 try/catch 確認會拋）。F-1~F-3（backlog 殘留過大句／舊數字／TECH-014 不存在）是它讀到**修正尚未落盤**的快照 → 已補；F-4 trust-log 未寫、F-5 呼叫端 7/8/3 → 統一 13、F-6 註解誤指 D6 → 改 D7、F-7 US-101 舊文 → 補註，**全部在 commit 前落地** |
| oracle2（執行，真 `node:sqlite` + 真 workerd + 自製探針） | **需修正後合併**（code 不重做） | ✅ F1 真的修好（Δ−elapsed = 60000 放行 / 60001 擋下，獨立重算）；✅ F2/F3 與文件一致（極端值表、回跳門檻表 `E=0 → R>60s`、`E=20min → R>1260s`）；❌ **B2（P1）** `session.ts:26-28` 常數註解仍留「真正要擋的是同量平移（小時級~年級）」過大話 → 已改寫；❌ **B3（P1）** **M8 的判讀是錯的**：補下界殺掉的是 AC-3 兩條護欄（`:140/:145`），釘樁兩條全綠 → 已在設計 D7 與本交付文原文更正，並承認「目前**沒有**單點突變能殺死釘樁群」；B4 註解 D6→D7（已修）；B7 測試名補「（elapsed 0）」（已修）；B1 期間 backlog 曾 2 條 MD013 紅（已修） |

### 凍結之後才動的（誠實揭露）

- 第一輪凍結的 patch（5 檔 / +273/−11 / sha256 `60a3f9a6…`）在審查期間**沒有被改動**；
  修正是在**兩條通道都回來之後**一次落地（因此第一輪審查看到的是同一份原始碼）。
- 第二輪審查（reviewer2/oracle2）在我把 backlog / trust-log 落盤**之前**讀到快照，
  所以它們報的 F-1~F-3（reviewer）是「還沒補」，不是「補錯」。
- 第二輪之後又動了 3 處，都在**兩條通道回來之後**一次落地，且都是文件／註解與測試名（`session.ts` 只動註解、規則未動）：
  ① `session.ts:26-28` 常數註解（B2）；② 測試名 `:183` 與註解 D6→D7（B7/B4）；③ 設計 D7／交付文 §3／trust-log 的 M8 判讀更正（B3）。
  這批修正**沒有再送第三輪審查**，是本票第二個殘餘風險（第一個是 TECH-013 遺留的「第二輪修正未再複審」）。

## 6. §2.4 反思（六維度）

### 1. 這一票做得好的地方：把「呼叫端有幾處」先算清楚再決定必填

「`nowMs` 必填還是可選」看起來是小決定，但它決定這條防線會不會在某次未來改動裡靜默消失。
動手前先 `grep` 呼叫端 → 成本幾乎是零 → 直接選最不容易爛掉的設計。
**決策的成本要用「改動的面積」估，不是用「哪個寫起來順」估。**

### 2. 最大的技術收穫：差值與位置是兩件事，而「位置單邊」也有量值

`ends - started == 2h` 是**差值**不變式，對整體平移完全無感。
更進一步：改成「位置的上界」之後，保護強度**取決於平移量與已錄時間的關係**
（`Δ > elapsed + TOL`）。任何單邊的位置檢查都要問一句「**被放行的量值上限是多少、它會不會隨時間長大？**」

### 3. 最大的失誤：我把「擋下同量平移」寫進 AC，而它只在部分情況成立

這一票的原始動機是「錄了 1 小時後再推 1 小時 → 上限變 3 小時」。我寫了檢查、跑了 7 條紅轉綠、
跑了 7 條突變、三條閘門全綠 —— **然後在文件裡宣稱我擋住了那個情境**。實際上沒有：
我的竄改測試全跑在 `elapsed = 0` 這個退化點上，綠燈給出的是**假的保證**。
是 oracle 真的去構造「先 tick 1 小時再平移」才把它打出來（實測 200 / 上限變 3h）。

教訓：**「測試都過」不代表「宣稱成立」**，尤其當測試只覆蓋了參數空間的一個角落。
自己在寫 AC 時就要把宣稱寫成**可驗證的形式**（本例：`Δ > elapsed + TOL`），
而不是寫成願望（「擋下同量平移」）——後者看起來完成了，其實沒有。

### 4. 測試的層次：先紅群 / 護欄群 / 釘樁群要分清楚

新檔 16 條 = 先紅 7 + 護欄 3（時鐘回調、DO happy path、上限收尾）+ 釘樁 6
（放行 2 + 真邊界 1 + 回跳代價 1 + 壞時鐘 1 + alarm 1）。
**釘樁群的意義是「已知限制就是規格的一部分」**：它在正常情況必然通過。
若要說它「不是空的」，必須指出**哪一條突變殺死它** —— 第二輪 oracle 實測的答案是：**目前找不到**
（M8 殺掉的是 AC-3 護欄）；它的紅燈路徑要等 TECH-014 落地。

### 5. 品質與速度

| 項目 | 數字 |
| --- | --- |
| 新增測試 | 6 條（Gate 4 後）+ 原有 10 條 = 16 條 |
| 突變 | 10 條全死（M6 第一版存活、M10 第一版無效，都換掉重做） |
| 實作面積 | 3 個 src 檔（+85/−11 行） |
| Gate 4 通道 | 第一輪 2 條並行、第二輪 1 條只讀複驗 |
| 回歸 | worker 263 / M01 214 / UI 188 / E2E 35 / 冒煙 66 項 |

### 6. 對 Backlog 的影響（下一票的輸入）

- 新增 **TECH-014（P1 / 3 SP）**：DO 外的可信錨點 —— 讓「已錄時間以內的平移」可被偵測。
  **先讀設計 D7/F6：`created_at_ms`、alarm、逐字稿筆數三個候選都不可行。**
- 待決（UI）：裝置端收到 `SESSION_CORRUPT` 的降級（匯出已錄音檔？強制重開？）。
- 待決（產品）：容忍值 `60s` 在「會議開頭」的鎖死代價是否可接受。
- TECH-012（P1 / 3 SP，跨請求等價）仍是 US-104 的前置，與本票無耦合。

## 7. 變更清單（送審用的完整範圍）

| 檔案 | 性質 |
| --- | --- |
| `docs/ac/TECH-008.md` | 新增（AC-1~AC-6 + 刻意不做；F1 後重寫目標與背景表） |
| `docs/design/TECH-008-session-clock-validation.md` | 新增（D1~D7 + 突變清單 + 限制；F1 後保留校正痕跡） |
| `docs/deliverable/2026-10-09-TECH-008-session讀取帶now時間.md` | 新增（本檔） |
| `worker/src/session.ts` | `SESSION_CLOCK_TOLERANCE_MS` + `sessionClockViolation` + 真實不變式的註解 |
| `worker/src/storage/session-store.ts` | `read(nowMs)` 必填 + `nowMs` 有限性檢查 + `SessionCorruptError` |
| `worker/src/meeting-do.ts` | `#readSession` 帶 `this.#now()`；`SessionCorruptError` → 500 `SESSION_CORRUPT` |
| `worker/test/session-clock.test.ts` | 新增（16 條：先紅 7 + 護欄 3 + 釘樁 6） |
| `worker/test/session-store.test.ts` | 6 條測試的 7 個 `read(` 呼叫點補上時間 |
| `docs/backlog.md` | TECH-008 → DONE；新增 TECH-014 |
| `docs/trust-log.md` | trust mode 條目 |

> 送審 patch（第一輪凍結，審查期間未再改動）：`/tmp/tech08-review.patch` = 5 檔、+273/−11、
> sha256 `60a3f9a6f04a788ff08693467033127144525a378dae0483501546a1f51f4ac4`。
