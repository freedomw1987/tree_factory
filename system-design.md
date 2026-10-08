# system-design.md — tree_factory（AI 會議記錄 Agent）

> SOP 階段：§2.2 計劃（dav-designer Step 3）
> 對應 Backlog：`docs/backlog.md`（v2.0，4 Module）
> 對應 UX：`DESIGN.md`（v2.0）
> 最後更新：2026-10-07（v2.0）
>
> ⚠️ 本檔**禁止出現真實程式碼**（不得有 import / class / function 範例）。純文字示意（如 JSON 結構）允許。

---

## 1. 技術棧

| 層 | 選擇 | 理由 | 約束 |
| --- | --- | --- | --- |
| 前端外殼 | **Tauri 2**（iOS target）| 需求指定；webview 可放 `VoiceClient` | 需 rustup + iOS target（TECH-001）|
| 前端 UI | Web（HTML/CSS/JS）於 Tauri webview | 與 `@cloudflare/voice` 的 `VoiceClient` 同語言，免跨語言膠水 | 無前端框架（v1 不引入 build tool？見 §1.1）|
| 雲端 runtime | **Cloudflare Workers + Agents SDK** | 需求指定 Pi Durable | Beta API |
| 語音轉譯 | **`agents/voice`** 的 `withVoiceInput` 服務 + **自寫 `DiarizingNova3Transcriber`**（走 nova-3 WS，`diarize=true`）| 純 STT、無 TTS、無 onTurn；SDK 的 transcriber 公開可覆寫 | `@cloudflare/voice` 已棄用→改依 `agents`（TECH-003）；模型層 diarize **已證實**，SDK 層沒傳參數（SPIKE-001）|
| Agent 耐久層 | **`@earendil-works/pi-durable` 的 `Harness.open(storage, options, context)`**（原名 `PiHarness` 是誤稱）| 需求指定；transcript/inbox/工具/重試/crash recovery 存在 DO SQLite | Beta，官方明示 API 會變（SPIKE-003 已證實可在 DO 內運作）|
| 儲存 | Durable Object SQLite（`Harness` 的 9 張 `STRICT` `pi_*` 表 + 本專案表）| 與 DO 同交易邊界，evict 後仍存活 | 單物件寫入吞吐上限；`SqliteStorage` 需 100 行 `DoSqliteDatabase` façade（SPIKE-003）|
| 模型（LLM）| **pi-ai 內建的 `cloudflare-workers-ai` provider**（`Provider<"openai-completions">`）＋分階段模型：即時 8b / 會後筆記 70b | 全 Workers AI、音訊與文字不離開 Cloudflare；分階段讓成本降一個數量級（SPIKE-004）| pi-ai 走 REST（非 `AI` binding）→ 憑證注入方式待 SPIKE-004b；`llama-3.3-70b-fp8-fast` **只有 24k 上下文** |
| 會後 TTS | **`agents/voice`** 的 `withVoice`（M02-US-205）| 會後無回音疑慮，可用完整語音 loop | 只在會後掛載，不與會議模式同時 |
| 認證 | device token（WS handshake 帶）| 單人自用，無帳號系統（決策 R5）| token 儲存於 iOS Keychain |
| 本機儲存 | Tauri fs（音訊分段檔 + 待送佇列）| 斷網/被殺時不回饋到雲端（M01-US-102）| 需清理策略（backlog Q4）|
| **錄音來源** | **目標＝原生層**（Tauri plugin：Swift `AVAudioEngine`）；v1 探針為 webview `MediaRecorder` | **webview 在背景/鎖屏會停止收音**（SPIKE-002：35 秒錄音只解出 5.1 秒）→ 只有原生 audio session 能續錄 | 原生 plugin 尚未實作（SPIKE-002b / M01 新票）；過渡期以 `visibilitychange` 標記 `TRANSCRIPT_GAP` |
| **問答檢索（M03）** | **待 SPIKE-005 決定**：DO SQLite 全文比對／向量索引／直接餵 LLM | 檢索方式決定成本與可回溯性，且必須**唯一**（不能兩個呼叫端各做一套）| 兩種方式的品質與成本差距未量測（SPIKE-005）|
| **概念提取（M04）** | Workers AI LLM（會議結束後批次，非即時）| 概念層是加值層，**失敗不得影響記錄**（F17）| 粒度與噪音率為 SPIKE-006 |
| **對話語音輸入（M03）** | **重用 `agents/voice` 的 `withVoiceInput` 服務、不重用會議收音管線** | 對話是單人短句：無 `diarize`、無分段上傳、無本地緩存回補 | 辨識錯字由使用者確認（先填後送，M03-US-308 AC-1）|
| **對話持久化（M03）** | DO SQLite（`conversation` / `message` / `message_source`）| 對話串要跨 app 重啟存活（M03-US-304 AC-1），不能只存裝置端 | 長對話的儲存成長需 D12 之後觀察 |

### 1.1 待 SPIKE 決定、本檔暫不定案

