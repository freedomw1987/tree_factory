# M01-US-103 設計：多人語音即時轉譯（逐字稿帳本 + 串流落地管線）

> 範圍修正（誠實聲明）：M01-US-103 的 AC-1~4/6/7 都是**資料層**性質（誰說的、什麼時候、不重不漏）。
> 螢幕上的逐字稿顯示是 M01-US-104（3 SP, P1）。本設計只做 **worker 端**：落地帳本、串流事件解析、
> 分段管線、讀寫 API。UI 一個字都沒改（所以本票沒有新 E2E，Gate 3 以既有 35 條 E2E 全綠當回歸證據）。

## 1 問題

`POST /transcript`（US-101 寫入守門員 + US-102 分段冪等）從第一天就寫著
「逐字稿內容的落地由 M01-US-103 接上」。現在有兩個洞：

1. **文字沒有地方可放**：會議中講的每一句只被計數，沒有任何一列真的存下來。
2. **串流事件沒有人翻譯**：STT 送來的是 `Results` / `UtteranceEnd` / `SpeechStarted` 的原始訊息
   （SPIKE-001 已證實 `diarize` 可行、每個字都帶 `speaker`），但 `worker/src/segmentation.ts`
   只吃「已整理過」的 `StreamEvent`，中間那層解析 + 落地管線**不存在**。

## 2 資料流

```
STT 原始訊息（nova-3 WS）
   │  raw JSON
   ▼
worker/src/nova-events.ts      parseNovaMessage()      ← 純函式，可用 SPIKE-001 真跡重播
   │  NovaEvent[]（words(final/interim) / utterance_end / speech_started）
   ▼
worker/src/segmentation.ts     TranscriptSegmenter     ← US-109 既有（被打開來用，不改）
   │  TranscriptSegment（完成段）
   ▼
worker/src/transcript-stream.ts TranscriptStream       ← 本票新：冪等鍵、重疊標記、finalize
   │  record(...) ＋ previousEndMs(...)      ← sink 介面（實作就是帳本）
   ▼
worker/src/storage/transcript-store.ts  TranscriptLedger  ← DO SQLite，append-only
```

寫入路徑（三條，語意互斥、不重疊）：

| 路徑 | 誰用 | 落地內容 |
| --- | --- | --- |
| `POST /transcript/segments` | 裝置端／外部已分好段的句子 | 直接進帳本（整批先驗證）|
| `POST /transcript/stream` | 伺服端 STT 串流（本票的正式路徑）| 原始訊息 → 解析 → 分段 → 進帳本 |
| `POST /transcript`（既有）| US-101/102 的舊客戶端 | **只計數、不落地**（維持既有契約；帳本才是文字的唯一真實來源）|

讀回路徑：`GET /transcript/segments`（依 `seq` 遞增）與 `GET /session` 的 `transcriptWrites` 計數。

**HTTP 動詞守門（append-only 的 HTTP 面）**：`POST /transcript/stream` **只收 POST**（非 POST → 405 `METHOD_NOT_ALLOWED`
＋ `allow: POST`）；`/transcript/segments` 收 `GET`／`HEAD`（讀回）與 `POST`，其餘 → 405 `METHOD_NOT_ALLOWED`
＋ `allow: GET, POST, HEAD`。兩條都**不得寫入**。理由不是潔癖：沒有這道守門時
`DELETE /transcript/stream` 帶合法 body 會被當成 POST 走完、**反而寫進一列**（Gate 4 兩輪各抓到一次，
第二輪抓到的是本票的**正式路徑**漏了守門）。

## 3 資料表

```sql
CREATE TABLE IF NOT EXISTS transcript_segments (
  seq             INTEGER NOT NULL,   -- 由帳本單調配發，1 起算，只增不改
  idempotency_key TEXT    NOT NULL,   -- 段落身分（見 D3）
  speaker_id      INTEGER NOT NULL,   -- 0 起算（SPIKE-001 / US-109 一致）
  text            TEXT    NOT NULL,
  start_ms        INTEGER NOT NULL,   -- 相對會議開始
  end_ms          INTEGER NOT NULL,
  overlap_ms      INTEGER NOT NULL DEFAULT 0,  -- 與前一段重疊的毫秒（AC-4）
  created_ms      INTEGER NOT NULL,
  PRIMARY KEY (seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_segments_key ON transcript_segments (idempotency_key);
```

