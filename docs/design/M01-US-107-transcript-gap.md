# M01-US-107 設計：背景／鎖屏缺口標記（`TRANSCRIPT_GAP`）

> AC：[docs/ac/M01-US-107.md](../ac/M01-US-107.md)｜Backlog：M01-US-107（3 SP，P0）
> 最後更新：2026-10-09｜狀態：已實作（見文末 §8 實作對照）

## 1. 問題定義與不變式

切到背景或鎖屏時 webview 不再收音（US-101 已誠實告知中斷），但**逐字稿上沒有任何痕跡**：
使用者回頭看會以為「那段時間沒人說話」。這一票要把「沒錄到」變成資料，而不是靠使用者記憶。

要守住的四件事：

1. **當下就寫**：`hidden` 事件發生的那一刻就要留下記號。等到回到前台才寫，等於把「被系統殺掉」
   這個最需要誠實的情境交给運氣。
2. **時間範圍以伺服端時間軸為準**：裝置時鐘可調；缺口位置的唯一可信來源是 `session.startedAtMs`
   （US-101 已定案的權威時間軸），裝置端只回報「相對會議開始的毫秒」。
3. **同一次中斷只標一次**：iOS webview 會重複送 `hidden`；重複標記會讓逐字稿被
   「此段未錄到」噪音淹沒，也讓使用者以為斷了很多次。
4. **離線不丟**：`hidden` 當下常伴隨斷網（尤其鎖屏）。本機先落地是最低要求，補送可以晚。

## 2. 決策

| 編號 | 決策 | 理由 | 可推翻 |
| ---- | ---- | ---- | ------ |
| **D1** | 缺口是一種**逐字稿條目**（`kind="gap"`），與未來的文字條目共用同一條 seq 空間 | 逐字稿的順序就是 seq 的順序；若另開一套 id，US-103/104 接上時就要重做排序與「同段不得重複」 | ✅ |
| **D2** | **先開後閉**（open → close）：`hidden` 時寫 `fromMs`、`toMs=null`；**真的續錄**（或結束會議）時補 `toMs`（見 D9） | 「當下就寫」與「知道結束時間」本質互斥；先開後閉讓兩者都成立。未閉合的缺口在 UI 明說「結束時間未知」 | ✅ |
| **D3** | seq 由裝置端決定但**持久化**（`localStorage` 的 `tree_factory.transcript-gaps.v1`），重開後從既有最大值 +1 | 若序號從 1 重算，被殺掉重開後的新缺口會撞上舊 seq，伺服端會判定「重複」而**丟掉一個真缺口**（最糟的假陰性） | ✅ |
| **D4** | 伺服端以 seq 為**主鍵**（`INSERT OR IGNORE`），閉合只允許「填 or 延長」，不得縮短 | 重複 `hidden` → `duplicate:true`、列數不變（AC-3）；晚到的 close 不得把範圍砍小 | ✅ |
| **D5** | 時間合法性在伺服端檢查：`seq` 正整數、`fromMs ≥ 0`、`toMs ≥ fromMs`、`fromMs ≤ 已過時間 + 60 秒容差` | 「未來的缺口」是資料錯誤，不是使用者行為；容差留給裝置與伺服端的時鐘漂移 | ✅ |
| **D6** | 開/閉不經過 state machine，而是由 `notifyVisibility` 這個既有出口**通知**（不是由它決定） | state machine 只管「收音狀態」；缺口是逐字稿的事。混進去會讓 `state.ts` 同時背兩種責任 | ✅ |
| **D7** | 缺口的長度 = **真的中斷了多久**（牆鐘時間）：`fromMs` 取中斷瞬間、`toMs` 取真的續錄（或結束會議）那一刻；即使畫面上的計時器在中斷期間凍結也一樣 | US-101 的權威時間軸（`session.startedAtMs`）是牆鐘；音檔在整段中斷期間**真的沒有**。若把缺口算成 0 長度，逐字稿就會保證「這裡有 1.5 秒的音訊」——那是假的 | ✅ |
| **D8** | 同 seq 但 `fromMs` 不同 → `409 GAP_CONFLICT`，本機該筆不再重送並標示「與伺服端不一致」 | 這代表本機 seq 被重算或接錯會議；靜默接受會讓兩份資料看起來都對，但合起來是錯的（同 US-102 D2 的心法） | ✅ |
| **D9** | 「關缺口」只由**真的回到錄音**觸發：續錄成功（`state==="recording"`）、結束會議、上限關閉。回到前景（`visibility_visible`）**只同步、不關閉** | `state.ts` 的 `visibility_visible` 刻意不自動續錄（要問「繼續這場會議？」）。若前景就收尾，缺口會在「錄音還沒恢復」時被寫成結束——使用者之後才按續錄，那段中斷就永遠沒人記得（Gate 4 F1） | ✅ |
| **D10** | 缺口長度讀 `RecorderStore.wallClockElapsedMs`（不受中斷凍結影響），**不得**讀 `snapshot.elapsedMs` | `snapshot.elapsedMs` 在中斷時凍結是**刻意的**（畫面計時不跳），但缺口要的是「牆鐘過了多久」。接錯來源 → 3 分鐘中斷記成 0 秒，而且畫面與伺服端會「一致地說謊」 | ✅ |
| **D11** | 永久性拒收（`SESSION_ENDED` / `LIMIT_REACHED` / `SESSION_NOT_STARTED`）→ 本機該筆標 `terminal`：保留、不再重送 | 之前一律當「暫時失敗」→ 每次啟動都重打一次註定失敗的請求，UI 永遠停在「待同步」；但那筆缺口是真的（使用者看過），不能刪——所以要誠實改成「僅存本機」 | ✅ |
| **D12** | 衝突列（D8）拉回時**整筆採用伺服端那份**，不得各取一半 | 各取一半會拼出兩邊都沒有、甚至 `toMs < fromMs` 的區間（伺服端自己保證 `toMs ≥ fromMs`），畫面就會出現「20:00 – 09:06」 | ✅ |
| **D13** | 會議結束／上限關閉後把 `gapTracker` 設為 `null`；`hidden` 只在「state 還是 `recording`（真的會被中斷）」時才開缺口 | 否則會出現幽靈缺口：會議早就結束，之後任何一次進背景都生出一筆送不出去的「未錄到」（409 反覆重試） | ✅ |

