# Backlog — tree_factory（AI 會議記錄 Agent）

> 來源：2026-10-07 用戶對話「做一個 AI agent 手機 app，即時錄音模式，用語音對話並為他做記錄；用 pi durable + tauri」
> SOP 階段：§2.1 規劃（dav-planner v2.6）→ 已通過 Plan Gate；§2.2 計劃進行中（dav-designer）
> 狀態：Module 已重切為 2 個（見 §1 變更說明）

---

## 0. 需求收斂（訪談定案）

| 面向 | 定案 | 決策輪次 |
| --- | --- | --- |
| 產品定位 | AI 會議記錄 agent（v1 核心 = 會議室多人對話 → 三層記錄）| R1 + R3 |
| 平台 | iOS（Tauri 2 mobile）；開發期先用 macOS webview 驗 pipeline | R2 |
| 收音場景 | 會議室、多人、手機置於桌面 | R3 |
| AI 出聲 | **會議中靜音，只出文字**；TTS 留到會後追問 | R4 |
| 記錄產出 | 三層：逐字稿（speaker + 時間戳）→ 摘要（決策/爭點/結論）→ 待辦（誰/做什麼/何時）| R5 |
| 模型 | 全 Workers AI（`AI` binding，零外部 key）| R5 |
| 斷網/被殺 | 本地緩存音檔 + 恢復後回補（不重譯、不遺失）| R5 |
| 使用者 | 單人自用，無帳號系統（device token）| R5 |
| 耐久層 | Pi Durable（`PiHarness` in Cloudflare Durable Object）| 初始需求 |
| 外殼 | Tauri 2 → iOS | 初始需求 |

### 0.1 關鍵技術事實（已查證，非假設）

| 事實 | 來源 | 影響 |
| --- | --- | --- |
| `PiHarness` 把 Pi 的 transcript / inbox / 工具 / 重試 / crash recovery 存在 Durable Object SQLite（表名 `pi_` 前綴）| Cloudflare Agents docs — Harnesses / Pi | M02 的地基；Beta，API 會變 |
| 物件被 evict 時靠 Lifecycle alarm 醒回、重開 storage、續跑 | 同上 | 「閃退可續」不是文案而是機制 |
| `@cloudflare/voice` 有 `withVoiceInput`（**純 STT，無 TTS、無 onTurn**）| Cloudflare Agents docs — Voice | 會議模式的正確地基（省掉回音迴路）|
| Workers AI `@cf/deepgram/nova-3` 有 `diarize` 參數（每字給 speaker 編號，從 0 起）| Workers AI models — nova-3 | M01 的多人辨識可行 |
| `withVoiceInput` 是否吃 `diarize`、串流模式有無 diarization → **官方文件未載明** | — | **最大未知數**，SPIKE-001 必驗 |
| 本機缺 `rustup`（Homebrew rustc）、缺 iOS target、缺 iOS simulator runtime、無 Android SDK、無 wrangler | 本機實測 2026-10-07 | TECH-001 為擋門票 |
| SOP v2.0 禁產 HTML，但 `dav-planner/backlog-rules.md` §4.6 仍要求產 HTML | 交叉比對 AGENTS.md v2.0 與 skill | TECH-002（V03）|

### 0.2 SWOT（戰略決策：v1 定位 = 會議記錄，而非一對一語音對話）

> 觸發條件：戰略影響 + 高成本（本決策定調整個 v1 的資料模型與 agent 設計，且推翻初始「AI 會回話」的直覺）

| 象限 | 內容 |
| --- | --- |
| **S 優勢** | 語音轉譯與 diarization 在 Cloudflare 有現成模型，不必自建 STT |
| **W 劣勢** | 會議記錄是紅海；Pi Durable 為 Beta，API 會變動 |
| **O 機會** | 逐字稿＋待辦的耐久性（斷網/閃退不遺失）是現有 app 少有的差異點 |
| **T 威脅** | 1 小時會議的 token 成本與 compaction 品質若不穩，整個價值主張會崩 |

**最終選項**（已寫入 M02-US-201 AC 欄）：會議中 AI 靜音、逐字稿與筆記全部經由 Pi Durable 持久化，
斷線/閃退可續且不重複計帳。

