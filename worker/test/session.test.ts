import { describe, expect, it } from "vitest";

import {
  LIMIT_WARN_LEAD_MS,
  MEETING_MAX_MS,
  acceptsTranscriptWrites,
  alarmAtMs,
  expireSession,
  sessionStatus,
  startSession,
  stopSession,
} from "../src/session";

/**
 * M01-US-101 伺服端 session（會議時間軸的權威）。
 *
 * 為什麼權威在伺服端：裝置的時鐘可以調、可以慢、可以剛好沒電。
 * 「2 小時上限」若由裝置判定，使用者只要調時間就能無限錄。
 * 因此 `ends_at` 由 DO 在開始時寫定，之後**只信這個時間**。
 */
describe("M01-US-101 伺服端 session（ends_at 權威）", () => {
  const STARTED = 1_700_000_000_000;

  it("M01-Given 開始一場會議 When 建立 session Then ends_at = 開始 + 2 小時、狀態 recording", () => {
    const session = startSession("m-1", STARTED);
    expect(session.endsAtMs).toBe(STARTED + MEETING_MAX_MS);
    expect(session.state).toBe("recording");
    expect(session.endedAtMs).toBeNull();
    expect(session.endedReason).toBeNull();
  });

  it("M01-Given 剛開始 When 查狀態 Then phase=recording、remaining=2:00:00、warn=false", () => {
    const session = startSession("m-1", STARTED);
    expect(sessionStatus(session, STARTED)).toEqual({
      phase: "recording",
      remainingMs: 7_200_000,
      warn: false,
      reached: false,
    });
  });

  it("M01-Given 距上限 5 分鐘 When 查狀態 Then warn=true 且 phase 仍是 recording（權威尚未到點）", () => {
    const session = startSession("m-1", STARTED);
    const status = sessionStatus(session, session.endsAtMs - LIMIT_WARN_LEAD_MS);
    expect(status.warn).toBe(true);
    expect(status.phase).toBe("recording");
  });

  it("M01-Given 剛好到 ends_at When 查狀態 Then phase=limit_reached、remaining=0（即使 alarm 還沒醒）", () => {
    const session = startSession("m-1", STARTED);
    expect(sessionStatus(session, session.endsAtMs)).toEqual({
      phase: "limit_reached",
      remainingMs: 0,
      warn: false,
      reached: true,
    });
  });

  it("M01-Given DO 醒來時已超過 ends_at When 查狀態 Then 一樣是 limit_reached、remaining 不得為負", () => {
    const session = startSession("m-1", STARTED);
    const status = sessionStatus(session, session.endsAtMs + 3_600_000);
    expect(status.phase).toBe("limit_reached");
    expect(status.remainingMs).toBe(0);
  });

  it("M01-Given recording When 上限前寫逐字稿 Then 接受；到點後 Then 拒收（DoD：2:00 之後不得再寫入）", () => {
    const session = startSession("m-1", STARTED);
    expect(acceptsTranscriptWrites(session, session.endsAtMs - 1)).toBe(true);
    expect(acceptsTranscriptWrites(session, session.endsAtMs)).toBe(false);
    expect(acceptsTranscriptWrites(session, session.endsAtMs + 1)).toBe(false);
  });

  it("M01-Given 使用者提前結束 When 之後才收到逐字稿 Then 拒收（不得寫進已結束的會議）", () => {
    const session = stopSession(startSession("m-1", STARTED), STARTED + 60_000, "user");
    expect(acceptsTranscriptWrites(session, STARTED + 61_000)).toBe(false);
  });

  it("M01-Given 時間到 When expireSession Then 標記 ended/limit 且時間戳記為 ends_at（不是醒來的時間）", () => {
    const session = startSession("m-1", STARTED);
    const expired = expireSession(session, session.endsAtMs + 90_000);
    expect(expired.state).toBe("ended");
    expect(expired.endedReason).toBe("limit");
    expect(expired.endedAtMs).toBe(session.endsAtMs);
  });

  it("M01-Given 還沒到點 When expireSession Then 不得動任何欄位（含不得提前結束）", () => {
    const session = startSession("m-1", STARTED);
    expect(expireSession(session, session.endsAtMs - 1)).toEqual(session);
  });

  it("M01-Given 使用者已結束 When expireSession 被晚到的 alarm 呼叫 Then 不得把原因改成 limit、不得覆寫結束時間", () => {
    const stopped = stopSession(startSession("m-1", STARTED), STARTED + 60_000, "user");
    const again = expireSession(stopped, stopped.endsAtMs + 1);
    expect(again).toEqual(stopped);
    expect(again.endedReason).toBe("user");
    expect(again.endedAtMs).toBe(STARTED + 60_000);
  });

  it("M01-Given 重複呼叫 stopSession When 已結束 Then 冪等（不得覆寫第一次的結束時間與原因）", () => {
    const stopped = stopSession(startSession("m-1", STARTED), STARTED + 60_000, "user");
    expect(stopSession(stopped, STARTED + 120_000, "limit")).toEqual(stopped);
  });

  it("M01-Given recording When 問該排什麼 alarm Then 回 ends_at；已結束 Then 回 null（不排無用的 alarm）", () => {
    const session = startSession("m-1", STARTED);
    expect(alarmAtMs(session)).toBe(session.endsAtMs);
    expect(alarmAtMs(expireSession(session, session.endsAtMs))).toBeNull();
  });

  it("M01-Given 任何操作 When 檢查 ends_at Then 永遠等於開始 + 2 小時（上限不得被任何路徑改動）", () => {
    const started = startSession("m-1", STARTED);
    const stopped = stopSession(started, STARTED + 1, "user");
    const expired = expireSession(started, started.endsAtMs + 1);
    for (const session of [started, stopped, expired]) {
      expect(session.endsAtMs).toBe(session.startedAtMs + MEETING_MAX_MS);
    }
  });
});