`meeting_id` 不放進表格：**一個 DO 就是一個會議**（US-101 起就如此，`gap-store` 同款），
多存一欄只會讓「唯一鍵」多一個永遠相同的維度。跨會議隔離由 DO id 保證。

## 4 決策

### D1 權威時間軸留在伺服端，裝置端只送「相對會議開始的毫秒」
沿用 US-101「伺服端權威」與 US-107 的缺口時間軸。**正準單位 = 毫秒**（AC-2 原寫「秒」，見 D2）。
伺服端以 60s 容差擋掉明顯不可信的未來時間戳；容差**自成一常數**
（`TRANSCRIPT_SKEW_TOLERANCE_MS`，與 US-107 的 `GAP_SKEW_TOLERANCE_MS` 同值但不同模組），
不直接 import 缺口的常數——兩個功能的容差日後可能各自調整，耦合會讓改一邊時誤傷另一邊。

`meetingOffsetMs`（音訊第一幀相對會議開始的毫秒）**沒有預設值**：默默當 0 等於宣稱
「按下開始的瞬間 STT 已經連上」，那是假的。缺它或給負數 → 400。

### D2 AC-2 的單位由「秒」修正為「毫秒」（doc 修正，非放寬）
US-109 的分段器輸出就是 ms（`startMs`/`endMs`），US-107 的缺口也是 ms。若帳本用秒，
每個邊界都要 `round(ms/1000)` 一次，兩段相鄰的句子會被四捨五入推到重疊或留縫——那是**自己製造**的假重疊。
故 `docs/ac/M01-US-103.md` 的 AC-2 修正為毫秒（v1.2），理由記在變更歷史。**驗收標準不變，只有單位換算消失。**

### D3 段落身分（冪等鍵）= `seg:<speakerId>:<startMs>`
同一個人、同一個起點＝同一句。前綴 `seg:` 由管線加上（`SEGMENT_KEY_PREFIX`），
之後若有別的來源（例如人工補登）不會撞進同一個命名空間。於是：

鍵用的是**位移後**的 `startMs`（`段落起點 + meetingOffsetMs`），所以「同一句話用不同 `meetingOffsetMs` 送出」
＝兩個不同身分（AC-2 要的正是這件事：毫秒是判準，不是裝飾）。同一個 offset 重播才是 `duplicate`。

- STT 重送同一段 → 同鍵 → `duplicate:true`，**不新增列**（AC-3、AC-6）。
- 不同人同時說、起點巧合相同 → 鍵不同（speakerId 不同）→ 兩列都在（AC-4）。
- 真的兩句同人同起點（例如人為重播）→ 第二句是 `conflict`（D8），不會變成靜默覆寫。

### D4 只有 `is_final` 的字進帳本；interim 只留在記憶體
AC-6 的「interim + final 混餵同一段只產生一段」由這條規則**結構上**保證——interim 根本不落地。
`pending()` 是本票提供的**唯一**顯示介面（回傳緩衝中最新的段落，含 interim）。

**注意「final ≠ 收段」**：final 只代表「這段文字不再變動」，還要等停頓 / `UtteranceEnd` / `finalize`
才成為帳本裡的一列。真跡實測：31 則 `Results` 裡有 7 則 `is_final:true`（第 7 則是空 `transcript`，被 D11 丟掉），
6 則有字；最後落地 6 段，但**段落邊界與 final 邊界不重合**——final#2 就跨了第 2、3 段
（它含 `Right.` 這句換人說的回應）。所以「6 段」是聚段器按講者變更／停頓切的結果，不是「每個 final 一句」。

另外，`pending()` 的品質只保證一件事：**不重複**。真跡的 interim 是「累積式重送」
（每則 interim 都重述那句到目前為止的全文，實測 24 則全部如此），若照單全收會讓 `pending()`
把同一句疊到 4 份；因此顯示緩衝在「本批字與緩衝重疊」時先丟舊的再餵（D13）。
仍有一個已知的顯示瑕疵：訊號換句的那一則 interim 講者標記可能是錯的、且停頓未達門檻，
`pending()` 會短暫把兩句接在一起（修正於該句的 final 到達時；實測 24 則中 1 則如此）。
**本票不決定 UI 要怎麼呈現**（合併、上色、捲動都是 US-104）——這裡只保證資料不重複、不遺漏。

