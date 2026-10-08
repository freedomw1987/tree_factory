# TECH-006 — Tauri webview 來源在真實 webview 內實證 CORS 與收音（驗收標準）

- **票號**：TECH-006（P1 / 1 SP / 依賴 M01-US-101；由 §2.4 反思維度 6 轉出）
- **目標**：把「`tauri://localhost` 在白名單內」從**文件上的假設**變成**實測事實**。
  在**真實 Tauri webview** 內對 worker 打一次核心會話請求，並同時取得三層證據：
  ① **wire 層**：worker 實際看到什麼 `Origin`；② **回應層**：`access-control-allow-origin`
  是否命中該值；③ **webview 層**：該回應被 webview **接受**（前端拿得到 201，不只是「伺服器有回」）。
- **實作**：`worker/src/cors.ts`（`corsDebugLine`）、`worker/src/index.ts`（`DEBUG_ORIGINS` 觀測）、
  `app/ui/src/lib/dev/cors-probe.ts`、`app/ui/src/main.ts`（旗標啟動，探針橫幅直接 `append` 到 body）
- **測試**：`worker/test/cors.test.ts`（cors 共 14 條，其中 6 條屬 TECH-006）、
  `app/ui/src/lib/dev/cors-probe.test.ts`（14 條）；另加真 webview 實測（本檔「實測紀錄」）

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
- **Then** 標準輸出多一行 `[cors] origin="…" allowed=true|false method=… path="…"`
  （`method` 與 `path` 也要印：preflight 與真請求成對出現才看得出問題在哪一段）
- **And** `DEBUG_ORIGINS` 未設定、空字串、`0`、`false`、`TRUE`、`" 1"`（帶前導空白）→ **不得**輸出
  （`1` 是唯一開啟值；避免在正式環境刷 log）
- **And** `Origin` 不存在時仍然輸出一行（`origin="(none)"`），因為「沒有 Origin」本身就是線索
- **And** 這行只由**純函式** `corsDebugLine(origin, configured, debugFlag, method, path)` 產生，
  可直接單元測試，不必真的起 worker

### AC-2 webview 端探針

- **Given** app 以 `VITE_CORS_PROBE=1` 建置（build-time 變數）
- **When** app 載入完成
- **Then** 自動對 worker 打 `POST /m/<uuid>/session/start`（**真的核心路徑**，不是 ping）
- **And** 把結果以純函式 `formatProbeReport()` 格式化後顯示在 `data-testid="cors-probe"` 的區塊，
  內容含：`location.origin`、HTTP status、以及（讀不到時）「看 worker log」的明確指示
- **And** 探針**只在讀到 `201` 時**回呼 `POST /m/<uuid>/session/stop {reason:"aborted"}`：
  一來把探針建的會議收掉，二來這筆請求**就是「webview 真的讀到了回應」的機械證據**
  （CORS 被擋時 `fetch` 直接丟例外，不可能走到這個分支）
- **And** `VITE_CORS_PROBE` 未設為 `1` → 完全不執行、不渲染，且 production bundle **不含**探針程式碼
- **And** 探針失敗**不得**影響正常 UI（不丟例外、不阻擋錄音流程）

> ⚠️ **與初版的差異①（實測後修正）**：初版把探針條件訂為「`VITE_CORS_PROBE=1` **且** `import.meta.env.DEV`」。
> 實測發現 `tauri dev` 的 webview 來源是 devUrl 的 http 來源，而**真正上線的 `tauri://localhost`
> 只存在於打包後的 app**（見「實測紀錄 → 被實測推翻的假設」）。若保留 DEV 條件，這張票
> 就永遠驗不到要驗的對象，所以 gate 改成只看旗標。
> 安全上仍收得住：旗標是 **build-time** 變數（vite 會內聯），未設時 `main.ts` 的整段分支
> 會被 tree-shake 掉（實測：未設旗標的 production build，`grep cors-probe|session/start` = 0）。
>
> ⚠️ **與初版的差異②（Gate 4 第 1 輪 P1 修正）**：初版要求探針輸出「回應的
> `access-control-allow-origin` / `access-control-allow-headers`」。這是**錯的**：
> 依 Fetch 規範，那兩個是 CORS 內部標頭，**瀏覽器不會 expose 給 JS**，`response.headers.get()`
> 在真 webview 永遠回 `null`。初版實測畫面就印出「（無）」，極易被誤讀成「CORS 失敗」。
> 因此改為：① 探針不讀那兩個標頭；② 以「**拿得到 `status` 就代表 CORS 已通過**（本探針顯式用
> `mode:"cors"`——被擋時 `fetch` 會丟例外；`no-cors` 的 opaque response 不在此列）」＋
> 「worker log 的 `allowed=…`」兩者作準。

