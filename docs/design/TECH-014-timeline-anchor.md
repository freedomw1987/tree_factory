# TECH-014 設計 — 時間軸的可信錨點（HMAC 覆蓋 `meetingId｜startedAt｜endsAt`）

- 票號：TECH-014（P1 / 3 SP）｜AC：`docs/ac/TECH-014.md`｜交付文：`docs/deliverable/2026-10-09-TECH-014-時間軸可信錨點.md`
- 相關：`docs/design/TECH-008-session-clock-validation.md`（本票由它的 Gate 4 oracle **F1** 轉出）、
  `worker/src/session.ts`、`worker/src/storage/session-store.ts`、`worker/src/meeting-do.ts`
- 上游來源：`docs/ac/M01-US-101.md`、`docs/backlog.md:218`

## 問題的精確形狀

權威時間軸只有一個來源：`meeting_session` 這一列的 `started_at_ms` / `ends_at_ms`。
TECH-008 補上的是**位置**檢查（`sessionClockViolation`：不得在未來，容忍 60 秒），
它真正的不變式在 `worker/test/session-clock.test.ts` 檔頭被寫成算式：

```text
設 Δ = 兩欄一起平移的量、elapsed = now - started_at（平移前）
違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS
```

也就是說：**在會議進行中，兩欄只要一起平移同樣多的量，檢查一律放行**，而且放行的量隨會議時間越大越大。
已錄 1 小時的會議把兩欄一起往後推 1 小時，`remainingMs` 就從 1 小時變回滿滿 2 小時——
上限被**無聲續命**，裝置端只會看到「還有很多時間」。TECH-008 的兩條釘樁測試就把這件事釘住了：
`shiftSessionBy(db, 60 * 60 * 1000)` 之後斷言 `200` / `phase === "recording"` / `remainingMs === MEETING_MAX_MS`。

**為什麼位置檢查必然不夠**：δ 只有一個純量，而對手有兩個自由度（`started`、`ends`）。
再怎麼調容忍值，都只能把放行區間縮小、不能消滅它。

## 設計決定

### D1 — 威脅模型：防「改 DB 的人」，不防「改程式碼的人」

| 編號 | 對手 | 本票是否防 |
| --- | --- | --- |
| T1 | 直接改 `meeting_session` 的人（外部工具、備份還原、別的程式碼路徑寫錯）| ✅ 防（改了就驗不過）|
| T2 | 把 `session_anchor` 整列刪掉的人 | ✅ 防（**不存在＝不合法**，D7）|
| T3 | 拿得到 `SESSION_ANCHOR_KEY` 的人（改 env／讀 secret 的權限）| ❌ 不防（可以重簽，D10-②把這件事寫成測試）|
| T4 | 能改 worker 程式碼的人 | ❌ 不防（任何檢查都可以被改掉，這不是本票能處理的層級）|

**一句話記住**：錨不是「防篡改」，是「**讓篡改留下痕跡**」。它把「靜默續命」變成「吵鬧的 500」。

### D2 — 錨的選擇：伺服端密鑰的 MAC（比較過三個候選）

| 候選 | 為什麼不可行／為什麼勝出 |
| --- | --- |
| `created_at_ms` 欄位（TECH-008 試過） | 同一張表、同一個 UPSERT 就能同步改寫，等於沒有錨 |
| DO alarm（TECH-008 試過） | 到點後 alarm 會照**被改過的** `ends_at` 重排；且 alarm 可被 `deleteAlarm` 清掉，線索消失 |
| 逐字稿筆數／時間戳（TECH-008 試過） | 同一個 DB，同一個攻擊者能一起改 |
| 平台 KV／R2／第二個 DO | 可行，但對 T1 而言只是「換一個地方再改一次」；而且要新增綁定、新部署步驟、新的失敗模式（KV 最終一致）|
| **HMAC + 只在 env 的密鑰（本票採用）** | 信任根**不在任何儲存體**：改得了 DB 不等於簽得出 MAC。零新綁定、零新部署步驟、純函式可測 |

關鍵差別在「信任根的位置」：前四個候選的信任根都是**資料**（改了就有），本票的信任根是**密鑰**（改了也沒有）。

### D3 — MAC 的形式與覆蓋範圍

- 演算法：`HMAC-SHA256`（WebCrypto `crypto.subtle.importKey` + `sign`，workerd 與 Node 22 都有；DO 與測試環境都實測過）。
- 覆蓋字串：`v1|<meetingId>|<startedAtMs>|<endsAtMs>`（宣告在設計裡；實作與測試用同一個常數，不各自拼字串）。
  版本前綴讓**未來**改覆蓋範圍時可以分辨新舊錨，不必改表結構。
- 輸出：十六進位（64 字元）整串儲存，比較走 `constantTimeEquals`（沿用 `worker/src/edge-auth.ts` 的既有函式，不另寫一份）。
- **`state` / `ended_at_ms` / `ended_reason` 刻意不在覆蓋範圍內**：它們每次合法寫入都會變（結束、到點收尾、
  `transcriptWrites` 遞增都走同一次 `SessionStore.write`），要同步就得把 `write()` 變成 async（13 個呼叫端）。
  殘餘風險有界：逐字稿寫入另外受 `now < ends_at` 與位置檢查管制，2 小時硬上限**不會**因為改 `state` 而突破（D10-①）。

