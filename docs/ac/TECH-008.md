# TECH-008 — session 讀取帶入「現在時間」（驗收標準）

- **票號**：TECH-008（P2 / 1 SP / 依賴 M01-US-101；由 US-101 §2.4 反思維度 3 轉票）
- **目標（Gate 4 oracle 實測後校正，2026-10-09）**：把「時間軸被**推到未來**」的 DB 竊改
  變成吵鬧的 500，並在讀取層帶入**伺服器的現在時間**。真正的不變式是：

  ```
  設 Δ = 兩欄一起平移的量、elapsed = now - started_at_ms（平移前）
  違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS
  ```

  **會擋住的只有「`started_at_ms` 被推到『現在 + 60s』之後」**（推到未來、或單次位移大於已錄時間）；
  **`Δ ≤ elapsed + 60s` 的平移一律放行** —— 所以在會議尾端（elapsed ≈ 2h）
  「再往後推 2h、上限續命」是**放行**的。這一半**沒有**被擋下，原因與後續補法見「刻意不做」。
  另一件同樣重要的事：**容忍真實的時鐘回調**（NTP 校正、平台抖動），不能一有偏差就把會議鎖死。
- **實作**：`worker/src/session.ts`（`SESSION_CLOCK_TOLERANCE_MS` + 純函式 `sessionClockViolation`）、
  `worker/src/storage/session-store.ts`（`read(nowMs)` 必填 + `nowMs` 有限性檢查）、
  `worker/src/meeting-do.ts`（`#readSession` 帶入 `this.#now()`；`SESSION_CORRUPT` 明確回錯）
- **測試**：`worker/test/session-clock.test.ts`（新增；16 條＝先紅 7 + 護欄 3 + 釘樁 6）

## 背景（為什麼要有這一票）

US-101 把會議時間軸落地，讀取層只驗兩件事：欄位型別/列舉合法，以及
`ends_at_ms === started_at_ms + MEETING_MAX_MS`。這條不變式**只驗差值，不驗位置**：
`(started, ends) = (T, T+2h)` 與 `(T+1h, T+3h)` 對它而言一模一樣。
而「上限」是**絕對時間**在管的（`acceptsTranscriptWrites` 比的是 `now < ends_at_ms`），
所以差值不變、位置平移 = 上限被改而沒人知道。

本票改成「只驗**位置的上界**（不得在未來）」，因此**能不能擋住取決於平移量與已錄時間的關係**：

| 平移情境（Δ = 平移量） | 後果 | 本票擋得住嗎 |
| --- | --- | --- |
| Δ = +10 年（推到未來） | `now < started_at_ms`：看起來「還沒開始」 | ✅ 擋下（Δ > elapsed + 60s） |
| 剛開始錄音（elapsed 0）+ 平移 Δ = 1h | 上限變 3h | ✅ 擋下（1h > 0 + 60s） |
| 已錄 1h 的會議 + 平移 Δ = 1h | 讀起來「還剩 2h」→ 上限變 3h | ❌ **放行**（1h ≤ 1h + 60s，見 AC-6 釘樁） |
| 已過期的會議 + 平移把時間軸搬回現在 | 過期會議復活 | ❌ **放行**（同上） |
| 往過去平移 Δ 為負 | 讀起來「多出時間」 | ❌ 放行（**刻意**，見 AC-3） |

## 驗收標準（BDD）

### AC-1 把 `started_at_ms` 推到「現在 + 60s」之後的平移一律擋下

- **Given** DB 裡的 `started_at_ms` / `ends_at_ms` 被**一起**往後推，使得 `started_at_ms > now + 60s`
  （例：剛開始錄音時推 1h）
- **When** 帶入現在時間讀取 session
- **Then** 丟 `SessionCorruptError`（訊息含 `started_at_ms`、當時的 `now`、容忍值）
- **And** 這個讀取**不改動 `meeting_session` 的任何列**（唯讀；唯一的非 SELECT 語句是
  冪等的 `CREATE TABLE IF NOT EXISTS`，冷啟動時才會出現 —— 措辭見設計 D5）

### AC-2 容忍邊界（±1 毫秒要分得出來）與回調的代價

> **適用範圍**：本條是 `elapsed = 0` 的切片（`started_at` 就是現在）；一般式
> `違規 ⟺ Δ > elapsed + TOL` 見 AC-6，兩者**是同一條式子的特例與通式**，不是兩套規則。

