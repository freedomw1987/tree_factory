/**
 * M01-US-102：上傳協調者——把「先落盤、後上傳、ack 才刪」變成一條可以被測試的流程。
 *
 * 為什麼要有這一層（而不是在畫面裡直接 fetch）：AC-1/AC-2 的保證是**順序**保證。
 * 順序一旦散在 UI 事件裡，任何一個 await 忘記接就會出現「先刪檔再上傳」或
 * 「網路斷了還在送後面的段」。集中在這裡，才能用假 api/假 store 把順序釘死。
 *
 * 伺服端 ledger 是權威（設計 §2 D4）：每次 flush 都先讀它，才決定要送哪些段。
 * 讀不到帳本時**不送任何段**——沒有權威帳本就無從確認「送過了」，也就不敢刪本機檔。
 */

import { ChunkApiError } from "../session/api";
import { ChunkQueue, backoffMs, timelineGaps } from "./chunk-queue";

export interface ChunkBlobRecord {
  meetingId: string;
  seq: number;
  hash: string;
  blob: Blob;
}

export interface ChunkLedgerSnapshot {
  acked: number[];
  expectedNextSeq: number;
  /** seq → 伺服端內容指紋；缺席＝帳本沒帶指紋（此時只能靠 seq 對帳，不可宣稱內容一致）。 */
  hashes?: Record<number, string>;
}

export interface ChunkUploadApi {
  /** 成功（含伺服端說「這是重送」）→ 回 accepted/duplicate；失敗丟 `ChunkApiError`。 */
  upload(meetingId: string, chunk: ChunkBlobRecord): Promise<"accepted" | "duplicate">;
  /** 伺服端帳本：已收下的 seq、下一個還缺的 seq（有洞就指洞）。 */
  ledger(meetingId: string): Promise<ChunkLedgerSnapshot>;
}

export interface ChunkBlobStore {
  put(item: ChunkBlobRecord): Promise<void>;
  list(meetingId: string): Promise<ChunkBlobRecord[]>;
  remove(meetingId: string, seq: number): Promise<void>;
  /** 有哪些會議還留著分段（恢復流程要問的就是這份清單）。 */
  meetings(): Promise<string[]>;
}

export interface UploadOutcome {
  /** 這次真的送到伺服端並被收下的段數（不含 duplicate）。 */
  sent: number;
  /** 伺服端說「已經收過同一段」的段數（仍算成功，本機檔已刪）。 */
  duplicates: number;
  /** 仍未確認的段數。 */
  pending: number;
  /** 內容衝突的段（永久性問題，保留本機檔等使用者處理）。 */
  conflictSeqs: number[];
  /** 其中「同 seq 但伺服端已是別的內容」的段（不覆蓋，本機檔保留）。 */
  contentMismatchSeqs: number[];
  /** 伺服端帳本說的「下一個還缺的 seq」；null = 這輪讀不到帳本（不可推測）。 */
  expectedNextSeq: number | null;
  /** 補不回來的缺段（伺服端已跳過、本機也沒有檔案）；AC-4 不得無聲跳過。 */
  gapSeqs: number[];
  /** 下次可重試時間（毫秒）；null = 沒有待重試的段。 */
  retryAtMs: number | null;
}

export interface ChunkUploaderDeps {
  store: ChunkBlobStore;
  api: ChunkUploadApi;
  queue?: ChunkQueue;
  now?: () => number;
}

export class ChunkUploader {
  readonly #store: ChunkBlobStore;
  readonly #api: ChunkUploadApi;
  readonly #queue: ChunkQueue;
  readonly #now: () => number;
  /** 內容衝突的段：同一段內容再送一百次還是 409，所以不要一直重試。 */
  readonly #conflicts = new Set<number>();
  /** 其中屬於「同 seq 不同內容」（伺服端已落地別的版本）的段。 */
  readonly #mismatches = new Set<number>();

  constructor(deps: ChunkUploaderDeps) {
    this.#store = deps.store;
    this.#api = deps.api;
    this.#queue = deps.queue ?? new ChunkQueue();
    this.#now = deps.now ?? (() => Date.now());
  }

