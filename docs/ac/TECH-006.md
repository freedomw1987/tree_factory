# TECH-006 — Tauri webview 來源在真實 webview 內實證 CORS 與收音（驗收標準）

- **票號**：TECH-006（P1 / 1 SP / 依賴 M01-US-101；由 §2.4 反思維度 6 轉出）
- **目標**：把「`tauri://localhost` 在白名單內」從**文件上的假設**變成**實測事實**。
  在**真實 Tauri webview** 內對 worker 打一次核心會話請求，並同時取得三層證據：
  ① **wire 層**：worker 實際看到什麼 `Origin`；② **回應層**：`access-control-allow-origin`
  是否命中該值；③ **webview 層**：該回應被 webview **接受**（前端拿得到 201，不只是「伺服器有回」）。
- **實作**：`worker/src/cors.ts`（`corsDebugLine`）、`worker/src/index.ts`（`DEBUG_ORIGINS` 觀測）、
  `app/ui/src/lib/dev/cors-probe.ts`、`app/ui/src/main.ts`（旗標啟動）、`app/ui/src/screens/DevProbe.svelte`
- **測試**：`worker/test/cors.test.ts`（cors 共 14 條，其中 6 條屬 TECH-006）、
  `app/ui/src/lib/dev/cors-probe.test.ts`（10 條）；另加真 webview 實測（本檔「實測紀錄」）

## 背景（為什麼要有這一票）

M01-US-101 的第 1 輪獨立稽核（checker）與 §2.4 反思各自指出同一件事：
E2E 跑的來源是 `http://localhost:1420`，但**正式 app 在 Tauri webview 內的來源是另一回事**
（macOS / iOS 都是自訂 scheme，通常是 `tauri://localhost`）。`DEV_ORIGINS` 是照文件寫進去的，
**從來沒有被真的用過**。

這類失敗最痛的地方是它的**症狀**：CORS 被擋時，請求在網路面板看起來「根本沒送出去」，
使用者只看到「按了開始會議沒反應」。而 M01-US-101 的核心路徑正好就架在這條請求上。

## 驗收標準（BDD）

### AC-1 觀測能力（可重複，非一次性 log 截圖）

- **Given** worker 以 `--var DEBUG_ORIGINS:1` 啟動
- **When** 任何請求進來
- **Then** 標準輸出多一行 `[cors] origin="…" allowed=true|false path="…"`
- **And** `DEBUG_ORIGINS` 未設定、空字串、`0`、`false`、`TRUE`、`" 1"`（帶前導空白）→ **不得**輸出
  （`1` 是唯一開啟值；避免在正式環境刷 log）
- **And** `Origin` 不存在時仍然輸出一行（`origin="(none)"`），因為「沒有 Origin」本身就是線索
- **And** 這行只由**純函式** `corsDebugLine(origin, configured, debugFlag)` 產生，
  可直接單元測試，不必真的起 worker

### AC-2 webview 端探針

- **Given** app 以 `VITE_CORS_PROBE=1` 建置（build-time 變數）
- **When** app 載入完成
- **Then** 自動對 worker 打 `POST /m/<uuid>/session/start`（**真的核心路徑**，不是 ping）
- **And** 把結果以純函式 `formatProbeReport()` 格式化後顯示在 `data-testid="cors-probe"` 的區塊，
  內容含：`location.origin`、HTTP status、回應的 `access-control-allow-origin`、
  或（被擋時）錯誤訊息
- **And** 探針**只在讀到 `201` 時**回呼 `POST /m/<uuid>/session/stop {reason:"aborted"}`：
  一來把探針建的會議收掉，二來這筆請求**就是「webview 真的讀到了回應」的機械證據**
  （CORS 被擋時 `fetch` 直接丟例外，不可能走到這個分支）
- **And** `VITE_CORS_PROBE` 未設為 `1` → **完全不執行、不渲染**（E2E 6 條必須維持不動）
- **And** 探針失敗**不得**影響正常 UI（不丟例外、不阻擋錄音流程）

