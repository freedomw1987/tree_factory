# TECH-012 — 逐字稿串流的跨請求等價：聚段緩衝改成「會議級」（驗收標準）

- **票號**：TECH-012（P1 / 3 SP / 依賴 M01-US-103；由 US-103 Gate 4 的 **P0-1** 轉出）
- **目標**：把聚段緩衝從「請求級」改成「會議級」（**隨 DO 狀態存活**）。一次解掉三件事：
  ① 呼叫端把同一場會議拆成多個請求 → **靜默少字**（P0-1）
  ② 換一個 `meetingOffsetMs`，同一句變**兩列**
  ③ 顯示路徑（`pending`）與落地路徑**同源**
- **實作**：`worker/src/segmentation.ts`（`bufferedWords()`／`resume`）、`worker/src/transcript-stream.ts`
  （快照、還原、強制收段、重播去重）、`worker/src/storage/stream-buffer-store.ts`（新）、
  `worker/src/meeting-do.ts`（`/transcript/stream` 讀寫緩衝、offset 首值即權威）
- **測試**：`worker/test/stream-buffer-store.test.ts`、`worker/test/transcript-stream-resume.test.ts`、
  `worker/test/transcript-stream-route-buffer.test.ts`（皆新增）

## 背景（為什麼要有這一票）

US-103 把逐字稿真的寫進帳本，但 `#transcriptStreamRoute` 是**每個請求建一個** `TranscriptStream`：

```ts
const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: body.meetingOffsetMs });
```

聚段器的緩衝（「還沒講完的那半句」）因此活在**請求**裡，而不是活在**會議**裡。後果是：

1. **靜默少字（P0-1）**：呼叫端把同一場會議的事件串流拆成兩個請求，而切點落在**一句話中間**時，
   第一段請求的字留在第一個 `TranscriptStream` 的緩衝裡，請求結束就隨物件被丟掉——
   帳本裡**沒有那一句**，回應也**沒有錯誤**。呼叫端無從得知。
2. **同一句變兩列**：`meetingOffsetMs` 是「音訊第一幀 ≠ 會議開始」的差額，由呼叫端每次帶。
   若兩次請求帶不同的值，同一句的 `startMs` 不同 → 冪等鍵 `seg:<speaker>:<startMs>` 不同 →
   同一句話在帳本裡變成兩列（兩列都是「合法」的，因為鍵本來就不同）。
3. **顯示與落地不同源**：回應的 `pending`（US-104 的即時顯示用）也活在請求裡，跨請求就歸零。

US-103 當時的處置是「**文件契約 ＋ 釘樁測試 ＋ 開票**」——呼叫端被要求在請求內把每個段落收乾淨
（`finalize: true`）。那是把正確性外包給呼叫端；US-104 要在會議中即時顯示逐字稿之後，
跨請求的 `pending` 遲早要真的存在。這張票把緩衝搬到會議層。

另外，真 workerd 冒煙（`/tmp/tech012-smoke.mjs`）在「收尾之後重連」這條路上抓到了設計缺口，
已回寫成 D3 的修訂（見設計檔 §7）：收尾只清字、釘樁留著。

## 驗收標準（BDD）

### AC-1 跨請求等價：拆請求不得少字、不得多句

- **Given** 一份事件串流（真跡 38 則 nova-3 訊息），且已知「一個請求全部送完」的帳本結果
- **When** 把它拆成任意多個請求（每個請求的 `messages` 是連續切片，最後一個帶 `finalize: true`）
- **Then** 帳本內容與「一個請求全部送完」**逐字相同**（列數、`text`、`startMs`、`endMs`、`speakerId`）
- **And** 每個請求都拿到 200（不得因為拆開而 400/500）

### AC-2 一句話被切在請求邊界（半句）

- **Given** 第一句的 final 字分成兩半
- **When** 第一半在請求 A（**沒有** `UtteranceEnd`、沒有 `finalize`），第二半在請求 B
- **Then** 帳本只有**一列**，`text` 是整句（不是兩列、也不是 0 列）
- **And** 請求 A 的回應已經能用 `pending` 看到那半句（顯示與落地同源）

### AC-3 `meetingOffsetMs` 首值即權威（不得漂移）

- **Given** 這場會議第一次串流寫入帶 `meetingOffsetMs = 0`（值被持久化）
- **When** 後續請求帶 `meetingOffsetMs = 500`
- **Then** 回應 **409 `OFFSET_MISMATCH`**，附既有值（`meetingOffsetMs: 0`）
- **And** 該請求**零寫入**（帳本列數、`transcriptWrites` 都不變），緩衝也不動
- **And** 帶回同一個值（`0`）的請求仍然正常

