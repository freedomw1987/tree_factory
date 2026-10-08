# TECH-008 設計 — session 讀取帶入「現在時間」

- **票號**：TECH-008（P2 / 1 SP）
- **對應 AC**：`docs/ac/TECH-008.md`
- **動到的檔案**：`worker/src/session.ts`、`worker/src/storage/session-store.ts`、
  `worker/src/meeting-do.ts`、`worker/test/session-clock.test.ts`（新）、`worker/test/session-store.test.ts`（呼叫端帶時間）
- **版本說明**：D3/D5 的措辭在 Gate 4（reviewer + oracle）之後**校正過一次**：
  原本寫成「擋得住把上限往後推」，oracle 實測證明那只在「平移量大於已錄時間」時成立。
  設計文件留著校正的痕跡（見 D3 的「校正前／校正後」），因為**宣稱過大本身就是缺陷**。

## 現況（動手前）

```ts
// session-store.ts（摘要）
read(): SessionSnapshot | null {
  const [row] = this.#sql.exec(SELECT).toArray();
  if (row === undefined) return null;
  return toSnapshot(row);          // ← 只驗型別/列舉，以及 ends - started === 2h
}
```

`toSnapshot` 驗的是**差值**（`endsAtMs !== startedAtMs + MEETING_MAX_MS`）與欄位合法性。
差值不變、位置平移，它就完全看不出來（見 AC 的背景表）。

## 設計

### D1 檢查放「讀取層」，但邏輯是**純函式**，且 `nowMs` 必填

```ts
// session.ts
export const SESSION_CLOCK_TOLERANCE_MS = 60_000;
export function sessionClockViolation(session: MeetingSession, nowMs: number): string | null;

// session-store.ts
read(nowMs: number): SessionSnapshot | null;   // 必填
```

- 純函式與 IO 分離：`session.ts` 已經是「無 IO、DO 與測試共用」的檔案（`sessionStatus` /
  `acceptsTranscriptWrites` 都在那裡），時間合理性檢查放同一處，測試不必碰 SQLite。
- **必填**而不是可選：可選參數的失敗模式是「新呼叫端忘了帶 → 這條防線靜默消失」，
  這是這一票最不想要的那種錯。必填會變成編譯錯誤，而且把「誰帶什麼時間」寫進型別。
- 呼叫端共 **13 處 `read(`**：`meeting-do.ts` 1 + `session-store.test.ts` 7 + `session-clock.test.ts` 5
  （第二輪 reviewer F-5：先前寫成 7／8／3 三種數字都與 repo 不符，這裡以 `grep -n "\.read("` 實數為準）。
- **不變式（新增，Gate 4 reviewer P2-2）**：**唯一**讀 `meeting_session` 的入口就是
  `SessionStore.read(nowMs)`；新路由**不得**直接 `storage.sql.exec("SELECT … FROM meeting_session")`。
  型別擋不住這件事（`exec` 回傳 `unknown`），所以它是**文件級不變式**：
  `grep -rn "FROM meeting_session" worker/src` 只允許命中 `session-store.ts`。

**可推翻**：若未來出現「沒有可信時鐘」的讀取者（例如離線分析/migration 工具），
再改成可選參數，但要在那個呼叫端明確寫下「此路徑不做時間合理性檢查」。

### D2 容忍值 `SESSION_CLOCK_TOLERANCE_MS = 60s`

- 量級依據：真實時鐘回調來自 NTP 校正 / 平台抖動（秒級），60s 足夠寬。
- 與既有的 `TRANSCRIPT_SKEW_TOLERANCE_MS = 60_000`（逐字稿 `startMs` 不得超過已過時間）**同數量級**，
  而且遠小於 `LIMIT_WARN_LEAD_MS = 5min`：容忍值不會讓黃橫幅與上限判定互相打架。
- **但這個數字不是「被放行的平移上限」**（Gate 4 oracle 校正）：因為檢查是位置的單邊
  （見 D3），被放行的平移量是 `Δ ≤ elapsed + 60s`，在會議尾端遠大於 60s。
  60s 只是「未來方向」的緩衝，不是「平移的容許量」。

**可推翻**：若真的觀察到 >60s 的時鐘回調導致誤擋，調高這個常數即可 ——
它是單一來源常數，且 AC-2 的邊界測試會隨之更新。

### D3 只驗**位置的上界**（不是「方向上的單邊」）——誠實寫下擋不掉的那一半

規則只有兩條（第二條是第一條 + 不變式的推論，仍獨立斷言）：

