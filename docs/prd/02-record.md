# PRD — 02 M02「記」（記錄、查詢與耐久）

> SOP 階段：§2.2 計劃（dav-designer Step 4）
> 對應 Backlog：`docs/backlog.md`（M02-US-201 ~ 205）
> 對應 UX：`DESIGN.md`　對應架構：`system-design.md` §3、§6
> DoD 深度：**DoD-Full**（5 狀態全做）
> 最後更新：2026-10-07

---

## 1. 這個 Module 存在的理由

把**逐字稿**變成**耐久、可查、能回溯**的記錄。

它是整個產品的差異點所在：**斷網、閃退、物件被踢掉，逐字稿都還在**。這裡也是 Pi Durable 選型的唯一理由
（backlog §0.2 SWOT 最終選項）—— 若這一條不成立，就沒有必要用 `PiHarness`。

**一句話成功標準**：會議結束後，使用者拿到三層記錄（逐字稿 / 摘要 / 待辦），每個待辦都能點回原句；
而且過程中 app 被殺過一次，資料沒有掉。

---

## 2. 功能需求（FR）

| FR | 名稱 | 說明 | 對應 US |
| --- | --- | --- | --- |
| FR-201 | 逐字稿持久化 | 逐字稿寫入 Durable Object SQLite，append-only | M02-US-201 |
| FR-202 | 崩潰後續接 | app 被殺後重開可還原到中斷前最後一句，不需重新轉譯 | M02-US-201 |
| FR-203 | 物件 evict 後醒回 | DO 被踢掉後新事件抵達時自動醒回並續用同一 session | M02-US-201 |
| FR-204 | 冪等去重 | 同 `idempotency_key` 重送只保留一份，不重複計帳 | M02-US-201 |
| FR-205 | 上下文壓縮 | 超過上下文時 compaction，且會議開頭內容仍可查 | M02-US-201 |
| FR-206 | `append_transcript` 工具 | 標記可安全重放（`replay: "safe"`），重放不產生第二筆 | M02-US-202 |
| FR-207 | `upsert_action` 工具 | 抽出待辦（誰 / 做什麼 / 何時），允許空值，同待辦不重複新增 | M02-US-202 |
| FR-208 | `finalize_notes` 工具 | 產生三層記錄，不覆蓋既有待辦 | M02-US-202 |
| FR-209 | 三層記錄呈現 | 逐字稿（speaker + 時間戳）/ 摘要（決策 / 爭點 / 結論）/ 待辦 | M02-US-203 |
| FR-210 | 待辦期限誠實 | 逐字稿未提及期限時 `due` 為 null，不得幻覺填入日期 | M02-US-203 |
| FR-211 | 待辦回溯 | 每個待辦可展開對應的逐字稿原句 | M02-US-203 |
| FR-212 | 匯出 Markdown | 產出含三層結構的檔案，外部工具可正確渲染 | M02-US-204 |
| FR-213 | 系統分享 | 透過 iOS 系統分享面板送出，內容與匯出檔一致 | M02-US-204 |
| FR-214 | 單場語音追問（v2.0 改為呼叫 M03 引擎）| 以語音提問並以 TTS 回答；檢索一律呼叫 M03 的 `ask()`（`scope = meeting_id`），**M02 不含任何檢索邏輯** | M02-US-205 |
| FR-215 | 查無此資訊誠實回答 | 由引擎統一回「查無」（狀態 `not_found`）；M02 只負責播放與顯示，不自行補足 | M02-US-205 |
| FR-216 | barge-in | 使用者打斷 TTS 播放時立即停止並改為收音 | M02-US-205 |
| FR-217 | 會後發言者命名（批次，決策 D1）| 逐字稿 tab 頂部提示未命名數，開 sheet 一次改完；套用後逐字稿與待辦負責人同步更新（對應 M01-US-105）| M01-US-105 |

**FR 編號連續性**：FR-201 ~ FR-217 連續無跳號 ✓

---

## 3. 驗收條件（AC）

完整 Given-When-Then + DoD 見 `docs/ac/`（每 US 一份）。摘要如下：

| US | AC 條數 | 核心斷言 |
| --- | --- | --- |
| M02-US-201 | 4 | 被殺後還原至最後一句；evict 後續用同 session；重送去重不重複計帳；compaction 後開頭仍可查 |
| M02-US-202 | 3 | `append_transcript` 為 `replay: "safe"`；待辦去重且允許空值；`finalize_notes` 不覆蓋既有待辦 |
| M02-US-203 | 4 | 三層齊備；無期限 → null（不得幻覺）；待辦可回溯原句；2 小時上限會議 120 秒內完成（門檻待 SPIKE-004）|
| M02-US-204 | 3 | 三層結構匯出；外部渲染正確；分享內容一致 |
| M02-US-205 | 3 | TTS 回答可回溯；超範圍明說查無（**由 M03 引擎判定**）；barge-in 立即停止；必須傳 `scope = meeting_id` |

---

## 4. 依賴關係