---

## 1. Module 定義

v1.1 重切：原 4 個模組（M01 app-shell / M02 voice-pipeline / M03 agent-core / M04 notes）改為 2 個。
原因見下方「為什麼重切」。

| Module | 名稱 | 一句話職責 | 涵蓋 US | DoD 深度 |
| --- | --- | --- | --- | --- |
| **M01** | 聽 | 把聲音變成**有名字的逐字稿** | M01-US-101 ~ 105（5 US）| DoD-Full |
| **M02** | 記 | 把逐字稿變成**耐久可查的記錄** | M02-US-201 ~ 205（5 US）| DoD-Full |

**M01 / M02 的介面（唯一通道）**：append-only 逐字稿事件流

```text
{ seq, idempotency_key, speaker_id, start_ms, end_ms, text }
```

- `seq`：會議內單調遞增序號（M01 產生）
- `idempotency_key`：由音檔分段序號導出（M01 產生，M02 用它去重）
- M02 可用**假事件**獨立測試，不需真的收音 → 符合「可獨立測試」

**Module 欄對 Spike 的語意**：Spike 的 Module 欄代表「**本 Spike 的結論會改變哪個 Module 的設計**」，
不是「本 Spike 屬於該 Module 的交付物」。TECH 項（基礎建設 / skill 修補）不綁 Module，故填 `—`。

### 為什麼重切（v1.0 → v1.1）

| 面向 | v1.0（4 Module）| v1.1（2 Module）|
| --- | --- | --- |
| 切割依據 | **技術層**（外殼 / STT / agent / 記錄）| **功能內聚**（聽 / 記）|
| US 分布 | 2 / 2 / 2 / 3 | 5 / 5 |
| 合規性 | ❌ M01-M03 皆 2 US，違反「3-15 US / Module」| ✅ 皆 5 US |
| 探針邊界 | 綁在實作層，換 STT 供應商要動 Module 邊界 | 綁在功能層，換 STT 只動 M01 內部 |
| PRD 份量 | 3 份薄 PRD（2 US 沒什麼好寫）| 2 份有內容的 PRD |

**根因**：v1.0 是照「技術分層」切，會被 dav-designer 的「功能內聚」原則反例命中的正是這一類。
重切時機選在**零程式碼階段**，成本僅文件；若等寫了 code 才重切，需同步改檔名 / import / 探針 / CI。

---

## 2. Backlog

| US ID | 類型 | Module | 標題 | AC | 優先級 | Story Point | 狀態 | 依賴 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TECH-001 | TECH | — | 環境前置：rustup + iOS target + simulator runtime + wrangler 登入 | — | P0 | 2 | PENDING | — |
| SPIKE-001 | Spike | M01 | 驗證 `withVoiceInput` 是否支援 nova-3 `diarize`、串流 diarization 是否成立 | — | P0 | 3 | PENDING | TECH-001 |
| SPIKE-002 | Spike | M01 | 驗證 Tauri 2 iOS webview `getUserMedia` 收音與鎖屏/背景行為 | — | P0 | 3 | PENDING | TECH-001 |
| SPIKE-003 | Spike | M02 | 驗證 `PiHarness`（Beta）在 Durable Object 的可用性與與 `withVoiceInput` 的整合面 | — | P0 | 5 | PENDING | SPIKE-001 |
| SPIKE-004 | Spike | M02 | 長會議成本實測（1 小時 → token/價格/compaction 行為）| — | P1 | 2 | PENDING | SPIKE-003 |
| M01-US-101 | US | M01 | 一鍵開始 / 結束會議錄音（iOS 前景）| 4 條 BDD | P0 | 5 | PENDING | SPIKE-002 |
| M01-US-102 | US | M01 | 會議中斷網或 app 被殺，本地音檔分段緩存與恢復回補 | 4 條 BDD | P0 | 8 | PENDING | M01-US-101 |
| M01-US-103 | US | M01 | 多人語音即時轉譯（speaker 編號 + 時間戳）| 4 條 BDD | P0 | 8 | PENDING | SPIKE-001 |
| M01-US-104 | US | M01 | 會議中即時顯示逐字稿（interim + 完成）| 3 條 BDD | P1 | 3 | PENDING | M01-US-103 |
| M01-US-105 | US | M01 | speaker 命名：把 speaker 2 貼成「阿明」| 3 條 BDD | P1 | 3 | PENDING | M01-US-103 |
| INT-M01-M02-01 | US | INT | 端到端：開始會議 → 講話 → 螢幕即時逐字稿 → 中斷 → 恢復續接 | 3 條 BDD | P0 | 5 | PENDING | M01-US-101, M01-US-103, M02-US-201 |
| M02-US-201 | US | M02 | 逐字稿持久化到 Durable Object，重開 app 續接、不重複不遺失 | 4 條 BDD | P0 | 8 | PENDING | SPIKE-003 |
| M02-US-202 | US | M02 | 會議記錄 agent tools（append_transcript / upsert_action / finalize_notes）| 3 條 BDD | P0 | 5 | PENDING | M02-US-201 |
| M02-US-203 | US | M02 | 會後產出三層記錄（逐字稿 + 摘要 + 待辦）| 4 條 BDD | P0 | 8 | PENDING | M02-US-202, M01-US-105 |
| M02-US-204 | US | M02 | 匯出 / 分享會議記錄 | 3 條 BDD | P2 | 3 | PENDING | M02-US-203 |
| M02-US-205 | US | M02 | 會後語音追問（withVoice + TTS）| 3 條 BDD | P2 | 5 | PENDING | M02-US-203 |
| TECH-002 | TECH | — | 修 `dav-planner` 「US 必產 HTML」與 SOP v2.0 禁 HTML 的文實矛盾 | — | P2 | 2 | PENDING | — |

