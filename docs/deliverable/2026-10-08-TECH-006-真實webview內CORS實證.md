# TECH-006 真實 Tauri webview 內的 CORS 實證

> **交付日期**: 2026-10-08
> **對應 Backlog**: TECH-006
> **Module**: M01（會議錄音與收音）— 跨層技術票（worker 邊緣 + Tauri 外殼）
> **交付狀態**: ✅ 完成（iOS 真機來源仍待用戶驗收，見 §5）

## 1. 這次完成什麼

把「`tauri://localhost` 在 worker 白名單內」從**文件上的假設**變成**實測事實**：
在**打包後的真實 Tauri webview 內**對 worker 打一次核心會話請求，取得 wire／回應／webview 三層一致證據，
並把整個驗證程序做成**可重複**（不是一次性截圖）。

**關鍵成果**：

- ✅ 真實 webview 實測：worker log 4 行 `origin="tauri://localhost" allowed=true`（OPTIONS + POST × start/stop）
- ✅ 「webview 真的讀到回應」有**機械證據**：只有讀到 `201` 才會發的 `session/stop` 回呼（同時把探針建的會議收掉）
- ✅ 推翻 3 個寫在文件裡的假設（`tauri dev` 的來源、臨時埠、`tauri://localhost` 只在打包 app）
- ✅ 一輪獨立稽核的 P1 抓到我的**認知錯誤**（ACAO 讀不到），並已更正文件敘述

### 1.2 為什麼做這個改動

- **問題/脈絡**：M01-US-101 的核心動作（按「開始會議」）架在 `POST /m/:id/session/start` 上，
  而正式 app 的來源是 Tauri 自訂 scheme。`DEV_ORIGINS` 是照文件抄來的，**從來沒有被真的用過**。
  這類失敗的症狀極惡：CORS 被擋時請求在網路面板看起來「根本沒送出去」，使用者只看到「按了沒反應」。
- **為什麼選這個解法**：只有跑在真 webview 裡的程式能回答「來源是什麼」——curl／E2E（來源是 `http://localhost:1420`）
  都無法假裝。所以選擇「**worker 端觀測（log）＋ webview 端探針（真打一次）**」的雙邊設計，
  且兩邊都做成**可重複的機制**（旗標啟動、純函式可測），而不是一次性的 console 截圖。
- **成功怎麼看**：worker log 出現 `allowed=true` 且 webview 端讀得到 `201`／發得出 `stop`。
  **走錯的話**：只有伺服器有回、webview 端拿不到（＝被瀏覽器擋掉），或反過來只有「看起來成功」卻沒有可重現程序。

## 2. 做了什麼改動

### 2.1 新增檔案

| 檔案路徑 | 用途 |
|---------|------|
| `app/ui/src/lib/dev/cors-probe.ts` | webview 端探針：打一次 `/session/start`，讀到 201 才回呼 `stop`；純函式可測 |
| `app/ui/src/lib/dev/cors-probe.test.ts` | 14 條：旗標判斷、報告格式、失敗路徑、`stop` 語意、缺 `randomUUID` |
| `app/package.json` | 只負責轉發到 `ui/`（`npm run build` / `dev` / `test` / `lint`），解決 Tauri cwd 依呼叫目錄而變的問題 |

### 2.2 修改檔案

| 檔案路徑 | 改動內容 |
|---------|---------|
| `worker/src/cors.ts` | 新增 `corsDebugLine(origin, configured, debugFlag, method, path)` 純函式（`DEBUG_ORIGINS=1` 才輸出） |
| `worker/src/index.ts` | 在 OPTIONS 分支**之前**印那一行（preflight 也看得到） |
| `worker/test/cors.test.ts` | 新增 6 條（含 `" 1"`／`TRUE` 等非開啟值不得輸出） |
| `app/ui/src/main.ts` | `VITE_CORS_PROBE === "1"` 時把探針報告渲染成橫幅（top-level 常數判斷 → 未設時整段被移除） |
| `app/src-tauri/tauri.conf.json` | `beforeDevCommand` / `beforeBuildCommand` 回到 `npm run dev` / `npm run build` |
| `docs/ac/TECH-006.md` | 驗收標準、實測紀錄、三層證據、已知陷阱、DoD（v1.0 → v1.3） |

### 2.3 刪除檔案（如有）

| 檔案路徑 | 刪除原因 |
|---------|---------|
| — | — |

### 2.4 改動背後的理由