## 3. API 契約

| Method | Path | Body | 成功 | 失敗 |
| ------ | ---- | ---- | ---- | ---- |
| `POST` | `/m/:id/transcript/gap` | `{seq, fromMs, toMs?}` | `200 {accepted, duplicate, gap:{seq,fromMs,toMs}, count}` | `400 GAP_INVALID`、`409 SESSION_NOT_STARTED`、`409 LIMIT_REACHED` / `SESSION_ENDED`、`409 GAP_CONFLICT` |
| `GET` | `/m/:id/transcript/gaps` | — | `200 {gaps:[{seq,fromMs,toMs}], count}` | `409 SESSION_NOT_STARTED` |

語意：

- `toMs` 缺省 = 開缺口；帶值 = 閉合（只填／延長）。
- 同 seq 重送 → `duplicate:true`，**不新增列**；閉合資訊仍會被吸收。
- 同 seq 但 `fromMs` 不同 → `409 GAP_CONFLICT`（D8）；**不覆蓋**伺服端那份。
- `fromMs` / `toMs` 是**相對會議開始的毫秒**（`0` = 會議開始）。

## 4. 裝置端流程

```
visibilitychange(hidden)
  ├─ GapTracker.handleHidden()  ← **必須先做**：此刻 state 還是 recording，wallClockElapsedMs 才是中斷真正那一刻（D10）
  ├─ store.notifyVisibility(true)（既有：凍結畫面計時、熄紅燈、釋放麥克風）
  │    ↑ 只有在 state 原本是 recording（真的會被中斷）時才走上面兩步（D13）
  └─ 開缺口：本機寫入 {seq: max+1, fromMs, toMs: null, synced: false}（同步、立刻）→ POST 補送（失敗留 synced=false）

visibilitychange(visible)          ← 只同步
  └─ flushChunks() + GapTracker.sync()（**不關缺口**：錄音還沒恢復，D9）

真的回到錄音（resume 成功 → state === "recording"） / 結束會議 / 上限關閉
  └─ GapTracker.handleVisible() → 找未閉合缺口 → 本機補 toMs → POST 補送 → （結束／上限：gapTracker = null）
```

