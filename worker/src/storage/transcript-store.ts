/**
 * M01-US-103：逐字稿帳本（DO SQLite，append-only）。
 *
 * 為什麼要有它：US-101/102 的 `POST /transcript` 只做「守門 + 計數」，
 * 而 US-102 的交付說明就寫著「逐字稿內容的落地由 M01-US-103 接上」。
 * 這個檔案就是那個「接上」——會議中講的每一句真的變成一列。
 *
 * 三個不變式：
 * 1. **append-only**：這個類別**沒有任何 update / delete 方法**。
 *    「不得改寫既有句子」（AC-3）不是靠自律，是靠型別上做不到。
 * 2. **同一把鑰匙只會有一列**（`idempotency_key` unique）→ 重送不產生重複句（AC-6）。
 * 3. **`seq` 單調遞增且不留洞**：被驗證擋下或判定衝突的請求**不燒 seq**。
 *
 * 兩條出口：
 *   - 同鍵、同內容 → `duplicate:true`（重送，不是錯誤）
 *   - 同鍵、不同內容 → `conflict:true`，**附上 existing 與 incoming 全文**（不得靜默丟棄，D8）
 */

export interface TranscriptSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[]; changes?: number };
}

/** 帳本裡的一列（時間戳為相對會議開始的毫秒）。 */
export interface TranscriptSegmentRecord {
  seq: number;
  idempotencyKey: string;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
  /** 與前一段重疊的毫秒（0 = 沒重疊）。AC-4 要留下來的紀錄。 */
  overlapMs: number;
  createdMs: number;
}

/** 呼叫端送進來的欄位（全部 `unknown`：這是網路邊界，必須驗證後才信任）。 */
export interface RecordSegmentInput extends Record<string, unknown> {
  /** 讀取 session 時算出的「允許的最大時間戳」（＝已過時間 + 容差）。 */
  maxMs: number;
  nowMs: number;
}

export type RecordSegmentOutcome =
  | { accepted: true; duplicate: false; segment: TranscriptSegmentRecord; count: number }
  | { accepted: false; duplicate: true; segment: TranscriptSegmentRecord; count: number }
  | {
      accepted: false;
      duplicate: false;
      conflict: true;
      existing: TranscriptSegmentRecord;
      incoming: TranscriptSegmentRecord;
      count: number;
    };

/** 欄位不合法（400）。訊息必須指出是哪個欄位，否則除錯只能通靈。 */
export class TranscriptInvalidError extends Error {
  readonly code = "TRANSCRIPT_INVALID";

  constructor(detail: string) {
    super(`TRANSCRIPT_INVALID: ${detail}`);
    this.name = "TranscriptInvalidError";
  }
}

/** 裝置時鐘與伺服端時間軸的允許漂移（與 US-107 缺口用同一個值，語意一致）。 */
export const TRANSCRIPT_SKEW_TOLERANCE_MS = 60 * 1000;

/** 單句長度上限：超過代表上游壞掉或有人在灌資料，不該讓它進帳本。 */
export const MAX_TEXT_CHARS = 2000;

/**
 * 講者編號上限。AC-1 說「2 至 4 人」，但**資料層不該讓第 5 個人消失**——
 * 所以只擋明顯壞掉的值（負數、非整數、> 63），不擋「比預期多的人」。
 */
export const MAX_SPEAKER_ID = 63;

/**
 * 一頁最多回幾列（TECH-013 D3）。預設就是這個值——**沒有「無上限」選項**：
 * 一個「可能回 1 MB 也可能不回」的預設值比有上限的預設值更難預期。
 * 截斷一定看得見（`hasMore` / `total`），所以它是分頁而不是丟資料。
 */
export const SEGMENT_PAGE_LIMIT_MAX = 500;

const CREATE_SEGMENTS = `CREATE TABLE IF NOT EXISTS transcript_segments (
  seq INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  speaker_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  overlap_ms INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
)`;

const CREATE_KEY_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS transcript_segments_key
  ON transcript_segments (idempotency_key)`;

/** seq 在 SQL 裡配發：`MAX(seq)+1` 與 INSERT 同一個 statement，不會有兩次寫入搶到同一個號。 */
const INSERT_SEGMENT = `INSERT INTO transcript_segments
  (seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms)
  VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_segments), ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_COUNT = `SELECT COUNT(*) AS count FROM transcript_segments`;

