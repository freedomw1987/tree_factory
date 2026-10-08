/**
 * M01-US-102：音訊分段帳本 + 逐字稿去重帳本（DO SQLite）。
 *
 * 為什麼要有「帳本」而不是只看記憶體：DO 會被平台回收，而冪等是**跨回收**的保證——
 * 裝置斷網重連時可能已經換了一個 DO instance，若 ledger 只在記憶體，重送就會變成
 * 第二列、第二句（正是 AC-2 / AC-4 要防的事）。
 *
 * 冪等的實作是原子的：`INSERT OR IGNORE` + 事後讀回（PK = seq）。
 * 刻意**不用**「先讀再寫」當判斷依據：那種寫法在並行重送下會雙寫；
 * 這裡的讀只用在「回報 duplicate 旗標」與「偵測同 seq 不同內容（409）」。
 *
 * 同 seq 不同 contentHash → `ChunkConflictError`（409），**不覆蓋**：
 * 覆蓋會讓已落地的逐字稿與音檔對不上（設計 §2 D2）。
 */

export interface ChunkCursorLike {
  toArray(): unknown[];
  /** 影響列數（workerd 的 `rowsWritten`；node:sqlite 替身給 `changes`）。 */
  changes?: number;
}

export interface ChunkSql {
  exec(sql: string, ...bindings: unknown[]): ChunkCursorLike;
}

export interface AudioChunkRecord {
  seq: number;
  byteLen: number;
  /** 內容指紋（SHA-256 前 16 hex）：同 seq 不同指紋 = 衝突。 */
  hash: string;
}

export interface RecordChunkInput {
  seq: number;
  byteLen: number;
  contentHash: string;
  nowMs: number;
}

export interface RecordChunkResult {
  accepted: true;
  duplicate: boolean;
  seq: number;
  count: number;
  lastSeq: number;
  expectedNextSeq: number;
}

export class ChunkConflictError extends Error {
  readonly code = "SEQ_CONFLICT";

  constructor(seq: number) {
    super(`SEQ_CONFLICT: seq=${seq} 已有不同內容的分段（不覆蓋，請檢查裝置端資料）`);
    this.name = "ChunkConflictError";
  }
}

export class ChunkInvalidError extends Error {
  readonly code = "SEQ_INVALID";

  constructor(detail: string) {
    super(`SEQ_INVALID: ${detail}`);
    this.name = "ChunkInvalidError";
  }
}

const CREATE_AUDIO = `CREATE TABLE IF NOT EXISTS audio_chunks (
  seq INTEGER PRIMARY KEY,
  byte_len INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
)`;

const INSERT_IGNORE = `INSERT OR IGNORE INTO audio_chunks (seq, byte_len, content_hash, received_at_ms)
  VALUES (?, ?, ?, ?)`;

const SELECT_ONE = `SELECT seq, byte_len, content_hash FROM audio_chunks WHERE seq = ?`;
const SELECT_ALL = `SELECT seq, byte_len, content_hash FROM audio_chunks ORDER BY seq ASC`;
const SELECT_COUNT = `SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS last_seq FROM audio_chunks`;

const CREATE_TRANSCRIPT = `CREATE TABLE IF NOT EXISTS transcript_chunks (
  seq INTEGER PRIMARY KEY,
  first_accepted_at_ms INTEGER NOT NULL
)`;

const CLAIM_TRANSCRIPT = `INSERT OR IGNORE INTO transcript_chunks (seq, first_accepted_at_ms) VALUES (?, ?)`;
const SELECT_TRANSCRIPT = `SELECT seq FROM transcript_chunks ORDER BY seq ASC`;

/** 音檔分段保留天數（設計 §2 D7／§7：自會議結束起算；刪會議則立即刪）。清理排程掛 M02-US-204。 */
export const AUDIO_RETENTION_DAYS = 7;

/** 音訊分段帳本。 */
export class AudioChunkStore {
  readonly #sql: ChunkSql;
  #ready = false;

  constructor(sql: ChunkSql) {
    this.#sql = sql;
  }

  list(): AudioChunkRecord[] {
    this.#ensure();
    return this.#sql.exec(SELECT_ALL).toArray().map(toRecord);
  }