- **Given** `started_at_ms = now + SESSION_CLOCK_TOLERANCE_MS`
- **When** 讀取 **Then** 放行（恰好在容忍內）
- **And** `started_at_ms = now + SESSION_CLOCK_TOLERANCE_MS + 1` → 擋下
- **And** 「時鐘回調」情境：會議剛開始，讀取時刻比 `started_at_ms` 早 30 秒 → 放行
- **And** **代價要說清楚**：回跳的容忍量同樣是 `elapsed + TOL`，所以**剛開始錄音時回跳 61 秒
  就會 500**（已錄 20 分鐘時回跳 10 分鐘仍放行）。這是刻意的降級：寧可吵鬧也不要靜默放行，
  但是產品是否接受這個降級已列為待決風險（交付文 §4）

### AC-3 合法的舊會議不得被誤擋（沒有下界規則）

- **Given** `state = ended`、`now = started_at_ms + 10h`（幾小時前結束的會議，現在才被讀）
- **When** 讀取 **Then** 放行（刻意沒有「不得太舊」的規則：DB 裡沒有可信錨點）
- **And** `state = recording` 但 `now > ends_at_ms`（錄到上限後就沒人再碰過這個 DO）
  → 讀取**放行**，由 `expireSession` 收成 `ended` / `limit`
  （時間檢查不得讓「過期偵測」失效、也不得把正常收尾變成 500）
- **And** 上界獨立斷言：`ends_at_ms > now + MEETING_MAX_MS + TOL` 也算違規。
  這條是 **defense-in-depth**：在「差值不變式成立」的前提下，AC-1 通過就推得它通過，
  **正式路徑命中不到**；單獨寫一條是為了防止未來有人放寬 `toSnapshot` 的不變式時靜默鬆掉

### AC-4 結構上不可能忘記帶時間，也不可能帶壞時間

- **Given** `SessionStore.read(nowMs)` 的 `nowMs` 是**必填**參數
- **When** 有人新增呼叫端卻忘記帶時間 → **TypeScript 編譯錯誤**（不是執行期靜默放行）
- **And** 帶了卻不是有限數（`NaN` / `±Infinity`）→ `SessionCorruptError`
  （否則兩個 `>` 比較全部是 `false`，整套檢查會**靜默關掉**）
- **And** DO 端 `#readSession` 傳入 `this.#now()`（可注入時鐘）→ 固定時鐘的測試就能重現竊改

### AC-5 不誤傷正常路徑（回歸）

- **And** `write` 的不變式不變（非 2h 的 session 一律寫不進去）
- **And** 既有 `session-store.test.ts` 全數維持綠，且 M01 回歸與全套回歸維持綠

### AC-6 已知限制必須被測試釘住（不是「還沒想到」）

- **Given** 「已錄 1h + 平移 1h」與「已過期 + 搬回現在」這兩個**放行**情境
- **When** 未來有人補上真正的錨點、或有人看到一排綠燈就以為「同量平移一律擋得住」
- **Then** 這兩條釘樁測試會**變紅**，強迫他更新 AC 與設計，而不是默默改變行為
- **And** 「真正的邊界」也被釘住：`Δ = elapsed + TOL + 1` → 500（證明放行不是因為整條規則失效）
- **And** 壞資料下 `alarm()` **不吞錯**（每次醒來都拋、平台會重試）也是**已知**行為，一併釘住

## 刻意不做（Out of scope，寫出來避免被當成漏做）

- **「已錄時間以內」的平移偵測**：需要一個**不能被同步改寫**的錨點。DB 內的欄位（含 `created_at_ms`）
  與 DO alarm 都做不到 —— 對手能改 `started_at` 就能改 `created_at`，而 alarm 會**跟著被改的
  `ends_at` 跑**（oracle F6 實測）。真正可行的是 DO 外的可信來源 → **另立 TECH-014**，不在本票範圍。
- **往過去平移的下界檢查**：同上，且沒有錨點時訂下界只會誤擋合法歷史查詢（設計 D3）。
- **SQLite CHECK 層的同步**：`CHECK` 只能驗欄位自身，驗不了「與 now 的關係」——
  這一票的守門員在讀取層（與 US-101 既有策略一致）。
- **裝置端對 `SESSION_CORRUPT` 的降級**（例如讓使用者匯出已錄音檔）：`app/ui` 目前
  完全沒消費 `recoverable`（只說「請確認網路後再試」），屬 UI 決策 → 交付文 §4 列為待決。
- **`transcript_writes` 的合理性**、`meeting_id` 空字串、`state=ended` 卻 `ended_at_ms=NULL`
  等**其他欄位的寬鬆**：既有行為、非本票引入 → 交付文 §4 記明並留給後續票。
- **`transcript_writes` 的計數語意**：已在 TECH-013 處理。