### D5 `UtteranceEnd` 是主要切段訊號；1200ms 停頓門檻是後備規則
`utterance_end_ms=1000`（SPIKE-001 實測參數）比聚段門檻 1200ms 早到 200ms。
事件到就直接收段（AC-7）；沒有 endpointing 訊號的來源（例如純 REST 批次）才靠 1200ms 門檻切。
實測真跡裡**沒有任何 `UtteranceEnd`**，而且 31 則 `Results` 的 `speech_final` **全是 `false`**
（0 則 `true`）。也就是說「nova-3 會回 endpointing 訊號」在本票是**規格**、不是實測結果：
AC-7 的證據只能是「真跡事件重播 + 合成 `UtteranceEnd`」兩者並列，不能假裝是真跡。

`UtteranceEnd` 還有一個實作細節：它的語意是「上一句到這裡結束」，所以**可能比那句的 `final` 早到**
（AC-6 的 Given 正是這個順序：interim → UtteranceEnd → final → final）。訊號一到就收段會切在**空緩衝**上
（實測：整段併成一句）。故訊號先記成旗標（D12），等緩衝真的有字、下一個 `words` 事件到來時才真的切。

### D6 重疊發言：分段器切段、帳本留痕（重疊值問帳本，不問記憶體）
`segmentation.ts` 的規則①「speaker 變更即切段」讓交錯的兩人字詞各自成段，**沒有一個字被丟掉**（AC-4）。
管線寫入 `overlapMs = max(0, 前一段.endMs - 本段.startMs)`（上限夾在本段長度內）。

「前一段」的來源是**帳本自己的查詢**（`previousEndMs(startMs)`：起點更早、最接近的那一列），
不是管線裡的記憶體指標。這不是潔癖：第一版用記憶體指標，重播同一份事件串流時，
第一段的「前一段」變成**上一輪的結尾**，於是同一句話在重播時帶著不同的 `overlapMs`
→ 撞到 D8 變成 `conflict`（AC-1 的重播等價當場破功，實測被測試抓到）。改成問帳本後：

- 重播時第一段永遠是「沒有前一段」→ `overlapMs = 0` → 同鍵同內容 → `duplicate`（AC-1、AC-3）。
- 亂序補送也一樣有確定答案（問的是時間軸，不是送達順序）。

### D7 append-only 用「沒有 API 可以改」來強制
`TranscriptLedger` 不提供任何 update/delete；`seq` 由 `MAX(seq)+1` 單調配發。
AC-3「不得改寫既有句子」不是靠自律，是靠**型別上做不到**。
被驗證擋下或判定衝突的請求**不燒 seq**（否則編號會出現無法解釋的跳號）。

### D8 同鍵不同內容 → 不寫入、回報 `conflict`（不得靜默）
「重送的更長版本」與「AC-3 不得改寫」相衝時，選 **AC-3**：既有那句是已發生的事實，
晚到的版本才是有爭議的一方。但**不靜默**：回傳帶 `existing` + `incoming` 兩個全文，
讓上層能記錄／人工判斷。這是本設計唯一會「不落地」的情況，故另立一列並有測試釘住。

### D9 寫入守門與 US-101 共用；`transcriptWrites` 只算**新增**的句子
`acceptsTranscriptWrites()`（未開始／已結束／2:00 上限）對新路徑一體適用，且**先守門再驗證**
（上限到了要回 409，不是讓裝置端以為內容有問題）。`/transcript` 舊路徑只計數；
新路徑計數並落地，而且**重送與衝突不增加計數**（否則重試會讓「寫了幾句」失去意義）。
US-101 的 DoD 探針（上限後 409 且次數不變）因此仍然有效。

### D10 串流收尾必 `flush()`
SPIKE-001 的失敗模式：只送 `CloseStream` 會掉最後一句。故串流路徑提供 `finalize:true`
（＝`finalize` + `flush()`），把緩衝中的最後一段落地；`flush()` 具冪等性（`segmentation.ts` 已保證第二次回 `null`），
所以重複 `finalize` 不會多出一句。

### D11 解析器的兩個「不」：不因缺 speaker 而丟字、不因空 transcript 而吐空句
- 缺 `speaker`（沒開 `diarize` 的來源）→ 當 0：「全部都是 0 號」是誠實的表示（＝沒有分軌資訊），
  讓整段消失才是說謊。
- 空 `transcript`／`words: []` 的 `Results` → 回空陣列。**真跡最後一則就是這種**
  （`{is_final:true, alternatives:[{transcript:"", words:[]}]}`，Deepgram 收尾時會回），
  若照收就會多出一句空話。

