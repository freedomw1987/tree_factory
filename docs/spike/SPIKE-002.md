# SPIKE-002：Tauri iOS webview 的即時錄音行為（含背景 / 中斷）實測

- **對應 Module**：M01（聽）
- **狀態**：✅ 完成（2026-10-08，trust mode 執行）
- **執行者**：trust mode 自動執行（`docs/trust-log.md`）
- **時限目標**：0.5 天內給結論 → 實際約 50 分鐘（含一次自我更正）
- **結論一句話**：**前台可錄、背景不錄** —— Tauri iOS webview 取得到麥克風、`MediaRecorder` 可用、
  音檔能 POST 回本機；但 app 一退到背景，iOS 就停止供音且凍結 JS 計時器，
  **錄音不會繼續**（35 秒的錄音只解出 5.1 秒音訊），回到前景才恢復。

## 1. 為什麼要做這個 Spike

backlog §1 把「Tauri iOS webview 能不能當錄音來源」列為 M01 的成立前提之一，
且 DESIGN 的「本地緩存音檔 + 恢復後回補」策略**完全建立在「背景仍可錄」的假設上**。
如果假設錯了，M01 的整個 capture 層要換位置（webview → native），
連帶影響 M02 的逐字稿完整性設計（段落缺口怎麼呈現）。

## 2. 實驗設計（三次實機 run，同一支探針）

探針是 `app/src/index.html`：載入後自動錄音（可設定秒數），停止後把
**報告（JSON）** 與 **音檔（binary）** POST 回 Mac 上的 `spike/collector.py`（`127.0.0.1:8765`）。
報告含每次狀態變化、心跳、捕獲秒數、片段大小，用來交叉判讀。

| Run | 探針版本 | 事件腳本 | 目的 |
| --- | --- | --- | --- |
| Run 1 | 手動模式 | 純前台錄 8 秒 | 基本收音能力 + 音檔格式 |
| Run 2 | 自動模式 + 心跳 | t=11s 送背景 → t=17s 回前景 | 背景行為（第一次，探針有 bug） |
| Run 3 | 自動模式 + 心跳 + stop 修正 | t=6s 送背景 → t=21s 回前景 | 背景行為（修正後，取到真音檔） |

**量測方法的關鍵**：`AudioContext.currentTime` **不能**當「已捕獲音訊」的證據
（它只反映音訊時鐘在前進，即使沒有任何音訊資料進來）。真正的證據是
**把上傳的音檔解碼後量長度與每秒能量**（`ffmpeg` → `s16le` → RMS）。

## 3. 實測結果

### 3.1 環境（Run 1）

| 項目 | 值 |
| --- | --- |
| protocol / origin | `tauri:` / `tauri://localhost`（**`isSecureContext = true`**） |
| UA | `iPhone OS 18_7`（runtime iOS 27.0） |
| viewport / dpr | 402 × 778 / 3 |
| locale | `zh-HK` |
| 模擬器 | iPhone 18 Pro（`56439690-…`） |

### 3.2 Web API 能力矩陣

| 能力 | 結果 | 備註 |
| --- | --- | --- |
| `mediaDevices` / `getUserMedia` | ✅ | 需 `simctl privacy … grant microphone` |
| `getDisplayMedia` | ✅ | |
| **`MediaRecorder`** | ✅ | 可用 mime：`audio/webm;codecs=opus` ✅、`audio/mp4` ✅；`audio/wav`、`audio/ogg`、`audio/aac` ✗ |
| `AudioContext` / `AudioWorklet` | ✅ | `sampleRate = 48000` |
| `wakeLock` | ✅ | 可由頁面主動防關屏 |
| `Notification` | ❌ | 產品若要提醒使用者「回前景才能續錄」，得走原生 |
| `Worker` / `SharedWorker` / `WebSocket` | ✅ | |

### 3.3 前台錄音（Run 1，證據齊）

- `bytes = 229111`、`mime = audio/webm; codecs=opus`、`peak = 0.3624`、`seconds = 9.21`、`chunks = 8`
- `ffprobe`：`codec_name=opus / sample_rate=48000 / channels=2 / duration=N/A`
  → **webm 沒有 duration header**（時間長度只能自己算）
