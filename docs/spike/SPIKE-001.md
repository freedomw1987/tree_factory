# SPIKE-001：`withVoiceInput` × `diarize`（說話者辨識）實測

- **對應 Module**：M01（聽）
- **狀態**：✅ 完成（2026-10-08，trust mode 執行）
- **執行者**：trust mode 自動執行（`docs/trust-log.md`）
- **時限目標**：0.5 天內給結論 → 實際約 40 分鐘
- **結論一句話**：**模型支援、SDK 不支援**——`@cf/deepgram/nova-3` 串流模式吃 `diarize=true` 且逐字回傳
  `speaker`；但 Agents SDK 的 `WorkersAINova3STT` 沒把這個參數傳出去，所以 M01 必須自寫一個 `Transcriber`。

## 1. 為什麼要做這個 Spike

多人辨識是「會議記錄」的成立前提。backlog §1 把這件事列為**全案最大未知數**：
`withVoiceInput` 是否吃 `diarize`、串流模式有無 diarization，官方文件均未載明。
若串流不可行，M01 架構要改成「先錄音、會後批次辨識」，連帶影響 M02 的即時逐字稿設計。

## 2. 實驗設計（三組對照）

| 組別 | 音檔 | 參數 | 目的 |
| --- | --- | --- | --- |
| 基準組（plain） | `spike/fixtures/two-speakers-16k.wav` | 無 `diarize` | 確認「不開」時完全沒有 speaker 欄位 |
| 實驗組（diarize） | 同上 | `diarize=true` | 確認逐字 `speaker` 標籤是否存在 |
| 壓力組（stress） | `spike/fixtures/two-speakers-stress-16k.wav` | `diarize=true` | 長靜音（每句間 4 秒 × 4）＋重疊語音（末兩句疊 1 秒）下的穩定性 |

**fixture 怎麼來**：macOS `say` 以兩個不同語音（`Samantha` / `Daniel`）交替朗讀 6 句會議對話
→ `afconvert -f WAVE -d LEI16@16000 -c 1` 轉 16kHz 單聲道 PCM16
（正好是 SDK 要求的 `feed(chunk)` 格式：16kHz mono 16-bit LE）。
壓力組由 `spike/fixtures` 內的 Python 腳本以 PCM 相加做出重疊、以零值補出靜音。
真值分段表：`spike/fixtures/two-speakers-turns.json`（Samantha=0、Daniel=1 交替）。

**量測路徑**：`spike/spike-001/ws-direct.mjs` 直接對 Workers AI 的串流 WebSocket 端點送音訊：

```text
wss://api.cloudflare.com/client/v4/accounts/<acct>/ai/run/@cf/deepgram/nova-3
    ?encoding=linear16&sample_rate=16000&language=en&interim_results=true
    &vad_events=true&endpointing=300&utterance_end_ms=1000&smart_format=true
    &punctuate=true&diarize=true&paragraphs=true&utterances=true
```

> 為什麼不用 `wrangler dev` 的 AI binding：本機 dev 模式下 AI binding 需要
> **workers.dev 子網域**才能走遠端（`Binding AI needs to be run remotely`），
> 而註冊子網域屬於帳號層變更。改走官方 REST/WS API 直連，零帳號變更、成本僅數分錢。

## 3. 實測結果

### 3.1 SDK 層（`agents@0.27.0` / `@cloudflare/voice@0.5.0`）

| 檢查項 | 結果 | 證據 |
| --- | --- | --- |
| `@cloudflare/voice` 是否還在 | ⚠️ **已棄用**，僅為相容轉出口 | `npm pack @cloudflare/voice` → `docs/index.md`：Voice 改由 `agents/voice` 提供 |
| `withVoiceInput` 是否存在 | ✅ 存在（`withVoice` 為對話版，`withVoiceInput` 為聽寫版） | `agents/dist/voice/index.d.ts` |
| 是否有 `diarize` 選項 | ❌ **完全沒有** | `grep -ril diariz agents/dist` → 0 命中 |
| SDK 送給模型的參數 | `{encoding,sample_rate,language,interim_results,vad_events,endpointing,utterance_end_ms,smart_format,punctuate,keyterm?}` | `agents/dist/voice/workers-ai.js` 的 `_connect2()` |
| SDK 解析回應用到哪些欄位 | 只取 `channel.alternatives[0].transcript` + `is_final` + `speech_final` | 同檔 `_handleMessage2()`；**`words[]` 被整包丟掉** |
| 可否換掉辨識器 | ✅ `Transcriber` / `TranscriberSession` 是**公開介面**，且可覆寫 `createTranscriber(connection)` | `index.d.ts` 的 `VoiceInputMixinMembers` |

