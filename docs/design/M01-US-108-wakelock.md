# M01-US-108 設計：錄音續航（WakeLock 防關屏 + 誠實提示）

> 對應 Backlog: [M01-US-108](../backlog.md) ｜ AC: [docs/ac/M01-US-108.md](../ac/M01-US-108.md)
> Module: M01（聽）｜ 日期：2026-10-09 ｜ 前置：M01-US-101（錄音狀態機）、M01-US-107（缺口標記）

## 1. 這一票要解決的失敗模式

**F05 螢幕自動關閉導致錄音中斷**：使用者在開會，手機放在桌上聽，
系統的「自動鎖定」（預設 30 秒～2 分鐘）就把螢幕關了 → webview 進背景 → 麥克風被系統沒收
（SPIKE-002 實測 Run 2/3：`hidden` 之後 `MediaRecorder` 收不到音）。
US-107 會誠實標出缺口，但那是**事後**；US-108 是**事前**——在錄音期間壓住螢幕不自動關。

### 1.1 三個必須講清楚的現實

| 現實 | 依據 | 本票的處理 |
| --- | --- | --- |
| WakeLock **進背景會被系統自動釋放**，回前景不會自己回來 | Web 標準：sentinel 在 `hidden` 時 release | 回前景且**仍在錄音**時重新取得（D3） |
| 不是每台裝置都有、也不是每次都會給（省電模式會拒） | `navigator.wakeLock` 為選配 API；`request()` 可 reject | 不支援／被拒 → 誠實提示「請保持畫面開啟」（D5/D6） |
| 使用者**主動鎖屏仍會中斷** | 電源鍵 = 系統釋放 sentinel | 提示「請保持畫面開啟」，中斷後由 US-107 缺口列接手 |

## 2. 設計決策（D1~D11，single source of truth）

- **D1 持有條件 = `state === "recording"`**。中斷中（`interrupted`）、到上限（`limit_reached`）、
  結束（`idle`）都**不**持有。理由：WakeLock 的目的是「讓這場會議繼續錄得到」；
  錄音停了卻還宣稱螢幕受保護，是假訊息。續錄成功（`resume_requested → recording`）才重新取得。
- **D2 純 TS 狀態機 + 依賴注入**（`app/ui/src/lib/recorder/wake-lock.ts`）：
  建構子吃 `{ isSupported(), request() }`，不直接碰 `navigator`。
  理由：`navigator.wakeLock` 在測試環境不存在，且 E2E 要能注入假的 sentinel 觀察呼叫次數。
- **D3 回前景重新取得**：`hidden` → `suspend()`（標記「系統已釋放、不是我放棄」）；
  `visible` + 仍錄音 → 重新 `request()`。理由：這是 Web 標準要求開發者自己做的補課，
  忘記做的話 WakeLock 只在「第一個前景週期」有效。
- **D4 非我方主動的 `release` → `lost`，且同一場會議最多自動重試 1 次**：
  使用者按電源鍵、或系統在低電量時強制釋放都會 fire `release`。
  重試 1 次是因為「系統暫時性釋放」常見，但無限重試就是 US-107 F5 那類問題（打註定失敗的請求）。
  重試預算以**連續失敗**為單位：重取成功就歸零（使用者中途按電源鍵、回前景後仍有一次機會），
  失敗一次就停在 `lost` 並持續顯示提示，不再打。
  失去保護的**當下**先降級為 `suspended`（不假裝還在 `active`），重取成功才回 `active`；
  重取失敗則降到 `lost`（`#everActive` 已是 true，不會被誤報成「沒被允許」的 `denied`）。
  規格上 `request()` 在頁面非前景時會被拒（E2E 的假 API 也照這條實作），所以真機按電源鍵的**落點取決於到場順序**
  （Gate 4 第二輪校正，兩種都刻意接受、都由測試釘住）：

  | 到場順序 | 我方行為 | 落點 | 為什麼這是對的 |
  | --- | --- | --- | --- |
  | `hidden` 先到 | `suspend()` 主動收乾淨並移除 listener；遲到的 `release` 是 no-op | `suspended`（不提示） | 錄音已 `interrupted`，誠實的訊息是 US-107 缺口列；這一刻不必再喊「請保持畫面開啟」 |
  | `release` 先到（瀏覽器已非前景） | 重取必被拒 → `lost` | `lost` + 提示 | 不再有修正機會的「重取失敗」是真的沒有保護：說出來比靜默好（寧可多一句提示，也不要無提示的無保護） |

  兩種落點都不是「假訊息」：分歧只來自「我方可不可以再補救一次」，而畫面在兩種情況下都與真實狀態一致。
