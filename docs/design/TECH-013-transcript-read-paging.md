# TECH-013 設計 — 逐字稿讀取分頁／增量 ＋ 計數一致（D1~D6）

- **票號**：TECH-013（P2 / 2 SP；起點：US-103 Gate 4 的 P2-4／F5）
- **驗收標準**：`docs/ac/TECH-013.md`
- **範圍**：`worker/` 內兩個檔（`storage/transcript-store.ts`、`meeting-do.ts`）＋ 測試 ＋ 冒煙。
  **不動** UI、不動帳本 schema、不動 AC-1~AC-7 的既有語意。
- **為什麼現在做**：US-104（會議中顯示逐字稿）會接上這條讀取路徑；先把「怎麼讀」訂好，
  免得顯示層用整場重抓的方式把 1 MB 的行為固化成依賴。

## D1 增量讀取的鍵是 `seq`，而且是**排他**下界

`seq` 是帳本的 `INTEGER PRIMARY KEY`，由 `MAX(seq)+1` 在 INSERT 時配發（D7）。
它天生是「單調、無洞、唯一」的游標，不需要另造 `updated_at` / cursor token。

- `?since=N` → 只回 `seq > N`（排他）。理由：呼叫端語意是「我已經有 N 了」，
  若做成包含式，每個消費端都得自己 `N+1`，久了就有人寫錯方向。
- 不帶 `since` → 不設下界（＝從第一列）。

**可推翻**：若日後出現「補寫早於既有列」的需求（本票不做，append-only 也擋著），
`seq` 順序就未必等於時間順序；那時游標得換成 `(start_ms, seq)` 複合鍵。

## D2 分頁用 `limit+1` 探測，不多打一次 `COUNT`

`listPage(since, limit)` 內部固定抓 `limit + 1` 列：

```
SELECT … FROM transcript_segments [WHERE seq > ?] ORDER BY seq ASC LIMIT ?
```

- 回傳前切掉多出來的那一列 → `hasMore = rows.length > limit`。
- 好處：一次查詢同時得到「這一頁」與「還有沒有下一頁」，不需要 `COUNT(*) … WHERE seq > ?`
  再算一次（那會是第二趟掃描）。
- `total` 仍走既有的 `count()`（`SELECT COUNT(*)`）——它是「整場有多少句」，
  與分頁無關，US-104 要用它顯示進度。

**可推翻**：若日後帳本量大到 `COUNT(*)` 成為負擔，可改成維護一個 count 欄位；
本票不做，因為兩個數字都要對得上才是重點，而 `COUNT(*)` 目前誠實且便宜。

## D3 預設限量＝上限 500，且**截斷一定看得見**

`SEGMENT_PAGE_LIMIT_MAX = 500`，`limit` 預設就是它（沒有「無上限」選項）。

- 這是本票唯一的**對外行為改變**：以前不帶參數＝整場，現在不帶參數＝最多 500 列。
- 為什麼還是要做：兩小時會議粗估近 2000 列，一個「可以回 3 MB 也可能不回」的預設值，
  正是 US-103 §6 記的技術債。截斷若不可見就是缺陷；可見（`hasMore` + `total`）就是分頁。
- 為什麼是 500：一個畫面看不完 500 句；US-104 用的是一頁內可渲染的量，其餘靠 `since` 續抓。
  500 也讓回應大小有可預期的上限。量級用真跡實測的段長換算（66 字/段 ≈ 200 bytes）：
  2000 列 ≈ **0.4 MB**；若每一段都頂到 `MAX_TEXT_CHARS = 2000` 字的上限（中文字 UTF-8 3 bytes）
  則是 500 × 6 KB ≈ **3 MB**——這是**判斷不是量測**，真跡裡沒有任何一段接近上限。
- **相容性影響**：US-103 的消費端只有冒煙腳本與測試（列數 < 10），US-104 還沒實作，
  所以現在改預設不影響任何在用的人。這件事明文寫在交付文 §4 與 backog。

## D4 參數不合法 → 400，且**不得靜默夾住**

`since` / `limit` 走既有 `TranscriptInvalidError`（400 `TRANSCRIPT_INVALID`），訊息指名欄位：

