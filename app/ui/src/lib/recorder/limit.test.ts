import { describe, expect, it } from "vitest";

import {
  LIMIT_WARN_LEAD_MS,
  MEETING_MAX_MS,
  endsAtFromStart,
  formatClock,
  limitStatus,
  minutesUntilLimit,
} from "./limit";

/**
 * M01-US-101 上限數學（決策 D5）。
 *
 * 這支模組刻意是**純函式**：沒有時鐘、沒有 DOM、沒有伺服器。
 * 伺服端（DO 的 `ends_at`）是權威，裝置端只負責「拿 ends_at 跟現在時間比」與顯示，
 * 所以「誰的時鐘比較準」不會影響正確性 —— 只影響畫面。
 */
describe("M01-US-101 上限數學（決策 D5）", () => {
  const STARTED = 1_700_000_000_000;

  it("M01-Given 會議開始時間 When 算 ends_at Then 恰好 +2 小時（7_200_000ms）", () => {
    expect(MEETING_MAX_MS).toBe(7_200_000);
    expect(endsAtFromStart(STARTED)).toBe(STARTED + MEETING_MAX_MS);
  });

  it("M01-Given 剛開始錄音 When 看狀態 Then remaining=2:00:00、warn=false、reached=false", () => {
    const endsAt = endsAtFromStart(STARTED);
    expect(limitStatus(endsAt, STARTED)).toEqual({
      remainingMs: 7_200_000,
      warn: false,
      reached: false,
    });
  });

  it("M01-Given 距上限 5:00.001 When 看狀態 Then warn=false（門檻是「≤ 5 分鐘」不是「< 6 分鐘」）", () => {
    const endsAt = endsAtFromStart(STARTED);
    expect(limitStatus(endsAt, endsAt - LIMIT_WARN_LEAD_MS - 1).warn).toBe(false);
  });

  it("M01-Given 距上限剛好 5:00.000 When 看狀態 Then warn=true、reached=false（紅燈仍亮）", () => {
    const endsAt = endsAtFromStart(STARTED);
    const status = limitStatus(endsAt, endsAt - LIMIT_WARN_LEAD_MS);
    expect(status).toEqual({ remainingMs: 300_000, warn: true, reached: false });
  });

  it("M01-Given 距上限只剩 1ms When 看狀態 Then warn=true、reached=false（尚未到點不得提前結束）", () => {
    const endsAt = endsAtFromStart(STARTED);
    expect(limitStatus(endsAt, endsAt - 1)).toEqual({
      remainingMs: 1,
      warn: true,
      reached: false,
    });
  });

  it("M01-Given 剛好到 ends_at When 看狀態 Then reached=true、remaining=0、warn=false（到點即熄燈）", () => {
    const endsAt = endsAtFromStart(STARTED);
    expect(limitStatus(endsAt, endsAt)).toEqual({
      remainingMs: 0,
      warn: false,
      reached: true,
    });
  });

  it("M01-Given 裝置時鐘落後（now > ends_at）When 看狀態 Then remaining 不得為負、reached=true", () => {
    const endsAt = endsAtFromStart(STARTED);
    const status = limitStatus(endsAt, endsAt + 60_000);
    expect(status.remainingMs).toBe(0);
    expect(status.reached).toBe(true);
  });

  it("M01-Given 各種剩餘時間 When 換算分鐘 Then 無條件進位且不得為負（AC-5 文案需要整數 N）", () => {
    expect(minutesUntilLimit(300_000)).toBe(5);
    expect(minutesUntilLimit(300_001)).toBe(6);
    expect(minutesUntilLimit(1)).toBe(1);
    expect(minutesUntilLimit(0)).toBe(0);
    expect(minutesUntilLimit(-5)).toBe(0);
  });

  it("M01-Given 計時器毫秒 When 格式化 Then 未滿 1 小時為 MM:SS、滿 1 小時為 H:MM:SS（補零、不得跳動）", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(59_999)).toBe("00:59");
    expect(formatClock(60_000)).toBe("01:00");
    expect(formatClock(3_599_999)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(7_200_000)).toBe("2:00:00");
    expect(formatClock(-1)).toBe("00:00");
  });
});