| 事項 | 由誰決定 | 為什麼不在這裡決定 |
| --- | --- | --- |
| 前端是否引入框架（React / Solid / 純 vanilla）| §2.3 執行 | 取決於原型複雜度與 `VoiceClient` 整合方式，需先看 SPIKE-002 |
| ~~`diarize` 走串流或批次~~ | **已由 SPIKE-001 結案** | 串流可用，但須自寫 `DiarizingNova3Transcriber`（自按 word-level speaker 聚段） |
| `Harness` 是否可與 `withVoiceInput` 同在一個 DO 類 | **部分由 SPIKE-003 結案**（Harness 可在 DO 內運作）；同一類共存仍待整合驗證 | 兩者都是 DO 導向；Harness 的排程器與 DO 凍結的共存方式需實作驗證 |
| 2 小時上限的計時用 DO alarm 或請求時比對 | **SPIKE-003 建議用 alarm**（排程器不能跨越 DO 凍結）；精度仍待實測 | 兩者到期行為可能不同 |
| 跨會議檢索用全文／向量／餵 LLM | **SPIKE-005** | 直接決定 M03 的架構與成本上限；猜錯會讓「來源可回溯」做不到（P7）|
| 檢索的會議數上限 N | **SPIKE-005** | 影響 M03-US-303 AC-4 的文案與 UX；未量測前不敢寫死 |
| 概念提取的粒度（一句一概念 vs 一場 5-15 個）| **SPIKE-006** | 抽太細 → 概念卡爆炸變噪音；抽太粗 → 沒有 wiki 價值 |
| 對話歷史是否分組 / 命名 | 階段 B 實作後（DESIGN §7 D12）| v1 先線性列表 + 時間，避免過早做分群 |
| 對話框是否支援語音輸入 | DESIGN §7 D11（Step 4.5 前解）| 會改變輸入元件、權限流程與 `RecIndicator` 的重用方式 |

---

## 2. 系統組成（部件圖，純文字）

```text
┌───────────────────────── iOS 裝置（Tauri 2 app）────────────────────────┐
│                                                                        │
│  ┌── Rust core ──┐        ┌──────────── webview ────────────┐          │
│  │ 音訊擷取       │───────▶│ 會議中畫面 / 逐字稿 / 記錄畫面    │          │
│  │ 分段緩存(本地)  │        │ VoiceClient（WS 客戶端）          │          │
│  │ 待送佇列 + ack │◀──────▶│                                   │          │
│  └────────────────┘        └───────────────────────────────────┘          │
│         │                              │                                 │
└─────────┼──────────────────────────────┼─────────────────────────────────┘
          │ 分段音訊（可離線堆積）           │ WS：音訊上行 / 事件下行
          └──────────────┬───────────────┘
                         ▼
┌──────────────── Cloudflare Worker ────────────────┐
│  device token 驗證（WS handshake）                  │
│                                                    │
│  ┌── M01「聽」──────────────────────────────┐      │
│  │  withVoiceInput（純 STT，nova-3 + diarize）│      │
│  │  → 產生逐字稿事件（seq / speaker / 時間戳）│      │
│  └──────────────────┬───────────────────────┘      │
│                     │ 逐字稿事件流（唯一介面）        │
│  ┌──────────────────▼───────────────────────┐      │
│  ┌──────────────────▼───────────────────────────────────────┐      │
│  │  M02「記」（Durable Object）                              │      │
│  │  ├─ PiHarness：session / inbox / tools / retry / recovery │      │
│  │  ├─ tools（給 LLM）：append_transcript / upsert_action /   │      │
│  │  │                   finalize_notes                       │      │
│  │  ├─ 編輯 API（給 M04）：edit_segment / edit_note /         │      │
│  │  │                     edit_action（**唯一寫入點**）       │      │
│  │  └─ DO SQLite：pi_* + meeting / transcript_segment /       │      │
│  │                speaker / action_item / note               │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                   │
│  ┌── M03「問」─────────────────────────────────────────────┐      │
│  │  ask(question, scope, idempotency_key) → 回答 + 來源[]   │      │
│  │  唯一檢索點；兩個呼叫端共用（§5.4）                       │      │
│  │    呼叫端① 首頁對話框（scope = "all"）— M03-US-301        │      │
│  │    呼叫端② M02「問這場」（scope = meeting_id）            │      │
│  │              — INT-M02-M03-01                            │      │
│  │  conversation / message / message_source                 │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                   │
│  ┌── M04「編」─────────────────────────────────────────────┐      │
│  │  事實層：逐字稿編輯 → 經 M02 的 edit_segment 寫 edited_at │      │
│  │  推論層：摘要 / 待辦編輯 → edit_note / edit_action        │      │
│  │  知識層：概念提取 / 概念卡 / 標籤                        │      │
│  │  concept / concept_alias / concept_source / tag / tag_ref │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                   │
│  withVoice（會後 TTS，僅由呼叫端② 掛載）                          │
└───────────────────────┬───────────────────────────────────────────┘
                        │ AI binding
                        ▼
              Workers AI（STT / LLM / TTS）
```

**關鍵（v1.0 的同一句話仍成立）**：M01 與 M02 雖然同處一個 Worker / 同一個 DO，但邊界以「事件流」而非
「共用記憶體」定義。M02 可被獨立測試：餵入假事件即可，不需真的收音（見 §5）。

**v2.0 新增的兩個邊界判準**：

1. **寫入權集中**：`transcript_segment` / `note` / `action_item` 三張表的**寫入介面由 M02 獨佔**
   （`edit_segment` / `edit_note` / `edit_action`），M04 只提供 UI 並呼叫它。
   理由：`edited_at` 若由 M04 自己寫，就會有「某條路徑忘了寫旗標」的可能，而 D8 的價值全在那根旗標上。