### D4 — 儲存：獨立表 `session_anchor`（不是新欄位）

```sql
CREATE TABLE IF NOT EXISTS session_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mac TEXT NOT NULL,
  version INTEGER NOT NULL
)
```

選獨立表而不是 `ALTER TABLE meeting_session ADD COLUMN anchor_mac` 的三個理由：

1. **不必處理既有 DB 的遷移**：`CREATE TABLE IF NOT EXISTS` 對舊 DO 是新增，不是改既有列。
2. **`SessionStore.write()` 一行都不用改**：mac 不是 session 快照的一部分，UPSERT 不會碰到它。
3. **語意清楚**：錨遺失（整列不見）是一個**明確**的壞狀態樣本，而「欄位是 NULL」會被誤讀成「舊資料」。

### D5 — 驗證點：DO 甦醒時（async、一次）＋ `#readSession` 的同步閘門

**為什麼不能「就在 `SessionStore.read()` 裡驗」**：`read()` 是**同步**的（TECH-008 讓 `nowMs` 必填、
同步丟錯），而 WebCrypto 的 HMAC 是**非同步**的。把它塞進 `read()` 就得讓 `read()` 變 async，
連帶在 13 個呼叫端的 `#readSession → write` 之間**插入一個 await**——

而 `worker/src/meeting-do.ts:781` 的註解寫得很清楚：那一段沒有 await 是**刻意**的
（DO 單執行緒 ＋ 同步段落 ⇒ 讀-改-寫不會被交錯，`transcriptWrites` 才不會掉帳）。
**TECH-014 不得為了驗錨而拆掉一個既有的原子性保證。**

因此拆成兩半，合起來等於「每一次讀取都在驗」：

1. **甦醒時（async、一次）**：在 `blockConcurrencyWhile` 內讀出 `session_anchor` 並驗 MAC，
   結果記在記憶體 `#anchor = { status, startedAtMs, endsAtMs }`（比較走 `constantTimeEquals`）。
   這個 promise **永不 reject**（壞狀態是「資料」，不是「例外」）：DO 不該因為錨不符而變成
   「每一條路徑都爆掉」，而是讓**用到 session 的路徑**回一個說得清楚的 500。
2. **每次讀取（sync）**：`#readSession` 在 `store.read(now)` 之後做**同步**閘門：
   ①`status === "ok"`；②現在讀到的 `startedAtMs` / `endsAtMs` **等於甦醒時驗過的那一組**。
   任一不符 → 丟錯（D5 的錯誤碼對照見 D6）。

**為什麼這樣就夠**：時間軸只有兩個自由度，而它只可能在兩種時刻被改動——
「DO 沒在跑」（甦醒那一次驗得到）與「DO 在跑」（每次讀取比對那兩個數字，同步、零成本）。

`fetch()` 與 `alarm()` 的開頭各加一行 `await this.#anchorReady`：在真平台上 `blockConcurrencyWhile`
已經保證甦醒先完成，這一行是為了**不依賴平台的排程細節**（也讓測試用的假 harness 不必模擬平台）。
它位在**任何讀取之前**，所以 `read → gate → write` 仍然沒有 await ✓。

### D6 — 金鑰缺失 ＝ fail-closed（`SESSION_ANCHOR_NOT_CONFIGURED`）

`SESSION_ANCHOR_KEY` 未設定／空字串／只有空白（正規化＝trim 後為空）→ **不能開始會議**：
`/session/start` 回 500 `SESSION_ANCHOR_NOT_CONFIGURED`（`recoverable:false`）。

| 另一個選項 | 為什麼不選 |
| --- | --- |
| 內建預設金鑰 | 那把金鑰在原始碼裡＝公開＝等於沒有錨，而且是**靜默**的失效 |
| 沒有金鑰就跳過驗證（放行） | 這正是 TECH-009 已經拒絕過的失敗模式（「沒設 `DEVICE_TOKEN` 就放行」），同一個錯不該犯第二次 |

代價要寫清楚：**dev 與 E2E 都必須帶這把金鑰**（`.dev.vars`、`playwright.config.ts` 的 `--var`、`do-smoke.mjs`），
否則連「開始會議」都跑不起來。這是刻意的：一道可以靜默關閉的防線不是防線。

### D7 — 舊資料不祖父化（故意的）

「讀到 session 但沒有錨列」的兩種可能：①真的舊資料 ②**攻擊者刪掉了錨列**。兩者無法區分。
如果選擇「沒有錨就補寫一個」，②就變成最有效的攻擊：**刪掉錨列 → 時間軸重新取得信任**。
所以規則只有一條：**`meeting_session` 有列、`session_anchor` 沒有列 → `SESSION_CORRUPT`**（AC-6）。

v1 沒有公開部署（`docs/backlog.md:20` R5「單人自用」），開發資料的重建成本是「刪掉那個 DO」。
正式上線後若要輪替金鑰或改覆蓋範圍，那是另一張票（AC-7-③）。