### 3.2 模型層（Workers AI `@cf/deepgram/nova-3`）

| 組別 | 訊息數 | 逐字數 | 帶 `speaker` 的字 | 看到的 speaker 值 |
| --- | --- | --- | --- | --- |
| 基準（無 `diarize`） | 38 | 274（含 interim 重複） | **0** | `[]`（欄位完全不存在） |
| 實驗（`diarize=true`） | 38 | 242 | **全部** | `[0, 1]` |
| 壓力（`diarize=true`） | — | 53（去重） | **53 / 53** | `[0, 1]` |

**乾淨版 6 句歸屬正確率（`spike/spike-001/analyze.py` 輸出）**：

```text
turn 真值        預測        字數    純度      文字
0    Samant    0         10    100%    ✓ Good morning, everyone. Thanks for joining t
1    Daniel    1         12    92%     ✓ I want to start with the marketing overspend
2    Samant    0         9     78%     ✓ Marketing was over budget by about 12%. Who
3    Daniel    1         13    85%     ✓ owns that number? And can we get a breakdown
4    Samant    0         11    91%     ✓ will ask Way to send the campaign breakdown
5    Daniel    1         13    100%    ✓ Let me also add that we need a decision on t

偵測到的換人次數: 5（真值 5 次，6 句交替）
```

> 純度不足 100% 是**量測窗造成的**：分析腳本用真值時間 ±0.15 秒取字，邊界字會落到鄰句。
> 逐字層面沒有觀察到「同一句內 speaker 交錯」的情形（6 句的 `speaker` 序列皆單一值）。

**壓力組：長靜音 + 重疊語音**（同 speaker 的連續段切分）：

```text
#   spk    start   end      字數    文字
0   0      0.00    2.88     9      Good morning, one. Thanks for joining the budget rev
1   1      7.29    11.32    11     Thanks. I want to start with the marketing from last
2   0      15.65   18.85    8      Right. Marketing was over budget by about 12%.
3   1      23.08   26.68    12     Who owns that number, and can we get a breakdown by
4   0      30.91   34.51    11     I will ask Wade to send the campaign breakdown befor
5   1      34.51   35.56    2      Perfect. Let

speaker 序列: [0, 1, 0, 1, 0, 1]   換人次數: 5
```

**判定**：跨 4 段 4 秒靜音、以及句尾 1 秒重疊，speaker 編號**沒有漂移、沒有交換**，
換人點與真值完全一致（5 次）。長靜音後重新認人時，同一位講者仍被指派同一個編號。

### 3.3 三個非預期但影響設計的發現

1. **串流模式不回 `paragraphs`**：即使帶了 `paragraphs=true` / `utterances=true`，
   WebSocket 回傳的仍是逐字層級；REST（非串流）才會回 `paragraphs[].speaker`。
   → **M01/M02 必須自己把逐字按 `speaker` + 停頓長度聚成「段落」**，不能指望上游給。
2. **收尾會掉最後一句**：音訊送完立刻送 `{"type":"CloseStream"}` 時，最後一段（`Perfect. Let`）
   只有部分內容；需要先送 `Finalize` 並等最後一批 `is_final` 回來。
   → 對應產品行為：**「結束會議」必須等最後一批結果落地才算寫完**（見 §5 後續票）。
3. **專有名詞會被聽錯**：`Wei` → `Way` / `Wade`。
   → `keyterm` 參數是必需品（會議常見人名/專案名），應由 M02 的會議 metadata 餵入。

## 4. 驗收對照（backlog §3 SPIKE-001）