| 輸入 | 回應 |
| --- | --- |
| `?limit=0` / `?limit=501` / `?limit=1.5` / `?limit=abc` / `?limit=` | `400 limit 必須是 1~500 的整數` |
| `?since=-1` / `?since=abc` / `?since=1.5` / `?since=` | `400 since 必須是 ≥ 0 的整數` |
| `?since=+5` / `?since=%20`（`+`／空白） | `400 since 必須是 ≥ 0 的整數` |
| `?limit=99999999999999999999`（超大字串） | `400 limit 必須是 1~500 的整數`（`Number.isSafeInteger` 擋下，不是夾住） |
| `?limit=1&limit=2`（重複） | `400 limit 不得重複` |
| `?cursor=3`（未知參數） | 忽略（本票沒承諾的參數不該讓請求失敗） |

- 為什麼不夾住：`limit=0` 若默默變成 500，呼叫端以為「我只要 0 列」卻收到 500 列，
  而且**永遠不會知道自己在說謊**。錯了就講，是這條路由所有既有守門的同一個立場
  （合法 JSON 的 `null` body → 400，US-103）。
- 守門順序：session 先（沒有進行中的會議 → 409），再驗參數（400）——
  與三條寫入路徑同序，避免「不存在的會議」被回成「你的參數錯了」。

## D5 計數改成「寫入當下重新讀 session」

現況（US-103）：`#transcriptWriteResult()` 用**請求開頭的快照**當基底：
`snapshot.transcriptWrites + accepted`，然後寫回去。兩個缺陷：

1. **部分寫入**：串流請求中途 400（後面那句落在未來）→ 前面已落地的列留著，
   但那次請求再也走不到計數更新 → 帳本 N 列、計數 N-k。
2. **併發覆蓋**：`await request.json()` 期間另一個請求先寫，後寫的人拿舊基底覆蓋 → 少算。

修法（兩件都解，且都變小）：

```
#addTranscriptWrites(delta) {
  const fresh = this.#readSession(this.#sessionStore());   // 寫入前一刻重讀
  if (fresh === null) throw new Error("session 不存在…");   // 到不了這裡；不編一個假數字
  const next = fresh.transcriptWrites + delta;
  if (delta !== 0) this.#sessionStore().write({ ...fresh, transcriptWrites: next });
  return next;
}

#writeWithCatchUp(ledger, run) {            // 兩條帳本寫入路徑共用
  const before = ledger.count();
  try { run(); }
  catch (error) { this.#addTranscriptWrites(ledger.count() - before); throw error; }
}
```

- `#readSession` 與 `write` 之間**沒有 `await`**：DO 是單執行緒，同步區塊內不會被打斷，
  所以「重讀 + 加 + 寫」在 DO 內是原子的（這是併發那一半的解法，不是靠鎖）。
- 回應的 `transcriptWrites` 也改用回傳值（不再是「舊基底 + delta」）——
  否則第二個回應會回一個**它自己知道已經過時**的數字。
- 部分寫入那一半：**兩條帳本寫入路徑都包在 `#writeWithCatchUp`**（進入前量一次 `count()` →
  `catch` 時用帳本列數**差額**補記 → 原樣 rethrow）。成功路徑仍用 `accepted`（省兩次 `COUNT(*)`）。
  為什麼用差額而不是「數已落地的列」：唯一可靠的來源就是帳本本身，
  重播（duplicate）不會增加列，所以差額自動等於「這次真的新增的句數」。
- **批次路徑為什麼也需要包**：前置的 `validateSegment` 只擋得下**邏輯性**壞資料
  （壞一個就整批不寫，這就是 US-103 的既有契約）。它擋不下**儲存層**錯誤：
  `record()` 是「INSERT → 讀回」，INSERT 或讀回都可能失敗；SQLite 本身也可能在寫入時報錯。
  那種時候前面幾列已經在地上了，計數若停在舊值，就是本票要消掉的「帳本 N 列、計數 N-k」。
  （這是第二輪獨立審查用**真 workerd 探針**推翻「批次不可能中途拋」之後補上的：
  把第 2 個 INSERT 弄成會拋 → 帳本 1 列、計數 0。現在有一條單元測試與一條突變釘著它。）

**可推翻**：真正跨 DO 物件的原子性（本票不需要：計數是同一場會議的區域狀態）。
若日後 `transcriptWrites` 要當帳務依據，應改為**推導值**（`SELECT COUNT(*)` 即時算），
而不是維護值——那時 D5 整個可以刪掉。目前保留維護值是為了不動 US-101/102 的既有契約。

