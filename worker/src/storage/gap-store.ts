/**
 * M01-US-107：逐字稿缺口帳本（`TRANSCRIPT_GAP`，DO SQLite）。
 *
 * 為什麼缺口要進 DB 而不是記憶體：缺口是**逐字稿的一部分**，它的價值在於「事後看得到」。
 * 若只存在記憶體，DO 被平台回收後逐字稿就會變成「那段時間沒人說話」——正是這一票要消滅的誤讀。
 *
 * 兩個不變式：
 * 1. **同 seq 只會有一列**（PK）→ 重複 `hidden` 不會產生第二筆（AC-3）。
 * 2. **閉合只會延長、不會縮短** → 晚到的 close 不可把已經誠實記錄的缺口砍小。
 *
 * 同 seq 不同起點 → `GapConflictError`（409）：那是裝置端把序號重用了（例如被殺掉後從 1 重算），
 * 這時**沉默接受**會讓兩個不同的中斷變成同一筆，時間軸直接說謊。
 */

export interface GapSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[]; changes?: number };
}

export interface TranscriptGap {
  seq: number;
  /** 相對會議開始的毫秒。 */
  fromMs: number;
  /** `null` = 中斷還沒結束（UI 必須明說「結束時間未知」）。 */
  toMs: number | null;
}

export interface RecordGapInput {
  seq: unknown;
  fromMs: unknown;
  toMs?: unknown;
  /** 允許的最大 `fromMs`（＝已過時間 + 容差）；由 DO 依 session 權威時間算出來。 */
  maxMs: number;
  nowMs: number;
}

export interface RecordGapResult {
  accepted: true;
  /** true = 這一列本來就在（重送 / 只是補閉合），沒有新增列。 */
  duplicate: boolean;
  gap: TranscriptGap;
  count: number;
}

/** 缺口時間不合法（不可是未來的缺口、不可逆轉、seq 必須是正整數）。 */
export class GapInvalidError extends Error {
  readonly code = "GAP_INVALID";

  constructor(detail: string) {
    super(`GAP_INVALID: ${detail}`);
    this.name = "GapInvalidError";
  }
}

/** 同一個 seq 被拿去標記兩次不同的中斷（裝置端序號重用）。 */
export class GapConflictError extends Error {
  readonly code = "GAP_CONFLICT";

  constructor(seq: number) {
    super(`GAP_CONFLICT: seq=${seq} 已是另一段缺口（不覆蓋，請檢查裝置端序號是否重算）`);
    this.name = "GapConflictError";
  }
}

/**
 * 裝置時鐘與伺服端時間軸的允許漂移（design §2 D5）。
 * 不是「隨便都收」：超過這個值代表裝置端算出來的時間軸已經沒有參考價值，
 * 那種缺口寫進去比不寫更糟（會指到錯的位置）。
 */
export const GAP_SKEW_TOLERANCE_MS = 60 * 1000;

const CREATE_GAPS = `CREATE TABLE IF NOT EXISTS transcript_gaps (
  seq INTEGER PRIMARY KEY,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER,
  first_seen_at_ms INTEGER NOT NULL
)`;

const INSERT_GAP = `INSERT OR IGNORE INTO transcript_gaps (seq, from_ms, to_ms, first_seen_at_ms)
  VALUES (?, ?, ?, ?)`;

const UPDATE_CLOSE = `UPDATE transcript_gaps SET to_ms = ? WHERE seq = ?`;

const SELECT_ALL = `SELECT seq, from_ms, to_ms FROM transcript_gaps ORDER BY seq ASC`;
const SELECT_ONE = `SELECT seq, from_ms, to_ms FROM transcript_gaps WHERE seq = ?`;

export class TranscriptGapLog {
  readonly #sql: GapSql;
  #ready = false;

  constructor(sql: GapSql) {
    this.#sql = sql;
  }

  list(): TranscriptGap[] {
    this.#ensure();
    return this.#sql.exec(SELECT_ALL).toArray().map(toGap);
  }

  count(): number {
    return this.list().length;
  }

  record(input: RecordGapInput): RecordGapResult {
    this.#ensure();
    const { seq, fromMs, toMs, maxMs, nowMs } = input;
    const seqValue = asCount(seq, "seq", 1);
    const fromValue = asCount(fromMs, "fromMs", 0);
    if (fromValue > maxMs) {
      throw new GapInvalidError(`fromMs=${fromValue} 超過已過時間上限 ${maxMs}（缺口不可以落在未來）`);
    }
    const closing = toMs !== undefined && toMs !== null;
    let toValue: number | null = null;
    if (closing) {
      toValue = asCount(toMs, "toMs", 0);
      if (toValue < fromValue) throw new GapInvalidError(`toMs=${toValue} 必須 ≥ fromMs=${fromValue}`);
      if (toValue > maxMs) {
        throw new GapInvalidError(`toMs=${toValue} 超過已過時間上限 ${maxMs}（結束時間不可以在未來）`);
      }
    }

    const before = this.#row(seqValue);
    if (before !== null && before.fromMs !== fromValue) throw new GapConflictError(seqValue);

    let duplicate = before !== null;
    if (before === null) {
      const cursor = this.#sql.exec(INSERT_GAP, seqValue, fromValue, toValue, nowMs);
      const stored = this.#row(seqValue);
      if (stored === null) {
        // INSERT OR IGNORE 之後一定讀得到；讀不到代表 storage 行為不符預期。
        throw new GapInvalidError(`seq=${seqValue} 寫入後讀不回，storage 行為不符預期`);
      }
      duplicate = (cursor.changes ?? 1) === 0;
    } else if (toValue !== null) {
      // 只延長、不縮短（晚到的 close 不可以把誠實記錄下來的缺口砍小）。
      const nextTo = before.toMs === null ? toValue : Math.max(before.toMs, toValue);
      if (nextTo !== before.toMs) this.#sql.exec(UPDATE_CLOSE, nextTo, seqValue);
    }

    const gap = this.#row(seqValue);
    if (gap === null) throw new GapInvalidError(`seq=${seqValue} 不存在（內部錯誤）`);
    return { accepted: true, duplicate, gap, count: this.count() };
  }

  #row(seq: number): TranscriptGap | null {
    const [row] = this.#sql.exec(SELECT_ONE, seq).toArray();
    return row === undefined ? null : toGap(row);
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_GAPS);
    this.#ready = true;
  }
}

/** 取「非負整數」欄位；不是就丟 `GapInvalidError`（訊息要指出是哪個欄位）。 */
function asCount(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new GapInvalidError(`${field}=${JSON.stringify(value)}`);
  }
  return value;
}

function toGap(row: unknown): TranscriptGap {
  const record = row as { seq: unknown; from_ms: unknown; to_ms: unknown };
  return {
    seq: Number(record.seq),
    fromMs: Number(record.from_ms),
    toMs: record.to_ms === null || record.to_ms === undefined ? null : Number(record.to_ms),
  };
}
