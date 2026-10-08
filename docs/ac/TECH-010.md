# TECH-010 — dev 模式來源埠漂移的診斷（AC）

- 票號：TECH-010（P2 / 1 SP），模組：—（跨模組，worker 側）
- 前置：TECH-006（已交付：`DEBUG_ORIGINS=1` → `[cors] origin=… allowed=…` 的事件記錄）
- 來源：TECH-006 §2.4 反思維度 3 / 5 轉票
- 交付文：`docs/deliverable/2026-10-09-TECH-010-CORS埠漂移診斷.md`

## 背景（為什麼要這一票）

app 的 UI 在瀏覽器開發時打 `http://localhost:1420`，Tauri webview 打 `tauri://localhost`，
worker 的允許清單**明列**這些來源（`worker/src/cors.ts` 的 `DEV_ORIGINS`，或用 `ALLOWED_ORIGINS` 覆蓋）。

問題出在「埠漂移」：dev server 換了埠（1420 → 1421、4173 → 4174）時，

| 情況 | 伺服器端 | 前端看到 |
| --- | --- | --- |
| 請求根本沒送到（worker 沒起來 / 位址打錯） | 完全安靜 | `Failed to fetch` |
| 送到了但白名單沒中（埠漂移） | TECH-006 之前：完全安靜；之後：有 `[cors] allowed=false` log | `Failed to fetch` |

**兩者在前端同症狀**，而 TECH-006 的證據只落在 **server log**——開發者盯著的是 DevTools。
這一票把「這次的 Origin 是什麼、白名單有沒有中」放到**回應標頭**上。

## 目的

1. 讓「埠漂移」在 **DevTools 的 Network 面板**就能一眼看出（不必再去翻 wrangler log）。
2. 把「用 curl 手動重播 OPTIONS／POST」這段流程寫成可重複執行的腳本。

## 驗收標準（AC）

| 編號 | 條件（可驗） | 證據 |
| --- | --- | --- |
| **AC-1** | 未設定 `DEBUG_ORIGINS=1` 時，回應**完全沒有** `x-cors-origin` / `x-cors-allowed`（正式環境與 TECH-006 之前**逐位元相同**） | 單元測試 2 條（純函式 + 入口）+ 真 workerd（埠 8808，未開旗標）實測 |
| **AC-2** | 設定 `DEBUG_ORIGINS=1` 時，**preflight 與一般請求都**帶診斷標頭：`x-cors-origin` = 對方送的 `Origin`（沒帶時 `(none)`）、`x-cors-allowed` = `true`/`false` | 單元測試 3 條（純函式）+ 入口 3 條 + 真 workerd（埠 8807）實測 |
| **AC-3** | 診斷標頭**不洩漏白名單內容**：只有「對方自己送的 Origin」與一個布林值，沒有任何其他來源字串 | 純函式測試逐鍵比對回傳物件（`toEqual` 精確相等，多一個鍵就紅） |
| **AC-4** | 白名單沒中時**不假裝成功**：仍然**不給** `access-control-allow-origin`，status / body 與 TECH-010 之前完全一致（POST 仍 201，由瀏覽器擋） | 入口測試 2 條（漂移來源的 OPTIONS 與 POST） |
| **AC-5** | `worker/scripts/cors-probe.mjs` 可在 CLI 重播：`--base`（預設 `http://127.0.0.1:8787`）、`--origin`（可重複）、`--meeting`、`--json`、`--help`；**離開碼 0 = 全部在白名單、1 = 有來源被擋、2 = 打不到 worker**。判斷邏輯（判讀／離開碼／參數／清單解析）必須**有自動化測試守門**（Gate 4 oracle 的 P1：原版寫在 `.mjs` 裡，kill 不死任何測試） | 真 workerd（8807 開旗標、8808 未開、**8809** 重構後）實跑；三種離開碼都出現過；`test/cors-probe-lib.test.mjs` **13 條**（突變 M5「一律回 allowed」→ **5 紅**；第二輪 oracle 獨立複驗亦 5 紅）；**未開旗標且已有 `ALLOWED_ORIGINS` 覆寫**時，收尾提示必須明說「無法分辨漂移與覆寫」（第二輪 oracle P2-2 補丁 `hint()`） |
| **AC-6** | 腳本預設清單**來自 `src/cors.ts` 的 `DEV_ORIGINS`**（單一真相來源），且**必定附一個刻意漂移的來源**（`http://localhost:1421`）作對照組；區塊找不到**或解析出 0 筆**都要明確報錯（`exit 2`），不是靜默退化 | 腳本原始碼；實跑輸出含 1421 一列 `⛔`；`cors-probe-lib.test.mjs` 覆蓋「0 筆 → 報錯」（突變 M8 → 1 紅） |
| **AC-7** | 要回顯的 `Origin` 必須**淨化**：只放行可見 ASCII（`\x20`–`\x7e`，長度 ≤255），其餘一律 `(invalid)`；白名單比對仍用**原始** Origin（淨化不得造成誤放行） | 單元測試 2 條（含 oracle 實測會被原樣寫進標頭的垂直 tab `0x0B`）；**真 workerd raw socket** 重播同一攻擊字串 → `x-cors-origin: (invalid)`（突變 M6 → 1 紅）|
| **AC-8** | 診斷標頭非空時回應**必須帶 `Vary: origin`**（值隨 `Origin` 變動的欄位不能被共享快取按 URL 混用）；既有 `Vary` 不得被覆蓋或重複 | 單元測試 2 條（新增 / 不重複）+ 真 workerd `curl -D -` 實測（漂移來源與白名單來源都出現 `Vary: origin`）；突變 M7 → 2 紅 |