### D8 — 與 TECH-008 位置檢查的關係：兩條都要，釘樁翻正

| 檢查 | 擋什麼 | 擋不到什麼 |
| --- | --- | --- |
| `sessionClockViolation`（TECH-008，保留） | 時間軸被推到未來（單邊、大幅） | 同量平移 |
| HMAC 錨（TECH-014） | **任何**對兩欄的改寫（含同量平移） | 拿得到密鑰的人 |

兩者互補且都不貴（一個是純比較、一個是一次 HMAC）。因此 TECH-008 檔尾的兩條釘樁**由放行改成擋下**，
第三條（`Δ > elapsed + TOL`）不變仍擋下——**這是收緊，不是放寬**，改測試前先確認它在舊實作上必紅。

### D9 — 模組與影響面

| 檔案 | 改動 |
| --- | --- |
| `worker/src/session-anchor.ts`（新） | `anchorMac(meetingId, startedAtMs, endsAtMs)`、`anchorKey(env)` 正規化、`sessionAnchorMessage(version)`；純函式／單一 async 邊界 |
| `worker/src/storage/session-store.ts` | `#ensure()` 多建一張表；新增 `readAnchor()` / `writeAnchor()`。**`read()` / `write()` 的簽名與行為都不動**（D5） |
| `worker/src/meeting-do.ts` | 建構子算 `#anchorReady`；`fetch()` / `alarm()` 開頭 await 它；`#readSession` 加同步閘門；`/session/start` 寫錨；缺金鑰 → 500 `SESSION_ANCHOR_NOT_CONFIGURED`；既有 `existing !== null` 路徑不動 |
| `worker/src/harness/meeting-harness.ts` | `MeetingBindings` 加 `SESSION_ANCHOR_KEY?: string`（`MeetingEnv = MeetingBindings` → DO 讀得到）|
| `worker/src/meeting-do.ts` 的 context 型別／測試假 harness | `blockConcurrencyWhile?` 選配（真的 `DurableObjectState` 有；假 harness 不必實作，靠 D5 的 `#anchorReady`）|
| `worker/wrangler.toml`、`docs/env-setup.md` | 設定說明（D6 的代價）|
| `system-design.md §5.2`、`DESIGN.md §5.1` | `SESSION_ANCHOR_NOT_CONFIGURED` 進表（13 → 14 碼）|

### D10 — 誠實界線（要進交付文的）

1. `state` / `ended_*` **沒有**被錨住：可以把 `ended` 改回 `recording`（逐字稿寫入仍受 `now < ends_at` 管制，
   2 小時上限不受影響），也可以把 `recording` 改成 `ended`（提早收工）。有界，但確實沒擋。
2. 持有 `SESSION_ANCHOR_KEY` 的人可以重簽 → 這條**寫成一條測試**（不是註解），免得後人以為錨是萬能。
3. 金鑰輪替／遺失＝舊會議不可讀，沒有自動遷移。
4. DO 的 `setAlarm` / `deleteAlarm` 仍然可以被同一層級的攻擊者動；本票沒有處理「時間軸合法但 alarm 被動過」的組合。

### D11 — 可推翻條件（什麼情況下該改回別的做法）

- 若**正式環境**需要金鑰輪替，D7 的「不祖父化」就不再合理 → 需要多金鑰版本表（另一張票）。
- 若**平台提供**可寫入且與 DO 儲存分權的錨（例如帶 TTL 的 KV 寫入權限分離），可以把它當第二錨；
  但只有在「拿得到 DO 儲存、拿不到 env」的假設不再成立時才有意義。
- 若未來要錨住 `state`／`ended_*`，正確做法是讓 `SessionStore.write()` 吃一個由呼叫端算好的 mac（async），
  而不是在 `write()` 裡面同步硬算——本票刻意不做（AC-7-①）。

## 測試策略（Gate 1）

- **先紅後綠的三條改寫**（AC-3）：把 TECH-008 檔尾的兩條釘樁與「真正邊界」那條改成期望 500；
  在**舊實作**上跑一次確認必紅（否則就是沒真的加檢查）。
- **護欄群不得變紅**（AC-4）：既有 6 條（合法舊會議／錄到上限沒人碰／時鐘回調容忍／`ends_at` 破格／NaN ／alarm 拋錯）
  全部保持綠；`meeting-do.test.ts`／`session-store.test.ts` 亦同。
- **純函式層**（`session-anchor.test.ts`）：金鑰正規化（未設／空／空白）、MAC 決定性、覆蓋範圍（改 id／改 started／改 ends 各一條）、
  「拿得到金鑰就能重簽」、`constantTimeEquals` 的長度不同也走完全長。
- **真 workerd**（`do-smoke.mjs`）：正常開始→逐字稿→結束全綠；帶一把**錯的** `SESSION_ANCHOR_KEY` 去讀既有會議 → 500。
- **突變測試**：拿掉驗錨、只比對長度、只比對 `started`、金鑰缺失時放行、缺錨列時補寫、
  以及「位置檢查」與「錨」各自失效時的交叉案例。