### AC-3 實測結果（本票真正的產出）

- **Given** 真實 Tauri 桌面 webview（與 iOS 同一套 Origin 機制）
  （**2026-10-08 補充**：iOS 模擬器亦已實測，同值 `tauri://localhost`，見「iOS 模擬器實測」）
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

1. 桌面 webview 與 iOS webview 走**同一套** Origin 機制（WKWebView 的自訂 scheme）。
   **2026-10-08 更新**：iOS **模擬器**已實測（同樣 `tauri://localhost` → `allowed=true`，見
   「iOS 模擬器實測」）；仍待確認的是 **iPhone 真機**（簽章 + 開發者模式，需用戶）。
   iOS 上的真機驗收仍屬 M01-US-101 的 DoD，本票不取代它。
2. 本票只證明「來源在白名單內、請求能被 webview 接受」；**不**證明收音品質、背景錄音
   （那是 SPIKE-002 / M01-US-106 的範圍）。
3. 探針會在 worker 上**真的建一場會議**（id 為隨機 uuid），並在讀到 `201` 後自動 `stop`
   （`reason=aborted`）把資料收掉——不會留下「錄音中」的孤兒會議（實測已驗；見「收尾驗證」）。

## 實測紀錄（2026-10-08）

**怎麼跑出來的**：

1. worker：`npx wrangler dev --port 8787 --local --var HARNESS_PROVIDER:faux --var DEBUG_ORIGINS:1`
2. app（**在 `app/` 目錄下執行**；`beforeBuildCommand` 的 cwd 陷阱見「已知陷阱」第 2 條）：
   `VITE_CORS_PROBE=1 cargo tauri build --debug`
   → 產出 `app/src-tauri/target/debug/bundle/macos/tree-factory.app`（先 `source ~/.cargo/env`）
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
| 回應（伺服器端）| worker log `allowed=true`（＝回應帶了 `access-control-allow-origin`）| `tauri://localhost`（命中 `DEV_ORIGINS`）|
| webview | 探針讀得到 `status`（＝ 201）且第 3、4 行 `session/stop` 出現 | CORS 通過 ✅ |

> ⚠️ Gate 4 第 1 輪 P1 的更正：初版把「回應層」寫成「webview 讀到 ACAO = `tauri://localhost`」，
> 那是**錯的**（解釋見 AC-2 差異②）。ACAO **只能在 worker 端看**（log 的 `allowed=true`
> 或 curl），webview 端看不到；反過來，webview 端「拿得到 `status`」就已經是 CORS 通過的證明
> （前提：該請求是 `mode:"cors"`；探針已顯式指定）。
> 下方保留初版探針畫面的原文，作為這個陷阱的現場證據。

**收尾驗證**（探針建的會議確實被收掉）：

```text
GET /m/db57c259-931f-430c-b8de-195f7baef8d1/session
→ 200 {"phase":"ended", "endedReason":"aborted", "transcriptWrites":0, ...}
```

### 初版探針畫面的原文（陷阱現場：那個「（無）」）

打包 app 內的探針橫幅（由 Gate 4 第 1 輪 checker 以 macOS Vision OCR 讀出；
`LTECH` / `a11ow` 是 OCR 對 `[` 與 `allow` 的誤識）：

```text
[TECH-006 CORS 探針]
webview origin：tauri://localhost
HTTP status：201
access-control-allow-origin：（無）
access-control-allow-headers：（無）
webview 真的讀到回應（能回呼 stop）：是
```

同一時間 worker 端確實有送 ACAO（curl 證明）：