| 改動 | 為什麼這樣設計 | 放棄的選項 |
| --- | --------------- | ----------- |
| 探針「讀到 201 才回呼 stop」 | 讓**證據與清理是同一件事**：log 上出現 stop ⇒ 前面那個 201 真的被 webview 讀到；同時不留孤兒會議。截圖自動化需要輔助使用權限、不可靠 | 用截圖／OCR 當證據（不可靠、無法自動化；本票仍留一次 OCR 記錄作人工複核）|
| 探針 gate 只看 `VITE_CORS_PROBE`（**拔掉 DEV**） | 實測發現 `tauri://localhost` **只在打包 app 出現**；保留 DEV 條件就永遠驗不到要驗的對象 | 保留 `import.meta.env.DEV`（乾淨但這張票做不到）；改放 `app/src-tauri` 的 Rust 側（要改 Tauri 程式碼，成本大）|
| 探針**不讀** ACAO | 第一輪稽核證明：CORS 內部標頭不 expose 給 JS，真 webview 一定讀到 `null`，畫面「（無）」會被誤讀成 CORS 失敗 | 送 `access-control-expose-headers`（為了診斷而永久增加正式回應的表面積，不值得）；保留欄位但標註（誤讀風險仍在）|
| `app/package.json` 轉發 | Tauri 的 `beforeBuildCommand` cwd **依呼叫目錄而變**（`app/` → `app/ui`；`app/src-tauri` → `app/`）。加一層轉發後，`npm run build` 在兩種 cwd 都正確，且跨平台 | `if [ -d ui ]; then … fi`（我第一版用這個：macOS OK，但 Windows `cmd` 不合法，是**可攜性回歸**）；在文件寫「請在 `app/` 下執行」（把陷阱留給下一個人）|
| `corsDebugLine` 只在旗標下輸出 | log 會含來源資訊；預設靜默才安全。用**純函式**是為了能在單元測試裡窮舉各種「非開啟值」 | 用環境變數 `DEBUG=1`（與 wrangler／node 生態的既有旗標語意衝突，容易誤開）|

## 3. 驗收標準對應

| AC | 描述 | 結果 | 證據 |
|----|------|------|------|
| AC-1 | `DEBUG_ORIGINS=1` 時每個請求印一行 `[cors] origin=… allowed=… method=… path=…`；其他任何值不輸出 | ✅ | `worker/test/cors.test.ts` 14 passed（含 undefined／""／0／false／TRUE／" 1"／yes 皆不輸出）|
| AC-2 | `VITE_CORS_PROBE=1` 時 webview 內自動打 `/session/start`，顯示結果；讀到 201 才回呼 `stop`；未設旗標不執行且 bundle 不含程式碼；失敗不影響 UI | ✅ | `cors-probe.test.ts` 14 passed；未設旗標 `grep -o 'cors-probe\|session/start\|probe' dist/assets/*.js` **無輸出** |
| AC-3 | 在**打包後**的 app 內實測，worker log 顯示 `allowed=true` | ✅ | §4 實測紀錄 4 行原文（Agent 一次 + 獨立稽核者各一次）|
| AC-4 | 未設旗標時 E2E 6 條不受影響 | ✅ | `npx playwright test` → 6 passed (14.7s) |

## 4. 測試結果

| 測試類型 | 通過 / 總數 | 備註 |
|---------|-------------|------|
| 單元測試（worker）| 132 / 132 | 其中 `test/cors.test.ts` 14 條（TECH-006 佔 6 條）|
| 單元測試（ui）| 49 / 49 | 其中 `cors-probe.test.ts` 14 條 |
| 整合測試（worker M01 探針）| 83 / 83 | `REGRESSION_MODE=on REGRESSION_MODULE=M01 npm run regression` → `✅ 通過` |
| 整合測試（ui M01 探針）| 35 / 35 | 另有 14 條 TECH-006 測試被 M01 filter 跳過（模組邊界正確）|
| E2E 測試 | 6 / 6 | `npx playwright test` → 6 passed (14.7s)（未設旗標）|
| Gate 2 | ✅ | worker `npm run lint`（tsc 0 + markdownlint 47 檔 0 issues）；ui `tsc --noEmit` 0、`svelte-check` 0 errors 0 warnings |

**實測紀錄（打包 app 內的真實 webview，worker log 原文 4 行，同一 meeting id）**：

```text
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/db57c259-…/session/start"
[cors] origin="tauri://localhost" allowed=true method=POST    path="/m/db57c259-…/session/start"
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/db57c259-…/session/stop"
[cors] origin="tauri://localhost" allowed=true method=POST    path="/m/db57c259-…/session/stop"
```

收尾驗證：`GET /m/db57c259-…/session` → `200 {"phase":"ended","endedReason":"aborted","transcriptWrites":0}`。

**被實測推翻的三個假設**：① `tauri dev` 的 webview 來源不是 `tauri://localhost`，是 devUrl 的 http 來源
（實測 `http://localhost:1421` → `allowed=false`）② `tauri dev` 搭 `frontendDist` 也不是自訂 scheme
（Tauri 另起臨時埠 `http://127.0.0.1:1430` → `allowed=false`）③ 因此**驗證程序必須用 `cargo tauri build` 的 `.app`**。