const SELECT_ALL = `SELECT seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms
  FROM transcript_segments ORDER BY seq ASC`;

const SELECT_PAGE = `SELECT seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms
  FROM transcript_segments ORDER BY seq ASC LIMIT ?`;

const SELECT_PAGE_SINCE = `SELECT seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms
  FROM transcript_segments WHERE seq > ? ORDER BY seq ASC LIMIT ?`;

const SELECT_BY_KEY = `SELECT seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms
  FROM transcript_segments WHERE idempotency_key = ?`;

const SELECT_BY_SEQ = `SELECT seq, idempotency_key, speaker_id, text, start_ms, end_ms, overlap_ms, created_ms
  FROM transcript_segments WHERE seq = ?`;

/**
 * 時間軸上「這一段之前最近的那一段」的結束時間。
 * 用**資料庫裡的事實**而不是串流裡的記憶體指標，是為了讓 `overlap_ms` 可重播：
 * 重播同一份事件串流時，第一段的「前一段」仍然是「沒有前一段」，不會突然變成上一輪的結尾。
 */
const SELECT_PREVIOUS_END = `SELECT end_ms FROM transcript_segments
  WHERE start_ms < ? ORDER BY start_ms DESC LIMIT 1`;

export class TranscriptLedger {
  readonly #sql: TranscriptSql;
  #ready = false;

  constructor(sql: TranscriptSql) {
    this.#sql = sql;
  }

  list(): TranscriptSegmentRecord[] {
    this.#ensure();
    return this.#sql.exec(SELECT_ALL).toArray().map(toSegment);
  }

  /**
   * 一頁逐字稿（TECH-013 D1 / D2）。
   *
   * - `since` 是**排他**下界（`seq > since`）；`null` ＝ 不設下界（從第一列）。
   *   排他是因為呼叫端的語意是「我已經有 N 了」——做成包含式，每個消費端都得自己 +1。
   * - 固定多抓一列（`limit + 1`）判斷還有沒有下一頁：一次查詢同時得到「本頁」與 `hasMore`，
   *   不必再掃一次 `COUNT(*) WHERE seq > ?`。
   */
  listPage(since: number | null, limit: number): { rows: TranscriptSegmentRecord[]; hasMore: boolean } {
    this.#ensure();
    const probe = limit + 1;
    const raw =
      since === null
        ? this.#sql.exec(SELECT_PAGE, probe).toArray()
        : this.#sql.exec(SELECT_PAGE_SINCE, since, probe).toArray();
    const rows = raw.map(toSegment);
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /**
   * 列數。用 `COUNT(*)` 而不是 `list().length`：寫入路徑每次都問一次，
   * 整表掃描會讓「寫 N 段」變成 O(N²) 的物件轉換。
   */
  count(): number {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_COUNT).toArray();
    return row === undefined ? 0 : Number((row as Record<string, unknown>).count);
  }

  /**
   * 時間軸上「起點在 `startMs` 之前、且最接近」的那一段的結束時間（沒有則 `null`）。
   * 這是 `overlap_ms` 的唯一來源（見 `transcript-stream.ts`）。
   */
  previousEndMs(startMs: number): number | null {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_PREVIOUS_END, startMs).toArray();
    if (row === undefined) return null;
    const endMs = Number((row as Record<string, unknown>).end_ms);
    return Number.isFinite(endMs) ? endMs : null;
  }

  /** 這把鑰匙落地了嗎？（給上層做「重送」的快速判斷用） */
  find(idempotencyKey: string): TranscriptSegmentRecord | null {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_BY_KEY, idempotencyKey).toArray();
    return row === undefined ? null : toSegment(row);
  }

  /**
   * 追加一列（或誠實回報「這把鑰匙已經有別的內容」）。
   *
   * 驗證順序刻意是「先驗證 → 再看鑰匙 → 才 INSERT」：
   * 壞內容不該燒掉 seq，也不該把已經落地的句子蓋掉。
   */
  record(input: RecordSegmentInput): RecordSegmentOutcome {
    this.#ensure();
    const incoming = validateSegment(input);

    const existing = this.find(incoming.idempotencyKey);
    if (existing !== null) {
      if (sameContent(existing, incoming)) {
        return { accepted: false, duplicate: true, segment: existing, count: this.count() };
      }
      // 同一把鑰匙、不同內容：**不覆寫**（AC-3），也不靜默（D8）——
      // 把兩份全文一起回給上層，讓「晚到的版本」有機會被人看到。
      return {
        accepted: false,
        duplicate: false,
        conflict: true,
        existing,
        incoming: { ...incoming, seq: existing.seq, createdMs: input.nowMs },
        count: this.count(),
      };
    }

    this.#sql.exec(
      INSERT_SEGMENT,
      incoming.idempotencyKey,
      incoming.speakerId,
      incoming.text,
      incoming.startMs,
      incoming.endMs,
      incoming.overlapMs,
      input.nowMs,
    );
    const stored = this.find(incoming.idempotencyKey);
    if (stored === null) {
      // INSERT 之後一定讀得到；讀不到代表 storage 行為不符預期（不吞、明講）。
      throw new TranscriptInvalidError(`key=${incoming.idempotencyKey} 寫入後讀不回，storage 行為不符預期`);
    }
    return { accepted: true, duplicate: false, segment: stored, count: this.count() };
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_SEGMENTS);
    this.#sql.exec(CREATE_KEY_INDEX);
    this.#ready = true;
  }
}