### AC-4 `finalize: true` 收尾並清空緩衝（冪等），**offset 釘樁留著**

- **Given** 緩衝裡有半句
- **When** 請求帶 `finalize: true`
- **Then** 那半句**落地成一列**，緩衝的字清空
- **And** 再送一次 `finalize: true` 不會多出一句（`accepted: 0`）
- **And** 之後的新字從**新的**段落開始（不會與收尾那句黏在一起）
- **And**（修訂，真 workerd 冒煙抓到）收尾**不得**解鎖 `meetingOffsetMs`：換一個值仍然 409，
  帶回原值則可以續寫。第一版把整列刪掉，重連的裝置端就能用重算過的 offset 把時間軸漂移掉

### AC-5 會議邊界

- **Given** 緩衝裡有半句
- **When** 會議結束（`/session/stop`）或達 2 小時上限後又有請求進來
- **Then** 回應 409（`SESSION_ENDED` / `LIMIT_REACHED`），並附 `droppedBufferedWords: <n>`
  （**明講**未完成的那段被丟掉幾個字——不假裝它不存在）
- **And** 那筆持久緩衝被清掉，**不會**被下一場會議繼承

### AC-6 緩衝有界（一字不丟）：**字數 ＋ 字元**兩個上限

> **修訂（Gate 4 第二輪 oracle 的 P1）**：第一版只有字數上限（2000 顆），而它是**逐批**檢查的，
> 在真 workerd 上可以被證偽——一次送 2001 顆字時那一批本身就超過上限、守衛只能放行，
> 聚段器產出 12005 字元的段落 → 帳本 `MAX_TEXT_CHARS` 拒收 → **每個請求都 400**，
> `forcedFlushes` 永遠 0，那 2001 顆字只在會議結束時以 `droppedBufferedWords` 現形。
> 修法：改成**逐字**檢查，並加上**字元預算**（預設＝帳本的 `MAX_TEXT_CHARS`）。

- **Given** 緩衝已達字數上限（`MAX_BUFFER_WORDS = 2000`）
  （**預設組態下走不到這一條**，理由見下方「字元預算」：一顆字至少 1 字元、~1001 顆字就已讓字元那條先成立；
  本條以注入的小上限（`maxBufferWords: 3／2`）驗證）
- **When** 又有字進來
- **Then** 先把緩衝中那一段**強制收段落地**（`forcedFlushes: 1`），再餵新字
- **And** 一個字都沒丟（帳本兩列、字數總和正確）；緩衝字數回到上限以下

**字元預算（真上限，不是防禦線）**：

- **Given** 一次請求送進「落地後會遠超過帳本上限」的一段獨白（實測：2001 顆字 → 12005 字元）
- **When** 聚段器本來會把整段黏成一句
- **Then** 依字元預算**逐字**提早收段（`forcedFlushes > 0`），**每一列都落得了地**
  （`text.length ≤ MAX_TEXT_CHARS`、回應 200，**不得** 400 `TRANSCRIPT_INVALID`）
- **And** 一字不丟：所有列的字數總和 = 送進去的字數
- **And** 邊界是「**超過**才切」：恰好等於預算時不得先切（切了會多出沒有人要的碎句）
- **And** 預算算的是**真正落地的字**（`punctuated_word`）且**包含** `resume` 回來的緩衝字數
- **And** **單一 token 本身**超過帳本上限時，在**收進來之前**就 400（訊息指名長度與上限）：
  那顆字不進緩衝 → 同一場會議之後的正常字照常落得了地（修訂二；Gate 4 第二輪 oracle 的 P2。
  放行時的實測症狀是「之後每一次請求都 400、連正常字也落不了地」）
- **And** 那顆超長 token **丟得對但不能靜默**：400 的訊息指名長度與上限（這一格**不**用
  `replayedWords`；被丟掉的重播字怎麼通報屬 AC-9）

### AC-7 壞掉的持久狀態必須大聲壞掉

- **Given** `stream_buffer` 那筆資料被寫壞（不是合法 JSON／欄位不合法）
- **When** 下一個串流請求進來
- **Then** 回應 **500 `STREAM_BUFFER_CORRUPT`**（`recoverable: false`）
- **And** **不得**當成「沒有緩衝」繼續寫——那正是 P0-1 的靜默少字

