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

/**
 * TECH-008：讀 session 時允許的時鐘偏差。
 *
 * 為什麼需要容忍值：真實世界的「現在時間」會被 NTP 校正與平台抖動推來推去，
 * 而會議的開始時間是**寫死的**。若要求 `started_at_ms <= now` 嚴格成立，
 * 一次秒級的時鐘回調就會讓整場會議讀不出來。
 *
 * 60 秒的角色（Gate 4 oracle 校正後）：它只是**未來方向**的緩衝，**不是**「被擋掉的平移量」。
 * 被放行的平移量是 `elapsed + 60s` —— 詳見 `sessionClockViolation` 上方的 `違規 ⟺ Δ > elapsed + TOL`。
 * 數量級參考：與逐字稿的 `TRANSCRIPT_SKEW_TOLERANCE_MS` 同級、遠小於 `LIMIT_WARN_LEAD_MS`。
 */
export const SESSION_CLOCK_TOLERANCE_MS = 60_000;

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

/**
 * TECH-008：帶入「現在時間」的合理性檢查。
 *
 * 原本的讀取驗證只檢查 `ends_at_ms === started_at_ms + MEETING_MAX_MS` —— 那是**差值**，
 * 不是**位置**：把兩欄一起往後推 1 小時，差值照樣是 2 小時，於是「2 小時上限」被無聲延長
 * （推到未來更糟：`now < started_at_ms`，看起來還沒開始，寫入卻被放行）。
 *
 * **這一票真正擋下的東西（Gate 4 oracle 實測後校正，不要寫得比事實大）**：
 * 設 Δ = 兩欄一起平移的量、elapsed = `now - started_at`（平移前），則
 * `違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS`。
 * 也就是「把 `started_at` 推到『現在 + 60s』之後」才擋得住；**Δ ≤ elapsed + 60s 一律放行**，
 * 在會議尾端（elapsed≈2h）等於上限可以被再續一次。
 * 原因是這裡只驗**位置**（不得在未來），而 DB 內沒有任何不可被同步改寫的錨點。
 *
 * 為什麼仍然只有上界、不補下界：
 * - 「幾小時前開始、現在才讀」是合法情境（查歷史會議），不能被擋；
 * - 往過去的平移在 DB 裡與真實歷史長得一模一樣，訂下界只會誤擋而不會多擋；
 * - 真正的補法需要 DO 外的可信錨點 → 另立票，不在本票範圍。
 *
 * 兩條規則的先後：`ends_at_ms` 那條由第一條 + 差值不變式推得，實質守門是 `started_at_ms`，
 * 第二條是「未來放寬不變式」的保險（defense-in-depth，正式路徑不可達）。
 *
 * 回傳違規說明（給 `SessionCorruptError` 用）；一切正常則回 `null`。
 */
export function sessionClockViolation(session: MeetingSession, nowMs: number): string | null {
  if (session.startedAtMs > nowMs + SESSION_CLOCK_TOLERANCE_MS) {
    return `started_at_ms (${session.startedAtMs}) 在未來（now=${nowMs}，容忍 ${SESSION_CLOCK_TOLERANCE_MS}ms）`;
  }
  // 由上一條 + `ends_at_ms === started_at_ms + MEETING_MAX_MS` 推得，仍獨立寫下來：
  // 未來若有人調整檢查順序或放寬不變式，這一條必須自己站得住。
  if (session.endsAtMs > nowMs + MEETING_MAX_MS + SESSION_CLOCK_TOLERANCE_MS) {
    return `ends_at_ms (${session.endsAtMs}) 超過「現在 + 上限」（now=${nowMs}，上限 ${MEETING_MAX_MS}ms，容忍 ${SESSION_CLOCK_TOLERANCE_MS}ms）`;
  }
  return null;
}

/** 逐字稿寫入的唯一守門員（DoD：2:00 之後不得再寫入；會議結束後也不得寫入）。 */
export function acceptsTranscriptWrites(session: MeetingSession, nowMs: number): boolean {
  return session.state === "recording" && nowMs < session.endsAtMs;
}

/** 需要排 alarm 的時刻（recording 時 = `ends_at`；已結束就不排）。 */
export function alarmAtMs(session: MeetingSession): number | null {
  return session.state === "recording" ? session.endsAtMs : null;
}