- 麥克風 label：`Mock audio device 1`（模擬器提供 4 個 mock 裝置）
- 關 3A：`echoCancellation / noiseSuppression / autoGainControl` 全關
- 音檔與報告都成功 POST 回 `http://127.0.0.1:8765`
  （**這條路要開 ATS `NSAllowsLocalNetworking`**，已寫進 `app/src-tauri/Info.plist`）

### 3.4 背景中斷（Run 2 / Run 3）——含一次自我更正

**Run 2（探針有 bug）**：報告 `bytes = 0`、`chunkSizes` 有 11 筆、`capturedSec = 39.97`。
我當下的判讀是「背景仍在錄音」，並打算寫進文件。

**Run 3（修正探針）**：報告 `bytes = 144407`、`chunks = 5`、`capturedSec = 34.97`、`wallSec = 37.62`。
看起來也像「有錄到」。但**把音檔解碼後只得到 5.1 秒**（5 個片段，每個約 28.9 KB ≈ 1 秒）：
也就是說 **35 秒的錄音裡，只有送背景前那 5 秒真的被錄下來**。

修正後的證據鏈（Run 3，`visibilitychange → hidden` 發生在開錄後 5.36 秒）：

| 證據 | 值 | 說明 |
| --- | --- | --- |
| 解碼後音訊長度 | **5.1 秒**（5 片段 × ~1 秒） | 背景期間沒有新的音訊資料 |
| 心跳日誌 | beat 5 @ 19:28:55.839 → beat 10 @ 19:29:04.354 | **19.7 秒空窗**：JS 計時器在背景被凍結/節流 |
| `visibilitychange` | `hidden` @ 19:28:56.189、`visible` @ 19:29:11.908 | **事件有送達**，可當可靠的中斷訊號 |
| `AudioContext.currentTime` | 一路前進到 34.97s | **不可作為捕獲量證據**（無資料時時鐘照走） |
| 回前景後 | 片段恢復產出 | 錄音會「續上」，但中間的音訊**永久缺失**（無回補來源） |

**Run 2 的 `bytes = 0`** 則是另一個 bug，順帶記下來當實作紀律：
`MediaRecorder.stop()` 的 `stop` 事件可能延遲超過 1 秒才來；若送資料前只等固定 1.2 秒，
`blob` 還是 `null`。正確寫法是**等 stop 事件 + 逾時 fallback，且 finalize 只跑一次**。

## 4. 驗收對照（backlog §3 SPIKE-002）

| 問題 | 結論 |
| --- | --- |
| Tauri iOS webview 能否 `getUserMedia` 收音 | ✅ 可以（前台、需授權、`isSecureContext=true`） |
| 鎖屏 / 背景行為 | ❌ **背景不收音**（`UIBackgroundModes: [audio]` 已寫進 Info.plist 也無效——
  Tauri 的 webview 不走 native audio session 的續航路徑） |
| 音檔能否落地 | ✅ `MediaRecorder` blob → POST 回本機（ATS 例外已開） |

## 5. 對設計的影響（要回寫的文件）

### 5.1 架構結論（三個選項，⭐ 為建議）

- **⭐ 選項 A：把錄音移到原生層**（Tauri plugin：Swift `AVAudioEngine` + `UIBackgroundModes: audio`），
  webview 只負責 UI 與顯示。這是 iOS 上「會議錄音」的標準做法，也才能同時保住
  背景續錄與鎖屏續錄。代價：多寫一個 plugin（估 200–300 行 Swift + Rust bridge，0.5–1 天）。
- **選項 B：接受「必須停留前景」的產品約束** —— 用 `wakeLock` 防關屏，偵測
  `visibilitychange → hidden` 就標記 `TRANSCRIPT_GAP` 並在逐字稿留缺口。
  零額外工程，但使用者一鎖屏 / 切走就斷，**與「幫我記錄整場會議」的核心承諾衝突**。
- **選項 C：v1 先 B、v1.1 換 A**。可出貨但會帶著一個已知的體驗缺陷。

**建議**：核心承諾是「開會時幫你記」，使用者鎖屏是必然行為 →
**A 才是正解**；但為了不讓 M01 卡住，先按 B 的可偵測缺口設計，
並在 M01 內開一張 P0 票把 capture 換到原生（見 §6）。
若 A 的工程量在時間盒內失控，再退回 C 並在 PRD 明寫限制。