```text
$ curl -s -o /dev/null -D - -X OPTIONS -H "Origin: tauri://localhost" \
    -H "Access-Control-Request-Method: POST" http://127.0.0.1:8791/m/x/session/start | grep -i access-control
Access-Control-Allow-Origin: tauri://localhost
access-control-allow-headers: content-type,x-meeting-id
access-control-allow-methods: GET,POST,OPTIONS
access-control-max-age: 600
```

**結論**：「（無）」不是 CORS 失敗，是**瀏覽器不 expose CORS 內部標頭**。
這個欄位已從探針移除（見 AC-2 差異②）；`status: 201` ＋ `stop` 才是 webview 端的有效證據。

### 被實測推翻的假設（本票最有價值的副產品）

1. **`tauri dev` 的 webview 來源不是 `tauri://localhost`**，而是 `devUrl` 的來源。
   實測：探針跑在 `http://localhost:1421`（我為探針另開的 vite 埠）→ log 為
   `origin="http://localhost:1421" allowed=false`。
2. **`tauri dev` 搭 `frontendDist`（`devUrl: null`）也不是自訂 scheme**：Tauri CLI 會另起
   一個臨時埠。實測得到 `origin="http://127.0.0.1:1430" allowed=false`。
3. **只有 `cargo tauri build` 產出的 `.app` 才有 `tauri://localhost`**（就是第 1 節那 4 行）。
4. 因此本票的驗收程序**必須**走打包這條路；這也是把探針的 DEV 條件拔掉的理由（見 AC-2 註）。

### iOS 模擬器實測（2026-10-08 補充，Agent 執行）

**為什麼要做**：桌面 macOS 已證，但 M01 的目標平台是 iPhone。iOS 模擬器跑的是**真的 WKWebView**
（與 iPhone 同一條自訂 scheme 處理路徑），先拿模擬器答案，真機就只剩「確認」而不是「探索」。

**程序（可重現）**：

1. worker：`npm exec -- wrangler@4 dev --port 8787 --local --var HARNESS_PROVIDER:faux --var DEBUG_ORIGINS:1`
2. 建置（**打包式**，不能用 `tauri dev`）：`VITE_CORS_PROBE=1 cargo tauri ios build --debug --target aarch64-sim`
3. 安裝／啟動：`xcrun simctl boot <iPhone 18 Pro udid>` → `simctl install <udid> <DerivedData>/debug-iphonesimulator/tree-factory.app`
   → `simctl launch <udid> com.treefactory.spike`
4. 證據：worker log 的 `[cors]` 行 + `simctl io <udid> screenshot`（文字用 macOS Vision OCR 取出）

**結果（log 原文 4 行，同一 meeting id `03a0851c-…`）**：

```text
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/03a0851c-…/session/start"
[cors] origin="tauri://localhost" allowed=true method=POST path="/m/03a0851c-…/session/start"
[cors] origin="tauri://localhost" allowed=true method=OPTIONS path="/m/03a0851c-…/session/stop"
[cors] origin="tauri://localhost" allowed=true method=POST path="/m/03a0851c-…/session/stop"
```

**探針面板 OCR 原文（iOS 上）**：`webview origin: tauri://localhost` / `HTTP status：201` /
`ACAO／CORS 標頭：JS 讀不到（…）` / `webview 真的讀到回應（能回呼 stop）：是`。

**收尾驗證**：`GET /m/03a0851c-…/session` → `phase="ended"`、`endedReason="aborted"`（無孤兒會議）。

**附帶收穫**：iOS webview 上 M01 的 Svelte UI 正常渲染（截圖 OCR 出現「還沒有任何會議」空狀態文字）
⇒ `frontendDist` 這條打包路徑在 iOS 也成立，不只是「請求通」。

**⚠️ 本節的收音能力不重測**：iOS 模擬器的 `getUserMedia` / `MediaRecorder` / 可用 mimeType 已在
`docs/spike/SPIKE-002.md` §3.2 實測過（`audio/webm;codecs=opus` ✅、`audio/mp4` ✅），本票不重複。

### 真機驗收程序（待用戶執行；Agent 已備妥指令與判讀表）