2. **檢索權集中**：M03 的 `ask()` 是唯一檢索點。M02 的「問這場」只是把 `scope` 換成 `meeting_id` 的呼叫端
   （INT-M02-M03-01）。理由：兩套檢索 = 兩個「不編造」的破口。

---

## 3. Module 邊界（即未來的測試邊界）

| Module | 擁有的狀態 | 對外介面 | 探針不檢查什麼 |
| --- | --- | --- | --- |
| **M01 聽** | 裝置端：音訊分段檔、待送佇列、ack 狀態；雲端：`withVoiceInput` 的 STT 會話 | ① WS 上行：音訊分段 + `idempotency_key` ② WS 下行：逐字稿事件 + ack | 不檢查 DO 內部表、不檢查 LLM 產出的摘要 |
| **M02 記** | DO SQLite 的 `pi_*` 與本專案 5 張表；agent session 狀態 | ① 工具呼叫（3 個）② 讀取 API（逐字稿 / 摘要 / 待辦 / 匯出）③ **編輯 API**（`edit_segment` / `edit_note` / `edit_action`）| 不檢查麥克風、不檢查 WS 傳輸細節、不檢查概念品質 |
| **M03 問** | `conversation` / `message` / `message_source` 三張表；對話串的 UI 狀態 | ① `ask({ question, scope, idempotency_key })` → 回答 + 來源[] ② 讀取對話歷史 | 不檢查 UI、不檢查 WS、**不檢查 M01 / M02 的表結構**（只透過 M02 的讀取 API）|
| **M04 編** | `concept` / `concept_alias` / `concept_source` / `tag` / `tag_ref` 五張表；編輯與概念層 UI | ① 呼叫 M02 的編輯 API（**不直接寫 M02 的表**）② 概念提取與管理 ③ 標籤管理 | 不檢查錄音 / STT / WS、**不檢查逐字稿寫入規則**（那是 M02 擁有的）|

**邊界規則**：
- M01 不直接讀寫 DO 的表（只送事件）
- M02 不碰麥克風與本地檔案（只收事件）
- M01 與 M02 的唯一同步點是 `idempotency_key`
- **M04 對事實層 / 推論層的寫入一律經過 M02 的編輯 API**（單一寫入點，保證 `edited_at` 不會漏寫）
- **M03 不得維護第二套逐字稿檢索**；呼叫端不得繞過 `ask()` 直接查表

---

## 4. 資料流

### 4.1 會議中（正常）

```text
mic → Rust 擷取 → 每 30s 封裝分段（seq + idempotency_key）
    → 本地落檔 → WS 上行 → Worker 驗 token
    → withVoiceInput 轉譯（speaker 編號 + 時間戳）
    → 逐字稿事件（seq / idempotency_key / speaker_id / start_ms / end_ms / text）
    → ├─ WS 下行 → webview 顯示（interim → final）
      └─ PiHarness session → append_transcript → DO SQLite（append-only）
    → DO 回 ack（含 idempotency_key）→ WS 下行 → 本地刪除已 ack 分段
```

### 4.2 會議中（斷網）

```text
網路斷 → 分段照封裝落檔（待送佇列成長）→ UI 顯示黃色橫幅（誠實告知，但錄音繼續）
網路恢復 → 依 seq 順序重送 → DO 以 idempotency_key 去重 → ack → 本地清理
```

### 4.3 會議後

```text
[結束會議] → finalize_notes（M02-US-202）
    → LLM 產生 note（決策 / 爭點 / 結論）+ 彙整 action_item
    → 寫入 note / action_item 表
    → UI：記錄產生中 → 會議詳情
```

### 4.4 會後追問（M02-US-205，v2.0 改為呼叫 M03 引擎）

```text
webview 開 withVoice 會話 → 使用者語音提問 → STT
    → 呼叫 M03 的 ask({ question, scope: meeting_id, idempotency_key })
    → 引擎檢索（限該場）→ 產生回答 + 來源[]
    → TTS 回覆；barge-in 時中止播放並丟棄未完成回覆
    → 來源回溯一律落在該場逐字稿（INT-M02-M03-01）
```

**與 v1.0 的差別**：v1.0 是「M02 自己拿該場逐字稿餵 LLM」；
v2.0 起 **M02 不含任何檢索邏輯**——「查無不編造」（F10 / F13）只由 M03 一處處理，避免兩個破口。

### 4.5 問答（首頁對話框，M03-US-301 ~ 307）

```text
使用者輸入問題（新對話 scope = "all"；或承襲既有對話的範圍）
    → 建立或沿用 conversation（範圍可切換，切換不開新對話 — M03-US-307 AC-3）
    → 寫入 user message（含 idempotency_key，防重複計帳）
    → ask() 檢索：
         ├─ 全部命中 ──→ 生成（串流）→ 逐條寫入 message_source[]
         ├─ 無命中 ────→ 查無（+ 可能相關的會議清單）
         ├─ 超範圍 ────→ 明說這不在會議記錄的範圍內
         └─ 部分失敗 ──→ partial（+ 明說漏了哪幾場）
    → 寫入 assistant message（status = answered / not_found / out_of_scope / partial / interrupted）
    → 來源卡渲染時，逐項從 DB 讀 edited_at（**不採 session 記憶**）→ 標「此句有人工修正」
    → 串流中斷 → status = interrupted，保留已產出部分 → 重試沿用同一則 user message
```

