# M01-US-102 設計：本地音檔分段緩存與恢復回補

> 對應 Backlog: [M01-US-102](../backlog.md)
> Module: M01（聽：收音與即時逐字稿）
> AC: [docs/ac/M01-US-102.md](../ac/M01-US-102.md)
> 最後更新: 2026-10-09

## 1. 問題

會議中斷網或 app 被強制終止時，音檔與逐字稿不能報廢。要求三件事：

1. 音訊**分段落盤**，且「沒確認送出前不得刪除」。
2. 網路恢復後**依序回補**，且**不重複**送出已確認的分段。
3. app 被殺後重開，**詢問**是否續傳（不得自動丟棄）。

## 2. 設計決策（單一來源）

| # | 決策 | 理由 | 代價 / 已知限制 |
| - | ---- | ---- | --------------- |
| D1 | 分段方式 = MediaRecorder **每 30 秒 stop/start**，每段是獨立可解碼檔 | `start(timeslice)` 吐的是同一容器的片段，無法單獨解碼或單獨回補 | 換段處 < 100 ms 空隙（另由 M01-US-107 標缺口） |
| D2 | 冪等鍵 = 會議內單調遞增 `seq`；相容性檢查 = `contentHash`（SHA-256 前 16 hex） | seq 對應時間軸 → 可判斷缺段；hash 防「同 seq 換內容」 | 同 seq 不同 hash 一律 409，不覆蓋（覆蓋會讓音檔與逐字稿對不上） |
| D3 | 本機佇列 = **IndexedDB**，key = `${meetingId}:${seq}` | webview 持久、app 被殺後仍在；不需新增 Tauri fs plugin | IndexedDB 在隱私模式可能不可用 → 明說並退化成「不保證恢復」 |
| D4 | 「已確認」以**伺服端 ledger 為權威**，本機標記只是快取；重開後用 `GET /audio/chunks` 對帳 | 只信本機標記 → 兩邊不一致時永久漏段；對帳是唯一能自癒的路徑 | 恢復時要多一個 GET |
| D5 | 恢復流程：啟動掃 IndexedDB → 有未 ack → 顯示「有未完成的會議」→ 續傳 / 丟棄（丟棄需二次確認） | AC-3 原文要求「詢問」 | 多一步使用者互動 |
| D6 | 逐字稿去重：`POST /transcript` 帶 `chunkSeq`，同 seq 重送回 `duplicate:true` 且不增加計數 | 只靠前端自律的話，重送音檔觸發 ASR 重跑必然產生重複句 | 呼叫端必須帶 seq（沒帶＝舊行為，不做去重） |
| D7 | 音檔保留：伺服端「結束後 7 天」或「刪會議即刪」；本機 ack 後立即刪 | 音檔是最敏感資料 → 隱私最小化 | **本票只落地政策**，清理排程掛 M02-US-204 |

## 3. 資料模型（DO SQLite）

```sql
-- 音訊分段帳本：一個會議 = 一個 DO，seq 在會議內唯一
CREATE TABLE IF NOT EXISTS audio_chunks (
  seq INTEGER PRIMARY KEY,          -- 冪等鍵（D2）
  byte_len INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
);

-- 逐字稿去重帳本（D6）
CREATE TABLE IF NOT EXISTS transcript_chunks (
  seq INTEGER PRIMARY KEY,
  first_accepted_at_ms INTEGER NOT NULL
);
```

`INSERT OR IGNORE` + `changes()` 判斷是否為重複：**冪等是原子的**，不需要「先讀再寫」（先讀再寫在
並行重送下會雙寫）。

## 4. API 契約

| Method | Path | Body / Query | 成功 | 失敗 |
| ------ | ---- | ------------ | ---- | ---- |
| `POST` | `/m/:id/audio/chunk?seq=N` | 原始音訊位元組（`content-type: application/octet-stream`） | `201 {accepted:true, duplicate:false, seq, count, lastSeq, expectedNextSeq}`（重送→`duplicate:true`，仍 201） | `409 SEQ_CONFLICT`（同 seq 不同 hash）、`400 SEQ_INVALID`（seq 非正整數字串）、`400 SEQ_INVALID`（空 body，byteLength=0）、`404 SESSION_NOT_STARTED`（會議未開始） |
| `GET` | `/m/:id/audio/chunks` | — | `200 {chunks:[{seq,byteLen,hash}], count, lastSeq, expectedNextSeq, retentionDays}` | `404 SESSION_NOT_STARTED` |
| `POST` | `/m/:id/transcript` | `{text, chunkSeq?}` | `200 {accepted:true, duplicate:false}` | `200 {accepted:false, duplicate:true}`（重送，非錯誤） |

`expectedNextSeq` = 最小未 ack 的 seq（供裝置端對帳與「缺段」判斷）。