## 5. 已知問題 / 限制

> ⚠️ 老實標記已發現但這次沒解決的問題，避免「假完成」。

| 問題 | 嚴重性 | 已記錄位置 |
|------|--------|-----------|
| **iOS 真機**的 webview 來源仍未實測（只有模擬器；`project.yml` 無 `DEVELOPMENT_TEAM`）| P1 | `docs/ac/TECH-006.md`「已知邊界」＋ M01-US-101 DoD（待用戶 iPhone）|
| dev 模式若前端埠漂移（例如 1420 被佔用、Tauri 改指其他埠）→ webview 來源不在白名單 → 症狀與正式被擋**一模一樣** | P2 | `docs/ac/TECH-006.md` 附帶發現；本票 §6 轉 TECH-010 |
| 探針／實測流程仍為手動（build app → 開 app → 讀 log／OCR）| P2 | 同上（TECH-010）|
| `TECH-006` 的 TDD「先紅後綠」只有對話與本檔記錄，repo 內**沒有**紅燈階段的提交 | P2 | 本檔「誠實揭露」（獨立稽核者已指出無法從 artifact 回溯）|

**後續補充（2026-10-08 當日，iOS 驗收準備）**：上面第 1 列（iOS 未實測）已**部分解除**——
在 **iPhone 18 Pro 模擬器（真 WKWebView）**內實測，worker log 同樣是
`origin="tauri://localhost" allowed=true`（4 行，meeting `03a0851c-…`），且 iOS 上 M01 的 Svelte UI 正常渲染。
**仍未驗**：iPhone **真機**（需簽章 Team ID + 開發者模式）。真機指令與判讀表見
`docs/ac/TECH-006.md` §「真機驗收程序」；收音能力不重測（已在 `docs/spike/SPIKE-002.md` §3.2 實測）。

## 6. 下一步建議

### 6.1 立即可做（建議優先）

1. **iOS 真機驗收 webview 來源** — 用你的 iPhone 跑一次（跑 app 時把 worker 以 `DEBUG_ORIGINS=1` 起著），
   讀 log 的 `origin=` 是否為白名單內的值。
   - **為什麼這個優先**：M01 的產品目標平台就是 iPhone；桌面 macOS 已證實，iOS 是**唯一還沒被證實的目標平台**，
     而它的失敗症狀最貴（使用者按了沒反應）。
2. **TECH-010：dev 埠漂移的診斷與實測自動化**（1 SP）— 讓 `allowed=false` 在開發時看得懂（不再與正式被擋同症狀），
   並把「建 app → 讀 log → 判定」腳本化，讓之後每一票都能一句指令重跑。
   - **為什麼這個優先**：它是本票暴露出的**唯一新缺口**，且會影響每一個後續涉及 webview 的票（重複踩雷成本高）。

### 6.2 下一個 Sprint 考慮

- [ ] TECH-007（E2E 補 iPhone viewport，1 SP）
- [ ] TECH-009（worker 邊緣授權／速率限制 + `/wake` GET→POST，3 SP）

### 6.3 長期方向（Think Big）

- **把「來源可觀測」變成平台能力**：worker 端對 `allowed=false` 的來源給**可辨識的提示**（不是靜默 403），
  這樣前端、iOS、未來的桌面／其他 shell 都能自助診斷，而不是每一票都重做一次實測。
- **真機平台矩陣**：iOS / macOS / 未來 Windows 各自的 webview 來源應該被**記錄成一張表**並由 CI 驗證，
  讓「來源」不再是每次都要重新發現的事。

## 8. 反思（Reflection 末段）

> **反省層級 = 子任務／US 級（輕量路徑）**；`which jev-use` → exit 1 ⇒ `JEV_AVAILABLE=false`（軟性降級），
> 但本機 pi `jev_judge` 可用，已用於關鍵 2 維度打分 + 反思結果驗證（見 §8.4）。

### 8.1 6 維度檢查

| # | 維度 | 結果 | 備註 |
| - | --- | --- | --- |
| 1 | UX/UI 一致性 | ✅ | 探針橫幅只在開發者刻意開旗標時出現，樣式沿用 DESIGN tokens；正式 app 不含（grep 0）|
| 2 | RWD 響應式設計 | ⚠️ | 本票無新 UI；RWD 缺口仍是 TECH-007（E2E 未跑 iPhone 寬度）|
| 3 | 技術債 | ⚠️ | 新增 dev-only 探針留在 repo；`app/package.json` 多一層轉發；dev 埠漂移未防護 |
| 4 | 可維護性 | ✅ | 純函式 + 28 條新測試；每個「為什麼」都寫進程式註解與 `docs/ac/TECH-006.md` |
| 5 | 測試覆蓋率 | ⚠️ | 桌面 macOS webview 有可重現證據；**iOS 真機未測**（產品目標平台）、E2E 未在 iPhone 寬度跑 |
| 6 | 需求對齊 | ✅ | 原始痛點（來源未經實證）被直接解答，且驗證程序可重複（獨立稽核者也重現成功）|