### 4.6 編輯（M04-US-401 ~ 403）

```text
[事實層] 點逐字稿某句 → edit_segment({ meeting_id, seq, text })
             → M02 檢查：非空白、≤ 2000 字元
             → 更新 transcript_segment.text 並寫 edited_at = now
             → 回傳新值 → UI 就地更新（不重載整場）
[推論層] 點摘要 / 待辦 → edit_note / edit_action
             → 更新欄位；待辦的人工期限另寫 due_source = "user"
             → **不寫任何「已編輯」旗標**（推論層本來就不是事實 — P8）
[重新產生] 先檢查「這場是否有人工編輯過」
             → 有 → 回覆「會覆蓋你改過的內容」要求確認；不得靜默覆蓋
             → 重新產生的輸入一律採**編輯後**的文字
```

### 4.7 概念提取（M04-US-404 / 405，會後非同步）

```text
一場會議的三層記錄完成
    → 非同步觸發概念提取（LLM，一次一場）
    → 輸入：該場逐字稿 + 既有 concept 清單 + concept_alias（避免重複抽同一個錯）
    → 抽出 5~15 個概念（粒度待 SPIKE-006）
    → **丟棄「0 個來源」的概念**（概念的定義就是「有出處」，無出處不算概念）
    → upsert concept（name / type）+ 寫入 concept_source（meeting_id + source_seq）
    → 失敗 → CONCEPT_FAILED（Banner，只在概念頁）；記錄與摘要完全不受影響
    → 合併 / 改名 / 刪除 → 在同一交易內轉移引用，**斷言 0 孤兒**；失敗則整批回滾
```

**關鍵**：概念提取是**可重跑的加值層**，不得進入「產生記錄」的關鍵路徑。
理由：若提取失敗會讓「記錄產生中」卡住，那就是為了一個附加價值擋住主要價值（F17）。

---

## 5. 介面契約

### 5.1 逐字稿事件（M01 → M02，唯一資料契約）

```text
{
  "seq":             整數，單調遞增，會議內唯一
  "idempotency_key": 字串，由音訊分段序號 + 會議 id 導出
  "speaker_id":      整數（nova-3 diarize 原始編號，0 起）
  "start_ms":        整數，相對會議開始
  "end_ms":          整數，相對會議開始
  "text":            字串，該段逐字稿
  "is_final":        布林，false = interim（不寫入儲存層）
}
```

**契約規則**：
1. `is_final = false` 的事件**只走 WS 下行到 UI，不寫入 DO**（避免儲存層被 interim 污染）
2. 相同 `idempotency_key` 重送 → M02 回既有結果，不新增第二筆
3. `seq` 只用於排序與偵測缺口，**不用於去重**（去重一律用 `idempotency_key`）
4. `speaker_id` 是 0 起算的原生編號；顯示層的「發言者 N」= `speaker_id + 1`（避免出現「發言者 0」）

### 5.2 WS 下行訊息

```text
{ type: "transcript", payload: <逐字稿事件> }
{ type: "ack",        payload: { idempotency_key, seq } }
{ type: "status",     payload: { connection: "ok" | "reconnecting", backlog: 整數 } }
{ type: "error",      payload: { code, message, recoverable: 布林 } }
{ type: "limit",      payload: { reached: 布林, ends_at: ISO8601, warn: 布林 } }
```

**`limit` 訊息（決策 D5）**：`warn` 為真 = 距 2 小時上限 ≤ 5 分鐘（前端顯示黃橫幅）；`reached` 為真 = 已達上限，
伺服端已停止接受新音訊，前端必須熄燈並明說「接下來不會被記錄」。**權威在伺服端**（`meeting.ends_at` + DO alarm），
裝置端僅負責顯示與停止收音——裝置被殺／鎖屏都不影響上限生效。

#### 錯誤碼表（`code` 的窮舉；新增碼必須同步更新此表與 `DESIGN.md` §5.1）

| code | 意義 | `recoverable` | 由誰產生 |
| --- | --- | --- | --- |
| `AUTH_INVALID` | device token 失效或不相符 | ❌ | Worker（handshake）|
| `STT_FAILED` | 該段轉譯失敗 | ✅ | M01 / Workers AI |
| `BACKLOG_FULL` | 待補分段超過上限 | ✅ | 裝置端 / M01 |
| `STORAGE_WRITE_FAILED` | DO SQLite 寫入失敗 | ✅ | M02 |
| `TRANSCRIPT_GAP` | 偵測到 `seq` 缺口 | ✅ | M02（比對 seq）|
| `NOTES_FAILED` | 摘要 / 待辦抽取失敗 | ✅ | M02 / LLM |
| `EXPORT_FAILED` | 匯出寫檔失敗 | ✅ | M02 |
| `MODEL_UNAVAILABLE` | 模型服務暫時不可用 | ✅ | Worker → Workers AI |
| `SOURCE_UNRESOLVED` | 回答引用的來源句解析失敗（該條結論降級為查無）| ✅ | M03（§5.4 規則 3）|
| `CONCEPT_FAILED` | 概念提取失敗或產出 0 個概念 | ✅ | M04（§4.7）|

