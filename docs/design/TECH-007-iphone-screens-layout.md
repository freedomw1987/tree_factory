# TECH-007 設計（續）— 其餘畫面的手機寬度（溢出／點擊區／橫向）

- 票號：TECH-007（P2 / 1 SP，狀態：**DONE**，2026-10-09）｜AC：`docs/ac/TECH-007.md`｜交付文：`docs/deliverable/2026-10-09-TECH-007-手機寬度版面收斂.md`
- 相關：`app/ui/e2e/iphone-viewport.spec.ts`（已交付的肖像 3 條）、`app/ui/index.html`（安全區變數唯一宣告處）、
  `app/ui/src/App.svelte`（外框 `.shell` / `.tabbar`）、`app/ui/src/lib/layout/safe-area.test.ts`（原始碼不變式守門）

## 這一票的形狀（已交付 vs 待辦）

2026-10-09 真機驗收（iPhone 12 mini）暴露的是**一整個家族**的「按不到」，不是單一 bug。
第一輪只修到「會議中」畫面（最上面的開始、最下面的結束、逐字稿撐高），並留下 3 條
`iphone-viewport.spec.ts`。其餘三個畫面**從來沒有在手機尺寸下被檢查過**：

| 畫面 | 進入方式 | 未被檢查的風險 |
| --- | --- | --- |
| 會議列表 | `app.view === "list"` | 會議標題長 → 橫向溢出；「開始會議」位置；每一列的點擊高度 |
| 開始 sheet | 列表 →「開始會議」 | 輸入框 + 兩顆按鈕在小螢幕的寬度／高度；sheet 是否超出可視區 |
| 權限阻斷頁 | `confirmStart` 拿到 `PERMISSION_DENIED` | 說明文字與兩顆按鈕在 390pt 寬是否溢出、是否掉出手勢區 |
| **橫向**（844×390） | 任何畫面轉橫 | 瀏海換到左右 → `safe-area-inset-left/right` 生效，但專案**完全沒有讓開左右**（見 D3） |

## 設計決定

### D1 — 用「幾何不變式」驗手機版面，不用截圖目視

三個可自動判定的不變式，每個畫面都套：

1. **不得橫向溢出**：`document.documentElement.scrollWidth <= clientWidth + 1`
   （`+1` 是次像素捨入；文件層溢出＝使用者得左右滑，手機上是明顯的壞掉）。
2. **主要互動元素必須夠大**：點擊高度 ≥ `--tap`（44px，專案既有 token，DESIGN §2.3）。
3. **主要 CTA 必須完整落在「扣掉安全區的可視矩形」內**：
   `x >= safeLeft`、`y >= safeTop`、`x + w <= width - safeRight`、`y + h <= height - safeBottom`。

為什麼不用截圖：**產出這一票的 agent 看不到圖**（模型不能檢視圖片），而且截圖無法在 CI 判紅綠。
截圖可以留檔給人看，但不能當成斷言——斷言必須是數字。真正的視覺品質（顏色、對齊美感）
仍由人眼與真機驗收負責，這一票只守「看不見／按不到」這一類。

### D2 — 尺寸集合：沿用 390×844，並補同一台的橫向 844×390

- 肖像 390×844（安全區 top 50 / bottom 34）＝已交付的 3 條，維持不動。
- 橫向 844×390＝本票新增。**真機橫向只會有一邊有瀏海**（單邊 44pt，取決於握持方向），
  所以橫向三條各跑**三組安全區夾具**：`left 44 / right 44`（對稱）、`left 44 / right 0`、
  `left 0 / right 44`（後兩組是 Gate 4 oracle 的 P2 修正：只跑對稱時，「左右顛倒」與
  「只讓開一邊」兩個突變都是 `0 紅`）。
- 刻意**不**加 iPhone SE / iPad 等更多尺寸：這一票的觸發點是真機實測回報，尺寸越多
  越容易變成「為了讓某尺寸過關而放寬斷言」。**可推翻條件**：若使用者手上出現第二台
  不同尺寸的真機並回報問題，就在同一個 D2 上加尺寸，而不是改門檻。

### D3 — 新增 `--safe-left` / `--safe-right`，外框與分頁列都要讓開

