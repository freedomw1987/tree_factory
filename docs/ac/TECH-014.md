# TECH-014 — 時間軸的可信錨點：把「同量平移」從放行改成擋下（AC）

- 票號：TECH-014（P1 / 3 SP），模組：—（worker 側，跨 M01）
- 前置：M01-US-101（權威時間軸）、TECH-008（時鐘合理性檢查，本票由它的 Gate 4 oracle **F1** 轉出）
- 來源：`docs/ac/M01-US-101.md`、`docs/backlog.md:218`、`docs/design/TECH-008-session-clock-validation.md` §D7
- 設計：`docs/design/TECH-014-timeline-anchor.md`（D1–D11）
- 交付文：`docs/deliverable/2026-10-09-TECH-014-時間軸可信錨點.md`

## 背景（為什麼要這一票）

`MEETING_MAX_MS`（2 小時）是**伺服端**權威的：裝置端只是提早顯示橫幅，改裝置時鐘沒有用。
這個權威唯一的依據是 `meeting_session` 這一列裡的 `started_at_ms` 與 `ends_at_ms`——
**兩者都在同一個 DB**。TECH-008 加上的時間合理性檢查只驗**位置**（不得在未來），
所以它真正的不變式是 `違規 ⟺ Δ > elapsed + 60s`：
**在會議進行中「兩欄一起往後推同樣多」照樣放行**，上限可以被無聲續命。

TECH-008 的設計 §D7 已經實測否決三個「看起來可行」的錨點：`created_at_ms`（同一張表）、
DO alarm（到點後會跟著被改的 `ends_at` 重排，線索消失）、逐字稿筆數（同一個 DB）。
結論是：要在同一個 DB 內找到「對手不能同步改寫」的東西是不可能的——**除非那個東西不是資料，而是金鑰**。

## 目的

1. 讓「時間軸被改過」這件事本身**可偵測**，不再依賴「改得多不多、改了多久」。
2. 錨必須活在「改得了 DB、拿不到伺服器密鑰」的那一邊。
3. 既有合法路徑（開始／結束／到點收尾／逐字稿寫入／查歷史）**一條都不能變紅**。
4. 把 TECH-008 的兩條「釘樁（放行）」升級成「擋下」，並把**新的**界線照樣寫成測試與文件。

## 驗收標準（AC）

| 編號 | 條件（可驗） | 證據 |
| --- | --- | --- |
| **AC-1** | 會議開始時，除了 `meeting_session` 之外必須寫入**錨**：`HMAC-SHA256(SESSION_ANCHOR_KEY, 版本｜meetingId｜startedAtMs｜endsAtMs)` 的十六進位值，存進獨立表 `session_anchor`（`id=1`、`mac`、`version`）| `worker/test/session-anchor.test.ts`（純函式）、`worker/test/session-clock.test.ts`（起一場會議後錨列存在）|
| **AC-2** | 讀取 session 時必須驗錨：①DO 甦醒時（`blockConcurrencyWhile`，async 一次）比對 `session_anchor.mac` 與現值 ②每次 `#readSession`（sync）比對「現值 ＝ 甦醒時驗過的那一組」。任一不符 → 500 `SESSION_CORRUPT`／`recoverable:false`（沿用既有碼，不新增）；且 `read → gate → write` 之間**不得**插入 await（`meeting-do.ts:781` 的原子性保證）| `session-anchor.test.ts`、`session-clock.test.ts`；真 workerd 冒煙（改 DB 後 `/session` 應 500）|
| **AC-3** | **TECH-008 的兩條釘樁翻正**：①已錄 1 小時後兩欄一起平移 1 小時（上限 2h→3h）→ **500**（原：200 放行）②已過上限的會議被平移回現在 → **500**（原：200 復活）③平移量 ≤ `elapsed + TOL`（TECH-008 說的「真正邊界」）→ 仍 **500** | `session-clock.test.ts` 三條改寫（紅→綠：改寫後在舊實作上必紅）|
| **AC-4** | 合法路徑不得變紅：開始／重複開始（不得重開）／使用者結束／到點收尾／`transcriptWrites` 遞增／查 10 小時前的舊會議／時鐘回跳容忍內 → 全部照舊；**任何一次合法 `write()` 都不需要重算 MAC** | `session-clock.test.ts`（既有護欄群 6 條保持綠）、`session-store.test.ts`、`meeting-do.test.ts`；真 workerd 完整 `do-smoke.mjs` |
| **AC-5** | **fail-closed**：`SESSION_ANCHOR_KEY` 未設定／空字串／只有空白 → `/session/start` 500 `SESSION_ANCHOR_NOT_CONFIGURED`（`recoverable:false`）；**不得**用內建預設金鑰、**不得**因為沒有金鑰就跳過驗證放行 | `worker/test/session-anchor.test.ts`（金鑰正規化）、`meeting-do.test.ts`（路由）；真 workerd（不帶 secret 的 instance）|
| **AC-6** | **錨列遺失 ＝ 資料不合法**：`meeting_session` 有列但 `session_anchor` 沒有（被刪）→ `SESSION_CORRUPT` 500。不得當成「舊資料」放行，也不得「補寫一個錨」（那正是攻擊者要的把戲）| `session-anchor.test.ts`（刪錨列）|
| **AC-7** | **誠實界線**：①MAC 只覆蓋時間軸三元組（`state`／`ended_at_ms`／`ended_reason` **不在內**，且要寫出影響有界的原因）②持有金鑰者可重簽 → 放行（把這件事本身寫成一條測試）③金鑰輪替／遺失會讓舊會議不可讀 ④威脅模型仍是「改 DB 的人」，不是「改程式碼的人」 | 交付文的「未驗證／留痕」段；`docs/design/TECH-014-timeline-anchor.md` D7／D10 |
| **AC-8** | 新碼與設定同步：`SESSION_ANCHOR_NOT_CONFIGURED` 進 `system-design.md §5.2`（13 → 14 碼）與 `DESIGN.md §5.1`；`docs/env-setup.md` 加 `SESSION_ANCHOR_KEY`（正式 secret、`.dev.vars`、E2E／冒煙的餵法）；`worker/wrangler.toml` 註解說明「沒設＝不能開始會議」 | 三份文件 diff；`app/ui/playwright.config.ts` 的 `--var`；`worker/scripts/do-smoke.mjs` 的啟動指令 |