> ⚠️ **與初版的差異（實測後修正）**：初版把探針條件訂為「`VITE_CORS_PROBE=1` **且** `import.meta.env.DEV`」。
> 實測發現 `tauri dev` 的 webview 來源是 devUrl 的 http 來源，而**真正上線的 `tauri://localhost`
> 只存在於打包後的 app**（見「實測紀錄 → 被實測推翻的假設」）。若保留 DEV 條件，這張票
> 就永遠驗不到要驗的對象，所以 gate 改成只看旗標。
> 安全上仍收得住：旗標是 **build-time** 變數（vite 會內聯，未設即死碼），且探針不開放任何新入口。

### AC-3 實測結果（本票真正的產出）

- **Given** 真實 Tauri 桌面 webview（與 iOS 同一套 Origin 機制）
- **When** 依「實測紀錄」小節的步驟啟動
- **Then** 三層證據一致：webview 的 `location.origin` ＝ worker 收到的 `Origin` ＝ `ACAO` 值，
  且該值在 `DEV_ORIGINS` 內
- **And** 若三者不一致 → **修** `DEV_ORIGINS`（或正式環境的 `ALLOWED_ORIGINS` 設定）並在本檔留紀錄
- **And** 若 webview 層失敗（拿不到 201）→ 本票視為**未完成**，因為那正是要防的症狀

### AC-4 不污染正式路徑

- **Given** 未設定 `VITE_CORS_PROBE`
- **When** 跑 `app/ui` 的 40 條單元測試 + 6 條 E2E
- **Then** 全綠（與 M01-US-101 交付時相同）
- **And** 探針程式碼即使被 bundle 進去，也**不會**執行（旗標未設時 `probeIfEnabled` 直接回 `null`）
- **And** 探針**不得**讓 app 多出任何正式依賴（只用 `fetch` / `crypto.randomUUID`，不引入新套件）

## 已知邊界（誠實記載）

1. 桌面 webview 與 iOS webview 走**同一套** Origin 機制（WKWebView 的自訂 scheme），
   但**不是同一個裝置**——iOS 上的真機驗收仍屬 M01-US-101 的 DoD，本票不取代它。
2. 本票只證明「來源在白名單內、請求能被 webview 接受」；**不**證明收音品質、背景錄音
   （那是 SPIKE-002 / M01-US-106 的範圍）。
3. 探針會在 worker 上**真的建一場會議**（id 為隨機 uuid），並在讀到 `201` 後自動 `stop`
   （`reason=aborted`）把資料收掉——不會留下「錄音中」的孤兒會議（實測已驗；見「收尾驗證」）。

## 實測紀錄（2026-10-08）

**怎麼跑出來的**：

1. worker：`npx wrangler dev --port 8787 --local --var HARNESS_PROVIDER:faux --var DEBUG_ORIGINS:1`
2. app：`VITE_CORS_PROBE=1 cargo tauri build --debug`（產出 `app/src-tauri/target/debug/bundle/macos/tree-factory.app`）
3. `open tree-factory.app` → 探針在 webview 內自行發動 → 看 worker log

**worker log 原文（4 行，同一個 meeting id）**：

```text
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/db57c259-931f-430c-b8de-195f7baef8d1/session/start"
[cors] origin="tauri://localhost" allowed=true method=POST    path="/m/db57c259-931f-430c-b8de-195f7baef8d1/session/start"
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/db57c259-931f-430c-b8de-195f7baef8d1/session/stop"
[cors] origin="tauri://localhost" allowed=true method=POST    path="/m/db57c259-931f-430c-b8de-195f7baef8d1/session/stop"
```

> 註：上方為可讀性對齊了 `method=` 欄後的空白（原文是單一空格）。數字、來源、方法、路徑皆為原文。

**三層證據怎麼對上**：

| 層 | 證據 | 值 |
| --- | --- | --- |
| wire | worker 收到的 `Origin` | `tauri://localhost` |
| 回應 | `access-control-allow-origin`（`allowed=true`） | `tauri://localhost`（命中 `DEV_ORIGINS`）|
| webview | 第 3、4 行 `session/stop`（只有讀到 `201` 才會發） | 讀到 ✅ |

**收尾驗證**（探針建的會議確實被收掉）：