**協定規則**：`recoverable = true` 的錯誤**不得**導致錄音中止；只有 `AUTH_INVALID` 可阻斷流程。
**共 10 碼**（8 碼會議期 + 2 碼問答 / 概念期），與 `DESIGN.md` §5.1 逐碼對齊（v2.0 已核對）。

**「查無資料」不是錯誤碼**：`ask()` 的 `status`（`answered` / `not_found` / `out_of_scope` / `partial`）
是**正常回答狀態**，不進本表（見 `DESIGN.md` §5.1 與 §5.4 規則 6）。

### 5.3 記錄讀取（M02 → UI）

```text
GET 記錄摘要 → { decisions[], disputes[], conclusions[], generated_at, status }
GET 逐字稿   → { segments[] }（含 speaker 顯示名 + edited_at）
GET 待辦     → { items[] }（who / what / due / due_source / source_seq）
匯出         → Markdown 字串
GET 對話     → { conversations[] }（線性，依時間）
GET 對話訊息 → { messages[] }（含 status 與 sources[]）
GET 概念     → { concepts[] }（name / type / status / source_count / 別名）
GET 概念詳情 → { concept, sources[] }（每項含 meeting_id / seq / speaker / 時間）
GET 標籤     → { tags[] }（來源分 user 與 suggested 兩種）
```

**`due` 契約**：未提及期限時為 `null`，**不得由模型填入推測日期**（M02-US-203 AC-2 的負向斷言基礎）。
`due_source` 取值 `model` 或 `user`，用途是區分「模型抽取的期限」與「人工填的期限」（M04-US-403 AC-2）。
**`due_source` 不是「編輯旗標」**——它是語意欄位（誰填的），與 P8 的「推論層不留旗標」不衝突。

### 5.4 `ask()` 契約（INT-M02-M03-01，M03 的對外唯一介面）

```text
ask({ question: 字串, scope: meeting_id | "all", idempotency_key: 字串 })
  → {
      status:  "answered" | "not_found" | "out_of_scope" | "partial",
      answer:  字串（可串流逐字送出），
      sources: [ { meeting_id, source_seq, edited_at(可 null) } ],
      searched_meetings: 整數,
      missed_meetings:   [ { meeting_id, reason } ]
    }
```

**契約規則**：

1. **`scope` 必填，不得由引擎推測**（M03-US-307 AC-1）。`"all"` 與 `meeting_id` 的差別只在範圍，不在行為
2. **引擎是唯一檢索點**：兩個呼叫端都不得自己查逐字稿表（見 §3 邊界規則）
3. **`sources` 每一項都必須能解析到真實存在的 `transcript_segment`**。
   解析失敗時（M03-US-302 AC-4）：
   - 該條結論**不輸出**，改以「查無資料」呈現 + 發 `SOURCE_UNRESOLVED`
   - 還有其他有效結論 → `status = partial`；**全數失效 → `status = not_found`**
   - **不得虛構來源、也不得把無來源的結論照樣當成答案輸出**
4. **`edited_at` 由引擎在回答時從 DB 讀取**，不讀 agent session 的記憶。
   因此「此句有人工修正」的標示責任在**引擎**，兩個呼叫端只負責顯示（INT-M02-M03-01 AC-3）
5. **來源的錨點是 `seq` 而非文字**：使用者改錯字不會讓來源斷鏈。
   這是 D7 敢允許改寫逐字稿的**技術前提**——若來源用文字比對，一次編輯就會讓所有引用失效
6. `status` 是**四種正常狀態**，不是錯誤碼（見 `DESIGN.md` §5.1）
7. 相同 `idempotency_key` 重送 → 回既有回答，不重複計帳、不新增第二則 message

### 5.5 編輯 API 契約（M02 擁有寫入權，M04 呼叫）

```text
edit_segment({ meeting_id, seq, text })      → { text, edited_at }
edit_note({ meeting_id, field, value })      → { field, value }
edit_action({ action_id, field, value })     → { due_source: "user" | "model" }
```

**契約規則**：

1. **`edited_at` 只由 M02 寫入**：M04 不得直接 UPDATE 逐字稿表（見 §3 邊界規則）
2. **只有事實層寫旗標**：`edit_segment` 寫 `edited_at`；`edit_note` / `edit_action` 不寫任何旗標
3. 驗證在 M02 端：`text` 非空白且 ≤ 2000 字元，否則拒絕（M04-US-401 AC-3）
4. **不可改動欄位**：`speaker_id`、`start_ms`、`end_ms`、`seq` 一律不可透過此 API 修改
   （改名走 M01-US-105，時間戳不可改）
5. 改回原樣也**不**清除 `edited_at`（無法證明已還原 —— 決策 D7 不留舊版，M04-US-402 AC-3）

---

## 6. 儲存模型（DO SQLite）

