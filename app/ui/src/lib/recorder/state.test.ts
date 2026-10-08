import { describe, expect, it } from "vitest";

import {
  initialRecState,
  isRedLightOn,
  isTimerRunning,
  transition,
  type RecEvent,
  type RecState,
} from "./state";

/**
 * M01-US-101 錄音狀態機（DoD 指定：idle / recording / interrupted / limit_reached 要有單元測試）。
 *
 * 這支模組是**純函式**：`transition(state, event) → { state, effects, notice }`。
 * 沒有時鐘、沒有 DOM、沒有 MediaRecorder —— 所以「畫面與真實錄音狀態不同步」
 * （最糟的情況是假裝還在錄）可以在單元測試裡被釘死。
 */
describe("M01-US-101 錄音狀態機", () => {
  it("M01-Given 初始 When 取狀態 Then idle，且紅燈不亮、計時器不跑", () => {
    const state = initialRecState();
    expect(state).toBe("idle");
    expect(isRedLightOn(state)).toBe(false);
    expect(isTimerRunning(state)).toBe(false);
  });

  it("M01-Given idle When 點開始 Then 要求開 session 並取得麥克風（狀態仍 idle，等 mic 到位）", () => {
    expect(transition("idle", { type: "start_requested" })).toEqual({
      state: "idle",
      effects: ["request_session_start", "acquire_mic"],
    });
  });

  it("M01-Given idle（mic 已到位）When started Then recording，紅燈亮且計時器開始跑", () => {
    const result = transition("idle", { type: "started" });
    expect(result.state).toBe("recording");
    expect(result.effects).toEqual([]);
    expect(isRedLightOn(result.state)).toBe(true);
    expect(isTimerRunning(result.state)).toBe(true);
  });

  it("M01-Given idle When 權限被拒 Then 停在 idle、釋放麥克風、給 PERMISSION_DENIED 說明與設定入口（不得靜默失敗）", () => {
    const result = transition("idle", { type: "start_failed", reason: "permission_denied" });
    expect(result.state).toBe("idle");
    expect(result.effects).toEqual(["release_mic"]);
    expect(result.notice?.code).toBe("PERMISSION_DENIED");
    expect(result.notice?.settingsLink).toBe(true);
  });

  it("M01-Given idle When 3 秒內 mic 沒起來（timeout）Then 停在 idle 並明說失敗原因（AC-1 的 3 秒是承諾）", () => {
    const result = transition("idle", { type: "start_failed", reason: "timeout" });
    expect(result.state).toBe("idle");
    expect(result.notice?.code).toBe("START_TIMEOUT");
  });

  it("M01-Given idle When 裝置無法收音 Then 停在 idle 並給 DEVICE_UNAVAILABLE 說明", () => {
    const result = transition("idle", { type: "start_failed", reason: "device_unavailable" });
    expect(result.state).toBe("idle");
    expect(result.notice?.code).toBe("DEVICE_UNAVAILABLE");
  });

  it("M01-Given recording When 切到背景/鎖屏 Then interrupted，且要求凍結計時器＋標記逐字稿缺口（AC-4）", () => {
    const result = transition("recording", { type: "visibility_hidden" });
    expect(result.state).toBe("interrupted");
    expect(result.effects).toEqual(["freeze_timer", "mark_transcript_gap"]);
    expect(isRedLightOn(result.state)).toBe(false);
    expect(isTimerRunning(result.state)).toBe(false);
  });

  it("M01-Given interrupted When 又收到一次 hidden Then 不重複標記缺口、狀態不變（同段不得重複標記）", () => {
    const result = transition("interrupted", { type: "visibility_hidden" });
    expect(result.state).toBe("interrupted");
    expect(result.effects).toEqual([]);
  });

  it("M01-Given interrupted When 回到前景 Then 不得自動續錄（要詢問使用者，設計 §4.2）", () => {
    const result = transition("interrupted", { type: "visibility_visible" });
    expect(result.state).toBe("interrupted");
    expect(result.effects).toEqual([]);
  });

  it("M01-Given interrupted When 使用者確認續錄 Then recording，且不重置時間軸（時間軸由 store 以 startedAt 計算）", () => {
    const result = transition("interrupted", { type: "resume_requested" });
    expect(result.state).toBe("recording");
    expect(result.effects).toEqual(["acquire_mic"]);
    expect(isTimerRunning(result.state)).toBe(true);
  });

  it("M01-Given recording When 使用者結束會議 Then idle 並停止收音（不得刪資料：資料由 store/伺服端保留）", () => {
    const result = transition("recording", { type: "stop_requested" });
    expect(result.state).toBe("idle");
    expect(result.effects).toEqual(["release_mic"]);
  });

  it("M01-Given interrupted When 使用者結束會議 Then 一樣回到 idle 並停止收音", () => {
    expect(transition("interrupted", { type: "stop_requested" })).toEqual({
      state: "idle",
      effects: ["release_mic"],
    });
  });

  it("M01-Given recording When 伺服端說到 2 小時上限 Then limit_reached、熄燈、停收音、明說不再記錄（AC-6）", () => {
    const result = transition("recording", { type: "limit_timeout" });
    expect(result.state).toBe("limit_reached");
    expect(result.effects).toEqual(["release_mic", "freeze_timer"]);
    expect(result.notice?.code).toBe("LIMIT_REACHED");
    expect(isRedLightOn(result.state)).toBe(false);
    expect(isTimerRunning(result.state)).toBe(false);
  });

  it("M01-Given limit_reached When 使用者想續錄 Then 不得回到 recording（不得延長，AC-6）", () => {
    expect(transition("limit_reached", { type: "resume_requested" }).state).toBe("limit_reached");
    expect(transition("limit_reached", { type: "start_requested" }).state).toBe("limit_reached");
    expect(transition("limit_reached", { type: "visibility_visible" }).state).toBe("limit_reached");
  });

  it("M01-Given limit_reached When 使用者按「產生記錄 / 開新一場」結束本場 Then 回 idle 並釋放資源", () => {
    const result = transition("limit_reached", { type: "session_closed" });
    expect(result.state).toBe("idle");
    expect(result.effects).toEqual(["release_mic"]);
  });

  it("M01-Given idle When 收到與當下狀態無關的事件（例：visibility_hidden / stop_requested）Then 不得改變狀態", () => {
    expect(transition("idle", { type: "visibility_hidden" }).state).toBe("idle");
    expect(transition("idle", { type: "stop_requested" }).state).toBe("idle");
    expect(transition("idle", { type: "limit_timeout" }).state).toBe("idle");
  });

  it("M01-Given 任意狀態×任意事件 When 檢查輸出 Then 狀態必為四個合法值之一且 effects 不得有重複項", () => {
    const states: RecState[] = ["idle", "recording", "interrupted", "limit_reached"];
    const events: RecEvent[] = [
      { type: "start_requested" },
      { type: "started" },
      { type: "start_failed", reason: "permission_denied" },
      { type: "start_failed", reason: "device_unavailable" },
      { type: "start_failed", reason: "timeout" },
      { type: "visibility_hidden" },
      { type: "visibility_visible" },
      { type: "resume_requested" },
      { type: "stop_requested" },
      { type: "limit_timeout" },
      { type: "session_closed" },
    ];
    for (const state of states) {
      for (const event of events) {
        const result = transition(state, event);
        expect(states).toContain(result.state);
        expect(new Set(result.effects).size).toBe(result.effects.length);
      }
    }
  });
});
