/**
 * M01-US-101 錄音狀態機（純函式）。
 *
 * 為什麼要獨立成純函式：這個產品最嚴重的失敗不是「crash」，而是**畫面與真實錄音狀態不同步**
 * （使用者以為還在錄，其實早就斷了）。把它寫成 `transition(state, event) → 新狀態 + 副作用 + 通知`，
 * 就能在單元測試裡把所有「假裝還在錄」的路徑釘死（DoD：idle / recording / interrupted / limit_reached 需有單元測試）。
 *
 * 四個狀態與畫面的對應（DESIGN.md §3.1／§4.2、決策 D5）：
 * - `idle`          未錄音（含「等麥克風到位」的 pending，pending 由 store 持有，見 store.ts）
 * - `recording`     錄音中：紅燈亮、計時器跑
 * - `interrupted`   因切背景/鎖屏而中斷：**紅燈必須熄滅**、計時器凍結、明說中斷時間
 * - `limit_reached` 已達 2 小時上限：紅燈熄滅、停止收音、明說「2:00 之後不記錄」（終態，不得回到 recording）
 */

export type RecState = "idle" | "recording" | "interrupted" | "limit_reached";

/** 狀態機要求外界做的事（由 store 執行；狀態機本身不碰任何資源）。 */
export type RecEffect =
  | "request_session_start"
  | "acquire_mic"
  | "release_mic"
  | "freeze_timer"
  | "mark_transcript_gap";

export type RecNoticeCode =
  | "PERMISSION_DENIED"
  | "DEVICE_UNAVAILABLE"
  | "START_TIMEOUT"
  | "LIMIT_REACHED";

/** 要給使用者看的說明。`settingsLink` = 需要提供「前往系統設定」入口（AC-3：不得靜默失敗）。 */
export interface RecNotice {
  code: RecNoticeCode;
  message: string;
  settingsLink?: boolean;
}

export type StartFailureReason = "permission_denied" | "device_unavailable" | "timeout";

export type RecEvent =
  | { type: "start_requested" }
  | { type: "started" }
  | { type: "start_failed"; reason: StartFailureReason }
  | { type: "visibility_hidden" }
  | { type: "visibility_visible" }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "limit_timeout" }
  | { type: "session_closed" };

export interface RecTransition {
  state: RecState;
  effects: RecEffect[];
  notice?: RecNotice;
}

const FAILURE_NOTICES: Record<StartFailureReason, RecNotice> = {
  permission_denied: {
    code: "PERMISSION_DENIED",
    message: "沒有麥克風權限，所以無法開始錄音。請到「設定」開啟麥克風權限後再試一次。",
    settingsLink: true,
  },
  device_unavailable: {
    code: "DEVICE_UNAVAILABLE",
    message: "目前抓不到麥克風（可能被其他 App 占用）。請關閉其他錄音 App 後再試一次。",
  },
  timeout: {
    code: "START_TIMEOUT",
    message: "麥克風 3 秒內沒有回應，這場會議沒有開始錄音。請再試一次。",
  },
};

const LIMIT_NOTICE: RecNotice = {
  code: "LIMIT_REACHED",
  message: "已達 2 小時上限，2:00 之後的內容不會被記錄。你可以在這裡產生記錄，或開新的一場。",
};

export function initialRecState(): RecState {
  return "idle";
}

/** 紅燈（唯一紅色，DESIGN.md §2.1）只在真的錄音中亮。 */
export function isRedLightOn(state: RecState): boolean {
  return state === "recording";
}

/** 計時器只在真的錄音中跑（中斷時必須凍結，否則就是「假裝還在錄」）。 */
export function isTimerRunning(state: RecState): boolean {
  return state === "recording";
}

/** 沒有變化的轉移：狀態不動、不做事（caller 仍可安全呼叫）。 */
function unchanged(state: RecState): RecTransition {
  return { state, effects: [] };
}

/**
 * 唯一的狀態轉移入口。未知組合一律「不動」——寧可什麼都不做，也不要進到沒有定義的狀態。
 */
export function transition(state: RecState, event: RecEvent): RecTransition {
  switch (event.type) {
    case "start_requested":
      // 只有 idle 能發起。等麥克風到位期間狀態仍是 idle（紅燈不亮），
      // 由 store 的 pending 旗標防止重複開麥克風。
      if (state !== "idle") return unchanged(state);
      return {
        state: "idle",
        effects: ["request_session_start", "acquire_mic"],
      };

    case "started":
      if (state !== "idle") return unchanged(state);
      return { state: "recording", effects: [] };

    case "start_failed":
      // 失敗一律留在 idle，而且一定要有說明（AC-3：不得靜默失敗）。
      if (state !== "idle") return unchanged(state);
      return { state: "idle", effects: ["release_mic"], notice: FAILURE_NOTICES[event.reason] };

    case "visibility_hidden":
      // 只有「真的在錄」才算中斷、才需要標缺口（同段不得重複標記）。
      if (state !== "recording") return unchanged(state);
      return {
        state: "interrupted",
        effects: ["freeze_timer", "mark_transcript_gap"],
      };

    case "visibility_visible":
      // 回到前景**不自動續錄**：設計 §4.2 要求詢問「繼續這場會議？」。
      return unchanged(state);

    case "resume_requested":
      if (state !== "interrupted") return unchanged(state);
      return { state: "recording", effects: ["acquire_mic"] };

    case "stop_requested":
      // 使用者主動結束：資料保留（由 store / 伺服端負責），這裡只負責停止收音。
      if (state === "recording" || state === "interrupted") {
        return { state: "idle", effects: ["release_mic"] };
      }
      return unchanged(state);

    case "limit_timeout":
      // 伺服端權威時間到：熄燈、停收音、凍結計時器，並明說不再記錄。
      if (state === "recording" || state === "interrupted") {
        return {
          state: "limit_reached",
          effects: ["release_mic", "freeze_timer"],
          notice: LIMIT_NOTICE,
        };
      }
      return unchanged(state);

    case "session_closed":
      // 使用者從上限畫面離開（產生記錄 / 開新一場）。
      if (state === "limit_reached") return { state: "idle", effects: ["release_mic"] };
      return unchanged(state);
  }
}
