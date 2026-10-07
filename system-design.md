# system-design.md — tree_factory（AI 會議記錄 Agent）

> SOP 階段：§2.2 計劃（dav-designer Step 3）
> 對應 Backlog：`docs/backlog.md`（v1.1）
> 對應 UX：`DESIGN.md`
> 最後更新：2026-10-07
>
> ⚠️ 本檔**禁止出現真實程式碼**（不得有 import / class / function 範例）。純文字示意（如 JSON 結構）允許。

---

## 1. 技術棧

| 層 | 選擇 | 理由 | 約束 |
| --- | --- | --- | --- |
| 前端外殼 | **Tauri 2**（iOS target）| 需求指定；webview 可放 `VoiceClient` | 需 rustup + iOS target（TECH-001）|
| 前端 UI | Web（HTML/CSS/JS）於 Tauri webview | 與 `@cloudflare/voice` 的 `VoiceClient` 同語言，免跨語言膠水 | 無前端框架（v1 不引入 build tool？見 §1.1）|
| 雲端 runtime | **Cloudflare Workers + Agents SDK** | 需求指定 Pi Durable | Beta API |
| 語音轉譯 | `@cloudflare/voice` 的 **`withVoiceInput`** + Workers AI `@cf/deepgram/nova-3`（`diarize`）| 純 STT、無 TTS、無 onTurn → 會議模式不需回音處理 | `diarize` 串流支援性未證實（SPIKE-001）|
| Agent 耐久層 | **`@earendil-works/pi-durable` 的 `PiHarness`** | 需求指定；transcript/inbox/工具/重試/crash recovery 存在 DO SQLite | Beta，官方明示 API 會變（SPIKE-003）|
| 儲存 | Durable Object SQLite（`PiHarness` 的 `pi_*` 表 + 本專案表）| 與 DO 同交易邊界，evict 後仍存活 | 單物件寫入吞吐上限 |
| 模型（LLM）| Workers AI（`AI` binding）| 零外部 key、音訊與文字不離開 Cloudflare | 模型選擇需 SPIKE-004 依成本定 |
| 會後 TTS | `@cloudflare/voice` 的 **`withVoice`**（M02-US-205）| 會後無回音疑慮，可用完整語音 loop | 只在會後掛載，不與會議模式同時 |
| 認證 | device token（WS handshake 帶）| 單人自用，無帳號系統（決策 R5）| token 儲存於 iOS Keychain |
| 本機儲存 | Tauri fs（音訊分段檔 + 待送佇列）| 斷網/被殺時不回饋到雲端（M01-US-102）| 需清理策略（backlog Q4）|

### 1.1 待 SPIKE 決定、本檔暫不定案

| 事項 | 由誰決定 | 為什麼不在這裡決定 |
| --- | --- | --- |
| 前端是否引入框架（React / Solid / 純 vanilla）| §2.3 執行 | 取決於原型複雜度與 `VoiceClient` 整合方式，需先看 SPIKE-002 |
| `diarize` 走串流或批次 | SPIKE-001 | 官方文件未載明，猜測會導致 M01 架構做錯 |
| `PiHarness` 是否可與 `withVoiceInput` 同在一個 DO 類 | SPIKE-003 | 兩者都是 mixin/DO 導向，組合方式未證實 |
| 2 小時上限的計時用 DO alarm 或請求時比對 | SPIKE-003 | alarm 精度與 evict 後的重建行為需實測；兩者到期行為可能不同 |

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
│  │  ── M02「記」（Durable Object）───────┐    │      │
│  │  PiHarness：session / inbox / tools   │    │      │
│  │  agent tools：append_transcript        │    │      │
│  │               upsert_action            │    │      │
│  │               finalize_notes           │    │      │
│  │  DO SQLite：pi_* 表 + meeting /        │    │      │
│  │             transcript_segment /       │    │      │
│  │             speaker / action_item /    │    │      │
│  │             note                       │    │      │
│  └────────────────────────────────────────┘    │      │
│  ┌── withVoice（會後追問用，M02-US-205）──┐      │      │
│  └────────────────────────────────────────┘      │      │
└───────────────────────┬────────────────────────────┘
                        │ AI binding
                        ▼
              Workers AI（STT / LLM / TTS）