| 表 | 擁有者 Module | 主要欄位 | 寫入方式 |
| --- | --- | --- | --- |
| `pi_*`（PiHarness 管理）| M02 | 由套件定義 | 套件內部，本專案不直接寫 |
| `meeting` | M01 建立 / M02 收尾 | `id` / `title` / `started_at` / `ends_at`（= `started_at` + 2 小時上限）/ `ended_at` / `status` | 建立時寫入 `ends_at`；結束或達上限時更新 |
| `transcript_segment` | M02（M01 產生）；`text` 由 M04 經 M02 的編輯 API 改 | `idempotency_key`（PK）/ `seq` / `meeting_id` / `speaker_id` / `start_ms` / `end_ms` / `text` / `edited_at`（可 null）| **捕捉期 append-only**；編輯期經 `edit_segment` 更新 `text` 並寫 `edited_at` |
| `speaker` | M01 命名 | `meeting_id` + `speaker_id`（複合鍵）/ `display_name` / `first_seen_seq` | 命名時 upsert |
| `action_item` | M02 | `id` / `meeting_id` / `who` / `what` / `due`（可 null）/ `due_source`（model / user）/ `source_seq` | `upsert_action`；編輯期經 `edit_action` |
| `note` | M02 | `meeting_id`（PK）/ `decisions` / `disputes` / `conclusions` / `generated_at` | `finalize_notes`；編輯期經 `edit_note` |
| `conversation` | M03 | `id`（PK）/ `scope`（`"all"` 或 `meeting_id`，**可變更**）/ `created_at` / `title`（可 null）| 建立對話時 INSERT；切換範圍時 UPDATE `scope`（不開新對話）|
| `message` | M03 | `id`（PK）/ `conversation_id` / `role`（user / assistant）/ `text` / `status`（answered / not_found / out_of_scope / partial / interrupted）/ `idempotency_key` / `created_at` | append-only（**連對話紀錄也不改寫**，與 D7 無關：D7 管的是「會議記錄」）|
| `message_source` | M03 | `message_id` + `meeting_id` + `source_seq`（複合鍵）| 回答完成時寫入；介面上的「來源」= 本表一列 |
| `concept` | M04 | `id`（PK）/ `name` / `type`（人 / 專案 / 主題 / 名詞）/ `status`（active / merged / deleted）/ `merged_into_id`（可 null）/ `created_at` / `updated_at` | 提取時 upsert；改名 / 合併 / 刪除時更新 |
| `concept_alias` | M04 | `concept_id` + `alias`（複合鍵）| 改名與合併時寫入；**提取時作為提示，避免重複抽到同一個錯**（M04-US-404 AC-3）|
| `concept_source` | M04 | `concept_id` + `meeting_id` + `source_seq`（複合鍵）| 提取時寫入；合併時**同一交易內整批轉移**（M04-US-405 AC-4）|
| `tag` | M04 | `id`（PK）/ `name` / `kind`（meeting / concept）/ `source`（user / suggested）| 使用者建立；`suggested` 需使用者確認才生效（M04-US-406 AC-3）|
| `tag_ref` | M04 | `tag_id` + `target_type` + `target_id` | 貼 / 撕標籤；**刪標籤不刪會議**（M04-US-406）|

**`transcript_segment` 的寫入規則（v2.0 修正：由「永遠 append-only」改為分兩期）**：

| 時期 | 規則 | 誰 | 依據 |
| --- | --- | --- | --- |
| **捕捉期**（會議進行中）| append-only：只 INSERT，不得改寫或重排既有句子 | M01 → M02 | M01-US-103 AC-3 |
| **編輯期**（會議結束後）| 可 UPDATE `text`，同時寫入 `edited_at`；**不保留舊文字** | M04-US-401 / 402 | 決策 D7 / D8 |

捕捉期為何必須 append-only：若允許 UPDATE，錯誤的 interim 覆寫 final 會造成逐字稿損毀且無法回溯
（去重與順序完整性全靠「只新增」這個不變量）。

編輯期為何允許改寫：決策 D7（用戶拍板）——收音品質造成的 STT 錯字是真實痛點，
而保留舊版對「修錯字」無幫助；D8 以 `edited_at` 保留「此句被人工改過」的唯一訊號。

> ⚠️ 兩者作用時間不重疊（會議進行中不會有編輯 UI），因此可並存。
> 但**任何新的寫入路徑都必須先問「這是捕捉期還是編輯期」**，這是本表存在的理由。

**實作對齊（2026-10-09，M01-US-103 回寫）**：捕捉期的落地表在 DO 內叫 **`transcript_segments`**（複數），
與上表的 `transcript_segment` 是**兩個階段**——US-103 只做「M01 產生、存進 DO 的本地帳本」，
M02 擁有、`text` 可被 M04 編輯的那張正規表仍在未來。因此：

- **沒有 `meeting_id`**：一個 DO 就是一場會議（與 `gap` 表同款，US-101 起的慣例）。
- **沒有 `edited_at`**：那是編輯期（M04-US-401/402）的欄位。
- **多了 `overlap_ms`**：`M01-US-103 AC-4` 的重疊留痕（值來源是帳本的同一把鍵前一列，見設計 D6）。
- **主鍵是 `seq`**（`MAX(seq)+1` 配發，失敗與衝突**不燒號**）；去重靠 `idempotency_key` 的 **UNIQUE 索引**，
  而不是把鍵當主鍵——因為 `seq` 是對 M02 的**穩定排序依據**。
- 讀取介面只有 `list / count / find / previousEndMs`，**型別上沒有 update / delete**（append-only 的強制方式）。

依據：`docs/design/M01-US-103-transcript-ledger.md`（D2 / D3 / D6 / D7）與 `docs/deliverable/2026-10-09-M01-US-103-多人群組即時轉譯.md`。

**三個「不留舊版」的例外要說清楚**（避免被誤讀為「全部都不能留歷史」）：

