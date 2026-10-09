/**
 * TECH-012：會議級聚段緩衝的持久層（`stream_buffer`，DO SQLite）。
 *
 * 為什麼要進 DB：`/transcript/stream` 的聚段緩衝本來活在 `TranscriptStream` 物件裡，
 * 而物件是**每個請求一份**（US-103 的 P0-1）。裝置端只要把事件拆成「每則一請求」，
 * 切在句子中間的那半句就會隨物件一起消失，而且**沒有任何錯誤回報**。
 * 把半句放進 DO SQLite 之後，同一個會議的下一個請求（甚至是換一個 DO instance）
 * 都接得回來——DO 記憶體做不到這件事（被平台回收就沒了）。
 *
 * 兩個反直覺但刻意的決定：
 * 1. **壞資料要「大聲壞掉」**：讀到壞掉的狀態丟 `StreamBufferCorruptError`（500），
 *    **不當成「沒有緩衝」**。當成空的等於默默把少字變成正常行為——那正是這一票要消滅的東西。
 * 2. **`drop()` 反過來要吞掉壞資料**：它的語意是「這段不會落地了，丟掉吧」，
 *    連壞掉的列都清不掉才是真的問題。
 */

import type { DiarizedWord } from "../segmentation.js";

/** 給 SQLite storage 的最小介面（與 `GapSql` / `TranscriptSql` 同型）。 */
export interface StreamBufferSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[]; changes?: number };
}

/** 持久化的聚段緩衝（`state` 欄的 JSON 形狀）。 */
export interface StreamBufferState {
  /** 音訊第一幀相對會議開始的毫秒；第一次寫定之後不得再變（見 TECH-012 D2）。 */
  meetingOffsetMs: number;
  /** 還沒完成的那一段的字（final 才進來；interim 不落地）。 */
  words: DiarizedWord[];
  /** `UtteranceEnd` 已經到了、但那句的 final 還沒到（訊號順序見 US-103 AC-7）。 */
  pendingUtteranceEnd: boolean;
}

/** 讀到的緩衝狀態不合法（欄位缺失、型別錯、時間軸顛倒、JSON 壞掉）。 */
export class StreamBufferCorruptError extends Error {
  readonly code = "STREAM_BUFFER_CORRUPT";

  constructor(detail: string) {
    super(`STREAM_BUFFER_CORRUPT: ${detail}`);
    this.name = "StreamBufferCorruptError";
  }
}

const CREATE_BUFFER = `CREATE TABLE IF NOT EXISTS stream_buffer (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
)`;

const SELECT_STATE = `SELECT state FROM stream_buffer WHERE session_id = ?`;
const UPSERT_STATE = `INSERT INTO stream_buffer (session_id, state, updated_ms) VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_ms = excluded.updated_ms`;
const DELETE_STATE = `DELETE FROM stream_buffer WHERE session_id = ?`;

export class StreamBufferStore {
  readonly #sql: StreamBufferSql;
  #ready = false;

  constructor(sql: StreamBufferSql) {
    this.#sql = sql;
  }

  /** 讀回緩衝；沒有這一場會議的緩衝時回 `null`（壞掉則丟 `StreamBufferCorruptError`）。 */
  read(sessionId: string): StreamBufferState | null {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_STATE, sessionId).toArray();
    if (row === undefined) return null;
    const raw = (row as { state: unknown }).state;
    if (typeof raw !== "string") {
      throw new StreamBufferCorruptError(`state 不是字串（${typeof raw}）`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StreamBufferCorruptError("state 不是合法 JSON");
    }
    return parseStreamBufferState(parsed);
  }

  /** 覆寫這一場會議的緩衝（一場會議一列）。 */
  write(sessionId: string, state: StreamBufferState, nowMs: number): void {
    this.#ensure();
    this.#sql.exec(UPSERT_STATE, sessionId, JSON.stringify(state), nowMs);
  }

  /**
   * 清掉整列（`drop()` 用它；對不存在的列是 no-op）。
   *
   * **`finalize` 不走這裡**：收尾只清「字」，`meetingOffsetMs` 的釘樁要留著——
   * 真 workerd 實測發現整列刪掉之後，重新連線的裝置端可以帶新的 offset 繼續寫，
   * 落地時間軸就會整個漂移（見 `meeting-do.ts` 收尾段）。
   */
  clear(sessionId: string): void {
    this.#ensure();
    this.#sql.exec(DELETE_STATE, sessionId);
  }