- **D5 不支援 → `unsupported`，不呼叫 `request()`、不 throw**。
  理由：`navigator.wakeLock` 是選配能力，缺席不是錯誤；但仍要顯示提示（不能靜默）。
- **D6 提示的顯示條件 = 只看「是否真的有保護」**：

  | 狀態 | 畫面 | 文案 |
  | --- | --- | --- |
  | `active` | **不顯示** | （WakeLock 生效中，多一句只是噪音） |
  | `unsupported` | 顯示 | 「此裝置不支援防止螢幕關閉；請保持畫面開啟，離開會中斷錄音」 |
  | `denied` | 顯示 | 「系統未允許防止螢幕關閉（可能開啟了省電模式，或系統沒有回應）；請保持畫面開啟，離開會中斷錄音」（**逾時**與**被拒**共用此狀態，所以兩種原因都要說得到，D11） |
  | `lost` | 顯示 | 「螢幕保護已失效（例如按下電源鍵）；請保持畫面開啟，離開會中斷錄音」 |
  | `suspended` | 不顯示 | （切到背景中，畫面本來就是「錄音已中斷」；回前景會重取） |
  | `idle` | 不顯示 | （沒在錄音） |

  用 `role="status"`（不搶焦點、不擋操作，不用彈窗——會議中不該被彈窗打斷）。
- **D7 觀測縫**：`MeetingScreen` 的根節點帶 `data-wakelock-state`，提示條帶
  `data-testid="wakelock-hint"`。E2E 不需要額外 dev 鉤子就能驗狀態。
- **D8 best-effort，永不擋錄音**：`request()` / `release()` 的任何失敗都只改狀態，
  不得讓 `store.start()` / `resumeMeeting()` 失敗（Recording 是主線，防關屏是加值）。
- **D9 主動釋放要區分**：我方 `release()` 前先標 `#intentional = true` 並移除 listener，
  否則自己的釋放會被誤判成 `lost` 而重試（使用者在結束會議後才看到「請保持畫面開啟」的鬼提示）。

- **D10 取得競態的守門**：`acquire()` 有兩個守門——`#acquiring`（同時只允許一個 `request()` 在飛）與
  `#generation`（`stop()`／`suspend()` 都會 +1；`acquire()` 回來時發現世代變了就**立刻 `release()` 剛拿到的 sentinel**
  並維持原狀態，不切成 `active`）。
  理由：`request()` 是 async，真機上「開始錄音後立刻按結束」「取得還在飛就進背景」都是毫秒級的競態；
  沒有守門的話會留下一個**沒人放掉、也沒人監聽**的鎖，而且畫面會宣稱 `active`——正是本票最不能出現的假訊息。
  配套（Gate 4 第一輪補）：`stop()`／`suspend()` 也要清 `#acquiring`（否則一個永不 settle 的 `request()`
  會讓之後所有取得都靜默 no-op＝「沒保護卻什麼都不說」，正是本票要消滅的失敗型態；舊結果已被世代守衛作廢，清掉是安全的）；
  放掉 sentinel 一律走 `#releaseQuietly()`（含 `try/catch`，因為 `Promise.resolve(x)` 會先求值 `x`，
  同步 throw 不會進 `.catch`，而呼叫端是每秒的 tick 與 `visibilitychange` 處理器）。
  第二輪再補一處（oracle 獨立審查抓到）：`acquire()` 的 `finally` 只能清**自己世代**的 `#acquiring`
  （`if (generation === this.#generation)`）——否則「A 在飛 → `stop()` → B 在飛 → A 回來」會把 B 的 in-flight 旗標清掉，
  之後第三次 `acquire()` 就能再打一次 `request()`，變成兩把鎖同時在飛、其中一把沒人放掉（螢幕再也不會自動關）。