| 表 | 是否留舊版 | 為什麼 |
| --- | --- | --- |
| `transcript_segment` / `note` / `action_item` | ❌ 不留（決策 D7）| 使用者要的是「改掉就好」，舊版對修錯字無幫助 |
| `message` / `message_source` | ✅ 本來就不改寫（append-only）| 對話紀錄是**我們自己的產出紀錄**，不是使用者要編輯的內容；改寫它會讓「AI 當初說了什麼」消失 |
| `concept` | ⚠️ 刪除 = soft delete（`status = deleted`）| **必須保留墓碑**，否則下次提取會把使用者刪掉的概念又抽回來（M04-US-404 AC-3）|

**概念層的兩個硬性約束**：

1. **合併必須在同一交易內轉移全部 `concept_source` 並斷言 0 孤兒**（M04-US-405 AC-4）；
   失敗則整批回滾。理由：孤兒引用會讓「來源可回溯」（P7）斷鏈，而且是**靜默斷鏈**——使用者不會知道
2. **刪除只改 `status`，不實體刪除**：`concept_alias` 與 `merged_into_id` 一起作為提取時的「負面提示」，
   讓使用者的修正**被後續提取沿用**（M04-US-404 AC-3 的原話：「不得每次重新抽到同一個錯」）

---

## 7. 失敗模式與對應設計

| # | 失敗 | 偵測方式 | 設計對應 | 對應 US |
| --- | --- | --- | --- | --- |
| F1 | 網路中斷 | WS status / 上行無 ack | 本地分段 + 待送佇列 + 依序回補 | M01-US-102 |
| F2 | app 被強制終止 | 啟動時發現未完成 session | 詢問續傳；DO 端逐字稿仍在 | M01-US-102 AC-3 / M02-US-201 AC-1 |
| F3 | Durable Object 被 evict | 新事件抵達時 storage 重開 | `PiHarness` 靠 alarm 醒回，續用既有 session | M02-US-201 AC-2 |
| F4 | 分段重送 | 同 `idempotency_key` 再次到達 | 去重，不重複寫入、不重複計帳 | M02-US-201 AC-3 |
| F5 | 轉譯失敗 | `withVoiceInput` 回錯 | UI 顯示錯誤但**保留音檔**（不得刪），可重送 | M01-US-103 / 104 |
| F6 | 上下文溢出 | 寫入長度逼近上限 | compaction；會議開頭內容仍可查 | M02-US-201 AC-4 |
| F11 | 會議達 2 小時上限 | DO alarm 到 `ends_at` | 伺服端停止接受新音訊並下 `limit.reached`；前端熄燈 + 明說不再記錄；2:00 前資料完整保留，可一鍵產生記錄 | M01-US-101 AC-6 |
| F12 | 到點時裝置離線 | 恢復後以伺服端 `ends_at` 比對 | 伺服端拒收 2:00 之後的分段（回 `ack` 但不入庫）；本地對應音檔刪除，避免「有音檔沒逐字稿」的懸空狀態 | M01-US-101 AC-6 / M01-US-102 |
| F7 | 鎖屏 / 切背景 | webview 生命週期事件 | 停止收音 + **誠實顯示中斷**（不得假裝錄音中）| M01-US-101 AC-4 |
| F8 | `PiHarness` Beta 破壞性改版 | 建置或執行期錯誤 | 版本鎖定（DoD）；備案 = 一般 `Agent` + 自建 SQLite | SPIKE-003 |
| F9 | 模型幻覺期限 | 摘要產出後檢查 | `due` 為 null 契約 + 負向探針 | M02-US-203 AC-2 |
| F10 | 追問超範圍 | 檢索無命中 | 明確回「查無此資訊」；不編造 | M02-US-205 AC-2 |
| F13 | 問答查無資料 | 檢索 0 命中 | 明說「記錄中沒提到」+ 可能相關會議清單；**不是錯誤，不用紅色** | M03-US-305 |
| F14 | 問答生成中斷 | 串流中斷 / 模型回錯 | `status = interrupted`，保留已產出部分 + 重試；重試沿用同一則 user message，**不新增第二個泡泡** | M03-US-306 |
| F15 | 來源解析失敗 | `source_seq` 對不到句子 | 該條降級、狀態改 `partial` + `SOURCE_UNRESOLVED`；**不得虛構來源** | M03-US-302 AC-4 |
| F16 | 部分場次檢索失敗（跨會議）| 逐場結果有失敗項 | `partial` + 明說「有 N 場沒查到：<場名>」；不得靜默當成全部 | M03-US-303 AC-3 |
| F17 | 概念提取失敗或品質差 | 提取任務回錯 / 抽出 0 個 | `CONCEPT_FAILED`（Banner，只在概念頁）；**記錄與摘要完全不受影響** | M04-US-404 |
| F18 | 合併造成孤兒引用 | 合併後查 `concept_source` 是否仍指向已合併概念 | 同一交易內轉移全部引用 + 斷言 0 孤兒；失敗整批回滾 | M04-US-405 AC-4 |
| F19 | 跨會議檢索超過上下文 / 上限 | 符合條件的會議數 > N | 明說「只搜尋了最近 N 場，可能還有更早的」+「擴大範圍」；**不得靜默截斷後宣稱這是全部** | M03-US-303 AC-4 |
| F20 | agent 記憶與編輯後文字不一致 | 回答引用到已被編輯的句子 | **來源一律在回答時從 DB 讀**（§5.4 規則 4），所以 `edited_at` 一定是最新的；但**模型的推理可能基於舊文字** → v1 已知限制，接受（逐句改寫通常不改變語意），並在 §5.4 規則 4 明寫 | M04-US-402 |
| F21 | 裝置端標籤 / 範圍顯示與實際不符 | 對話的 `scope` 變更後未更新指示 | 範圍指示由 `conversation.scope` 單一來源渲染；切換時同步更新，不另存副本 | M03-US-307 |
| **F22** | **webview 進背景 / 鎖屏期間錄音中止** | app 非前景（`visibilitychange → hidden`）| 實測：iOS 會停止供音且凍結 JS 計時器，**背景期間的音訊永久缺失**（無回補來源）→ ①立即標記 `TRANSCRIPT_GAP`，在逐字稿顯示「此段未錄到」②以 `WakeLock` 降低發生率 ③**架構解＝把錄音移到原生層**（SPIKE-002 / M01 新票）| M01-US-1xx（新）|
| **F23** | **上下文窗口溢出（長會議）** | 2 小時逐字稿約 20k tokens，`llama-3.3-70b-fp8-fast` 只有 24k 窗口 | 明訂壓縮政策（`reserveTokens` / `keepRecentTokens`）；**逐字稿的 source of truth 是 `transcript_segment` 表**，代理一律用工具檢索，不靠常駐上下文（SPIKE-004）| M02-US-2xx（新）|