順序為什麼不能顛倒（D-US107-2）：`handleHidden()` 要在 `store.notifyVisibility(true)` **之前**做，
這樣它讀到的 `wallClockElapsedMs` 就是中斷那一刻，且不必依賴 state machine 的實作細節。
`hidden` 另外還有一個前置條件：呼叫前 `state` 必須還是 `recording`（真的是「錄音中被切斷」），
否則（例如會議已結束）不得開缺口（D13）。

補送時機：`initRecovery()`（重開）、`online`、`visible`。與 US-102 的分段補送共用同一個「本機先落地、
再對帳」的心法，但這裡的資料量極小（一場會議通常 0～3 筆），不做退避佇列。

## 5. 顯示（AC-2）

逐字稿面板現在只有「等待第一句…」的佔位。本票先把**缺口列**做成第一等公民
（`MeetingScreen.svelte` 內 `data-testid="transcript-gap"`）：

| 狀態 | 文案 |
| ---- | ---- |
| 已閉合 | 此段未錄到（12:03 – 15:41，共 3 分 38 秒） |
| 未閉合 | 此段未錄到（從 12:03 起中斷，結束時間未知） |
| 已閉合、未同步 | 同上 + 「待同步」標籤（`data-testid="gap-pending"`） |
| 與伺服端衝突（D8/D12） | 以伺服端範圍為準 + 「與伺服端不一致」標籤（`data-testid="gap-conflict"`） |
| 永久送不出去（D11） | 同上 + 「僅存本機」標籤（`data-testid="gap-terminal"`）；**不寫**「待同步」——那是「之後會同步」的承諾 |

時間格式沿用 US-101 的 `formatClock`（未滿 1 小時 `MM:SS`、滿 1 小時 `H:MM:SS`），
長度另外換算成「N 分 N 秒／N 秒／不到 1 秒」。有缺口列時**不再顯示**「等待第一句…」——
那句話在有缺口時會誤導（看起來像「這段沒人說話」）。

## 6. 失敗模式

| 失敗 | 處理 |
| ---- | ---- |
| `hidden` 當下斷網 | 本機先落地（`synced:false`）；`online`／下一次可見／重開時補送 |
| app 在背景被殺 | 缺口已在本機；重開後恢復流程會把它一起載回並補送 |
| 重複 `hidden` | 未閉合 → 直接忽略（AC-3） |
| 晚到的 close | 只填／延長，不縮短（D4） |
| 缺口一直沒閉合（app 直接死掉） | UI 明說「結束時間未知」；不猜、不補一個假的結束時間 |
| 會議已結束 | 拒收（409）——會後補寫缺口會讓逐字稿與時間軸對不上 |
| 同 seq 不同 `fromMs`（本機 seq 被重算） | `409 GAP_CONFLICT`；本機該筆標為衝突、不再重送，拉回時整筆以伺服端為準（D8／D12） |
| 會議已結束／上限到點才送（`409 SESSION_ENDED` / `LIMIT_REACHED`） | 標 `terminal`：保留本機、停止重送、UI 說「僅存本機」（D11）——不假裝它還會同步 |
| 會議結束後才進背景 | 不開缺口（`gapTracker` 已清空、且 state 不是 `recording`，D13） |

## 7. 測試計畫