### 5.2 其他必須回寫的設計事實

1. **`visibilitychange` 是可靠的中斷訊號** → 直接餵給既有的 `TRANSCRIPT_GAP` 錯誤碼
   （system-design §5.2 已有此碼，現在有了觸發來源）。
2. **`AudioContext.currentTime` 不能當捕獲量**：監控與「會議長度」要用
   *已交付的音訊位元組 / 片段時間戳*，不能用音訊時鐘。
3. **iOS 本地緩存音檔建議改用 `audio/mp4`（AAC）**：webm/opus 無 duration header，
   要自己記長度；mp4 在 iOS 生態較完整。
4. **webview 送出的是 48kHz 立體聲** → 餵 Deepgram 前必須降採樣到 16kHz 單聲道
   （agents SDK 已有 `downsample48kStereoTo16kMono` helper，SPIKE-001 也用同格式）。
5. **`MediaRecorder` 收尾要有逾時 fallback**（Run 2 的 `bytes = 0` 教訓）。
6. **本地網絡 POST 需 ATS `NSAllowsLocalNetworking`**（開發期用；正式走 HTTPS 後可移除）。

## 6. 待辦（建議新增 / 更新的 backlog 項）

| 建議票 | 內容 | 優先級 |
| --- | --- | --- |
| **M01-US-1xx（新）** | 原生錄音層：Tauri plugin（`AVAudioEngine`）取代 webview `MediaRecorder`，支援背景 / 鎖屏續錄 | **P0** |
| M01-US-1xx（新，較小） | 以 `visibilitychange` 標記 `TRANSCRIPT_GAP`：逐字稿在缺口中顯示「此段未錄到」 | P0 |
| M01-US-103（補 AC） | 監控指標改以「已交付位元組 / 片段時間戳」計算，不得用 `AudioContext.currentTime` | P0 |
| SPIKE-002b | 時間盒 0.5 天：驗證原生 plugin 是否真能在背景 / 鎖屏續錄（A 選項的可行性） | P0 |
| （設計） | 本地緩存格式改 `audio/mp4`（AAC） | P1 |

## 7. 未驗證項（誠實列出）

1. **鎖屏**：`xcrun simctl` 沒有 lock 指令，需 UI 自動化或實機手動。
   推論與「背景」同因（app 非前景即被暫停），但**未直接驗證**。
2. **實機**：本次全在模擬器（`Mock audio device`），實機的麥克風路徑與
   真實 audio session 行為（例：藍牙耳機切換、來電中斷）未驗證。
3. **長會議**：只驗到 35 秒級；2 小時級的記憶體 / 熱 / session 穩定性未驗。
4. **原生路徑可行性**（選項 A）尚未實作驗證 → 建議票 SPIKE-002b。

## 8. 重跑方式（可重現）

```bash
# 0) 收集器（Mac 端）
nohup python3 spike/collector.py > /tmp/tech001/collector.log 2>&1 &

# 1) 建置探針（iOS 模擬器）
rm -rf app/src-tauri/gen/apple/build && touch app/src-tauri/src/lib.rs
cd app && cargo tauri ios build --debug --target aarch64-sim

# 2) 安裝 + 授權 + 啟動（探針會自動錄音並上報）
xcrun simctl install booted gen/apple/build/arm64-sim/tree-factory.app
xcrun simctl privacy booted grant microphone com.treefactory.spike
xcrun simctl launch booted com.treefactory.spike

# 3) 背景測試：t=8s 送背景、t=25s 拉回前景
xcrun simctl launch booted com.apple.Preferences
sleep 17 && xcrun simctl launch booted com.treefactory.spike

# 4) 判讀：報告在 spike/results/spike-002-report-*.json
ffmpeg -v error -i spike/results/spike-002-audio-*.webm -ac 1 -ar 16000 -f s16le - | wc -c
#    → 位元組數 / 32000 = 實際音訊秒數（不是容器時長！）
```

## 9. 變動歷史

| 版本 | 日期 | 變動 |
| --- | --- | --- |
| v1.0 | 2026-10-08 | 初版：前台可錄、背景不錄（含一次判讀更正）、ATS 例外、48k→16k 降採樣、原生錄音建議 |