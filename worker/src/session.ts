/**
 * M01-US-101 伺服端 session：會議時間軸的**權威**。
 *
 * 為什麼權威在伺服端：裝置的時鐘可以調、可以慢、可以剛好沒電。
 * 「2 小時上限」若由裝置判定，使用者只要改時間就能無限錄。
 * 因此 DO 在會議開始時把 `ends_at` 寫定，之後**只信這個時間**：
 * - 到點之後的逐字稿寫入一律拒收（DoD：探針要鎖「2:00 後不得再寫入」）；
 * - 裝置端只是「提早 5 分鐘顯示黃橫幅」，它算錯也不影響上限。
 *
 * 純函式、無 IO：DO 端（wiring）與測試共用同一份邏輯。
 */

/** 會議長度硬上限：2 小時。與前端 `app/ui/src/lib/recorder/limit.ts` 的常數必須一致。 */
export const MEETING_MAX_MS = 2 * 60 * 60 * 1000;

/** 距上限多久開始廣播 warn（AC-5：剩 ≤ 5 分鐘）。 */
export const LIMIT_WARN_LEAD_MS = 5 * 60 * 1000;

export type SessionState = "recording" | "ended";
/**
 * 結束原因：
 * - `user` 使用者主動結束；
 * - `limit` 到 2 小時上限（結束時間 = ends_at）；
 * - `aborted` 裝置端「開始」失敗（例：麥克風被拒）——伺服端 session 必須被收掉，
 *   否則它會掛在那裡直到 alarm 到點，之後被錯認為「這是一場錄到上限的會議」。
 */
export const SESSION_ENDED_REASONS = ["user", "limit", "aborted"] as const;

export type SessionEndedReason = (typeof SESSION_ENDED_REASONS)[number];

export interface MeetingSession {
  meetingId: string;
  startedAtMs: number;
  /** 權威上限時刻；任何路徑都不得改動（= startedAtMs + MEETING_MAX_MS）。 */
  endsAtMs: number;
  state: SessionState;
  endedAtMs: number | null;
  endedReason: SessionEndedReason | null;
}

/** 對外（裝置端）看到的三態；`limit_reached` 由**時間**決定，不依賴 alarm 是否醒過。 */
export type SessionPhase = "recording" | "ended" | "limit_reached";

export interface SessionStatus {
  phase: SessionPhase;
  remainingMs: number;
  warn: boolean;
  reached: boolean;
}

/** 開始一場會議：寫定權威時間軸。 */
export function startSession(meetingId: string, nowMs: number): MeetingSession {
  return {
    meetingId,
    startedAtMs: nowMs,
    endsAtMs: nowMs + MEETING_MAX_MS,
    state: "recording",
    endedAtMs: null,
    endedReason: null,
  };
}

/**
 * 使用者主動結束（或伺服端因其他原因收尾）。
 * 冪等：已經結束過的 session 不會被覆寫（否則「使用者 10:00 結束」會被晚到的 alarm 改成「上限結束」）。
 */
export function stopSession(
  session: MeetingSession,
  nowMs: number,
  reason: SessionEndedReason,
): MeetingSession {
  if (session.state === "ended") return session;
  return { ...session, state: "ended", endedAtMs: nowMs, endedReason: reason };
}

/**
 * 到點收尾（alarm 或任何請求進來時呼叫）。
 * 結束時間戳記為 `ends_at` 而不是「alarm 醒來的時間」——後者可能是幾分鐘後，會讓結束時間說謊。
 */
export function expireSession(session: MeetingSession, nowMs: number): MeetingSession {
  if (session.state !== "recording") return session;
  if (nowMs < session.endsAtMs) return session;
  return {
    ...session,
    state: "ended",
    endedAtMs: session.endsAtMs,
    endedReason: "limit",
  };
}

export function sessionStatus(session: MeetingSession, nowMs: number): SessionStatus {
  const remainingMs = Math.max(0, session.endsAtMs - nowMs);
  const reached = remainingMs <= 0;
  const phase: SessionPhase = reached
    ? "limit_reached"
    : session.state === "ended"
      ? "ended"
      : "recording";
  return {
    phase,
    remainingMs,
    warn: phase === "recording" && remainingMs <= LIMIT_WARN_LEAD_MS,
    reached,
  };
}

/** 逐字稿寫入的唯一守門員（DoD：2:00 之後不得再寫入；會議結束後也不得寫入）。 */
export function acceptsTranscriptWrites(session: MeetingSession, nowMs: number): boolean {
  return session.state === "recording" && nowMs < session.endsAtMs;
}

/** 需要排 alarm 的時刻（recording 時 = `ends_at`；已結束就不排）。 */
export function alarmAtMs(session: MeetingSession): number | null {
  return session.state === "recording" ? session.endsAtMs : null;
}