  count(): number {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_COUNT).toArray();
    return Number((row as { count?: unknown } | undefined)?.count ?? 0);
  }

  lastSeq(): number {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_COUNT).toArray();
    return Number((row as { last_seq?: unknown } | undefined)?.last_seq ?? 0);
  }

  has(seq: number): boolean {
    this.#ensure();
    return this.#sql.exec(SELECT_ONE, seq).toArray().length > 0;
  }

  /**
   * 最小未收到的 seq（從 1 起算）：裝置端用它在恢復時判斷「缺哪一段」。
   * 有洞（1,2,4）→ 3，不是 5——不可無聲跳過缺口。
   */
  expectedNextSeq(): number {
    const seqs = new Set(this.list().map((chunk) => chunk.seq));
    let expected = 1;
    while (seqs.has(expected)) expected += 1;
    return expected;
  }

  record(input: RecordChunkInput): RecordChunkResult {
    this.#ensure();
    const { seq, byteLen, contentHash, nowMs } = input;
    if (!Number.isSafeInteger(seq) || seq < 1) throw new ChunkInvalidError(`seq=${JSON.stringify(seq)}`);
    if (!Number.isSafeInteger(byteLen) || byteLen < 0) {
      throw new ChunkInvalidError(`byte_len=${JSON.stringify(byteLen)}`);
    }
    if (typeof contentHash !== "string" || contentHash.length === 0) {
      throw new ChunkInvalidError("content_hash 不可為空");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new ChunkInvalidError(`received_at_ms=${JSON.stringify(nowMs)}`);
    }

    const before = this.#row(seq);
    const cursor = this.#sql.exec(INSERT_IGNORE, seq, byteLen, contentHash, nowMs);
    const stored = this.#row(seq);
    if (stored === null) {
      // INSERT OR IGNORE 之後一定讀得到；讀不到代表這不是我們預期的 SQLite。
      throw new ChunkInvalidError(`seq=${seq} 寫入後讀不回，storage 行為不符預期`);
    }
    if (stored.hash !== contentHash) throw new ChunkConflictError(seq);

    const wrote = cursor.changes ?? (before === null ? 1 : 0);
    return {
      accepted: true,
      duplicate: wrote === 0,
      seq,
      count: this.count(),
      lastSeq: this.lastSeq(),
      expectedNextSeq: this.expectedNextSeq(),
    };
  }

  #row(seq: number): AudioChunkRecord | null {
    const [row] = this.#sql.exec(SELECT_ONE, seq).toArray();
    return row === undefined ? null : toRecord(row);
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_AUDIO);
    this.#ready = true;
  }
}

/**
 * 逐字稿去重帳本（AC-4「無重複句」）。
 *
 * 沒帶 `chunkSeq` 一律回 true（＝不做去重，維持舊行為）：只有呼叫端明確說「這是第 k 段」
 * 時，我們才有資格判斷重複。硬要對沒帶 seq 的請求去重，會把「同一段講兩次」誤判成重送。
 */
export class TranscriptChunkLedger {
  readonly #sql: ChunkSql;
  #ready = false;

  constructor(sql: ChunkSql) {
    this.#sql = sql;
  }

  /** true = 第一次看到這個 seq（可以寫入）；false = 重送（不得產生第二句）。 */
  claim(seq: number | undefined | null, nowMs: number): boolean {
    if (seq === undefined || seq === null) return true;
    if (!Number.isSafeInteger(seq) || seq < 1) throw new ChunkInvalidError(`chunkSeq=${JSON.stringify(seq)}`);
    this.#ensure();
    // 沒有 `changes` 可讀的 storage：用「寫入前是否已存在」退化判斷（唯一性仍由 PRIMARY KEY 保證）。
    const existedBefore = this.#sql.exec(SELECT_TRANSCRIPT).toArray().some(
      (item) => Number((item as { seq: unknown }).seq) === seq,
    );
    const cursor = this.#sql.exec(CLAIM_TRANSCRIPT, seq, nowMs);
    return cursor.changes !== undefined ? cursor.changes > 0 : !existedBefore;
  }

  has(seq: number): boolean {
    this.#ensure();
    return this.#sql.exec(SELECT_TRANSCRIPT).toArray().some((item) => Number((item as { seq: unknown }).seq) === seq);
  }

  list(): number[] {
    this.#ensure();
    return this.#sql.exec(SELECT_TRANSCRIPT).toArray().map((row) => Number((row as { seq: unknown }).seq));
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_TRANSCRIPT);
    this.#ready = true;
  }
}

function toRecord(row: unknown): AudioChunkRecord {
  const record = row as { seq: unknown; byte_len: unknown; content_hash: unknown };
  return {
    seq: Number(record.seq),
    byteLen: Number(record.byte_len),
    hash: String(record.content_hash),
  };
}