### AC-8 回應欄位（介面增補，全部是加法）

- **Then** `/transcript/stream` 回應新增 `meetingOffsetMs`（權威值回聲）、`bufferedWords`、
  `forcedFlushes`、`replayedWords`（本次被判定成「早就落地的重播字」而沒進緩衝的字數）；
  `pending` 由持久緩衝還原。既有欄位（`accepted` / `duplicates` / `conflicts` /
  `transcriptWrites` / `appended`）語意不變
- **And** `replayedWords` 與 `duplicates` 是兩種單位、不合併：前者**字級**（被丟掉的重播字），
  後者**段落級**（帳本冪等鍵命中）

### AC-9 重播去重（接續的那半句不得疊字）

- **Given** 請求 A 送了半句（緩衝留住），但回應在路上掉了
- **When** 呼叫端原樣重送同一批（請求 B）
- **Then** 緩衝**不變**（不得變成「甲 甲」），帳本也不變
- **And** 之後的下一批字照常接上，落地時是**一列**正確的句子
- **And** 判準是「身分相同」（講者＋起訖秒＋字面）；改過內容的重播會走衝突路徑（大聲）
- **And** 重播的批次裡**含被判定成重播**的字時（Gate 4 第二輪 oracle 的 P1）：那些字**不得**
  被餵進聚段器（餵了會讓緩衝時間軸反向 → 之後**每個**請求 400）。
  這裡的判準是**時間軸覆蓋**不是逐字身分，所以「帳本時間已蓋到、但其實沒有落地」的交錯講者字
  可能被一併丟掉（`replayedWords` 看得見；交付文 §6 第 3 條有記載這個取捨）
- **And** 判準是「字終點 ≤ 緩衝現有內容終點」**且**「帳本的時間軸已蓋到該字終點」；
  沒被帳本蓋到的字（例如 US-102 回補的舊音訊）**不進判準**，一個字都不丟
- **And** 被丟掉的字以 `replayedWords` 報出（丟得對，但不靜默）。
  **範圍界定（Gate 4 第三輪 oracle 的 P2-1）**：「不靜默」指的是 **worker 回應層**；
  `app/ui` 目前沒有消費這個欄位（`grep -rn replayedWords app/ui/src` = 0 命中），
  所以從使用者角度看，那個排序下**是真的少字**。要不要接到 UI 告警 = 新票（交付文 §6 第 13 條）
- **And** 緩衝空時的重播**不變**：照舊交給帳本判 `duplicate`（US-103 AC-4/AC-1 的既有承諾）

## DoD（完成定義）

- [x] Gate 1：測試先紅後綠（3 個新測試檔，**54 條**；紅→綠的輸出貼在交付文 §3）
- [x] Gate 2：`worker` `tsc --noEmit` 通過 ＋ `markdownlint`（含本檔與設計檔）0 issues
- [x] Gate 3：`worker` 全量測試（**348 條**）＋ `REGRESSION_MODULE=M01` 回歸全綠；UI 未動仍跑一次 E2E 回歸（39 條）
- [ ] Gate 4：獨立 `reviewer` ＋ `oracle` 子代理（fresh context）審查，逐條處置 P0/P1/P2 並留痕
      ＞ 第二輪因 oracle 的 P1（AC-6 可被證偽）而**必須**重跑（凍結後才審、審完才提交）
      ＞ 第三輪因 oracle 第二輪的 P1（D10 重播含已落地的字）＋ reviewer 的 P2 一起修完而**必須**重跑
- [x] 真 workerd（`wrangler dev --local --var HARNESS_PROVIDER:faux`）冒煙：拆兩段請求＝一段的結果、
      半句跨請求、offset 漂移 409、finalize 清緩衝、**DO instance 換一個**後仍接得回來
- [x] 突變測試：**42 個**突變全部轉紅、還原後全綠（腳本自印表格貼進交付文 §4）
- [x] 文件：設計檔（D1~D10＋D10 修訂二）、`docs/ac`、`docs/backlog.md` 轉 DONE（v2.18）、交付文（含未驗事項誠實聲明）、`trust-log`
      ＞ 註：這一格在 Gate 4 第一輪之後才勾（reviewer 的 P3-6 指「backlog 已 DONE 但這格還沒勾」；順序上是**先審查、後落地文件**，不是漏）
- [ ] 未驗事項明講：顯示用的 interim 緩衝**不持久化**（設計 §6 有理由）；真 STT 的請求切法
      由呼叫端決定，本票只保證「不管怎麼切都等價」