- **D11 取鎖要有逾時（`timeoutMs`，預設 10_000 ms）**（Gate 4 第二輪補）：一個永不 settle 的 `request()`
  會讓狀態停在 `idle`，而 `wakeLockHint("idle")` 是 `null`——畫面只寫「錄音中」，使用者卻完全沒有螢幕保護。
  逾時一律當失敗處理（降為 `denied`／`lost`）並顯示提示；
  **逾時之後才回來的鎖**若「這場錄音還在、而我們正宣稱沒有保護」就補收（`#adoptLate`），
  否則安靜放掉——兩邊都是同一條原則：畫面說的必須等於真實狀態。
  10 秒的理由：真機授予鎖是毫秒級，10 秒足以排除「慢但成功」，設更短會把慢成功誤判成失敗。

## 3. 狀態機

```
             acquire() 成功
  idle ────────────────────────► active
    ▲                             │  ▲
    │ stop()                      │  │ visible + recording → acquire()
    │                             │  │
    │        hidden（系統釋放）    ▼  │
    ├──────────────────────── suspended
    │                             │
    │        release 事件（非我方） ▼
    │                          lost ──retry(1)──► active
    │
    ├── isSupported()=false ──► unsupported
    └── request() reject ─────► denied
```

`stop()`（結束會議／上限關閉／錄音中斷）→ 一律回 `idle`，並清掉重試計數。

## 4. 與其他模組的接線

| 時機 | 呼叫 | 說明 |
| --- | --- | --- |
| `confirmStart()` 進到 recording | `wakeLock.acquire()` | AC-1 |
| `resumeMeeting()` 真的回到 recording | `wakeLock.acquire()` | AC-1（續錄也要防關屏） |
| `notifyVisibility(true)` | `wakeLock.suspend()` + `gapTracker.handleHidden()` | 兩個各自獨立：US-107 誠實記錄、US-108 準備重取 |
| `notifyVisibility(false)` | 仍錄音 → `wakeLock.acquire()` | D3 |
| `endMeeting()` / `closeLimitSession()` | `wakeLock.stop()` | D1（與 `gapTracker = null` 同一位置） |
| `tickMeeting()` → `interrupted` | **只在自己還握著（`wakeLockState === "active"`）時** `wakeLock.stop()` | 中斷不算「有保護」；無條件每秒 `stop()` 會把進背景後的 `suspended` 壓成 `idle`（狀態在 tick 之間跳動、也清掉 `lost` 的提示與重試預算） |
| `devCorsProbe` 等其他路徑 | 不涉及 | — |

## 5. 錯誤與邊界

| 情況 | 預期 | 測試 |
| --- | --- | --- |
| 裝置不支援 | `unsupported`、未呼叫 `request()`、不 throw | `wake-lock.test.ts` |
| `request()` reject（`NotAllowedError`） | `denied`、無 unhandled rejection | 同上 |
| `request()` 超過 `timeoutMs` 未 settle | 同上降為 `denied`／`lost`，且提示要說明「或系統沒有回應」（不得與單純被拒混為一談） | 同上（逾時那條會斷言文案含「沒有回應」） |
| 進背景後回前景（仍錄音） | 重新 `request()`（累計 2 次） | 同上 |
| 進背景後回前景（已中斷） | **不**重新取得（不然會宣稱已保護但其實沒在錄） | 同上（負向） |
| 系統釋放（電源鍵） | 先降 `suspended` → 自動重試 1 次；重取成功回 `active` | 同上 |
| `release` 與 `hidden` 幾乎同時到（真機電源鍵） | 依到場順序有兩種落點（見 D4 表）：`hidden` 先到 → `suspended` 不提示；`release` 先到（已非前景）→ `lost` + 提示。兩者都不得宣稱 `active`、不得洩漏鎖、不得多打註定失敗的請求 | `wake-lock.spec.ts` 三條（Gate 4 第一輪兩條 + 第二輪一條） |
| `request()` 永不 settle | ①`stop()`／`suspend()` 清掉 in-flight 旗標，之後的取得不得靜默 no-op；②超過 `timeoutMs` 要降級並顯示提示（不得停在 `idle` 靜默，D11） | `wake-lock.test.ts`（Gate 4 兩輪補） |
| 逾時之後鎖才回來 | 仍在錄音且正宣稱無保護 → 補收成 `active`（不得「握著鎖卻宣稱沒保護」）；已結束／已進背景／已有鎖 → 安靜放掉 | 同上 |
| 舊世代的 `request()` 姍姍來遲 | 不得清掉新請求的 in-flight 旗標（否則會多打一次並洩漏第二把鎖） | 同上（Gate 4 第二輪補） |
| `release()` 同步丟錯 | 不得往上拋（每秒的 tick 會讓它變成事件處理器例外） | 同上（Gate 4 補） |
| 系統釋放後重取也被拒 | 停在 `lost`、只打一次（初始 1 + 重試 1）、不再空轉 | 同上 |
| 連續 `acquire()` | 已 `active` 不重複 `request()` | 同上（冪等） |
| 我方 `release()` 觸發的 `release` 事件 | 不得變成 `lost` | 同上 |
| 結束會議後 `visible` | 不取得（`idle` 終態） | 同上 |