### D12 `UtteranceEnd` 延後到「緩衝有字」時才切
訊號先記旗標（`#pendingUtteranceEnd`），真正的切段發生在**下一個 `words` 事件**，
且只在緩衝非空時執行；緩衝還是空的就繼續等（旗標不消）。理由見 D5：
訊號早於 final 是正常順序，一到就切會切在空緩衝上（實測併成一句）。
效果：`interim(第一句) → UtteranceEnd → final(第一句) → final(第二句)` → 2 段（符合 AC-7 的 Then）。

**已知後果（第二輪審查抓到，刻意留下並釘住）**：`parseNovaMessage` **丟掉** `UtteranceEnd.last_word_end`，
所以管線不知道這個訊號指的是哪個時間點；若訊號遲到時緩衝裡已經換成**下一句**
（前一句先被 1200ms 停頓門檻切走了），旗標就會被下一句吃掉，多切一刀：
`A(0–1) → B(3–4) → 過期的 UE → C(4.1–5) → D(5.1–6)` 得到 `A | B | C D`，
而沒有那則過期訊號時是 `A | B C D`。**不會丟字**（不變量仍成立），只是多一條邊界。
要根治得保留 `last_word_end` 並比對容差；本票選擇「寫下來 + 釘樁測試」，與 P0-1 同一個處置立場。

### D13 顯示緩衝以「重疊」判準去重
`#feedDisplay` 在本批字的第一個字起點**不晚於**緩衝結尾時，先 `flush()` 再餵。
不能比「緩衝起點」：真跡 interim 的講者標記不可靠（前 13 則一律標 `speaker 0`，連屬於 `speaker 1`
的句子也被標成 0），緩衝起點因此可能停在好幾句之前，比起點會漏掉第 2 句之後的每一次重述
（實測 `pending()` 疊到 4 次）。改判準後：24 則 interim 有 23 則 `pending()` 恰好等於該批文字
（**環境＝只餵 interim 的餵法**，即 `transcript-stream.test.ts` 那條；真跡整串重播會把 final 也餵進顯示
緩衝，那時是 19/24——差異來自跨講者的殘句，不是重複；這個數字已由測試釘住）。
判準假設來源是**累積重送**；若來源改成零間隙的增量片段，判準恆真 → 每批都 `flush()` 而回傳值目前被丟棄
（顯示是 US-104）→ `pending()` 只剩本批。**這是顯示層語意，不影響帳本與 AC**（Gate 4 第二輪 P2-2）。

### D14 呼叫端契約：`/transcript/stream` 的緩衝生命週期＝一個請求
`TranscriptStream` 的聚段緩衝是物件狀態，所以**同一場會議的事件必須在同一個請求裡送完**
（最後一個請求帶 `finalize:true`）。違反契約不會報錯，只會**少字**。實測（真跡 6 則 final）：

| 送法 | 結果 |
| --- | --- |
| 一次送完 + `finalize:true` | 6 段、66 字（正確）|
| 每則 final 一個請求、都不 `finalize` | 4 段、**28 字（少 38 字）**，且沒有任何錯誤回報 |
| 每則 final 一個請求、每個都 `finalize` | 10 段、66 字（字都在，但切法與一次送完不同）|

正式路徑是 DO 內的 STT WS（同一個「請求」就是同一條連線），所以生產上不會踩到；
但對外 API 必須講清楚，否則下一個接線的人會照著 REST 直覺拆請求然後靜默漏字。
**這個契約用測試釘住**（`transcript-stream.test.ts` 與 `transcript-ledger-routes.test.ts` 各有一條），
緩衝持久化列為後續票（§6）。

## 5 錯誤與邊界