橫向時 iOS 的瀏海／圓角在左右，`env(safe-area-inset-left/right)` 才有值；現況：

- `index.html` 只定義 `--safe-top` / `--safe-bottom` → 左右完全沒有留白。
- `App.svelte` 的 `.shell` 只有 `padding-top: var(--safe-top)`。
- `.tabbar` 是 `position: fixed; inset: auto 0 0 0` → 橫向時分頁按鈕會橫跨到瀏海側。

決定：`index.html` 補 `--safe-left` / `--safe-right`（`env(safe-area-inset-left/right, 0px)`），
`.shell` 加水平 padding，`.tabbar` 的水平邊界由 `0` 改為 `var(--safe-left)` / `var(--safe-right)`。
**安全區仍然只能在 `index.html` 定義一次**（既有 `safe-area.test.ts` 的規則），
元件一律用 `var()`——否則 E2E 的假安全區注入會失效（那正是這套測試能被信任的原因）。

### D4 — 「主要互動元素」用白名單列舉，不是全畫面掃描

掃描所有元素會把說明文字、極小的狀態點也當成觸控目標，逼出沒有意義的 CSS 改動。
白名單（`data-testid`，共 **6 個**）：`btn-start-meeting`、`input-title`、
`btn-start-confirm`、`btn-perm-retry`、`tab-meetings`／`tab-chat`。
其中**前 4 個**（AC-2）另外被斷言「點擊高度 ≥ 44px」；兩個 tab 按鈕只被斷言幾何（落在安全矩形內、不溢出），
**沒有**被斷言 44px——`AC-2` 的「4 個元素」說的就是這件事，兩處數字沒有矛盾。

**可推翻條件（本輪真的用到了兩次，方向是「縮名單」不是「降門檻」）**：

- `meeting-item`（會議列表的每一列）：目前是**純顯示**的 `<li>`（phase A 還沒有「開啟會議」行為），
  對一個不能點的元素斷言「點擊高度 ≥44px」是**類別錯誤**。改為：不列入觸控白名單，
  但仍受 AC-1（不溢出）與 AC-4 的容器幾何約束。**可推翻條件**：等列表列真的可點（接上開啟會議），
  就把它加回白名單——那時它的高度才有觸控意義。
- 「先回首頁」（權限阻斷頁的次要出路）：它**沒有 `data-testid`**，而這一票不改產品加測試屬性；
  不加測試縫是本票的既有立場（D5）。改為不列入白名單，並在 AC 誠實段寫明。
  若真機回報它按不到，處置是**改版面**，不是降低 44px。

門檻一律是專案既有 `--tap`（44px）；不得為了讓斷言過關而降低。

### D5 — 權限阻斷頁用「真的拒權」進入，不加測試縫

權限阻斷頁必須**真的**走到 `permission_denied`，否則驗到的是別條分支的版面。做法：在頁面註冊
init script，把 `navigator.mediaDevices.getUserMedia` 換成**直接丟 `NotAllowedError`**；`store.ts`
本來就把 `NotAllowedError` 映射成 `permission_denied` → `PERMISSION_DENIED` → `view = "permission"`。
**產品碼一行都沒動**，所以不會有「縫改了但產品沒改」的假陽性。

**為什麼不是 `test.use({ permissions: [], launchOptions })`（初版設計，已作廢）**：
`launchOptions` 只要出現在 `test.describe` 裡，Playwright 就**當場報錯**（實測訊息：
`Cannot use({ launchOptions }) in a describe group, because it forces a new worker.`）；
而放進 config 又會影響同一支檔案的其他 5 條。加上 config 的
`--use-fake-ui-for-media-stream` 會**自動按下允許**，光收回 `permissions` 不一定拒得成。
改在瀏覽器邊界偽造 → 行為確定、影響範圍只在那兩條，而且仍然走產品自己的錯誤映射。

**已知限制（誠實）**：這模擬的是「瀏覽器層拒權（`NotAllowedError`）」，與 iOS 系統設定裡關掉
麥克風的**文案來源**可能不同（`recordsnapshot.notice.message` 由 worker／裝置端提供），
所以這一條驗的是**版面**，不是文案正確性。