```text
GET /m/db57c259-931f-430c-b8de-195f7baef8d1/session
→ 200 {"phase":"ended", "endedReason":"aborted", "transcriptWrites":0, ...}
```

### 被實測推翻的假設（本票最有價值的副產品）

1. **`tauri dev` 的 webview 來源不是 `tauri://localhost`**，而是 `devUrl` 的來源。
   實測：探針跑在 `http://localhost:1421`（我為探針另開的 vite 埠）→ log 為
   `origin="http://localhost:1421" allowed=false`。
2. **`tauri dev` 搭 `frontendDist`（`devUrl: null`）也不是自訂 scheme**：Tauri CLI 會另起
   一個臨時埠。實測得到 `origin="http://127.0.0.1:1430" allowed=false`。
3. **只有 `cargo tauri build` 產出的 `.app` 才有 `tauri://localhost`**（就是第 1 節那 4 行）。
4. 因此本票的驗收程序**必須**走打包這條路；這也是把探針的 DEV 條件拔掉的理由（見 AC-2 註）。

## 驗收清單（DoD）與證據

| # | 項目 | 結果 | 證據 |
| --- | --- | --- | --- |
| 1 | `corsDebugLine` 單元測試（先紅後綠） | ✅ | 初版 5 失敗（`(0, corsDebugLine) is not a function`）→ 14 passed；加 `method=` 時 2 失敗 → 再次全綠 |
| 2 | `corsProbeEnabled` / `formatProbeReport` / `runCorsProbe` 單元測試 | ✅ | 初版找不到模組 → 10 passed |
| 3 | worker wire 層觀測可用 | ✅ | 本檔「實測紀錄」4 行原文 |
| 4 | 打包 app webview 內實測 `tauri://localhost` 命中白名單 | ✅ | 同上 |
| 5 | 「webview 真的讀到回應」有機械證據 | ✅ | 第 3、4 行 `session/stop` + `GET /session` 顯示 `endedReason=aborted` |
| 6 | 未設旗標時 E2E / 單元測試不受影響 | ✅ | E2E 6 passed（14.8s）；ui 單元 40 passed |
| 7 | Gate 2 / Gate 3 | ✅ | markdownlint 45 檔 0 issues；`tsc --noEmit` ×2 OK；worker M01 regression 83/0；ui M01 35 passed |
| 8 | 是否需要修 `DEV_ORIGINS` | 不需要 | 白名單本來就含 `tauri://localhost`；實測為 `allowed=true` |

## 附帶發現（不在本票修，供決策）

- **dev 模式多開前端埠會被 CORS 擋**（`tauri dev` 自帶的臨時埠、或任何人另開 `vite --port 14xx`）。
  症狀與正式 webview 被擋**一模一樣**：「按開始沒反應」。現在有了 `DEBUG_ORIGINS` 至少能看到
  `allowed=false`，但使用者（開發者）仍然要自己發現。可能的後續票：dev 時讓 worker 在 CORS
  拒絕的回應裡多帶一句提示，或讓 dev 白名單吃 `http://localhost:<任意埠>`（僅 dev，且不得是 `*`）。
- **iOS 上的實際來源仍未實測**（無實體裝置）。若 iOS 的 webview 來源與 macOS 不同
  （例：`http://tauri.localhost`），`DEV_ORIGINS` 已同時列了兩種寫法；真機驗收時請把
  `DEBUG_ORIGINS=1` 打開，log 會直接給答案。

## 變更歷史

| 日期 | 版本 | 變更 | 作者 |
| --- | --- | --- | --- |
| 2026-10-08 | v1.0 | 初版（由 M01-US-101 §2.4 反思維度 6 轉票；dav-planner §2.1 精簡版）| Agent（TECH-006 執行階段）|
| 2026-10-08 | v1.1 | 實測後修正：①探針 gate 拔掉 `DEV` 條件（`tauri://localhost` 只在打包 app 出現）②補上「讀到 201 才回呼 stop」的機械證據設計 ③回填實測紀錄 / DoD / 附帶發現 | Agent（TECH-006 執行階段）|
