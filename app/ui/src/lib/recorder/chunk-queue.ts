/**
 * M01-US-102：分段佇列（純邏輯；持久化由 `chunk-store.ts` 負責）。
 *
 * 這支檔案是整張票的「不變式守門員」：
 *   1. 沒有 ack 的分段**永遠不會**出現在 `deletionCandidates()`（AC-1 原文）。
 *   2. 重送一律依 seq 升序，且同一段不會在佇列裡長成兩筆。
 *   3. 伺服端 ledger 才是權威：`reconcile()` 用伺服端回報校正本機。
 *   4. 失敗要退避（指數、上限 30 秒），不可 busy loop 打爆伺服端。
 */

export interface ChunkRecord {
  meetingId: string;
  /** 1 起算＝伺服端冪等鍵。 */
  seq: number;
  /** 內容指紋（SHA-256 前 16 hex）。 */
  hash: string;
  bytes: number;
  /** 失敗次數（用來算退避）。 */
  attempts: number;
  /** 上次嘗試送出時間；null = 從未送過。 */
  lastAttemptAtMs: number | null;
  /** 伺服端確認收下（唯一可刪的狀態）。 */
  acked: boolean;
}

export type NewChunkRecord = Omit<ChunkRecord, "attempts" | "lastAttemptAtMs" | "acked">;

export interface ReconcileResult {
  /** 因伺服端回報而由「未收」轉成「已收」的段數。 */
  ackedNow: number;
}

const BACKOFF_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;

/** 第 n 次失敗後的等待時間：0、1s、2s、4s、8s…上限 30s。 */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

export class ChunkQueue {
  readonly #items = new Map<number, ChunkRecord>();
  /**
   * 永久無法送出的段（內容衝突）。
   *
   * 為什麼不能只靠「退避」把它擋住：`nextDue()` 只回最小 pending 段，如果衝突段留在 pending，
   * 它每一輪都會被選中、被 fail、然後下次又選中——後面所有 seq 一輩子送不出去（Gate 4 F7）。
   * 排除是**刻意**的：衝突是永久性問題，需要人處理，不該拖垮整條管線。
   */
  readonly #blocked = new Set<number>();