### 8.2 問題清單（每個 ⚠️／❌ 必含「根因 + 建議」）

- ⚠️ [P1] iOS 真機 webview 來源未實測 — 根因：無實體裝置 + 專案無 `DEVELOPMENT_TEAM` — 建議：用戶 iPhone 驗收時以
  `DEBUG_ORIGINS=1` 讀來源（不需新票，掛 M01-US-101 DoD）
- ⚠️ [P2] dev 埠漂移 → CORS 被擋，症狀與正式被擋相同 — 根因：webview 來源 = devUrl／臨時埠，白名單只有固定埠 —
  建議：開 TECH-010
- ⚠️ [P2] 實測流程手動（build + open + 讀 log／OCR）— 根因：Tauri webview 不易自動化 — 建議：併入 TECH-010
- ⚠️ [P2] TDD 紅燈階段沒有 commit artifact — 根因：TDD 迴圈在單一工作階段內完成、未逐階段提交 — 建議：後續票在紅燈時先提交一次（低成本、可回溯）

### 8.3 Action Items（每個填滿「動作 + 類型 + 驗收標準 + 預估」）

| # | 動作 | 類型（TECH/DE/US/Spike）| 驗收標準 | 預估 |
| - | -- | ----------------------- | -------- | ---- |
| 1 | dev 埠漂移的診斷（`allowed=false` 給可辨識提示）＋ webview 實測腳本化 | TECH-010 | ① 開發者能一眼分辨「被白名單擋」與其他失敗 ② 一句指令完成「建 app → 讀 log → 判定 PASS/FAIL」並在 CI／本機可重跑 | 1 SP |
| 2 | iOS 真機驗收 webview 來源（用戶執行，Agent 準備指令與判讀）| 無新票（掛 M01-US-101 DoD）| iPhone 跑 app 後，worker log 的 `origin=` 在白名單內且 `allowed=true`；結果回填 `docs/ac/TECH-006.md` | 用戶 ~10 分 + Agent ~5 分 |
| 3 | 後續票的 TDD 紅燈階段先提交一次 | 流程紀律（無票）| 至少下一張有 TDD 的票，`git log` 能看到紅燈提交 | 每次 ~1 分 |

> **待用戶確認 Action Items**：以上 3 項的優先序（第 1 項是否本 Sprint 做、第 2 項何時安排）。

### 8.4 Reviewer 二審結果（V03 紀律）

- **非 SOP 修改**（本票為程式碼＋專案文件），故不觸發 V03；但依 §2.3 Gate 4 走**獨立稽核**：

| 輪次 | P0 | P1 | P2 | 處置 |
| --- | --- | --- | --- | --- |
| 1 | 0 | 1（ACAO 讀不到卻寫成證據）| 4 | 全修（`6929a8d`）|
| 2 | 0 | 0 | 3（文件數字／斷言前提／Windows 可攜性）| 全修（`e3b33cb`）|

- **stop-loop 裁決**：第 2 輪為同家族文件級 P2 共 3 條 → 觸發 stop-loop 規則 → **2026-10-08 用戶裁決：接受 Gate 4**，進入 §2.4／§2.5。
- **jev 輔助**（`jev-use` 不可用，改用本機 `jev_judge`）：
  - 測試覆蓋率：jev → `✅`（0.78）、LLM → `⚠️`；**不一致以 LLM 為準**（理由是 iOS 真機＝產品目標平台仍未測）。
  - 需求對齊：jev → `✅`（0.88），與 LLM 一致。
  - 反思驗證（noul）：jev 回 **0.53、信心 0.06 → `escalate: true`（unsure）**。
- **⚠️ jev escalate 待確認**（不自行補答，交由用戶／後續票判斷）：
  1. 我列出的 3 個 ⚠️ 是否**已經涵蓋**這票真正該擔心的事？（候選補充：探針在正式 app 被誤設旗標時會真的開一場會議 → 資料污染；以及 `corsDebugLine` 的 log 輪替／噪音）
  2. 「dev 埠漂移」是否值得升到 P1（它會讓開發者在**本機**看到與正式被擋相同的症狀）。

## 7. 相關文檔連結

- [Backlog 對應項目](../backlog.md)
- [驗收標準 TECH-006](../ac/TECH-006.md)
- [M01-US-101 交付文](./2026-10-08-M01-US-101-一鍵開始結束會議錄音.md)
- [系統架構](../../system-design.md)（前端框架 §2.3 RESOLVED = Svelte 5）

---

**產生者**: Agent (透過 dav-submitter skill)
**產生時間**: 2026-10-08 23:36