**合計**：78 SP｜P0 = 11 項 / 60 SP（由 `awk` 從上表實算，非手寫估算）

---

## 3. 詳細段

### TECH-001 環境前置

- **對應 Module**: —（基礎建設）
- **AC**: 無（基礎建設）
- **驗收方式**:
  - `rustup target list --installed` 含 `aarch64-apple-ios`
  - `xcrun simctl list devices available` 至少一台 iPhone
  - `wrangler whoami` 回傳已登入的帳號
- **為什麼這個優先**: 擋門票。本機現況缺 rustup / iOS target / iOS runtime / wrangler，Tauri mobile 完全無法開工
- **風險**: Homebrew rustc 與 rustup 並存可能衝突，需確認 toolchain 來源切換後 `cargo` 版本不變

### SPIKE-001 驗證 `withVoiceInput` × `diarize`

- **對應 Module**: M01
- **AC**: 無（研究）
- **驗收方式**: 產出 `docs/spike/SPIKE-001.md`，內含
  1. `withVoiceInput` 是否可傳 `diarize` 的實測結論
  2. 串流模式下 speaker 編號是否穩定（換人/重疊/長靜音後）
  3. 若不可行的替代路線（批次 diarize + 對齊時間戳）
- **為什麼這個優先**: 全案最大未知數。多人辨識是「會議記錄」的成立前提，若串流不可行則 M01 架構要改
- **時限**: 0.5 天內給結論，避免拖住整條主線

### SPIKE-002 驗證 Tauri 2 iOS webview 收音

- **對應 Module**: M01
- **AC**: 無（研究）
- **驗收方式**: 產出 `docs/spike/SPIKE-002.md`，內含
  1. iOS 真機 `getUserMedia` 成功 / 失敗
  2. 需要哪些 `Info.plist` / entitlement
  3. 鎖屏與切背景時 mic 是否中斷
  4. device token 認證可行性
- **為什麼這個優先**: 決定 M01 是「純 webview」還是「需寫 Swift 原生層」。此結論會改寫 M01 全部票的估算
- **已知預期**: 鎖屏應會中斷（v1 已接受，見 §0 需求收斂表）
- **風險**: 模擬器無 mic，必須真機；需 Apple 開發者帳號與簽章

### SPIKE-003 驗證 `PiHarness` 可用性