### D6 — 會議列表要有「一列」時，用真的流程產生

用「開始 → 立刻結束」跑一次（既有 `meeting-recording.spec.ts` 的做法），讓列表渲染**真實資料**；
不直接塞 localStorage（那只驗到樣式，驗不到「這種長度的標題真的會出現在列表裡」）。

標題刻意用**長標題**（例：`這是一場標題非常長的會議用來檢查手機窄螢幕不會把畫面撐爆`），
因為溢出的成因是內容，不是元件本身。

### D7 — 斷言紅了要修版面，不是把斷言放寬

這一票的價值在於「同一類錯誤不會再無聲溜過」；把門檻調低等於買一張假的綠燈。
若真的量到**設計上刻意**的例外，處置順序是：
① 修版面 → ② 若設計就是這樣，移出白名單並在文件寫明理由 → ③ 不得只改數字。
**同時**：每一條新斷言都必須用「把修正回退」證明它會紅（見 AC-6 的非空洞證明）。

**這一輪真的量到的一個縫（誠實揭露）**：把 `index.html` 的 `--safe-left` / `--safe-right`
宣告整段拿掉，**E2E 的橫向 3 條仍然全綠**（突變 M1＝`0 紅`）。原因是那些測試自己用
`addStyleTag` 注入 `--safe-left` / `--safe-right`，注入值覆蓋了（已消失的）宣告——這正是
「注入假安全區」這個手法的代價：**E2E 驗的是「元件有沒有用 `var()`」，驗不到「`var()` 有沒有被宣告」**。
這一格由原始碼不變式測試補上（突變 M1b／M4 證明它會紅），兩層合起來才完整。
**不得**因為 E2E 全綠就宣稱「宣告也被守住了」。

### D8 — 不做的事：不驗顏色／動效／對齊美感，不引入視覺回歸工具

這一票只補幾何斷言。像素級視覺回歸（截圖比對）需要人審圖且 baseline 維護成本高，
不是「按不到」這一類問題的解法；若未來要做，另開票。

## 變更範圍

| 檔案 | 性質 |
| --- | --- |
| `app/ui/e2e/iphone-screens.spec.ts` | 新增（肖像 + 橫向，列表／sheet／權限頁的幾何不變式） |
| `app/ui/index.html` | 新增 `--safe-left` / `--safe-right`（仍為安全區唯一宣告處） |
| `app/ui/src/App.svelte` | `.shell` 水平讓開安全區；`.tabbar` 固定列的左右邊界改 `var(--safe-*)` |
| `app/ui/src/lib/layout/safe-area.test.ts` | 擴充守門：左右安全區必須存在、fallback 必須是 `0px`、恰好宣告一次、且真的被 `var()` 使用 |

## 測試策略（Gate 1）

- 先紅後綠：新增的 spec 在修正前必須有**具體失敗**（哪一條、量到多少），貼出指令與輸出。
- 非空洞證明：把 `App.svelte` / `index.html` 的修正各回退一次，對應斷言必須轉紅（記成突變表）。
  其中 M1（拿掉宣告）對 E2E 是 `0 紅`，**明列為殺不死**並由原始碼不變式接手（見 D7）。
- 既有 39 條 E2E 必須維持全綠（這一票不動任何既有斷言）。

## 第一輪 Gate 4 之後的補強（2026-10-09 11:20）

- oracle 的 **P2**：對稱夾具殺不掉「左右顛倒／只漏一邊」→ 改為三組夾具（共 9 條橫向）
  並新增 `.content` 容器左右緣斷言；新增突變 M6／M7（各 6 紅）。
- oracle 的 **P3**（fallback／重複宣告無守備）→ 單元不變式追加 2 條；新增突變 M8／M9（各 1 紅）。
- reviewer／oracle 指出的**註解與文件精確度**問題（檔頭作廢描述、`clearPermissions()` 死碼、
  交付文不存在的路徑、design 路徑、白名單數字）一併修正。
- 橫向權限頁 CTA 底部 5px 疊在 tabbar 下（oracle P3）**不修**：`AC-4` 未宣稱「不被分頁列覆蓋」，
  留給後續票（記在交付文 §6）。
