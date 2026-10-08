/**
 * M01-US-101 上限數學（決策 D5：會議最長 2 小時）。
 *
 * 這裡**只有**「拿 ends_at 跟現在時間比」的計算，不含時鐘、不含 DOM。
 * `ends_at` 由伺服端（DO）在會議開始時寫定 —— 裝置端只負責顯示與提前提示，
 * 所以使用者的手機時間不準、或中途被改過，都不會讓 2 小時上限失守。
 */

/** 會議長度硬上限：2 小時。與伺服端 `worker/src/session.ts` 的常數必須一致。 */
export const MEETING_MAX_MS = 2 * 60 * 60 * 1000;

/** 距上限多久開始顯示黃橫幅（AC-5：剩 ≤ 5 分鐘）。 */
export const LIMIT_WARN_LEAD_MS = 5 * 60 * 1000;

export interface LimitStatus {
  /** 距上限的毫秒數，永不為負（到點後為 0）。 */
  remainingMs: number;
  /** 是否進入「剩 ≤ 5 分鐘」的黃橫幅區間（到點後為 false：已經不是「快到了」）。 */
  warn: boolean;
  /** 是否已達 / 超過上限。 */
  reached: boolean;
}

/** 由會議開始時間推算上限時刻（伺服端寫入 `ends_at` 用的同一條算式）。 */
export function endsAtFromStart(startedAtMs: number): number {
  return startedAtMs + MEETING_MAX_MS;
}

/** 依權威的 `ends_at` 與現在時間算出剩餘量與兩個旗標。 */
export function limitStatus(endsAtMs: number, nowMs: number): LimitStatus {
  const remainingMs = Math.max(0, endsAtMs - nowMs);
  const reached = remainingMs <= 0;
  return { remainingMs, warn: !reached && remainingMs <= LIMIT_WARN_LEAD_MS, reached };
}

/** 給文案用的整數分鐘數（無條件進位：剩 4:01 要說「剩 5 分鐘」而不是「剩 4 分鐘」）。 */
export function minutesUntilLimit(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 60_000));
}

/**
 * 計時器格式：未滿 1 小時為 `MM:SS`，滿 1 小時為 `H:MM:SS`。
 * 一律補零且用整秒（`floor`）——避免數字每秒抖動（DESIGN.md §2.2 要求 tabular-nums）。
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