| 步驟 | 指令 / 動作 | 備註 |
| --- | --- | --- |
| 1 | iPhone 接 USB；**設定 → 隱私權與安全性 → 開發者模式** 開啟並重啟 | iOS 16+ 必要 |
| 2 | Xcode 已登入 Apple ID（Xcode → Settings → Accounts）。**不必改 repo 檔**：用環境變數 `APPLE_DEVELOPMENT_TEAM=<Team ID>` 帶著跑即可（已查 tauri-cli 原始碼：`APPLE_DEVELOPMENT_TEAM` 優先於 `tauri.conf.json` 的 `bundle.iOS.developmentTeam`）。登入後可用 `cargo tauri info` 讀出 Team ID（目前顯示 `Developer Teams: None`）| 目前**未設**（所以真機建置會失敗）；不寫進版控可避免簽章資訊入 git |
| 2b | iPhone 連 Mac **不是 loopback**：iOS 14+ 的 Local Network Privacy 會擋，需 `NSLocalNetworkUsageDescription` | **已補進 `app/src-tauri/Info.plist`**（見已知陷阱 5）|
| 3 | worker 必須**聽 LAN**：`npm exec -- wrangler@4 dev --port 8787 --ip 0.0.0.0 --local --var HARNESS_PROVIDER:faux --var DEBUG_ORIGINS:1`（已預檢：log 顯示 `Ready on http://0.0.0.0:8787`，從 `192.168.1.172:8787` 打 OPTIONS 得 `204` + `Access-Control-Allow-Origin: tauri://localhost`；Mac 防火牆為關閉）| 只聽 `localhost` 時手機連不到 |
| 4 | 建到真機：`VITE_CORS_PROBE=1 VITE_WORKER_BASE_URL=http://192.168.1.172:8787 cargo tauri ios build --debug --target aarch64`，再 `xcrun devicectl device install app --device <UDID> <.app>` | 本機 LAN IP 現為 `192.168.1.172`（會變動）|
| 5 | 開 app，讀 worker log：`grep '\[cors\]' <log>` | 目標：`origin="tauri://localhost" allowed=true` |
| 6 | 首次安裝需在 iPhone「設定 → 一般 → VPN與裝置管理」信任開發者憑證 | 免費 Apple ID 憑證 7 天到期 |

> **判讀表（真機跑完看哪一種）**：
> - 看到 `allowed=true` + 面板 `status 201` → **全通**（本票 P1 可結）
> - 看到 `allowed=false` → 把 `origin=` 的值貼回來：**這就是票的價值**（我把值加進 `DEV_ORIGINS` 並補測試）
> - **完全沒有 `[cors]` 行** → 手機沒連到 worker（不是 CORS 問題）：檢查 `--ip 0.0.0.0`、同 Wi-Fi、
>   `VITE_WORKER_BASE_URL` 是否為 LAN IP；若仍不通，可能是 ATS 對「純 IP 的 http」的阻擋
>   （目前只有 `NSAllowsLocalNetworking`，到時再補 dev 專用例外網域）
>
> **不要用 `tauri ios dev` 驗來源**：那條路會讓 webview 來源變成 `devUrl` 的 http 來源
> （與「被實測推翻的假設」第 1 點同因），驗到的不是要驗的對象。

## 驗收清單（DoD）與證據

