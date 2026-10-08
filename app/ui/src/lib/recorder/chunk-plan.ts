/**
 * M01-US-102：分段計畫（純函式）。
 *
 * 為什麼要有「計畫」而不是邊錄邊算：分段序號必須與時間軸一一對應，
 * 恢復時才能用伺服端回報的 `expectedNextSeq` 判斷「缺哪一段」（AC-4）。
 *
 * D1：MediaRecorder **每 30 秒 stop/start**，每段都是獨立可解碼的檔；
 * 這是「上傳成功才刪」（AC-1）的前提——`start(timeslice)` 吐的是同一容器的片段，
 * 單獨一個片段解不開，也就無法單獨回補。
 * 單調性：分段是「向後推算」而不是「事後補洞」——計畫只是用來驗證 30 秒切段與 seq 對應的關係；
 * 正式錄音由 MediaRecorder 的 stop/start 驅動（`media.ts`），seq 由 capture 自己單調遞增。
 * Gate 4 F8 註記：本檔的 `planChunks`／`chunkIndexAt` 目前只有單元測試使用（產品程式碼只用
 * `CHUNK_DURATION_MS`）。保留原因：它們是「seq ↔ 時間軸」契約的可執行文件，回歸時能捉住常數被改壞。
 */

/** 分段長度（30 秒，設計 §2 D1 的單一來源）。 */
export const CHUNK_DURATION_MS = 30_000;

export interface ChunkPlan {
  /** 1 起算的序號＝伺服端冪等鍵。 */
  seq: number;
  /** 相對於錄音開始的毫秒（0 起算）。 */
  startsAtMs: number;
  durationMs: number;
}

/** 某個累積時間點落在第幾段（0 起算）。 */
export function chunkIndexAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / CHUNK_DURATION_MS);
}

/** 目前這段該不該收尾換段（`>=` 邊界：29999 不換、30000 換）。 */
export function rotationDue(elapsedMs: number, currentIndex: number): boolean {
  return chunkIndexAt(elapsedMs) > currentIndex;
}

/** 依總長度排出分段（不足一段的尾段照算；0 或負數沒有分段）。 */
export function planChunks(totalMs: number): ChunkPlan[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];
  const full = Math.floor(totalMs / CHUNK_DURATION_MS);
  const rest = totalMs - full * CHUNK_DURATION_MS;
  const plan: ChunkPlan[] = [];
  for (let index = 0; index < full; index += 1) {
    plan.push({ seq: index + 1, startsAtMs: index * CHUNK_DURATION_MS, durationMs: CHUNK_DURATION_MS });
  }
  if (rest > 0) {
    plan.push({ seq: full + 1, startsAtMs: full * CHUNK_DURATION_MS, durationMs: rest });
  }
  return plan;
}