## 6. 失敗模式（本票不引入新問題）

| 想定 | 對策 |
| --- | --- |
| 假裝已防護（提示說「已防止關屏」但其實沒有） | 顯示條件只看真實狀態（D6），`active` 才不顯示提示 |
| 無限重試打註定失敗的請求 | 連續失敗重試上限 1，成功即歸零（D4） |
| 「取得沒回來」被當成沒事（靜默無保護） | 逾時一律降級 + 提示；逾時後才到的鎖若還有用就補收（D11） |
| WakeLock 失敗把錄音帶下去 | best-effort（D8）：狀態機永不 throw |
| 使用者在鎖屏狀態下被提示誤導 | 提示文案一律明說「離開畫面會中斷錄音」，並由 US-107 缺口列負責事後交代 |
| 一場結束後殘留監聽造成鬼提示 | `stop()` 移除 listener + `#intentional`（D9） |

## 7. 實作與測試結果

| 檔案 | 內容 |
| --- | --- |
| `app/ui/src/lib/recorder/wake-lock.ts` | `WakeLockManager`（狀態機）+ `wakeLockHint()`（文案）；注入 `{ isSupported(), request() }`，不碰 `navigator` |
| `app/ui/src/lib/recorder/wake-lock.test.ts` | **22 條**：AC-1 取得 / 不支援 / 被拒 / D3 重取 / D4 重取成功 / D4 重取失敗停在 lost / D9 主動釋放 / 負向（中斷中不取）/ 冪等 / `stop()` 後不受舊 sentinel 影響 / `suspend()` 後系統 release 不變 lost / `wakeLockHint` 映射 / **D10 競態三條**（結束時取得還在飛、進背景時取得還在飛、同時兩次 `acquire()`） / **Gate 4 第一輪補的四條**（`request()` 卡死不回來、`release()` 同步丟錯、`release()` 非同步丟錯、每個提示都要明說後果） / **Gate 4 第二輪補的三條**（舊世代不得清掉新請求的 in-flight 旗標、逾時要誠實降級、逾時後補收） |
| `app/ui/e2e/wake-lock.spec.ts` | **10 條**（注入假 `navigator.wakeLock`——含「非前景時 `request()` 依規格被拒」，同時驗畫面與呼叫次數）：AC-1 開始即取得且無提示 / 切背景不重取、續錄才重取 / 系統釋放自動重取 / 重取被拒停在 lost / 不支援 / 被拒（省電）/ D9 結束後放掉且無殘留提示 / 真機電源鍵的**兩種**到場順序（`release`→`hidden`、`hidden`→`release`）不得留幽靈保護或假提示 / 第二輪補的第三種落點（`release` 先到且瀏覽器已非前景 → 重取必被拒 → `lost` + 提示，回前景續錄才清提示） |
| `app/ui/src/lib/app.svelte.ts` | 接線：`confirmStart` / `resumeMeeting` / `notifyVisibility` / `endMeeting` / `closeLimitSession` / `tickMeeting`（見 §4） |
| `app/ui/src/screens/MeetingScreen.svelte` | `data-wakelock-state`（根節點）+ `data-testid="wakelock-hint"`（`role="status"`） |
| 既有 E2E | `gap-marking.spec.ts` 不受影響（兩票共用 `notifyVisibility`，E2E 全量通過） |

### 7.1 驗收數據（Gate 證據）

- **Gate 1（TDD）**：`wake-lock.test.ts` 先紅（模組不存在）→ 實作 → 12 條綠；
  D10 的三條競態測試同樣先紅（2 次 request、幽靈 `active`）→ 補守門 → 15 條綠；
  Gate 4 第一輪的 4 條修正也先紅後綠（3 條真的紅：卡死的 `request()`、`release()` 同步丟錯、文案少一句）→ 19 條綠；E2E 由無到有 → 9 條。
  Gate 4 第二輪的 3 條修正同樣先紅後綠（3 條全紅，其中「舊世代不得清旗標」在修前是 `expected 3 to be 2`——真的多打了第三次 `request()`）→ 22 條綠；E2E 再加 1 條 → 10 條。