- **對應 Module**: M02
- **AC**: 無（研究）
- **驗收方式**: 產出 `docs/spike/SPIKE-003.md`，內含
  1. `PiHarness` Beta 是否可安裝運行
  2. 與 `withVoiceInput` 共存的寫法（逐字稿如何進 Pi 的 session）
  3. `PiHarness` 不穩時的退路（改用一般 `Agent` + 自建 SQLite）
- **為什麼這個優先**: Pi Durable 是本案的指定技術，但屬 Beta 且官方明示 API 會變；必須先確認整合面而不是寫完才發現接不上

### SPIKE-004 長會議成本實測

- **對應 Module**: M02
- **AC**: 無（研究）
- **驗收方式**: 產出 `docs/spike/SPIKE-004.md`，內含 1 小時會議的 STT 成本、Pi token 成本、compaction 觸發次數與摘要品質退化情形
- **為什麼這個優先**: 「1 小時會議」是本產品的核心單位，成本若失控則價值主張不成立

### M01-US-101 一鍵開始 / 結束會議錄音

- **對應 Module**: M01（聽）
- **負責 dev**: （派工後填入）
- **預估時間**: 5 SP
- **AC**:
  - **AC-1**: Given app 在前景且已取得 mic 權限 When 點「開始會議」 Then 3 秒內進入錄音中狀態並顯示計時
  - **AC-2**: Given 錄音中 When 點「結束會議」 Then 立即停止收音並保留本次 session（不刪資料）
  - **AC-3**: Given 未取得 mic 權限 When 點「開始會議」 Then 顯示權限說明並引導至系統設定，不得靜默失敗
  - **AC-4**: Given 錄音中 When app 被切到背景或鎖屏 Then 明確顯示「錄音已中斷」狀態（不得假裝仍在錄）
  - **AC-5** (DoD): 探針 `REGRESSION_MODULE=M01` 通過
- **依賴**: SPIKE-002
- **驗收方式**: `REGRESSION_MODULE=M01` 全套（pipeline 腳本由 TECH-001 建立）
- **為什麼這個優先**: P0。所有其他票的入口，沒有它其他都無法驗證

### M01-US-102 本地音檔分段緩存與恢復回補

- **對應 Module**: M01（聽）
- **負責 dev**: （派工後填入）
- **預估時間**: 8 SP
- **AC**:
  - **AC-1**: Given 會議進行中 When 每累積 30 秒音訊 Then 於本地寫入一個可續傳的分段檔，並記錄其序號
  - **AC-2**: Given 會議中網路中斷 When 恢復連線 Then 自動依序回補未送出分段，且不重複送出已成功分段
  - **AC-3**: Given app 於會議中被強制終止 When 重新開啟 app Then 判斷存在未完成 session 並詢問是否續傳，不得自動丟棄
  - **AC-4**: Given 回補完成 When 對照伺服端逐字稿 Then 逐字稿時間軸連續、無缺段且無重複句
  - **AC-5** (DoD): 探針 `REGRESSION_MODULE=M01` 通過
- **依賴**: M01-US-101
- **驗收方式**: `REGRESSION_MODULE=M01`
- **為什麼這個優先**: P0。這是 Pi Durable 在本產品的核心價值主張（斷網/閃退不遺失）；也是「本地緩存」決策的落地

### M01-US-103 多人語音即時轉譯

- **對應 Module**: M01（聽）
- **負責 dev**: （派工後填入）
- **預估時間**: 8 SP
- **AC**:
  - **AC-1**: Given 2 至 4 人在同一支手機前輪流說話 When 每人各說一句 Then 逐字稿為每句標上 speaker 編號，且同一人跨句編號一致
  - **AC-2**: Given 任一段發言 When 產生逐字稿 Then 附帶該段起訖時間戳（相對會議開始）
  - **AC-3**: Given 會議進行中 When 收到逐字稿事件 Then 伺服端以 append-only 方式寫入，不得改寫既有句子
  - **AC-4**: Given 兩人同時說話 When 轉譯 Then 不得靜默丟句（可標為重疊或合併，但必須留下紀錄）
  - **AC-5** (DoD): 探針 `REGRESSION_MODULE=M01` 通過
- **依賴**: SPIKE-001
- **驗收方式**: `REGRESSION_MODULE=M01`
- **為什麼這個優先**: P0。多人辨識是產品定義的核心；沒有它，「會議記錄」退化成「單人 dictation」