```ts
startedAtMs > nowMs + TOL                       → 違規
endsAtMs   > nowMs + MEETING_MAX_MS + TOL       → 違規
```

- **校正前（錯的）**：本節原本寫「擋得住『把上限往後推』（也就是真正能延長錄音的那個方向）」。
- **校正後（對的）**：這兩條加起來只等於「`started_at_ms` 不得落在 `now + 60s` 之後」，
  代入 `started_at = 原 started_at + Δ`、`now = 原 started_at + elapsed` 得

  ```
  違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS
  ```

  所以被放行的量值**隨會議進行而變大**：剛開始錄音時 Δ=1h 擋得住，已錄 1h 之後 Δ=1h 就放行。
  這不是方向問題而是**量值×位置**問題。用「方向」描述它會直接導致 AC 的宣稱過大（oracle F1）。
- **為什麼不補下界**：合法情境中存在「幾小時前開始、現在才讀」（查歷史會議），
  而往過去的平移**與真實歷史在 DB 裡長得一模一樣**（沒有不可同步改寫的錨點）。
  強行訂一個下界只會把合法讀取擋掉，而不會多擋到任何竊改。
- 這一票的價值因此是**明確但不完整**的：把「推到未來」與「單次大量位移」從**靜默**變成**吵鬧**，
  並把擋不掉的那一半寫進 AC-6 的釘樁測試與交付文 §4。

**可推翻**：若有了 DO 外的可信錨點（TECH-014）就能補上雙邊檢查；
**不要在 `meeting_session` 內加欄位就以為解決了**（見 D7）。

### D4 違規的出口：明確的 `SESSION_CORRUPT`（500 / `recoverable:false`）

```
{ "error": "SESSION_CORRUPT", "message": "SESSION_CORRUPT: meeting_session 資料不合法（…）",
  "recoverable": false }
```

- 動手前這種情況會落到 `catch` 的預設分支 → `INTERNAL`。「資料庫被竊改」與「程式有 bug」
  在維運上是兩件不同的事（前者要查封存/還原，後者要修程式），所以讓它有自己的 code。
- `recoverable: false` 依 system-design §5.2 的定義（裝置端不可繼續）：DO 每次讀都會失敗，
  這場會議已經不可用，裝置端應該停錄並讓使用者重開（而不是原地重試造成無聲重播）。
- 保持 500（伺服器端資料不合法是伺服器側的錯，不是請求的錯），與既有 `SessionCorruptError`
  的用法一致。
- **已知副作用（Gate 4 reviewer P2-1）**：錯誤也會從 `alarm()` 拋出（`alarm` → `#expireSessionIfReached`
  → `#readSession`），平台會**重試**這個 alarm。這是刻意的「吵鬧」而不是被吞掉，且有測試釘住；
  但它意味著壞資料的 DO 會週期性被喚醒。**目前沒有補償**（不重排 alarm、不改寫資料、不 log），
  已在交付文 §4 列為殘餘風險；`wrangler` log 內目前也**查不到** `SESSION_CORRUPT` 字樣
  （伺服器端沒有主動記錄），要定位得靠回應或平台指標。

**可推翻**：若 §5.2 決定「所有非預期錯誤一律收斂成 `INTERNAL`」（不洩漏細節），
就拿掉這個分支；但那樣就得放棄「維運一眼分辨竊改」的能力。

### D5 與 `expireSession` 的順序：先驗不變式、再過期收尾

```ts
#readSession(store) {
  const snapshot = store.read(this.#now());   // ← 先驗（含時間合理性）
  if (snapshot === null) return null;
  const expired = expireSession(snapshot.session, this.#now());
  if (expired === snapshot.session) return snapshot;
  const next = { ...snapshot, session: expired };
  store.write(next);                          // ← 過期收尾照舊落地
  return next;
}
```

- 順序刻意不變：讀取驗證（純函式、唯讀）→ 過期判定（可能落地）。
  **時間檢查失敗時不改動任何列**（AC-1），否則壞資料會被「修」成另一個壞樣子。
  措辭校正（reviewer P2-3）：`read()` 開頭一定會跑 `#ensure()`，冷啟動時那是
  `CREATE TABLE IF NOT EXISTS`（非 SELECT 但冪等、不碰任何列），所以精確說法是
  「**不改動任何列**」，不是「沒有任何非 SELECT 語句」。測試的觀測方式也相應定義為
  「違規後非 SELECT 語句數不變」（先 `write()` 讓 `#ensure()` 先發生）。