| # | 項目 | 結果 | 證據 |
| --- | --- | --- | --- |
| 1 | `corsDebugLine` 單元測試（先紅後綠） | ✅ | 初版 5 失敗（`(0, corsDebugLine) is not a function`）→ 14 passed；加 `method=` 時 2 失敗 → 再次全綠 |
| 2 | 探針單元測試（含 «stop 回 500 不得報成功»、«無 `randomUUID` 不得丟例外»）| ✅ | 初版找不到模組 → 14 passed |
| 3 | worker wire 層觀測可用 | ✅ | 本檔「實測紀錄」4 行原文 |
| 4 | 打包 app webview 內實測 `tauri://localhost` 命中白名單 | ✅ | 同上（Agent 一次 + Gate 4 checker 獨立重現一次）|
| 5 | 「webview 真的讀到回應」有機械證據 | ✅ | 第 3、4 行 `session/stop` + `GET /session` 顯示 `endedReason=aborted` |
| 6 | 未設旗標時 production bundle 不含探針程式碼 | ✅ | `npx vite build`（未設旗標）→ `grep -o 'cors-probe\|TECH-006 CORS\|session/start\|session/stop' dist/assets/*.js` **無輸出** |
| 7 | 未設旗標時 E2E / 單元測試不受影響 | ✅ | E2E **6 passed (14.7s)**；ui 單元全量 **49 passed**（其中 14 條屬本票）|
| 8 | Gate 2 | ✅ | `npm run lint`（worker）→ `tsc --noEmit` 0、markdownlint **47 檔 0 issues**；ui `tsc --noEmit` 0、`svelte-check` 0 errors 0 warnings |
| 9 | Gate 3 | ✅ | worker `REGRESSION_MODULE=M01` → `passed=83 failed=0`、`✅ 通過`；ui M01 → 35 passed |
| 10 | 是否需要修 `DEV_ORIGINS` | 不需要 | 白名單本來就含 `tauri://localhost`；實測為 `allowed=true` |
| 11 | iOS 模擬器（真 WKWebView）也命中白名單 | ✅ | 本檔「iOS 模擬器實測」4 行原文（`origin="tauri://localhost" allowed=true`）+ 截圖 OCR + 收尾驗證 |
| 12 | iPhone **真機**來源 | ⏳ 待用戶 | 「真機驗收程序」已備（含指令、判讀表、風險）；需要簽章 Team ID 與開發者模式 |

> 全量測試數字（供對帳，跑法見各 repo 的 `npm test`）：worker **132 passed / 11 files**；ui **49 passed / 4 files**。
> ⚠️ 這兩個數字會隨新測試漂移；本檔以「實測當下」為準，數字不符時請重新實跑而不是改字。

## 已知陷阱（本票實測抓到）

1. **`access-control-allow-origin` 讀不到不是 bug**：CORS 內部標頭不 expose 給 JS（見 AC-2 差異②）。
   要看 ACAO 請看 worker log 或 curl。
2. **`beforeBuildCommand` / `beforeDevCommand` 的 cwd 取決於「你從哪個目錄跑 `cargo tauri`」**：
   - 從 `app/` 執行 → cwd = `app/ui`
   - 從 `app/src-tauri` 執行 → cwd = `app/`（沒有 `package.json` → `npm run build` 直接 ENOENT）
   實測原文（`-c` 把命令換成 `pwd` 觀測）：從 `app/` → `/…/app/ui`；從 `app/src-tauri` → `/…/app`。
   **修法**：在 `app/` 放一份只負責轉發的 `package.json`（`"build": "npm --prefix ui run build"`），
   於是 `beforeBuildCommand` 回到最單純、也跨平台的 `npm run build`：
   - cwd = `app/ui` → 用 `ui/package.json` 自己的 build ✅
   - cwd = `app/` → 用新增的 `app/package.json` 轉發到 `ui` ✅
   實測從 `app/`、`app/src-tauri`、repo 根三種目錄執行 `cargo tauri build --debug` **都成功**。
   （不採用 `if [ -d ui ]; then … fi` 寫法：那在 Windows 的 `cmd` 下不是合法語法。）
3. **`tauri dev` 的 webview 來源不是 `tauri://localhost`**（是 devUrl 的 http 來源）；
   `tauri dev` 搭 `frontendDist` 也不是自訂 scheme（Tauri 會另起臨時埠）。
   要驗正式來源**只能**用 `cargo tauri build` 產出的 `.app`。
4. **`vite` 的 `strictPort` 會讓 `cargo tauri dev` 在 1420 被佔用時直接失敗**
   （錯誤：`The "beforeDevCommand" terminated with a non-zero status code`）。
   開發時請先確認 1420 空著，或改用 `devUrl` 指向其他埠。
5. **iOS 真機連本機 worker 會撞「兩層」不同的權限**（本票真機準備時定出）：
   - ATS（明碼 HTTP）：已有 `NSAllowsLocalNetworking` 例外
   - **Local Network Privacy（iOS 14+）**：連**非 loopback** 的區域網路位址（如 `192.168.x.x`）
     需要 `NSLocalNetworkUsageDescription`，否則**不會跳權限對話框、連線直接失敗**。
     已補進 `app/src-tauri/Info.plist`（`plutil -lint` OK）。
   > 判別法：模擬器可以直連 Mac 的 `127.0.0.1`（loopback，不受此限），所以**這個坑只在真機出現**。