/** 驗證並正規化欄位（`text` 去頭尾空白後不得為空）。 */
export function validateSegment(input: RecordSegmentInput): Omit<TranscriptSegmentRecord, "seq" | "createdMs"> {
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "" || idempotencyKey.length > 128) {
    throw new TranscriptInvalidError(`idempotencyKey=${JSON.stringify(idempotencyKey)}`);
  }
  const speakerId = input.speakerId;
  if (
    typeof speakerId !== "number" ||
    !Number.isInteger(speakerId) ||
    speakerId < 0 ||
    speakerId > MAX_SPEAKER_ID
  ) {
    throw new TranscriptInvalidError(`speakerId=${JSON.stringify(speakerId)}（必須是 0~${MAX_SPEAKER_ID} 的整數）`);
  }
  const text = typeof input.text === "string" ? input.text.trim() : null;
  if (text === null || text === "") {
    throw new TranscriptInvalidError(`text=${JSON.stringify(input.text)}（不得為空）`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new TranscriptInvalidError(`text 長度 ${text.length} 超過上限 ${MAX_TEXT_CHARS}`);
  }
  const startMs = asMillis(input.startMs, "startMs");
  const endMs = asMillis(input.endMs, "endMs");
  if (endMs < startMs) {
    throw new TranscriptInvalidError(`endMs=${endMs} 必須 ≥ startMs=${startMs}`);
  }
  if (startMs > input.maxMs) {
    throw new TranscriptInvalidError(`startMs=${startMs} 超過已過時間上限 ${input.maxMs}（逐字稿不可以落在未來）`);
  }
  if (endMs > input.maxMs) {
    throw new TranscriptInvalidError(`endMs=${endMs} 超過已過時間上限 ${input.maxMs}（結束時間不可以在未來）`);
  }
  const overlapMs = input.overlapMs === undefined ? 0 : asMillis(input.overlapMs, "overlapMs");
  if (overlapMs > endMs - startMs) {
    throw new TranscriptInvalidError(`overlapMs=${overlapMs} 超過本段長度 ${endMs - startMs}`);
  }
  return { idempotencyKey, speakerId, text, startMs, endMs, overlapMs };
}

function asMillis(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TranscriptInvalidError(`${field}=${JSON.stringify(value)}（必須是非負整數毫秒）`);
  }
  return value;
}

function sameContent(
  stored: TranscriptSegmentRecord,
  incoming: Omit<TranscriptSegmentRecord, "seq" | "createdMs">,
): boolean {
  return (
    stored.speakerId === incoming.speakerId &&
    stored.text === incoming.text &&
    stored.startMs === incoming.startMs &&
    stored.endMs === incoming.endMs &&
    stored.overlapMs === incoming.overlapMs
  );
}

function toSegment(row: unknown): TranscriptSegmentRecord {
  const record = row as Record<string, unknown>;
  return {
    seq: Number(record.seq),
    idempotencyKey: String(record.idempotency_key),
    speakerId: Number(record.speaker_id),
    text: String(record.text),
    startMs: Number(record.start_ms),
    endMs: Number(record.end_ms),
    overlapMs: Number(record.overlap_ms),
    createdMs: Number(record.created_ms),
  };
}
