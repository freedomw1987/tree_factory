/**
 * M01-US-101：session 的持久化（DO SQLite）。
 *
 * 一個會議 = 一個 DO，所以這張表刻意只有一列（`id = 1`）：它描述「這個 DO 的那場會議」。
 *
 * 為什麼要落地而不是放記憶體：DO 隨時可能被平台回收。若時間軸只在記憶體，
 * 回收之後重開就變成「沒有這場會議」——使用者會看到錄音中的會議突然消失，
 * 或（更糟）上限歸零而可以無限錄。落地 + 驗證不變式才能保證「權威時間軸」真的權威。
 */

import {
  MEETING_MAX_MS,
  SESSION_ENDED_REASONS,
  sessionClockViolation,
  type MeetingSession,
  type SessionEndedReason,
} from "../session.js";

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

// CHECK 由 `SESSION_ENDED_REASONS` 推導，不手寫清單：新增一個結束原因時，
// SQL 層、型別層、讀取驗證層就不會有其中一層忘了改（P0：曾經漏了讀取層，
// 導致寫得進去、讀不出來）。
const REASONS_SQL = SESSION_ENDED_REASONS.map((reason) => `'${reason}'`).join(", ");

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS meeting_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  meeting_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('recording', 'ended')),
  ended_at_ms INTEGER,
  ended_reason TEXT CHECK (ended_reason IN (${REASONS_SQL}) OR ended_reason IS NULL),
  transcript_writes INTEGER NOT NULL DEFAULT 0
)`;

/** TECH-014（D4）：錨存獨立表，`id=1` 與 `meeting_session` 的單列哲學一致。 */
const CREATE_ANCHOR_TABLE = `CREATE TABLE IF NOT EXISTS session_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mac TEXT NOT NULL,
  version INTEGER NOT NULL
)`;

const SELECT_ANCHOR = `SELECT mac, version FROM session_anchor WHERE id = 1`;

/** UPSERT 進 session_anchor；用 INSERT OR REPLACE 確保冪等。 */
const UPSERT_ANCHOR = `INSERT OR REPLACE INTO session_anchor (id, mac, version) VALUES (1, ?, ?)`;

/** 刪除錨列（用於 AC-6 測試：模擬「刪掉錨列」攻擊）；常式不直接使用。 */
const DELETE_ANCHOR = `DELETE FROM session_anchor WHERE id = 1`;

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

  /**
   * TECH-008：`nowMs` **必填**。
   *
   * 為什麼不給預設值：可選參數的失敗模式是「新呼叫端忘記帶 → 時間合理性檢查靜默消失」，
   * 那正是這一票要防的錯。必填會變成 TypeScript 編譯錯誤，把「誰帶什麼時間」寫進型別。
   */
  read(nowMs: number): SessionSnapshot | null {
    // 必填只保證「有帶」，不保證「帶得對」：`NaN` / `±Infinity` 會讓下面兩個 `>` 比較
    // 全部是 false → 整套時間檢查被靜默關掉（Gate 4 oracle F2 實測）。這裡把它變成吵鬧的失敗。
    if (!Number.isFinite(nowMs)) {
      throw new SessionCorruptError(`讀取時間不是有限數：now=${nowMs}`);
    }
    this.#ensure();
    const [row] = this.#sql.exec(SELECT).toArray();
    if (row === undefined) return null;
    const snapshot = toSnapshot(row as Record<string, unknown>);
    // 驗證失敗**不寫回任何東西**（讀取是唯讀的；否則壞資料會被「修」成另一個壞樣子）。
    const violation = sessionClockViolation(snapshot.session, nowMs);
    if (violation !== null) throw new SessionCorruptError(violation);
    return snapshot;
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
    this.#sql.exec(CREATE_ANCHOR_TABLE);
    this.#ready = true;
  }

  /**
   * TECH-014（D4／D5）：讀取錨列。
   *
   * 沒列 → 回 `null`（**不等於合法**，AC-6：會議存在但錨不存在＝資料不合法），
   * 不由這裡丟 `SessionCorruptError`——決策權在更外層（DO 的同步閘門）。
   */
  readAnchor(): { mac: string; version: number } | null {
    this.#ensure();
    const [row] = this.#sql.exec(SELECT_ANCHOR).toArray();
    if (row === undefined) return null;
    const r = row as Record<string, unknown>;
    const mac = r.mac;
    const version = r.version;
    if (typeof mac !== "string" || typeof version !== "number") {
      throw new SessionCorruptError(`session_anchor 欄位型別錯：mac=${typeof mac}, version=${typeof version}`);
    }
    return { mac, version };
  }

  /** TECH-014（D4）：寫入／覆寫錨列。`write()` **不**呼叫這個，由 DO 在 `/session/start` 明確觸發（AC-4 任何一次合法 `write()` 都不需要重算 MAC）。 */
  writeAnchor(mac: string, version: number): void {
    this.#ensure();
    this.#sql.exec(UPSERT_ANCHOR, mac, version);
  }

  /**
   * 刪除錨列（**測試專用**）：讓 AC-6 測試可以模擬「刪掉錨列」的攻擊者行為。
   * 常式程式碼不呼叫這個方法。
   */
  deleteAnchorForTest(): void {
    this.#ensure();
    this.#sql.exec(DELETE_ANCHOR);
  }
}

function toSnapshot(row: Record<string, unknown>): SessionSnapshot {
  const state = row.state;
  const reason = row.ended_reason;
  if (state !== "recording" && state !== "ended") {
    throw new SessionCorruptError(`state=${JSON.stringify(state)}`);
  }
  if (reason !== null && reason !== undefined && !isEndedReason(reason)) {
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

function isEndedReason(value: unknown): value is SessionEndedReason {
  return (SESSION_ENDED_REASONS as readonly unknown[]).includes(value);
}

function requireSafeInteger(value: unknown, field: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num)) throw new SessionCorruptError(`${field}=${JSON.stringify(value)}`);
  return num;
}