- **突變驗證（證明測試不是空的；全部在**同一份凍結修訂版**上跑，紅→綠紀錄在 `/tmp/us108-mutations2.log`、`/tmp/us108-mutations2-e2e.log`）**：
  - M1：拿掉 `confirmStart()` 的 `acquire()` → E2E AC-1 紅。
  - M3a／M3b：拿掉 `#onRelease` 的重試分支（直接判 `lost`）→ 單元 3 條紅、E2E「系統釋放自動重取」紅（D4 的重取與上限都真的被驗到）。
  - M4：拿掉 `acquire()` 的世代守門 → 2 條競態單元紅（幽靈 `active`）。
  - M5：拿掉 `#acquiring` 守門 → 「同時兩次 `acquire()`」紅（2 次 request，洩漏第二個鎖）。
  - M6：`tickMeeting()` 改回無條件 `stop()` → E2E「切背景被系統收走」紅（進背景後的 `suspended` 被每秒壓成 `idle`，正是 Gate 4 指出的 flake）。
  - M7：拿掉 `stop()`／`suspend()` 清 `#acquiring` → 2 條紅（「`request()` 卡住不回來」＋第二輪的「舊世代不得清旗標」）。
  - M8：`#releaseQuietly()` 改回沒有 `try/catch` → 「`release()` 同步丟錯」紅。
  - M9：`acquire()` 的 `finally` 改回無條件清 `#acquiring` → 第二輪的「舊世代不得清旗標」紅（證明這條測試真的守著那個守門）。
  - M10：關掉 `timeoutMs`（`if (true) return pending`）→ 第二輪的逾時兩條紅（證明「靜默無保護」真的被測出來）。
  - M11：假 `wakeLock` 改回不管前景狀態都給鎖 → 第二輪的第三種落點（E2E）紅（證明那條 E2E 真的走到「重取被拒」的路徑）。
- **Gate 2（lint）**：`svelte-check --threshold warning` 0 errors 0 warnings；`check:icons` PASS（48 檔）；
  worker `npm run lint`（tsc + markdownlint）57 檔 0 issues。
- **Gate 3（regression）**：UI 單元 **188 條（19 檔）** 全綠、regression 過濾 **153 passed / 35 skipped**；worker **169 條（15 檔）** 全綠。
- **E2E 全量**：**35 passed**（WakeLock 10 + 既有 25，39.1 s），Chromium 1 worker 順跑。
  一律加 `--output=<自己的目錄>`：並行寫 `test-results/` 會產生假的 ENOENT 紅燈（第二輪踩過）。

### 7.2 誠實聲明（本票沒驗到的部分）

1. **真機螢幕自動關**：Chromium 沒有螢幕省電行為，E2E 用注入假 API 走同一條程式碼路徑（`app.svelte.ts` → `WakeLockManager`）；真機（iPhone webview）是否真的壓得住，
   仍屬 SPIKE-002 已證範疇（webview 進背景收不到音），需 iOS 真機驗收。
2. **省電模式 / 低電量下的真實系統行為**：假 API 只模擬 `NotAllowedError` 與 `release` 事件，真機何時拒、何時偷偷釋放未實測。
3. **實際延長了幾秒**：屬真機體驗指標，未量化。
4. **耳機 / 外部音訊路由、通話中斷**：不在本票範圍（見 AC 的「範圍外」）。
5. **真機「按電源鍵」的實際落點未實測**（`release` 與 `hidden` 的先後無保證）：依 D4 的表，兩種順序會有兩種落點
   （`hidden` 先到 → `suspended` 不提示；`release` 先到且瀏覽器已非前景 → `lost` + 提示）。
   兩種都已用假 API 釘住，但**真機是哪一種**（甚至同一台裝置每次不同）這裡測不到——
   若真機兩者都出現，使用者可能先看到「錄音已中斷」（US-107 缺口列）再看到「請保持畫面開啟」；
   我們刻意選擇「多一句提示」而不是「靜默無保護」（詳見 trust-log D-US108-11）。