### 誠實的範圍界定（這一票**沒有**解決的事）

- **前端的 JS 仍然讀不到這些標頭。** CORS 失敗時瀏覽器連 `response.headers` 都不給 JS
  （`fetch` 直接 reject），所以「程式自動判斷」不可行。這一票解的是
  **開發者（人）在 DevTools 看得到**，不是「裝置端程式自動分辨」。要把這件事變成
  程式可讀，只能反過來讓 worker 在「被擋」時**回一個不含 CORS 標頭的錯誤 body**
  （瀏覽器照樣不給 JS 讀）或改用非 CORS 通道（例如同源的自家代理）——前者無效、後者超出本票。
- **標頭裡的 Origin 是淨化過的副本。** AC-7 之後，含控制字元的 `Origin` 會被換成 `(invalid)`——
  也就是說「看到 `(invalid)`」本身就是一個訊號（有客戶端送了不合法的 Origin），但它**不是**對方原文。
- **webview 實測仍需人跑。** 腳本重播的是 wire（同一個 worker、同一個 `Origin`）；
  真的 Tauri / WKWebView 的 scheme 差異（TECH-006 的產物）不是腳本能取代的。

> **註（reviewer 第三輪 P2-3）**：表中「單元測試 N 條」為**代表條數**，逐條歸屬由實作判斷；
> 檔內實測總數以 `worker/test/cors.test.ts` 32 條（其中本票 18）＋ `worker/test/cors-probe-lib.test.mjs` 13 條為準。

## 刻意不做

| 不做 | 為什麼 |
| --- | --- |
| 埠漂移時**自動**把新埠加進白名單 | 等於把允許清單變成「任何 localhost 埠」；這一區是會議資料入口（TECH-006 的安全立場），自動放行比症狀難查更糟 |
| 把白名單內容放到回應標頭或 body | 等於免費送攻擊者一份允許清單 |
| 新增第二個旗標（例如 `CORS_DIAGNOSTIC=1`） | 兩個開關會出現「開了一個沒開另一個」的假陰性；沿用 TECH-006 的 `DEBUG_ORIGINS=1`，觀測與診斷一起開 |
| 在正式環境也送診斷標頭 | 多兩個指紋欄位、對使用者零用處；正式環境的現場是 server log 與「腳本主動探測」（`cors-probe.mjs` 未開旗標時仍可判讀 allow-origin 有無） |
| 改 status code 或回錯誤 body 讓漂移「更明顯」 | 會破壞既有契約（被擋的來源在伺服器端本來就是正常請求），並讓所有既有測試的路徑假設改變 |