### M01-US-104 會議中即時顯示逐字稿

- **對應 Module**: M01（聽）
- **負責 dev**: （派工後填入）
- **預估時間**: 3 SP
- **AC**:
  - **AC-1**: Given 有人正在說話 When 尚未定稿 Then 螢幕顯示未定稿文字（interim），且視覺上與已定稿句子可區分
  - **AC-2**: Given 一段話結束 When 定稿 Then interim 文字轉為定稿樣式，不得重複顯示
  - **AC-3**: Given 逐字稿持續成長 When 已超過一屏 Then 自動跟隨最新一句，且使用者手動上滑時停止自動跟隨
- **依賴**: M01-US-103
- **驗收方式**: `REGRESSION_MODULE=M01`
- **為什麼這個優先**: P1。不影響資料正確性，但「看得見 AI 記下了什麼」是信任感的來源

### M01-US-105 speaker 命名

- **對應 Module**: M01（聽）
- **負責 dev**: （派工後填入）
- **預估時間**: 3 SP
- **AC**:
  - **AC-1**: Given 逐字稿中出現未命名的 speaker 編號 When 使用者點該編號 Then 可輸入名字並套用至該 speaker 的所有歷史與未來句子
  - **AC-2**: Given 已命名 speaker 2 為「阿明」 When 會議中 speaker 2 再次發言 Then 逐字稿直接顯示「阿明」
  - **AC-3**: Given 未命名 speaker When 匯出記錄 Then 顯示為「發言者 2」而非空白或編號 0 起算的原生值
- **依賴**: M01-US-103
- **驗收方式**: `REGRESSION_MODULE=M01`
- **為什麼這個優先**: P1。零工程的天花板很低但價值很高——沒有這條，會議記錄對使用者幾乎不可用

### INT-M01-M02-01 端到端整合

- **對應 Module**: INT（M01 × M02）
- **負責 dev**: （派工後填入）
- **預估時間**: 5 SP
- **AC**:
  - **AC-1**: Given 錄音中對手機講話 When 一段話結束 Then 螢幕 3 秒內出現該段逐字稿（含 speaker 編號）
  - **AC-2**: Given 錄音中拔掉網路 30 秒再接回 When 網路恢復 20 秒內 Then 中斷期間的逐字稿補齊且順序正確
  - **AC-3**: Given 全程錄音 10 分鐘 When 結束會議 Then 伺服端逐字稿與螢幕所見內容一致（同句數、同順序）
- **依賴**: M01-US-101, M01-US-103, M02-US-201
- **驗收方式**: 真機手動 + `REGRESSION_MODULE=INT`
- **為什麼這個優先**: P0。模組各自綠不等於整條路綠；這是唯一能證明「產品真的能用」的票

### M02-US-201 逐字稿持久化與續接

- **對應 Module**: M02（記）
- **負責 dev**: （派工後填入）
- **預估時間**: 8 SP
- **AC**:
  - **AC-1**: Given 會議進行到一半 When app 被殺後重開 Then 逐字稿完整還原至中斷前最後一句，不需重新轉譯
  - **AC-2**: Given Durable Object 被 evict When 有新的逐字稿事件到達 Then 物件自動醒回、重開 storage 並繼續寫入既有 session（不另開新 session）
  - **AC-3**: Given 同一段音訊因回補被送出兩次 When 伺服端處理 Then 逐字稿只保留一份（冪等），不得重複計帳
  - **AC-4**: Given 會議長度超過模型上下文 When 持續寫入 Then 觸發 compaction 後仍可查得會議開頭內容，且不影響待辦抽取
  - **AC-5** (DoD): 探針 `REGRESSION_MODULE=M02` 通過
- **依賴**: SPIKE-003
- **驗收方式**: `REGRESSION_MODULE=M02`
- **為什麼這個優先**: P0。**這是 Pi Durable 的選型理由本身**；若這條不成立，就沒有必要用 `PiHarness`（見 §0.2 SWOT 最終選項）

### M02-US-202 會議記錄 agent tools