```

**關鍵：M01 與 M02 雖然同處一個 Worker / 同一個 DO，但邊界以「事件流」而非「共用記憶體」定義。**
M02 可被獨立測試：餵入假事件即可，不需真的收音（見 §5）。

---

## 3. Module 邊界（即未來的測試邊界）

| Module | 擁有的狀態 | 對外介面 | 探針不檢查什麼 |
| --- | --- | --- | --- |
| **M01 聽** | 裝置端：音訊分段檔、待送佇列、ack 狀態；雲端：`withVoiceInput` 的 STT 會話 | ① WS 上行：音訊分段 + `idempotency_key` ② WS 下行：逐字稿事件 + ack | 不檢查 DO 內部表、不檢查 LLM 產出的摘要 |
| **M02 記** | DO SQLite 的 `pi_*` 與本專案 5 張表；agent session 狀態 | ① 工具呼叫（3 個）② 讀取 API（逐字稿 / 摘要 / 待辦 / 匯出）| 不檢查麥克風、不檢查 WS 傳輸細節 |

**邊界規則**：
- M01 不直接讀寫 DO 的表（只送事件）
- M02 不碰麥克風與本地檔案（只收事件）
- 兩者的唯一同步點是 `idempotency_key`

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

### 4.4 會後追問（M02-US-205）

```text
webview 開 withVoice 會話 → 使用者語音提問 → STT
    → LLM（上下文 = 該場逐字稿 + 既有 note，嚴格限定 session 邊界）
    → TTS 回覆；barge-in 時中止播放並丟棄未完成回覆
```

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

**協定規則**：`recoverable = true` 的錯誤**不得**導致錄音中止；只有 `AUTH_INVALID` 可阻斷流程。

### 5.3 記錄讀取（M02 → UI）

```text
GET 記錄摘要 → { decisions[], disputes[], conclusions[], generated_at, status }
GET 逐字稿   → { segments[] }（含 speaker 顯示名）
GET 待辦     → { items[] }（who / what / due / source_seq）
匯出         → Markdown 字串
```

**`due` 契約**：未提及期限時為 `null`，**不得由模型填入推測日期**（M02-US-203 AC-2 的負向斷言基礎）。

---

## 6. 儲存模型（DO SQLite）

| 表 | 擁有者 Module | 主要欄位 | 寫入方式 |
| --- | --- | --- | --- |
| `pi_*`（PiHarness 管理）| M02 | 由套件定義 | 套件內部，本專案不直接寫 |
| `meeting` | M01 建立 / M02 收尾 | `id` / `title` / `started_at` / `ends_at`（= `started_at` + 2 小時上限）/ `ended_at` / `status` | 建立時寫入 `ends_at`；結束或達上限時更新 |
| `transcript_segment` | M02 寫入（M01 產生）| `idempotency_key`（PK）/ `seq` / `meeting_id` / `speaker_id` / `start_ms` / `end_ms` / `text` | **append-only** |
| `speaker` | M01 命名 | `meeting_id` + `speaker_id`（複合鍵）/ `display_name` / `first_seen_seq` | 命名時 upsert |
| `action_item` | M02 | `id` / `meeting_id` / `who` / `what` / `due`（可 null）/ `source_seq` | `upsert_action` |
| `note` | M02 | `meeting_id`（PK）/ `decisions` / `disputes` / `conclusions` / `generated_at` | `finalize_notes` |

**為什麼 `transcript_segment` 是 append-only**：M01-US-103 AC-3 明訂不得改寫既有句子。
若允許 UPDATE，錯誤的 interim 覆寫 final 會造成逐字稿損毀且無法回溯。

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
