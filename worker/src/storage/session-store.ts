/**
 * M01-US-101：session 的持久化（DO SQLite）。
 *
 * 一個會議 = 一個 DO，所以這張表刻意只有一列（`id = 1`）：它描述「這個 DO 的那場會議」。
 *
 * 為什麼要落地而不是放記憶體：DO 隨時可能被平台回收。若時間軸只在記憶體，
 * 回收之後重開就變成「沒有這場會議」——使用者會看到錄音中的會議突然消失，
 * 或（更糟）上限歸零而可以無限錄。落地 + 驗證不變式才能保證「權威時間軸」真的權威。
 */

import { MEETING_MAX_MS, type MeetingSession, type SessionEndedReason } from "../session.js";

/** DO cursor 的最小形狀（與 do-sqlite.ts 保持同樣的鬆綁策略）。 */
export interface SessionCursorLike {
  toArray(): unknown[];
}

export interface SessionSql {
  exec(sql: string, ...bindings: unknown[]): SessionCursorLike;
}

export interface SessionSnapshot {
  session: MeetingSession;
  /** 已接受的逐字稿寫入次數（內容落地由 M01-US-103 接上）。 */
  transcriptWrites: number;
}

/** 讀到壞資料一律大聲失敗：默默當成 recording 繼續寫，就等於繞過 2 小時上限。 */
export class SessionCorruptError extends Error {
  readonly code = "SESSION_CORRUPT";

  constructor(detail: string) {
    super(`SESSION_CORRUPT: meeting_session 資料不合法（${detail}）`);
    this.name = "SessionCorruptError";
  }
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS meeting_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  meeting_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('recording', 'ended')),
  ended_at_ms INTEGER,
  ended_reason TEXT CHECK (ended_reason IN ('user', 'limit', 'aborted') OR ended_reason IS NULL),
  transcript_writes INTEGER NOT NULL DEFAULT 0
)`;

const UPSERT = `INSERT INTO meeting_session
  (id, meeting_id, started_at_ms, ends_at_ms, state, ended_at_ms, ended_reason, transcript_writes)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    meeting_id = excluded.meeting_id,
    started_at_ms = excluded.started_at_ms,
    ends_at_ms = excluded.ends_at_ms,
    state = excluded.state,
    ended_at_ms = excluded.ended_at_ms,
    ended_reason = excluded.ended_reason,
    transcript_writes = excluded.transcript_writes`;

const SELECT = `SELECT meeting_id, started_at_ms, ends_at_ms, state, ended_at_ms, ended_reason, transcript_writes
  FROM meeting_session WHERE id = 1`;

export class SessionStore {
  readonly #sql: SessionSql;
  #ready = false;

  constructor(sql: SessionSql) {
    this.#sql = sql;
  }

  read(): SessionSnapshot | null {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT).toArray();
    if (row === undefined) return null;
    return toSnapshot(row as Record<string, unknown>);
  }

  write(snapshot: SessionSnapshot): void {
    this.#ensure();
    const { session } = snapshot;
    if (session.endsAtMs !== session.startedAtMs + MEETING_MAX_MS) {
      // 不變式：上限不得被任何路徑改動（寫進來就先擋掉）。
      throw new SessionCorruptError(
        `ends_at_ms (${session.endsAtMs}) 不等於 started_at_ms + ${MEETING_MAX_MS}`,
      );
    }
    this.#sql.exec(
      UPSERT,
      session.meetingId,
      session.startedAtMs,
      session.endsAtMs,
      session.state,
      session.endedAtMs,
      session.endedReason,
      snapshot.transcriptWrites,
    );
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(CREATE_TABLE);
    this.#ready = true;
  }
}

function toSnapshot(row: Record<string, unknown>): SessionSnapshot {
  const state = row.state;
  const reason = row.ended_reason;
  if (state !== "recording" && state !== "ended") {
    throw new SessionCorruptError(`state=${JSON.stringify(state)}`);
  }
  if (reason !== null && reason !== undefined && reason !== "user" && reason !== "limit") {
    throw new SessionCorruptError(`ended_reason=${JSON.stringify(reason)}`);
  }
  const startedAtMs = requireSafeInteger(row.started_at_ms, "started_at_ms");
  const endsAtMs = requireSafeInteger(row.ends_at_ms, "ends_at_ms");
  if (endsAtMs !== startedAtMs + MEETING_MAX_MS) {
    throw new SessionCorruptError(`ends_at_ms (${endsAtMs}) 與 started_at_ms (${startedAtMs}) 不符`);
  }
  const endedAtRaw = row.ended_at_ms;
  return {
    session: {
      meetingId: String(row.meeting_id),
      startedAtMs,
      endsAtMs,
      state,
      endedAtMs:
        endedAtRaw === null || endedAtRaw === undefined
          ? null
          : requireSafeInteger(endedAtRaw, "ended_at_ms"),
      endedReason: (reason ?? null) as SessionEndedReason | null,
    },
    transcriptWrites: requireSafeInteger(row.transcript_writes ?? 0, "transcript_writes"),
  };
}

function requireSafeInteger(value: unknown, field: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num)) throw new SessionCorruptError(`${field}=${JSON.stringify(value)}`);
  return num;
}