  /** 同一 seq 重複加入＝就地更新（不長大）；`seq` 是冪等鍵。 */
  enqueue(record: NewChunkRecord): void {
    // 同一個 seq 有新內容進來＝先前「這一段沒救」的判定作廢（與 uploader 的清 conflict 同步）。
    this.#blocked.delete(record.seq);
    const existing = this.#items.get(record.seq);
    if (existing === undefined) {
      this.#items.set(record.seq, { ...record, attempts: 0, lastAttemptAtMs: null, acked: false });
      return;
    }
    this.#items.set(record.seq, {
      ...existing,
      meetingId: record.meetingId,
      hash: record.hash,
      bytes: record.bytes,
    });
  }

  /** 尚未被伺服端確認、且不是永久衝突的分段（依 seq 升序）。 */
  pending(): ChunkRecord[] {
    return [...this.#items.values()]
      .filter((item) => !item.acked && !this.#blocked.has(item.seq))
      .sort((a, b) => a.seq - b.seq);
  }

  /** 標記為永久無法送出（內容衝突）；`enqueue` 新內容時會自動解除。 */
  block(seq: number): void {
    this.#blocked.add(seq);
  }

  /**
   * 目前被排除在待送清單外的段（畫面要說清楚它們還在，只是送不了）。
   * Gate 4 F8 註記：產品路徑靠它間接生效（`pending()` 會排除 blocked），但直接呼叫的只有測試與除錯。
   */
  blockedSeqs(): number[] {
    return [...this.#blocked].sort((a, b) => a - b);
  }

  size(): number {
    return this.#items.size;
  }

  /** 伺服端確認收下：清掉退避狀態並標記 acked。 */
  ack(seq: number): void {
    const existing = this.#items.get(seq);
    if (existing === undefined) return;
    this.#items.set(seq, { ...existing, attempts: 0, acked: true });
  }

  /**
   * 只有已 ack 的分段可以被刪除（不變式 1）。
   *
   * Gate 4 F8 註記：產品程式碼目前不直接呼叫它——真正的刪除在 `uploader.flush()` 的對帳裡
   * （它要同時比對內容指紋）。這支留在佇列上，是因為「哪些段可以刪」是這張票的紅線語意，
   * 值得有一支單獨可測的查詢；單元測試靠它守住不變式 1。
   */
  deletionCandidates(): number[] {
    return [...this.#items.values()]
      .filter((item) => item.acked)
      .map((item) => item.seq)
      .sort((a, b) => a - b);
  }

  /** 上傳失敗：累計次數並記錄時間，退避後才可再送。 */
  fail(seq: number, nowMs: number): void {
    const existing = this.#items.get(seq);
    if (existing === undefined) return;
    this.#items.set(seq, { ...existing, attempts: existing.attempts + 1, lastAttemptAtMs: nowMs });
  }

  /**
   * 現在可以送的分段：**只看 seq 最小的那一段**（依序送是 AC-2 的順序保證）。
   * 若最小段還在退避，就回 undefined 讓呼叫端停下來等——不可跳過它去送後面的段，
   * 否則網路斷掉時會把後面的段塞進壞掉的連線，而且恢復時 seq 會出現洞。
   */
  nextDue(nowMs: number): ChunkRecord | undefined {
    const first = this.pending()[0];
    if (first === undefined) return undefined;
    if (first.lastAttemptAtMs !== null && nowMs - first.lastAttemptAtMs < backoffMs(first.attempts)) {
      return undefined;
    }
    return first;
  }

  /** 丟掉整場會議的項目（只在使用者明確選擇丟棄時呼叫，AC-3）。 */
  drop(meetingId: string): void {
    for (const [seq, item] of [...this.#items.entries()]) {
      if (item.meetingId === meetingId) this.#items.delete(seq);
    }
  }

  /** 用伺服端 ledger 校正：伺服端說收過的，本機一律標記已收（伺服端是權威）。 */
  reconcile(serverAcked: readonly number[]): ReconcileResult {
    let ackedNow = 0;
    for (const seq of serverAcked) {
      const existing = this.#items.get(seq);
      if (existing === undefined || existing.acked) continue;
      this.#items.set(seq, { ...existing, attempts: 0, acked: true });
      ackedNow += 1;
    }
    return { ackedNow };
  }
}

/** 最小未收的 seq（伺服端與裝置端共用同一條規則：有洞先補洞）。 */
export function nextExpectedSeq(seqs: readonly number[]): number {
  const set = new Set(seqs);
  let expected = 1;
  while (set.has(expected)) expected += 1;
  return expected;
}

/** 本機有、伺服端還沒收到的分段（＝恢復時要回補的清單）。 */
export function missingSeqs(localSeqs: readonly number[], serverSeqs: readonly number[]): number[] {
  const server = new Set(serverSeqs);
  return [...new Set(localSeqs)].filter((seq) => !server.has(seq)).sort((a, b) => a - b);
}

/**
 * 時間軸缺口：伺服端已經收過**更後面**的段（所以中間那個洞不會再有請求來補），
 * 而本機也沒有對應檔案——這種洞補不回來，只能照實回報（AC-4「無缺段」的偵測點，
 * 設計 §6「缺段不得無聲跳過」）。
 *
 * 注意與 `missingSeqs` 的差別：那支是「本機有、還沒送上去」（可以補），
 * 這支是「已經被跳過、兩邊都沒有」（補不回來）。
 */
export function timelineGaps(acked: readonly number[], localSeqs: readonly number[]): number[] {
  const ackedSet = new Set(acked);
  const localSet = new Set(localSeqs);
  let maxAcked = 0;
  for (const seq of acked) if (seq > maxAcked) maxAcked = seq;
  const gaps: number[] = [];
  for (let seq = 1; seq <= maxAcked; seq += 1) {
    if (ackedSet.has(seq) || localSet.has(seq)) continue;
    gaps.push(seq);
  }
  return gaps;
}