| 層 | 檔案 | 驗什麼 |
| -- | ---- | ------ |
| worker 單元 | `worker/test/transcript-gap-routes.test.ts` | 開／閉、重複同 seq 不新增、晚到 close 只延長、非法範圍 400、未開始 409、結束後拒收、list |
| worker 儲存 | 同檔（`TranscriptGapLog`） | 跨 DO 重建仍在（重讀同一份 SQLite） |
| UI 單元 | `app/ui/src/lib/transcript/gap-tracker.test.ts` | 開→不重複開、閉→補 toMs、離線保留待補、重啟後 seq 不重用、拉回伺服端、衝突不再重送、衝突合併不拼出壞區間（D12）、永久性失敗標 `terminal`（D11） |
| UI 單元 | `app/ui/src/lib/recorder/store.test.ts` | 中斷時 `snapshot.elapsedMs` 凍結、`wallClockElapsedMs` 仍前進（D10 的資料來源） |
| UI 單元（接縫） | `app/ui/src/lib/transcript/gap-tracker-store.test.ts` | 真的 `RecorderStore` × 真的 `GapTracker`：中斷 3 分鐘的缺口長度真的是 3 分鐘；並留一條「接錯來源＝0 長度」的反面教材（D9／D10） |
| UI 單元 | `app/ui/src/lib/transcript/gap-text.test.ts` | 文案與時間範圍（含未知結束、極短、超過 1 小時） |
| UI 元件 | `app/ui/src/screens/transcript-gap-row.test.ts`（`svelte/server` render） | `data-gap-seq` / `data-gap-open`／待同步標籤／衝突與 `terminal` 標籤 |
| E2E | `app/ui/e2e/gap-marking.spec.ts` | 中斷→逐字稿出現缺口→續錄補範圍；重複 hidden 不重複標；兩次中斷兩列；離線「待同步」；中斷下結束會議會收尾（**且長度 ≥ 1 秒**，不是只驗 `toMs != null`）；回前景未續錄時缺口不得被提前關掉；結束後進背景不得生出幽靈缺口；每一步都同時驗伺服端帳本 |

## 8. 實作對照（2026-10-09）

- 伺服端：`worker/src/storage/gap-store.ts`（`TranscriptGapLog`）、`worker/src/meeting-do.ts`
  （`/transcript/gap`、`/transcript/gaps`；錯誤碼 `GAP_INVALID` 400）、`worker/src/index.ts` 路由表。
- 裝置端：`app/ui/src/lib/transcript/gap-tracker.ts`（純 TS、可單測）、`app/ui/src/lib/transcript/gap-text.ts`
  （文案）、`app/ui/src/screens/TranscriptGapRow.svelte`（缺口列）、`app/ui/src/lib/session/api.ts`
  （`writeGap` / `listGaps` + `TranscriptGapApiError`）、`app/ui/src/lib/app.svelte.ts`（`notifyVisibility` /
  `resumeMeeting` / `endMeeting` / `closeLimitSession` 接線）、`app/ui/src/screens/MeetingScreen.svelte`。
- 實測語意（Gate 3 的 E2E 抓到）：中斷 1.5 秒後續錄，伺服端收到的缺口是 `fromMs=1032, toMs=2589`，
  差 1557ms ≈ 真的中斷時間（D7）。
- Gate 4（雙 reviewer）對抗結果：5 條全部修完（F1 P0＝回到前景就關缺口／F2 衝突合併拼出壞區間／
  F3 衝突列沒有畫面提示／F4 缺 store×tracker 接縫測試且 E2E 用 `toMs != null` 假綠／F5 永久性 409 被當暫時失敗），
  每一條都先補測試（紅）再修（綠）；F1 另外加了 `gap-tracker-store.test.ts` 的反面教材防止改回去。
  修完後：UI 166 單元（18 檔）、E2E 24（4 檔）、worker 169、lint/typecheck 全綠。
- 未做（誠實聲明）：真機鎖屏（Chromium 無法真的鎖屏；由 `__tf.notifyVisibility` 走同一條程式碼驅動）、
  US-106 原生層的「補錄」。