  /** 落盤（**先於**任何上傳；這是 AC-1「沒確認前不得刪除」的前提）。 */
  async save(chunk: ChunkBlobRecord): Promise<void> {
    await this.#store.put(chunk);
    this.#queue.enqueue({
      meetingId: chunk.meetingId,
      seq: chunk.seq,
      hash: chunk.hash,
      bytes: chunk.blob.size,
    });
    // 同一個 seq 重新落盤＝有新的內容，先前的衝突判定作廢。
    this.#conflicts.delete(chunk.seq);
    this.#mismatches.delete(chunk.seq);
  }

  /** 把某場會議還沒確認的分段送出去（依 seq 升序，一段失敗就停下來退避）。 */
  async flush(meetingId: string): Promise<UploadOutcome> {
    const now = this.#now();
    const stored = await this.#store.list(meetingId);
    const bySeq = new Map(stored.map((item) => [item.seq, item]));
    for (const item of stored) {
      this.#queue.enqueue({
        meetingId: item.meetingId,
        seq: item.seq,
        hash: item.hash,
        bytes: item.blob.size,
      });
    }

    let ledger: ChunkLedgerSnapshot;
    try {
      ledger = await this.#api.ledger(meetingId);
    } catch {
      // 讀不到權威帳本：不送、也不刪（回一個「稍後再試」的結果，讓畫面照實說）。
      return {
        sent: 0,
        duplicates: 0,
        pending: this.#queue.pending().length,
        conflictSeqs: this.conflictSeqs(),
        contentMismatchSeqs: this.contentMismatchSeqs(),
        expectedNextSeq: null,
        gapSeqs: [],
        retryAtMs: now + backoffMs(1),
      };
    }
    const acked = ledger.acked;

    // 同 seq 但**內容不同**（Gate 4 F4，設計 §6「不得覆蓋；保留本機檔」）：
    // 伺服端那份已經和已落地的逐字稿綁在一起，本機這份既不能覆蓋也不能刪——刪了才是真的丟音。
    // 這類段標成衝突（永久性，等人處理），不計入 ack，也不從本機刪。
    if (ledger.hashes !== undefined) {
      for (const seq of acked) {
        const local = bySeq.get(seq);
        const serverHash = ledger.hashes[seq];
        if (local === undefined || serverHash === undefined) continue;
        if (serverHash === local.hash) continue;
        this.#conflicts.add(seq);
        this.#mismatches.add(seq);
        this.#queue.block(seq);
      }
    }

    // 伺服端已收下的段：本機檔案可以刪（冪等帳本才是權威）。內容不符的除外。
    const resolvable = acked.filter((seq) => !this.#mismatches.has(seq));
    this.#queue.reconcile(resolvable);
    for (const seq of resolvable) {
      if (bySeq.has(seq)) await this.#store.remove(meetingId, seq);
    }

    // AC-4「無缺段」的偵測點：伺服端已經跳過、而本機也沒有檔案的洞＝補不回來，必須回報。
    const gapSeqs = timelineGaps(acked, stored.map((item) => item.seq));

    let sent = 0;
    let duplicates = 0;
    const conflictSeqs: number[] = [];
    let retryAtMs: number | null = null;

    while (true) {
      const next = this.#queue.nextDue(now);
      if (next === undefined) break;
      if (this.#conflicts.has(next.seq)) {
        // 已判定衝突：跳過但仍留在本機（不回報成 sent）。
        if (!conflictSeqs.includes(next.seq)) conflictSeqs.push(next.seq);
        // 把它移出待送清單：否則它會永遠占住「最小 seq」的位置，後面的段全送不出去（Gate 4 F7）。
        this.#queue.block(next.seq);
        continue;
      }
      const item = bySeq.get(next.seq);
      if (item === undefined) {
        // 帳本裡有、本機沒有：代表本機檔案已經被外部刪掉，無聲跳過會造成缺段，所以留紀錄。
        this.#conflicts.add(next.seq);
        this.#queue.block(next.seq);
        conflictSeqs.push(next.seq);
        continue;
      }
      try {
        const result = await this.#api.upload(meetingId, item);
        this.#queue.ack(next.seq);
        await this.#store.remove(meetingId, next.seq);
        bySeq.delete(next.seq);
        if (result === "duplicate") duplicates += 1;
        else sent += 1;
      } catch (error) {
        const code = error instanceof ChunkApiError ? error.code : "SERVER";
        if (code === "SEQ_CONFLICT") {
          this.#conflicts.add(next.seq);
          this.#queue.block(next.seq);
          conflictSeqs.push(next.seq);
          continue;
        }
        this.#queue.fail(next.seq, now);
        retryAtMs = now + backoffMs(this.#queue.pending().find((p) => p.seq === next.seq)?.attempts ?? 1);
        break;
      }
    }

    // 已知衝突的段不管這輪有沒有走到，都要照實回報（否則畫面會以為它「還在排隊」）。
    const allConflicts = [...new Set([...conflictSeqs, ...this.#conflicts])].sort((a, b) => a - b);
    return {
      sent,
      duplicates,
      pending: this.#queue.pending().filter((item) => !this.#conflicts.has(item.seq)).length,
      conflictSeqs: allConflicts,
      contentMismatchSeqs: this.contentMismatchSeqs(),
      expectedNextSeq: ledger.expectedNextSeq,
      gapSeqs,
      retryAtMs,
    };
  }

  /**
   * 還有哪些會議留著未確認的分段（恢復流程的輸入）。
   *
   * Gate 4 F8 註記：目前只有測試使用；正式流程走 `ChunkRecovery.scan()`（同樣以 store 為準，
   * 但另外回報每場會議的可恢復性 `durable`）。保留原因：`unfinished()` 是「本機還有沒有東西」
   * 的最單純表述，適合當回歸探針。
   */
  async unfinished(): Promise<Array<{ meetingId: string; pending: number }>> {
    const meetings = await this.#store.meetings();
    const result: Array<{ meetingId: string; pending: number }> = [];
    for (const meetingId of meetings) {
      const items = await this.#store.list(meetingId);
      if (items.length > 0) result.push({ meetingId, pending: items.length });
    }
    return result;
  }

  /** 使用者明確選擇丟棄（AC-3：只有明確指令才丟，不得自動丟棄）。 */
  async discard(meetingId: string): Promise<void> {
    for (const item of await this.#store.list(meetingId)) {
      await this.#store.remove(meetingId, item.seq);
    }
    this.#queue.drop(meetingId);
  }

  /** 目前已知的衝突段（畫面要講清楚，不可裝作沒事）。 */
  conflictSeqs(): number[] {
    return [...this.#conflicts].sort((a, b) => a - b);
  }

  /** 其中「同 seq 不同內容」的段（訊息要和「本機檔案不見」區分開來）。 */
  contentMismatchSeqs(): number[] {
    return [...this.#mismatches].sort((a, b) => a - b);
  }
}