**契約修正（Gate 4 審查 F5，2026-10-09）**：伺服端**沒有** `SEQ_OUT_OF_ORDER` 這條規則，也刻意
不做「seq 必須連續」的驗證——順序保證放在裝置端（`ChunkQueue.nextDue()` 只送最小未 ack 段）。
理由：伺服端擋順序會讓「恢復時只補缺的那一段」被自己擋掉（先到 3、後補 2 是合法流程），
而重送／並發下伺服端也無從得知「誰先出發」。
因此 `chunks[].hash` 是裝置端對帳的必需欄位：`hashes[seq] != 本機 hash` → 同 seq 不同內容，
**不刪本機檔、不覆蓋**，列為 contentMismatch（見 §6）。

## 5. 恢復時序（文字圖）

```text
裝置重開                      伺服端 DO
   | 掃 IndexedDB（有未 ack seq）      |
   |--- GET /audio/chunks ------------>|  取得 ledger
   |<-- {acked:[...], expectedNextSeq} |
   | 佇列 = 本機 pending − 已 ack       |
   | 依 seq 升序重送（每段完成才送下一段）|
   |--- POST /audio/chunk?seq=k ------>|  INSERT OR IGNORE
   |<-- {duplicate:true}（早已收過）    |
   | 全部 ack 後：刪本機分段、檢查時間軸 |
```

## 6. 失敗模式與處理

| 失敗 | 處理 |
| ---- | ---- |
| 上傳中斷網 | 分段留在本機（`ack=false`）；`online` 事件或下次啟動時重送 |
| 同一段重送兩次 | 伺服端 `duplicate:true`，不重複落帳 |
| 同 seq 不同內容（裝置資料損毀 / 換會議） | `409 SEQ_CONFLICT`，**不覆蓋**；裝置端標記該段異常並保留本機檔。對帳時若發現 `hash` 不符，**也不得因為 seq 相同就刪本機檔**（刪了才是真的丟音） |
| 缺段（seq 跳號） | `expectedNextSeq` 指出缺口；裝置端先補缺口再送新的（不得無聲跳過）。若缺口處**本機也沒有檔案**（已被外部刪除／寫入失敗），回報 `gapSeqs` 明說補不回來 |
| IndexedDB 不可用 | 明說「這場會議沒有本地備份」，不假裝有恢復能力 |
| app 被殺 → 重開 | 進恢復流程（D5），**不得自動丟棄** |

## 7. 開放問題（Q4）定案

> AC 的 DoD 要求「音檔清理策略已記為開放問題 Q4 並在 Design 階段定案」。

**定案**：伺服端分段音檔保留 **7 天**（自會議結束起算）或使用者**刪除會議時立即刪除**；
本機分段在伺服端 ack 後**立即刪除**。清理排程的實作**不在本票**，掛 M02-US-204
（匯出 / 分享之後才動刪除，避免匯出前就清掉來源）。

## 8. 不變式（測試要守住的）

1. 沒有 ack 的分段**永遠不會**被本機刪除。
2. 同一個 `(meetingId, seq)` 在伺服端只會有一列（重送 n 次仍是 1 列、1 句）。
3. 恢復後「本機 pending」與「伺服端 ack」的交集為空 → 不重複送出。
4. 時間軸連續性檢查只看 seq 是否連續（`expectedNextSeq` 之前沒有洞）。
5. 同一場會議的 `seq` **跨中斷/續錄單調遞增**：`release()` → `acquire()`（切背景再回來）不得把 seq 歸零
   （歸零會讓續錄後的第一段撞上已 ack 的 seq，被當成「伺服端已有」而刪掉，是靜默丟音）。
6. 永久衝突（409 / hash 不符）的段不得卡住佇列：它必須被排除在待送清單外，後面的段照送。

## 9. Gate 4 審查修正記錄（2026-10-09）

審查（read-only reviewer）判 FAIL / BLOCK，共 7 條：

| 編號 | 等級 | 修正 |
| ---- | ---- | ---- |
| F1 `seq` 在 `acquire()` 被歸零 → 續錄重用已 ack 的 seq → 新音檔被當成「伺服端已有」刪掉 | **P0** | 移除歸零；回歸探針 `media.test.ts`「切背景中斷後續錄」驗 seq 續接 [1,2,3] |
| F2「續傳」路徑零測試 | P1 | `e2e/recovery.spec.ts` 兩條：續傳成功（驗伺服端帳本）與續傳失敗（不得說處理完、保留本機檔） |
| F3 `expectedNextSeq` 取了就丟、缺段無偵測 | P1 | `UploadOutcome.gapSeqs` + `timelineGaps()` + 畫面明說缺段；`uploader.test.ts` 驗 [1,3] → [2] |
| F4 對帳只看 seq、不比內容 | P2 | ledger 帶回 `hashes`；不符→不刪本機檔、列 `contentMismatchSeqs` |
| F5 §4 契約與實作不符 | P2 | §4 改成實作契約（無 `SEQ_OUT_OF_ORDER`／`EMPTY_CHUNK`）；client 改依 body `error` 碼判斷 409 |
| F6 裝置端指紋算了但沒比對 | P2 | 改與伺服端 ledger 指紋比對（F4）；兩端各加黃金向量測試（`eeef17c1e796515f`） |
| F7 衝突段卡住後面的 seq、訊息又不誠實 | P2 | `ChunkQueue.block()` 把衝突段移出待送清單；訊息改為「內容衝突，已保留在本機」 |