```text
SPIKE-001（diarize 可行性）
   └─▶ SPIKE-003（PiHarness 可用性）★ M02 的選型驗證
          ├─▶ M02-US-201（持久化與續接）
          │      └─▶ M02-US-202（agent tools）
          │             └─▶ M02-US-203（三層記錄）◀── M01-US-105（speaker 命名）
          │                    ├─▶ M02-US-204（匯出）
          │                    └─▶ M02-US-205（會後追問）
          └─▶ SPIKE-004（長會議成本）
```

**向上依賴（本 Module 需要的、由 M01 提供）**：M01 的逐字稿事件流（`seq` / `idempotency_key` / `speaker_id` / 時間戳），
以及 M01-US-105 的人名。M02 不碰麥克風、不碰本地檔案。

**向下依賴（別的 Module 需要本 Module）**：M01-US-102 的 ack 語意由 M02-US-201 決定；INT-M01-M02-01 需要 M02-US-201。

⚠️ **依賴風險**：SPIKE-003 若證明 `PiHarness` 不可用（Beta 破壞或無法與 `withVoiceInput` 共存），
M02-US-201/202 需改為一般 `Agent` + 自建 SQLite。此變更會動到 FR-202/203/205 的實作方式，
但**不影響使用者可見的 AC**（這正是 AC 寫成行為而非實作的好處）。

---

## 5. 追溯矩陣（強制）

| FR | User Story | 對應畫面 | 原型檔案 | 狀態 |
| --- | --- | --- | --- | --- |
| FR-201 逐字稿持久化 | M02-US-201 | 會議詳情 — 逐字稿 → `02-record.html §tr` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-202 崩潰後續接 | M02-US-201 | 待續傳 session sheet（M01 畫面） → `01-listen.html §resume（資料正確性由 M02 保證）` | `docs/prd/01-listen.html` | ✅ 已原型 |
| FR-203 物件 evict 後醒回 | M02-US-201 | （無 UI，後端行為）（無對應原型） | — | ⬜ 不適用（無 UI） |
| FR-204 冪等去重 | M02-US-201 | （無 UI，後端行為）（無對應原型） | — | ⬜ 不適用（無 UI） |
| FR-205 上下文壓縮 | M02-US-201 | 會議詳情 — 摘要（長會議提示） → `02-record.html §gen（edge：長會議）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-206 `append_transcript` | M02-US-202 | （無 UI，agent 工具）（無對應原型） | — | ⬜ 不適用（無 UI） |
| FR-207 `upsert_action` | M02-US-202 | 會議詳情 — 待辦 → `02-record.html §act` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-208 `finalize_notes` | M02-US-202 | 記錄產生中 → `02-record.html §gen` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-209 三層記錄呈現 | M02-US-203 | 會議詳情（3 tabs） → `02-record.html §summary / §tr / §act（3 分頁）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-210 待辦期限誠實 | M02-US-203 | 會議詳情 — 待辦（無期限態） → `02-record.html §act（「未提及期限」態）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-211 待辦回溯 | M02-US-203 | 會議詳情 — 待辦（展開原句） → `02-record.html §act（點擊展開原句）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-212 匯出 Markdown | M02-US-204 | 匯出 / 分享 sheet → `02-record.html §export` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-213 系統分享 | M02-US-204 | 匯出 / 分享 sheet → `02-record.html §export（edge：無可分享 app）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-214 會後語音追問 | M02-US-205 | 會後追問 → `02-record.html §fup` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-215 查無此資訊 | M02-US-205 | 會後追問（not-found 態） → `02-record.html §fup（error 態）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-216 barge-in | M02-US-205 | 會後追問 → `02-record.html §fup（edge 態：打斷）` | `docs/prd/02-record.html` | ✅ 已原型 |
| FR-217 會後發言者命名（批次）| M01-US-105 | 逐字稿 tab 提示 + 命名 sheet → `02-record.html §spk` | `docs/prd/02-record.html` | ✅ 已原型 |

**幽靈檢查**：
- 每個 FR 都有對應 US ✓（16 FR / 5 US）
- 每個 US 都被 FR 覆蓋 ✓（201: FR-201~205；202: FR-206~208；203: FR-209~211；204: FR-212~213；205: FR-214~216）
- **4 個 FR 沒有 UI**（FR-203 / 204 / 206 及部分後端行為），刻意標為「無 UI，後端行為」而非留空 ——
  它們的驗證方式是探針與 `docs/ac/` 的 DoD，不是原型。

**跨 Module 註記**：
- FR-202 的畫面在 M01（待續傳 session sheet）—— 因為使用者是在 M01 的流程裡重新開 app；
  但**資料的正確性由 M02 保證**。兩份 PRD 都登記此 FR。
- FR-111（M01 的未命名 fallback）與 FR-217（M01-US-105 的命名入口）的 UI 都在本 Module 的逐字稿畫面 ——
  決策 D1：會議中一律不提供命名（M01 零打擾）。兩份 PRD 都登記，避免成為孤兒。