| 情況 | 行為 |
| --- | --- |
| `speakerId` 非 0~63 整數 / `text` 空白或 > 2000 字 / `endMs < startMs` / 時間戳非非負整數 / `overlapMs` 超過本段長度 | 400 `TRANSCRIPT_INVALID`（不得寫入）|
| `startMs` 或 `endMs` > 已過時間 + 60s | 400 `TRANSCRIPT_INVALID`（逐字稿不得落在未來）|
| `meetingOffsetMs` 缺少 / 負數 / 非整數 | 400 `TRANSCRIPT_INVALID`（D1，不得默默當 0）|
| 批量寫入中有一個不合法 | 整批不寫（400）；**串流路徑例外**：串流是逐段落地的，壞的那一段會 400、前面已落地的保留（見 §6）|
| 同一 `idempotencyKey` 重送相同內容 | 200 `duplicate:true`（列數與計數都不變）|
| 同一 `idempotencyKey` 不同內容 | 200 `conflict:true` + `existing` / `incoming`（列數不變，D8）|
| 會議未開始 / 已結束 / 超過 2:00 上限 | 409 `SESSION_NOT_STARTED` / `SESSION_ENDED` / `LIMIT_REACHED`（US-101 既有語意）|
| 合法 JSON 的 `null`／陣列／純量 body | 400 `TRANSCRIPT_INVALID`（不得 500）——**三條寫入路由都適用**；`/transcript/gap` 原本會 500，Gate 4 第二輪 P2-3 一併修掉 |
| 原始訊息型別不認識 / `words` 缺欄位 / 整則不是物件 | 忽略該事件（`parseNovaMessage` 回空陣列），不得 500 |
| 某個字缺時間戳 | 只丟那個字，其餘仍成段（不得整段陪葬）|
| `is_final:false` 的 `Results` | 只更新 `pending()`，不落地（D4）|
| `UtteranceEnd` 而緩衝為空 | 回 0 段（不得產生空句）|
| 亂序／重播真跡整段 | 由冪等鍵收斂（**同一個 `meetingOffsetMs`** 下重播第二次 → 全部 `duplicate`）|

## 6 失敗模式（我們選擇的立場）

- **STT 斷線 / 憑證失效**：本票不做重連；`parseNovaMessage` 的容忍度只保證「壞訊息不會毒死管線」。
  真實 WS 連線在本地開發環境不可得（需要 Cloudflare 帳號憑證），故本票**沒有**端到端真 STT 證據。
- **串流落地是逐段的**：`/transcript/stream` 收到一批事件後會邊解析邊寫；
  若中途某一段被驗證擋下（例如時間戳超出容差），前面已寫入的段落**不會回滾**，
  該次請求回 400 並指出欄位。這是刻意的：串流是即時路徑，把它做成「全有全無」
  等於讓一個壞時間戳把整個會議的進度卡住。批量補寫（`/transcript/segments`）才是全有全無。
- **同一段被切成兩次**（例如 finalize 早到）：第二筆起點不同 → 是新的一段，不是重複（D3 的鍵含起點）。
- **時間戳回退**（上游壞資料）：`endMs < startMs` 直接 400；不猜、不修、不靜默歸零。
- **聚段緩衝活在物件裡（P0-1，見 D14）**：`/transcript/stream` 的緩衝生命週期＝**一個 HTTP 請求**。
  呼叫端若把同一場會議的事件拆成多個請求，緩衝中的句子會跟著請求一起消失，而且**不會有任何錯誤回報**。
  正式路徑（DO 內的 WS）沒有這個邊界，但這條契約必須寫下來。真正的修法是緩衝持久化（跟隨會議狀態），
  已開票追蹤；本票以契約 + 釘樁測試處理。
- **`GET /transcript/segments` 沒有分頁**：整場會議一次回傳。當前上限（2 小時）下可接受，
  但兩小時的逐字稿不該靠 `JSON.stringify` 直接吐；分頁與增量讀取列在追蹤票裡。
- **串流部分寫入與計數的落差（已知，未修）**：`/transcript/stream` 是逐段落地的，
  如果請求中途被擋（400），前面已落地的段落會留著，但該次請求回 400 → 呼叫端不會拿到那次的
  `transcriptWrites`。帳本內容正確，**計數可能落後**。修正方式（把計數改成每次寫入即更新）
  留給後續票，本票在交付說明與此處明講。

- **`speech_started` 解析但未使用（小債）**：`nova-events.ts` 會把它轉成事件，管線目前不消費。
  留著是為了「同一份真跡餵進去，事件序列完整」；若之後要做「沒收到字就報錯」，這裡是掛點。
- **同一段被驗證兩次（小債）**：`transcript-stream.ts` 先 `validateSegment` 再由 `ledger.record` 再驗一次。
  重複但**沒有矛盾**（兩邊都容許同一個範圍），拿掉任一邊都會讓另一條路徑失去守門，故不動。

## 7 測試與證據

### 7.1 測試清單