  /**
   * 丟掉緩衝並回報「幾個字沒有落地」。
   *
   * 用於「這場會議不再接受寫入」（已結束／到上限）——那半句確定不會進帳本了，
   * 但**不能默默消失**：呼叫端要在錯誤回應裡說出 `droppedBufferedWords`。
   * 壞掉的狀態也照樣清掉（回 0）：清不掉才是問題。
   */
  drop(sessionId: string): number {
    const state = this.#readOrNull(sessionId);
    this.clear(sessionId);
    return state === null ? 0 : state.words.length;
  }

  #readOrNull(sessionId: string): StreamBufferState | null {
    try {
      return this.read(sessionId);
    } catch (error) {
      if (error instanceof StreamBufferCorruptError) return null;
      throw error;
    }
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_BUFFER);
    this.#ready = true;
  }
}

/**
 * 嚴格驗證從 DB 讀回來的狀態。
 *
 * 為什麼比 `parseSegmentRow` 嚴：這裡的輸入是**自己寫進去的**，不合法代表 DB 被改過、
 * 或程式的寫入路徑壞了。寬鬆地收下只會把壞掉的時間軸餵進帳本（比 500 更糟）。
 */
export function parseStreamBufferState(value: unknown): StreamBufferState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamBufferCorruptError(`state 必須是物件（收到 ${JSON.stringify(value)}）`);
  }
  const record = value as Record<string, unknown>;
  const meetingOffsetMs = record.meetingOffsetMs;
  if (typeof meetingOffsetMs !== "number" || !Number.isSafeInteger(meetingOffsetMs) || meetingOffsetMs < 0) {
    throw new StreamBufferCorruptError(`meetingOffsetMs=${JSON.stringify(meetingOffsetMs)} 不是非負整數`);
  }
  const rawWords = record.words;
  if (!Array.isArray(rawWords)) {
    throw new StreamBufferCorruptError(`words 必須是陣列（收到 ${JSON.stringify(rawWords)}）`);
  }
  const words = rawWords.map((word, index) => parseBufferedWord(word, index));
  const pendingUtteranceEnd = record.pendingUtteranceEnd;
  if (typeof pendingUtteranceEnd !== "boolean") {
    throw new StreamBufferCorruptError(
      `pendingUtteranceEnd=${JSON.stringify(pendingUtteranceEnd)} 不是布林`,
    );
  }
  // 未知欄位忽略（向前相容：之後若長出新欄位，舊版程式不該整場會議 500）。
  return { meetingOffsetMs, words, pendingUtteranceEnd };
}

function parseBufferedWord(value: unknown, index: number): DiarizedWord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamBufferCorruptError(`words[${index}] 必須是物件`);
  }
  const record = value as Record<string, unknown>;
  const speaker = record.speaker;
  if (typeof speaker !== "number" || !Number.isSafeInteger(speaker) || speaker < 0) {
    throw new StreamBufferCorruptError(`words[${index}].speaker=${JSON.stringify(speaker)} 不是非負整數`);
  }
  const start = asFinite(record.start, `words[${index}].start`);
  const end = asFinite(record.end, `words[${index}].end`);
  if (end < start) {
    throw new StreamBufferCorruptError(`words[${index}] end=${end} < start=${start}（時間軸顛倒）`);
  }
  if (typeof record.word !== "string") {
    throw new StreamBufferCorruptError(`words[${index}].word 不是字串`);
  }
  // `punctuated_word` 是選填：有給就必須是字串（顯示層會用它）。
  const punctuated = record.punctuated_word;
  if (punctuated !== undefined && typeof punctuated !== "string") {
    throw new StreamBufferCorruptError(`words[${index}].punctuated_word 不是字串`);
  }
  return punctuated === undefined
    ? { word: record.word, speaker, start, end }
    : { word: record.word, punctuated_word: punctuated, speaker, start, end };
}

function asFinite(value: unknown, field: string): number {
  // 秒為單位的浮點數（不取整：取整會讓 1.25 秒變 1 秒，字與字之間的間隙跟著失真）。
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StreamBufferCorruptError(`${field}=${JSON.stringify(value)} 不是有限數`);
  }
  return value;
}