## 誠實的範圍界定（這一票**沒有**解決的事）

- **它不是「防得住改 DB 的人」，而是「讓改 DB 這件事留下痕跡」。** 錨的信任根是一把只在伺服器 env 裡的密鑰；
  拿得到密鑰（或能改程式碼）的人可以重簽，這條界線會寫成一條測試，不是寫成一句註解。
- **只有時間軸被錨住。** `state`／`ended_at_ms`／`ended_reason` 不在 MAC 之內：攻擊者可以把 `ended` 改回 `recording`
  或反過來。影響有界（逐字稿寫入仍然受 `now < ends_at` 與位置檢查管制，2 小時硬上限不會被這個改動突破），
  但**這是真的沒被擋**，所以列在這裡而不是藏起來。
- **金鑰輪替沒有自動化。** 換金鑰＝舊會議的 MAC 驗不過＝那些會議讀不出來（500 `SESSION_CORRUPT`）。
  v1 沒有公開部署、開發環境可以直接刪掉該 DO；正式上線前若需要輪替，那是另一張票。
- **沒有「偵測到就自動修好」。** 讀到錨不符一律吵鬧（500），不嘗試還原、不 log 敏感值。

## 刻意不做

| 不做 | 為什麼 |
| --- | --- |
| 平台 KV／R2／另一個 DO 當錨點 | 三者都要新綁定與新部署步驟，而且對「能改 DO 儲存的人」而言它們只是**換一個地方**再改一次；HMAC 的信任根是一把只在 env 裡的密鑰，不在任何儲存體，成本更低、界線更清楚（設計 D2 有完整的候選比較）|
| 把 `state`／`ended_*` 一起納入 MAC | 它們每次合法寫入都會變（結束、過期、`transcriptWrites` 同一次 `write`），要同步就得讓 `SessionStore.write` 變成 async——那是把 13 個呼叫端全部拖下水的改動，換到的是一個有界的殘餘風險（AC-7-①）|
| 金鑰輪替機制（多把金鑰同時有效） | 需要版本協商與清理策略，v1 沒有上線資料；先留痕（AC-7-③）|
| 「舊資料沒有錨就補寫一個」的祖父化路徑 | 這正是攻擊者要的（刪掉錨列就能讓被改的時間軸重新取得信任）；開發資料重建成本為零（設計 D7）|
| 把 60 秒容忍值拿掉 | 容忍值是為了 NTP 校正與平台抖動；它與本票的正交（錨不管「差多少」，只管「有沒有被改」）|