| 檔案 | 內容 |
| --- | --- |
| `worker/test/nova-events.test.ts` | 解析真跡 `spike-001-ws-diarize.json`（31 則 `Results` → 30 則有字、final 6 / interim 24）；**真跡 final 66 個字的時間戳在同一則訊息內不倒退（`start`／`end` 都非遞減；242 個字全量另經人工核對為 0 違規）**；空 transcript 不回事件；壞字只丟自己；合成 `UtteranceEnd`；壞訊息容忍 |
| `worker/test/transcript-ledger.test.ts` | 追加單調、重送 duplicate、同鍵異內容 conflict、驗證 400（不燒 seq）、append-only（無 update API）|
| `worker/test/transcript-stream.test.ts` | 管線：interim 不落地（AC-6）、final 重送只一段、UtteranceEnd 早切（AC-7）與**訊號早於 final**（D12）、真跡 6 段且 speaker 0/1 交替、重播等價（AC-1）、整段重播全 duplicate（AC-3）、重疊留痕與字詞不丟（AC-4）、`meetingOffsetMs` 進身分（AC-2）、finalize 不掉尾（D10）、壞訊息不毒死管線、`pending()` 不疊字（D13，含**釘住 24 則中 23 則恰好等於該批**）、**呼叫端契約 6 段 66 字 vs 每則一請求 4 段 28 字 / 10 段 66 字（P0-1）**、**AC-7 的兩段 `overlapMs` 都是 0**、**過期 `UtteranceEnd` 多切一刀但不丟字（D12 已知後果，釘樁）** |
| `worker/test/transcript-ledger-routes.test.ts` | DO 路由（真 `node:sqlite`）：守門 409、寫入與讀回排序、duplicate 不增計數、conflict 附全文、整批驗證、單物件也收、舊 `/transcript` 不落地、上限探針、跨 DO 重建仍在、**HTTP 動詞守門：兩條路由各一條（`/transcript/segments` 與正式路徑 `/transcript/stream`；DELETE/PUT/PATCH/GET → 405＋`allow` 且列數不變）**、**壞 body（null／陣列／純量／空／`segments` 非陣列／`segments[i]` 不是物件／`finalize` 非布林）→ 400 不得 500**、**計數不含重送** |

### 7.2 原有測試的處置

`worker/test/segmentation.test.ts`（US-109）**不動**——它是被本票打開來用的既有零件。
`session-routes.test.ts` 的 `/transcript` 斷言也**不動**（該路徑契約沒變，D9）。
`worker/test/transcript-gap-routes.test.ts`（US-107）**加了**一條（Gate 4 第二輪 P2-3：
合法 JSON 的 `null`／陣列／純量 body → 400 而不是 500）；原有 11 條斷言不動。

## 8 變更歷史

| 版本 | 日期 | 變動 |
| --- | --- | --- |
| v1.0 | 2026-10-09 | 初版：D1~D10 |
| v1.1 | 2026-10-09 | 依實作回頭修正：D3 鍵加 `seg:` 前綴；D6 重疊值改問帳本（記錄重播漂移的真實缺陷）；新增 D11（解析器兩個「不」）；§5 補上串流路徑逐段落地與批量整批不寫的差別；§6 明講串流不做回滾 |
| v1.3 | 2026-10-09 | 第二輪審查（Gate 4 R2）後修正：§2 新增「HTTP 動詞守門」段（`/transcript/stream` 漏了守門 → 非 POST 動詞會**真的寫入**，補 405 `allow: POST`）；D12 補「過期 `UtteranceEnd` 多切一刀」的已知後果（含釘樁測試）；D13 補「環境＝只餵 interim」與零間隙增量來源的**顯示層**限制（P2-2）；§5 補「合法 JSON 非物件 body → 400」列（`/transcript/gap` 原本 500，P2-3）；§6 補兩項小債（`speech_started` 未使用、同一段重複驗證）；§7.1 補新測試（真跡單調、AC-7 `overlapMs`、stream 動詞守門、`finalize` 型別、`segments[i]` 指名、顯示緩衝 23/24）|
| v1.2 | 2026-10-09 | 審查（Gate 4）後修正：新增 D12（UtteranceEnd 延後收段）、D13（顯示緩衝去重判準）、D14（**呼叫端契約**，P0-1）；D3 補「鍵含 offset」；D4 改寫 final↔段落關係（原本寫成「7 則 final 收斂成 6 段」，與實測的 final#2 跨第 2/3 段不符）；D5 更正 `speech_final` 敘述（真跡 31 則全為 false）；§5 重播列補「同一個 offset」前提；§6 補三項技術債（請求級緩衝、無分頁、部分寫入與計數落差）；§7.1 補新測試 |