| AC | 結果 |
| --- | --- |
| 1. `withVoiceInput` 是否可傳 `diarize` 的實測結論 | ✅ §3.1：SDK 不傳；模型層可直接下參數 |
| 2. 串流模式下 speaker 編號是否穩定（換人 / 重疊 / 長靜音後） | ✅ §3.2：6/6 歸屬正確、5/5 換人點正確、靜音與重疊皆無漂移 |
| 3. 若不可行的替代路線 | ✅ 見 §5.2（不必降級為批次辨識；改為自寫 Transcriber） |

## 5. 對設計的影響（要回寫的文件）

### 5.1 架構結論

M01 的音訊路徑維持**串流**（原本設計成立），但辨識器**不是** SDK 內建的 `WorkersAINova3STT`：

```text
Tauri iOS webview（getUserMedia，16kHz PCM）
  → WSS（agents/voice 的 Voice 傳輸）
  → 自寫 DiarizingNova3Transcriber（implements Transcriber）
        └─ ai.run("@cf/deepgram/nova-3", {..., diarize:"true"}, {websocket:true})
        └─ 解析 words[]：{word, start, end, speaker}
        └─ 聚段：speaker 變更 或 停頓 > 1.2 秒 或 UtteranceEnd → 產生 transcript_segment
  → M01 onTranscript → M02 append_transcript（idempotency_key = meeting + seq）
```

- `speaker` 是 **0 起算整數**，與 DESIGN「`speaker_id` 0 起算、顯示 `+1`」一致，無需轉換。
- 逐字帶 `start` / `end`（秒，浮點）→ 足以支撐 system-design §5.4 的**來源錨點**與
  `transcript_segment.start_ms / end_ms`。
- 自寫 transcriber 的風險：Agents SDK 屬 Beta，`Transcriber` 介面可能變動
  （backlog 風險 2）→ 以**單一檔案 + 契約測試**隔離。

### 5.2 替代路線（若未來 SDK 或模型改動導致失敗）

1. **先串流、後補標**：串流只做文字（既有 SDK 路徑），會後用 REST 非串流端點（已證實回
   `paragraphs[].speaker`）對齊時間戳補上講者 → 代價是**講者延遲到會後**才顯示。
2. **自架 diarization**（如 pyannote）：成本高、維運重，僅在模型層失效時才考慮。

## 6. 待辦（建議新增 / 更新的 backlog 項）

| 建議 | 類型 | 說明 |
| --- | --- | --- |
| TECH-003 | tech | 通報：`@cloudflare/voice` 已棄用，改依 `agents/voice`（`agents@0.27.0`）；system-design §1 要更新 |
| M01-US-103 補充 AC | AC 修訂 | 加入「段落切分規則（speaker 變更 / 停頓 > 1.2 秒 / UtteranceEnd）」與「最後一段必須等 Finalize 落地」 |
| M01-US-10x（新） | US | 會議結束時先 `Finalize` 並等待最後一批結果（避免掉最後一句），失敗要可重試 |
| — | 設計更新 | `keyterm` 由會議 metadata 餵入（人名 / 專案名），列入 M02 的會議建立流程 |

## 7. 重跑方式（可重現）

```bash
# 0) 前置：已 wrangler login（憑證用於直連 API；不部署任何東西）
cd tree_factory

# 1) 重建 fixture（若音檔不在）
say -v Samantha -o /tmp/l0.aiff -f <句子檔> && afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/l0.aiff /tmp/w0.wav

# 2) 基準組 / 實驗組
node spike/spike-001/ws-direct.mjs 0                       # 無 diarize → speaker 欄位應為空
node spike/spike-001/ws-direct.mjs 1                       # 有 diarize → speaker 應為 {0,1}

# 3) 壓力組（長靜音 + 重疊）
node spike/spike-001/ws-direct.mjs 1 spike/fixtures/two-speakers-stress-16k.wav

# 4) 歸屬正確率分析
python3 spike/spike-001/analyze.py spike/results/spike-001-ws-diarize.json
```

原始訊息（完整 JSON，含每個 `Results` 事件的逐字與 speaker）保存在 `spike/results/`。

## 8. 變動歷史

| 版本 | 日期 | 變動 |
| --- | --- | --- |
| v1.0 | 2026-10-08 | 初版：三組對照實驗 + SDK 原始碼證據 + 架構結論與後續票 |