- 「錄到上限但沒人碰過」的 recording session（`now > ends_at`）**不是**違規：
  它是合法狀態，交給 `expireSession` 收成 `ended`/`limit`（AC-3）。
- rule2 是 defense-in-depth（reviewer P2-5）：在差值不變式成立時它不可達。

**可推翻**：若服務層（`index.ts`）改成先驗時間再進 DO，這一段就要跟著搬；
但現在時間的來源只有 DO 的 `#now()`（可注入），留在 DO 最省事。

### D6 壞時鐘也要吵：`Number.isFinite(nowMs)`（Gate 4 oracle F2）

```ts
read(nowMs: number) {
  if (!Number.isFinite(nowMs)) throw new SessionCorruptError(`讀取時間不是有限數：now=${nowMs}`);
  …
}
```

- 「必填」只保證有帶，不保證帶得對：`NaN` / `±Infinity` 會讓兩個 `>` 比較全部是 `false`
  → 整套時間檢查**靜默關掉**。這一票的核心價值是「不要靜默」，所以把它變成吵鬧的失敗。
- 正式環境不可達（`#now()` 回退 `Date.now()`，`index.ts` 未注入 `ctx.now`），
  但測試 / 未來的注入點 / JS 呼叫端都可能踩到，成本 1 行。
- 用 `SessionCorruptError`（而不是 `INTERNAL`）：裝置端同樣不可自行修復。

**可推翻**：若 `#now()` 之後改成由平台提供且保證有限數，可以把這行降級成 assertion。

### D7 真正的錨點不在這張票裡（oracle F6，另立 TECH-014）

要偵測「Δ ≤ elapsed + 60s」的平移，需要一個**對手不能同步改寫**的參考點。三個看似可行的都不行：

| 候選錨點 | 為什麼不行 |
| --- | --- |
| `meeting_session.created_at_ms`（DO 寫入） | 同一張表同一個 DB：能改 `started_at` 就能一起改它 |
| DO alarm（`getAlarm()`） | 實測：平移 +1h 後 alarm 仍是 2h（曇花一現的線索），但 alarm 到點後 `#rearmSessionAlarm()` 會把 alarm **重排到被竄改的 `ends_at`**，線索消失、會議繼續（200 / `recording`） |
| 「已寫入的逐字稿筆數 × 時間」 | 逐字稿本身也在同一個 DB |

可行方向：把「這場會議的權威開始時間」存在 DO 之外的受信來源（例如服務層的 KV / 另一張只有
伺服器能寫的表），或改用平台提供的單調時鐘 / 稽核欄位。**不在本票的 1 SP 內** → TECH-014。

**可推翻**：若 TECH-014 找到零成本的錨點（例如平台已提供 monotonic 欄位），
這一節就整段換掉，並把 AC-6 的釘樁測試改成「擋下」。

## 突變清單（實作後以突變證明測試真的在守；實跑結果見交付文 §3）

| # | 突變 | 預期 | 實跑（16 條中死了幾條） |
| --- | --- | --- | --- |
| M1 | 移除 `sessionClockViolation` 的呼叫（`read` 不驗時間） | 紅色 | 5 |
| M2 | 容忍值改 `Number.MAX_SAFE_INTEGER`（等於不驗） | 紅色 | 8 |
| M3 | 把 `>` 寫成 `>=`（邊界 +TOL 被擋） | 紅色 | 1 |
| M4 | 只驗 `endsAt`、不驗 `startedAt` | 紅色 | 1 |
| M5 | `#readSession` 傳 `0` 當現在時間（不帶真實時鐘） | 紅色 | 4 |
| M6 | 違規時仍把 snapshot 寫回（唯讀要求被破壞） | 紅色 | 1 |
| M7 | 拿掉 `SESSION_CORRUPT` 專屬分支（退回 `INTERNAL`） | 紅色 | 2 |
| M8 | **偷偷補上下界**（未經設計的「好心修正」） | 紅色（釘樁群必須因此變紅） | 2 |
| M9 | 拿掉 `nowMs` 有限性檢查（壞時鐘靜默放行） | 紅色 | 1 |
| M10 | `alarm()` 提早返回（不再收 session → 壞資料不再吵） | 紅色 | 1 |

**M8 是這一票第二次「突變改變思考」**：它證明 AC-6 的釘樁測試不是空的 ——
如果未來有人只改了程式而沒更新 AC/設計，那一排綠燈會立刻變紅。
（第一次是 M6 證明「同一份資料寫回去」抓不到，見交付文 §3。）