**殘餘風險（設計已知並接受）**：補記本身若失敗（`count()` 拋、或 `#addTranscriptWrites` 拋），
原始錯誤會被蓋掉／計數會落後。兩者都是**大聲**壞掉（500）而非靜默，且機率極低；
要完全消除只能把計數改成推導值（上一段的「可推翻」）。

## D6 不變式（本票要釘住的三條）

1. **每一列新落地的段落，恰好讓 `transcriptWrites` +1**：成功、部分失敗、併發都成立。
   （US-101 的舊 `/transcript` 路徑只計數、不落地，所以精確式是
   `transcriptWrites = 舊路徑次數 + 帳本列數`；測試在「沒有舊路徑寫入」的 session 上驗等式。
   第二輪審查補：**三條寫入路徑**（舊 `/transcript`、批次、串流）都走 `#addTranscriptWrites`，
   所以「舊路徑 × 批次」的並發也滿足這條等式，不只是「沒舊路徑寫入」的 session。）
2. **讀取不改狀態**：任何 GET（含壞參數 400）都不動列數與 `seq`。
3. **分頁不漏不重**：用 `nextSince` 串接走完整場，收集到的 `seq` 集合恰好等於帳本。

## §5 測試清單

| 測試 | 對應 |
| --- | --- |
| `?since=2&limit=1` → `seq=3`、`hasMore=false`、`nextSince=3`、`total=3` | AC-1 |
| `?limit=2` → 前兩列、`hasMore=true`；用 `nextSince` 續抓 → 第三列、`hasMore=false`（不漏不重） | AC-1 |
| `since` 超過最後一列 → 空頁且 `nextSince=null` | AC-1 |
| 不帶參數與 `?limit=500` 同形；`count === segments.length`（back-compat） | AC-1 |
| 注入小上限 50、寫 51 列 → 不帶參數只回 50 列（`count=50`/`hasMore=true`/`nextSince=50`），續抓剛好第 51 列；`?limit=51` → 400（上限同時是合法邊界） | AC-1 |
| 十一種壞參數 → 400 且訊息含欄位名（含 `?since=+5`、`?since=%20`、超大字串）；列數不變 | AC-2 / AC-5 |
| 沒有進行中的會議 + 壞參數 → **409 先於 400**（守門順序） | AC-2 |
| 未知參數 → 200（忽略） | AC-2 |
| 串流「第 1 句合法 + 第 2 句未來」→ 400、帳本 1 列、`transcriptWrites=1` | AC-3 |
| 批次第 2 列才在**儲存層**失敗（注入：第 2 个 INSERT 抛）→ 帳本 1 列、`transcriptWrites=1` | AC-3 |
| 請求內 `await` 期間注入另一筆落地 → 兩請求後 `transcriptWrites=2`、帳本 2 列 | AC-4 |
| 舊路徑 `/transcript` 的 `await` 期間被帳本寫入 2 列插隊 → 回 `transcriptWrites=3`（不得寫回 1） | AC-4 |
| 冒煙 §9（真 workerd）：分頁、壞參數、部分寫入、同時兩請求 | AC-1 ~ AC-4 |

## §6 已知限制（明講，不假裝已驗）

- **併發的「真交錯」沒有保證**：單元層用注入 `json()` 的方式**保證**在 `await` 期間插入
  另一筆寫入（這是可重現的）；真 workerd 的冒煙用 `Promise.all` 打兩個請求，
  但**不保證**雲端排程一定會交錯——它只是壓力測試，不是證明。
- **沒有做跨 DO／跨 session 的一致性**：計數是單場會議的狀態。
- **沒有做「游標過期」處理**：`seq` 是單調無洞的，所以不需要快照／TTL；
  若日後加入刪除（本票與 AC 都禁止），這個前提會失效。
- **500 這個數字是判斷，不是量測**：以真跡段長（≈ 200 bytes/句）推 2000 列 ≈ 0.4 MB；
  以每句天花板 2000 字推最壞 ≈ 3 MB。沒有實測兩小時真會議的列數（沒有真 STT 與真會議）。
- **補記本身的失敗路徑沒有測試**：只驗「儲存層失敗時補記追上」，沒有把 `count()` 或補記弄壞
  （那需要更深的注入；發生時是 500 而不是靜默，設計已知）。
- **審查後補的兩個修法沒有獨立重驗**：第二輪的兩個修正（批次差額補記、舊路徑走 `#addTranscriptWrites`）
  由母行程自己寫測試與突變釘住，**沒有**再送一次獨立審查（時間上限：07:00）。