## 附帶發現（不在本票修，供決策）

- **dev 模式多開前端埠會被 CORS 擋**（`tauri dev` 自帶的臨時埠、或任何人另開 `vite --port 14xx`）。
  症狀與正式 webview 被擋**一模一樣**：「按開始沒反應」。現在有了 `DEBUG_ORIGINS` 至少能看到
  `allowed=false`，但使用者（開發者）仍然要自己發現。可能的後續票：dev 時讓 worker 在 CORS
  拒絕的回應裡多帶一句提示，或讓 dev 白名單吃 `http://localhost:<任意埠>`（僅 dev，且不得是 `*`）。
  → **已轉票 `TECH-010`**（§2.4 反思維度 3/5 轉出，含「實測流程腳本化」）。
- **iOS 上的實際來源仍未實測**（無實體裝置）。若 iOS 的 webview 來源與 macOS 不同
  （例：`http://tauri.localhost`），`DEV_ORIGINS` 已同時列了兩種寫法；真機驗收時請把
  `DEBUG_ORIGINS=1` 打開，log 會直接給答案。

## 變更歷史

| 日期 | 版本 | 變更 | 作者 |
| --- | --- | --- | --- |
| 2026-10-08 | v1.0 | 初版（由 M01-US-101 §2.4 反思維度 6 轉票；dav-planner §2.1 精簡版）| Agent（TECH-006 執行階段）|
| 2026-10-08 | v1.1 | 實測後修正：①探針 gate 拔掉 `DEV` 條件（`tauri://localhost` 只在打包 app 出現）②補上「讀到 201 才回呼 stop」的機械證據設計 ③回填實測紀錄 / DoD / 附帶發現 | Agent（TECH-006 執行階段）|
| 2026-10-08 | v1.2 | Gate 4 第 1 輪修正（P1×1 / P2×4）：①移除「讀 ACAO」的錯誤設計（瀏覽器不 expose CORS 內部標頭）並更正三層證據表 ②更正測試數字（worker 132 / ui 49 / markdownlint 47 檔）③`beforeBuildCommand`/`beforeDevCommand` 改為 cwd 無關 ④探針程式碼真的被 tree-shake（未設旗標時 bundle 內 grep = 0）⑤`stop` 檢查 `res.ok`、`randomUUID` 加後備、`probeIfEnabled` 不外拋 ⑥新增「已知陷阱」 | Agent（TECH-006 執行階段）|
| 2026-10-08 | v1.3 | Gate 4 第 2 輪修正（P2×3）：①更正 v1.2 自己寫錯的數字（ui 45 → 49）②探針顯式 `mode:"cors"`，並把「拿得到 status ⇒ CORS 通過」的斷言補上模式前提 ③cwd 修法改為 `app/package.json` 轉發（回到跨平台的 `npm run build`，不採 POSIX-only 的 `if [ -d ]`）| Agent（TECH-006 執行階段）|
| 2026-10-08 | v1.4 | 結案後補強：①新增「iOS 模擬器實測」（真 WKWebView：`tauri://localhost` allowed=true，含可重現程序）②新增「真機驗收程序」＋判讀表（含 `--ip 0.0.0.0`、`VITE_WORKER_BASE_URL`、ATS 風險）③明確不重測收音能力（指向 SPIKE-002 §3.2）| Agent（TECH-006 iOS 驗收準備）|
| 2026-10-08 | v1.5 | 真機預檢：①`NSLocalNetworkUsageDescription` 補進 Info.plist（iOS 14+ Local Network Privacy，只在真機出現的坑；新陷阱 5）②Team ID 改用 `APPLE_DEVELOPMENT_TEAM` 環境變數（不需要改 repo 檔，已查 tauri-cli 原始碼確認優先序）③LAN 可達性預檢證據（`0.0.0.0:8787` + LAN IP 回 204 + ACAO 正確 + 防火牆關閉）| Agent（TECH-006 真機準備）|