- `INT-M01-M02-01`（跨模組端到端）刻意不列為本 Module 的 FR，登記於 `docs/prd/01-listen.md` §5.1。
- **`INT-M02-M03-01`（v2.0 新增）** 刻意不列為本 Module 的 FR，登記於 `docs/prd/03-ask.md` §5.1。
  本 Module 的 FR-214 ~ 216 是它的呼叫端：**唯一差別只有 `scope`**，同一份引擎。

---

## 6. Non-goals（本 Module 明確不做）

| 不做 | 理由 |
| --- | --- |
| 會議中即時長出摘要 | prompt 與 token 成本難控，且會干擾會議（backlog §5）|
| 自動推送待辦到 Notion / Slack | 外部授權會炸開 v1 範圍（backlog §5）|
| **本 Module 自建檢索邏輯** | v2.0 起檢索一律呼叫 M03 的 `ask()`（INT-M02-M03-01）。理由：兩套檢索 = 兩個「不編造」的破口 |
| 跨會議彙整的**呈現** | 跨會議彙整已是 M03 的核心能力，但**入口在首頁對話框**；本 Module 只提供單場入口（`scope = meeting_id`）|
| 多人協作編輯記錄 | 單人自用（決策 R5）|
| 記錄版本歷史 | append-only 的逐字稿已提供回溯基礎，v2 再考慮 |

---

## 7. 變動歷史

| 日期 | 版本 | 變更 | 作者 |
| --- | --- | --- | --- |
| 2026-10-07 | v1.4 | 第二輪（M03 / M04）：FR-214 改為「呼叫 M03 引擎」（M02 不再含檢索邏輯）；FR-215 明訂查無由引擎判定；Non-goals 刪除「跨會議檢索不做」（已是 M03 核心）並改為「本 Module 不自建檢索」；登記 INT-M02-M03-01 於 `03-ask.md` §5.1 | Agent（dav-designer Step 4，第二輪）|
| 2026-10-07 | v1.3 | M02-US-203 AC-4 由「1 小時 60 秒」改為「2 小時上限 120 秒（門檻待 SPIKE-004）」；修掉深層連結首次載入失效（`#gen`/`#tr` 會落錯畫面）| Agent（dav-designer Step 5）|
| 2026-10-07 | v1.2 | 原型修掉 `#app` 未設 flex 欄導致 `.body` 無法捲動、內容被 `overflow:hidden` 切掉（長逐字稿與 20 位發言者原本看不到）| Agent（dav-designer Step 5）|
| 2026-10-07 | v1.1 | Step 5：決策 D1 拍板「會後統一命名」→ 新增 FR-217（會後批次命名入口，對應 M01-US-105）| Agent（dav-designer Step 5）|
| 2026-10-07 | v1.0 | 初版：16 FR / 5 US / 依賴圖 / 追溯矩陣 | Agent（dav-designer Step 4）|

---

## 8. 原型與驗證證據（Step 5）

| 項目 | 值 |
| --- | --- |
| 原型檔案 | `docs/prd/02-record.html` |
| 檔案行數 | 345（上限 500 ✓） |
| 開啟方式 | 雙擊即開；單檔內嵌 CSS + JS；無 build tool、無外部依賴、無真實 API |
| 覆蓋畫面 | 7 個（`gen` / `summary` / `tr` / `act` / `spk` / `export` / `fup`），中間 4 個屬「會議詳情」 |
| 可切換狀態 | 30 組 |
| 驗證命令 | Playwright（`channel: chrome`）以 `file://` 載入，逐一切換狀態並斷言 |
| 驗證結果 | 30/30 狀態渲染非空；10/10 互動斷言通過；JavaScript 錯誤 0 |

關鍵互動（實測輸出）：

| # | 斷言 | 結果 |
| --- | --- | --- |
| 5 | 摘要 / 逐字稿 / 待辦 分頁切換 | ✓ |
| 6 | 待辦點擊展開逐字稿原句（FR-211） | ✓ 顯示「陳大文 · 01:02（第 6 句）」 |
| 7 | 匯出 → loading（CTA disabled）→ 成功 toast | ✓ 400–500ms 可感知 |
| 8a | 追問「誰負責預算明細」→ 人名 + 回溯句（FR-214） | ✓ |
| 8b | 追問超範圍題 → 明說查無（FR-215） | ✓ |
| 9 | barge-in 打斷播放（FR-216） | ✓ 顯示「已停止播放」 |
| — | 待辦「未提及期限」顯示為未提及而非猜測日期（FR-210） | ✓ `due` 為 null 的那一筆顯示「未提及期限」 |
| — | 摘要 error 態 → 按「重試摘要與待辦」→ skeleton → 成功（FR-208） | ✓ 全鏈路可走完，不停在 error |
| 10 | 會後批次命名（FR-217）：逐字稿提示「有 3 位發言者還沒命名」→ sheet 一次改名 → 回到逐字稿名字已套用、提示消失、**待辦負責人同步換名** | ✓ 全綠（含空名字擋下、20 位發言者 edge）|

> 未達標項：無。