---

## 8. 部署拓撲

| 環境 | 用途 | 內容 |
| --- | --- | --- |
| 本機（macOS）| 開發期驗 pipeline | Tauri 桌面模式 + `wrangler dev`（含 DO 模擬）|
| iOS 真機 | 驗收音與 UX（唯一能驗 M01 的地方）| `tauri ios` 建置 + 簽章 |
| Cloudflare（staging）| 驗耐久性與成本 | staging Worker + DO；`PI_DURABLE` 版本鎖定 |
| Cloudflare（prod）| 自用 | 同上，另加 device token |

**模擬器不能驗什麼**：無麥克風 → 不能驗 M01-US-101/103、也不能驗 INT。

---

## 9. 變動歷史

| 日期 | 版本 | 變更 | 作者 |
| --- | --- | --- | --- |
| 2026-10-07 | v1.0 | 初版：技術棧 / 部件圖 / Module 邊界 / 資料流 / 介面契約 / 儲存模型 / 失敗模式 / 部署 | Agent（dav-designer Step 3）|
| 2026-10-07 | v1.1 | §6 `transcript_segment` 寫入規則由「永遠 append-only」改為**分捕捉期 / 編輯期兩期**（新增 `edited_at` 欄位）；理由：決策 D7 / D8 與 `M01-US-103 AC-3` 的措辭矛盾（AC v1.1 已限定範圍）| §2.1 補規劃（M04 編輯能力）|
| 2026-10-09 | v2.3 | §6 補「實作對齊」：M01-US-103 的捕捉期落地表是 DO 本地 `transcript_segments`（複數、無 `meeting_id`、無 `edited_at`、多 `overlap_ms`、主鍵 `seq` + `idempotency_key` UNIQUE），與表中正規 `transcript_segment` 的兩階段關係明文化 | Agent（trust mode 執行階段）|
| 2026-10-08 | v2.2 | 依 SPIKE-001~004 回寫：§1 `PiHarness`→`Harness.open`、`@cloudflare/voice`→`agents/voice`、模型改 pi-ai `cloudflare-workers-ai`（分階段 8b/70b）；新增「錄音來源」列（webview 背景不收音→原生 plugin）；§1.1 三項結案/部分結案 | Agent（trust mode 執行階段）|
| 2026-10-07 | v2.1 | Step 4.5 簽核後落地：§1 技術棧新增「對話語音輸入」列（重用 `withVoiceInput`、不重用會議收音管線）；§5.2 錯誤碼表補 `SOURCE_UNRESOLVED` / `CONCEPT_FAILED`（共 10 碼）並明訂「查無資料不是錯誤碼」；§5.4 規則 3 依 `M03-US-302 AC-4` 改寫（來源失效的結論**不輸出**，改以查無呈現）；§4.7 明訂丟棄 0 來源的概念 | Agent（dav-designer Step 4.5 / D11）|
| 2026-10-07 | v2.0 | 第二輪（M03 問 / M04 編）：§1 新增檢索 / 概念提取 / 對話持久化三列；§1.1 新增 SPIKE-005 / 006 與 D11 / D12；§2 部件圖補 M03 / M04 並新增「寫入權集中 / 檢索權集中」兩個邊界判準；§3 新增 M03 / M04 邊界與 2 條規則；§4.4 改為呼叫 M03 引擎、新增 §4.5 問答 / §4.6 編輯 / §4.7 概念提取；§5.3 補對話 / 概念 / 標籤讀取與 `due_source`；**新增 §5.4 `ask()` 契約（7 條規則）與 §5.5 編輯 API 契約（5 條規則）**；§6 新增 7 張表（conversation / message / message_source / concept / concept_alias / concept_source / tag / tag_ref）與「三個不留舊版的例外」；§7 新增 F13~F21 | Agent（dav-designer Step 3，第二輪）|