- **對應 Module**: M02（記）
- **負責 dev**: （派工後填入）
- **預估時間**: 5 SP
- **AC**:
  - **AC-1**: Given 逐字稿寫入完成 When agent 執行 Then 可呼叫 `append_transcript` 且該工具標記為可安全重放（`replay: "safe"`）
  - **AC-2**: Given 對話中出現承諾事項 When agent 判定為待辦 Then 呼叫 `upsert_action` 寫入待辦（含負責人與期限欄位，允許空值），同一待辦不得重複新增
  - **AC-3**: Given 使用者按下結束會議 When 執行 `finalize_notes` Then 產生三層記錄，且已存在的待辦不被覆蓋
- **依賴**: M02-US-201
- **驗收方式**: `REGRESSION_MODULE=M02`
- **為什麼這個優先**: P0。agent 的實際能力邊界在此定義；工具的重放語意直接關乎 crash recovery 的正確性

### M02-US-203 會後產出三層記錄

- **對應 Module**: M02（記）
- **負責 dev**: （派工後填入）
- **預估時間**: 8 SP
- **AC**:
  - **AC-1**: Given 一場已結束的會議 When 開啟記錄 Then 可看到三層：完整逐字稿（含 speaker 與時間戳）、摘要（決策 / 爭點 / 結論）、待辦（誰 / 做什麼 / 何時）
  - **AC-2**: Given 逐字稿中提到明確截止日 When 產生待辦 Then 期限欄位有值；若未提及則為空值，不得幻覺填入日期
  - **AC-3**: Given 產出的待辦 When 使用者逐條點開 Then 可回溯該待辦對應的逐字稿原句
  - **AC-4**: Given 1 小時會議 When 產生摘要 Then 單場處理於 60 秒內完成
- **依賴**: M02-US-202, M01-US-105
- **驗收方式**: `REGRESSION_MODULE=M02`
- **為什麼這個優先**: P0。這是交付價值的最終端點——使用者真正要的東西
- **風險**: AC-2 的「不得幻覺日期」需以探針固定（負向斷言），否則會靜默假成功

### M02-US-204 匯出 / 分享

- **對應 Module**: M02（記）
- **負責 dev**: （派工後填入）
- **預估時間**: 3 SP
- **AC**:
  - **AC-1**: Given 一份會議記錄 When 選擇匯出 Markdown Then 產出含三層結構的檔案
  - **AC-2**: Given 匯出檔 When 在外部工具開啟 Then 標題層級與待辦清單可正確渲染
  - **AC-3**: Given 選擇分享 When 使用系統分享面板 Then 可傳給其他 app，且內容與匯出檔一致
- **依賴**: M02-US-203
- **驗收方式**: `REGRESSION_MODULE=M02`
- **為什麼這個優先**: P2。沒有它產品仍可用（記錄留在 app 內），有的話才能進工作流

### M02-US-205 會後語音追問

- **對應 Module**: M02（記）
- **負責 dev**: （派工後填入）
- **預估時間**: 5 SP
- **AC**:
  - **AC-1**: Given 一場已結束的會議 When 開啟追問模式並問「剛剛誰負責預算？」 Then 以語音（TTS）回答，且答案可回溯至逐字稿
  - **AC-2**: Given 追問中 When 提問內容超出該場會議範圍 Then 明確回答查無此資訊，不得編造
  - **AC-3**: Given 追問進行中 When 使用者打斷發言 Then 立即停止播放並改為收音（barge-in）
- **依賴**: M02-US-203
- **驗收方式**: `REGRESSION_MODULE=M02`
- **為什麼這個優先**: P2。會議中靜音的決策把 TTS 全部推到這裡；這是「對話式」體驗在 v1 唯一保留的位置

### TECH-002 修 dav-planner 文實矛盾

- **對應 Module**: —
- **驗收方式**: `bats tests/restruct-dav-planner.bats` 通過 + Reviewer verdict
- **為什麼這個優先**: P2 但不可省。文實矛盾會讓後續每個新 US 都多產一份沒人要的 HTML，且違反 SOP v2.0
- **前置**: 屬 V03（skill 修改）→ 必走 `dev-checker-loop` Reviewer 二審，並依 V03.5 跑主檔行數預檢
- **範圍**: `dav-planner/backlog-rules.md` §4.6 + SKILL.md 規則表「每個 US 都產 .md + .html」

---

## 4. 需求成熟度評估（§5）

| 維度 | 分數 | 說明 |
| --- | --- | --- |
| **涵蓋率** | 3 | 核心 4 維度（用戶場景 / 目標痛點 / 流程操作 / 成功標準）齊備，補充維度（Non-goals / Risks / Edge cases）已展開 |
| **清晰度** | 2 | ⚠️ 多數 AC 可量測；但「轉譯延遲」「diarization 準確率」尚無實測基準，需 SPIKE-001 回填 |
| **可行性** | 2 | 已查證官方文件、確認套件存在；但 diarization 串流與 `PiHarness` 整合面尚未實測（SPIKE-001/003 待跑）|

**結論**：3 維度皆 ≥ 2 → 可寫 Backlog（已寫）。

---

## 5. Non-goals（v1 明確不做）

| 不做 | 理由 |
| --- | --- |
| Android | 無 SDK，且 v1 已足夠驗證產品（決策 R2）|
| 鎖屏 / 背景持續錄音 | 需 Swift 原生層，工期 +1.5~2x（決策 R3）|
| 會議中 AI 出聲 | 回音迴路 + 干擾會議（決策 R4）|
| 帳號系統 / 多租戶 | 單人自用（決策 R5）|
| 會議中即時長出摘要 | prompt 與 token 成本難控，易干擾會議（決策 R5）|
| 視訊 / 螢幕分享記錄 | 與語音記錄是不同產品 |
| 自動發送待辦到外部工具（Notion / Slack）| 依賴外部授權，v1 只做匯出（M02-US-204）|

---

## 6. 開放問題（未定，不擋開工）

| # | 問題 | 影響 | 何時解 |
| --- | --- | --- | --- |
| Q1 | 會議長度上限（2 小時？4 小時？）| 成本與 compaction 策略 | SPIKE-004 後 |
| Q2 | speaker 命名時機（會議中即時 vs 會後）| M01-US-105 的 UI | §2.2 Design |
| Q3 | 逐字稿在會議中顯示到什麼程度（只看最近 N 句 vs 全文可捲）| M01-US-104 的 UI | §2.2 Design |
| Q4 | 音檔本地保留期限（隱私 vs 回補完整性）| M01-US-102 的清理策略 | §2.2 Design |
| Q5 | 是否需要「會議範本」（例：週會 / 客戶訪談）改變摘要風格 | M02-US-203 的 prompt | v2 |

---

## 7. 環境前置清單（TECH-001 明細）

| 項目 | 現況 | 動作 |
| --- | --- | --- |
| Xcode 27.0 | ✅ 已裝 | — |
| iOS Simulator runtime | ❌ 無可用 iPhone | Xcode 下載 iOS runtime |
| rustc 1.97.1 (Homebrew) | ⚠️ 無 rustup | 裝 rustup、確認 toolchain 來源不衝突 |
| `aarch64-apple-ios` target | ❌ 未安裝 | `rustup target add aarch64-apple-ios` |
| tauri-cli 2.11.4 | ✅ 已裝 | 之後加 `tauri ios init` |
| node 22 / pnpm 11 / bun 1.3 | ✅ 已裝 | — |
| wrangler | ❌ 未裝未登入 | `npm i -g wrangler` + `wrangler login` |
| Cloudflare 帳號 | ❓ 未知 | `wrangler whoami` 確認 |
| Apple 開發者帳號 | ❓ 未知 | 真機測試與簽章需要 |

---

## 變動歷史

| 版本 | 日期 | 變動 | 為什麼 |
| --- | --- | --- | --- |
| v1.1 | 2026-10-07 | Module 由 4 個重切為 2 個（聽 / 記）；全數 US 重新編號；介面定義為逐字稿事件流 | 原切法違反「3-15 US / Module」（M01-M03 各僅 2 US），且切割依據為技術層而非功能內聚 |
| v1.0 | 2026-10-07 | 初版：17 項 backlog（4 Spike / 11 US / 2 TECH）+ Module 草稿 + SWOT + 成熟度評估 | §2.1 Plan Gate 產出 |
