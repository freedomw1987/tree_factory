/**
 * M01-US-101 錄音 store：把「純狀態機」接到「真的麥克風」與「伺服端 session」。
 *
 * 分工：
 * - `state.ts` 決定狀態怎麼轉（純函式、可窮舉測試）。
 * - 這一層負責「轉了之後誰去做事」：開/關麥克風、開/關 session、計算計時、標記缺口。
 *
 * 依賴全部由建構子注入（時鐘、麥克風、session client）——所以這一層也能在 node 上單元測試，
 * 不需要瀏覽器、不需要真的麥克風。
 */

import { MEETING_MAX_MS, limitStatus } from "./limit";
import {
  initialRecState,
  transition,
  type RecEffect,
  type RecEvent,
  type RecNotice,
  type RecState,
  type StartFailureReason,
} from "./state";

export interface CaptureAdapter {
  /** 取得麥克風（會 resolve 代表真的開始收音了）。失敗時 throw。 */
  acquire(): Promise<void>;
  /** 放掉麥克風。 */
  release(): void | Promise<void>;
}

export interface SessionClient {
  /** 在伺服端開一場會議，回傳權威時間軸（`endsAtMs` 由伺服端決定）。 */
  start(): Promise<{ startedAtMs: number; endsAtMs: number }>;
  stop(reason: "user" | "limit" | "aborted"): Promise<void>;
}

export interface RecorderDeps {
  /** 單調時鐘（測試注入假時鐘；正式環境用 `Date.now`）。 */
  now(): number;
  capture: CaptureAdapter;
  session: SessionClient;
  /** AC-1 承諾「3 秒內進入錄音中」，所以 3 秒沒起來就要明說失敗。 */
  startTimeoutMs?: number;
}

export interface RecorderSnapshot {
  state: RecState;
  /** 正在等麥克風（已按開始、還沒真的錄）。 */
  pending: boolean;
  /** 已錄音時間（中斷時凍結）。 */
  elapsedMs: number;
  remainingMs: number;
  warn: boolean;
  notice?: RecNotice;
  /** 已標記的逐字稿缺口段數（US-107 會用它；同一次中斷只算一次）。 */
  gapMarked: number;
}

const DEFAULT_START_TIMEOUT_MS = 3_000;

function classifyFailure(error: unknown): StartFailureReason {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  return "device_unavailable";
}

export class RecorderStore {
  readonly #deps: Required<RecorderDeps>;
  #state: RecState = initialRecState();
  #pending = false;
  #notice: RecNotice | undefined;
  #startedAtMs: number | null = null;
  #endsAtMs: number | null = null;
  #frozenElapsedMs: number | null = null;
  #gapMarked = 0;
  /** 每次「開始嘗試」遞增；讓晚到的非同步結果知道自己已經過期。 */
  #attempt = 0;
  #acquireInFlight: Promise<void> | null = null;
  readonly #listeners = new Set<(snapshot: RecorderSnapshot) => void>();
  #lastEmitted = "";

  constructor(deps: RecorderDeps) {
    this.#deps = {
      ...deps,
      startTimeoutMs: deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    };
  }

  get snapshot(): RecorderSnapshot {
    const rawElapsed =
      this.#startedAtMs === null ? 0 : Math.max(0, this.#deps.now() - this.#startedAtMs);
    const elapsedMs =
      this.#state === "recording"
        ? Math.min(rawElapsed, MEETING_MAX_MS)
        : (this.#frozenElapsedMs ?? Math.min(rawElapsed, MEETING_MAX_MS));
    const endsAtMs = this.#endsAtMs ?? this.#deps.now() + MEETING_MAX_MS;
    const status = limitStatus(endsAtMs, this.#deps.now());
    return {
      state: this.#state,
      pending: this.#pending,
      elapsedMs,
      remainingMs: status.remainingMs,
      warn: status.warn,
      ...(this.#notice === undefined ? {} : { notice: this.#notice }),
      gapMarked: this.#gapMarked,
    };
  }

  /** 訂閱狀態變化（只在真的變化時通知，UI 不必輪詢猜狀態）。 */
  subscribe(listener: (snapshot: RecorderSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 使用者按下「開始會議」：先開 session，再取麥克風（順序反了會出現「沒 session 的音訊」）。 */
  async start(): Promise<void> {
    if (this.#pending || this.#state !== "idle") return;
    this.#pending = true;
    const attempt = ++this.#attempt;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await this.#deps.session.start();
      if (attempt !== this.#attempt) return;
      this.#startedAtMs = session.startedAtMs;
      this.#endsAtMs = session.endsAtMs;
      this.#frozenElapsedMs = null;
      watchdog = setTimeout(() => {
        if (attempt === this.#attempt) this.#fail("timeout");
      }, this.#deps.startTimeoutMs);
      await this.#deps.capture.acquire();
      if (attempt !== this.#attempt) return;
      clearTimeout(watchdog);
      this.#pending = false;
      this.#apply({ type: "started" });
      this.#emitIfChanged();
    } catch (error) {
      clearTimeout(watchdog);
      if (attempt !== this.#attempt) return;
      this.#fail(classifyFailure(error));
    }
  }

  /** 中斷後使用者確認「繼續這場會議？」：續錄，時間軸接續（不重置）。 */
  async resume(): Promise<void> {
    if (this.#state !== "interrupted") return;
    this.#apply({ type: "resume_requested" });
    await this.#acquireInFlight;
    this.#emitIfChanged();
  }

  /** 使用者主動結束會議（長按填滿確認後呼叫）。 */
  async stopByUser(): Promise<void> {
    if (this.#state !== "recording" && this.#state !== "interrupted") return;
    this.#apply({ type: "stop_requested" });
    try {
      await this.#deps.session.stop("user");
    } catch {
      // 伺服端收尾失敗不影響裝置端已停止收音的事實；錯誤由下一次同步時重試（見 US-102）。
    }
    this.#emitIfChanged();
  }

  /** 從「已達上限」畫面離開（產生記錄 / 開新一場）。 */
  closeSession(): void {
    this.#apply({ type: "session_closed" });
    this.#emitIfChanged();
  }

  /** 前景/背景變化（AC-4：切背景必須明確顯示中斷，且計時器不得繼續跑）。 */
  notifyVisibility(hidden: boolean): void {
    if (hidden) {
      const wasRecording = this.#state === "recording";
      this.#apply({ type: "visibility_hidden" });
      if (wasRecording) void this.#deps.capture.release();
    } else {
      this.#apply({ type: "visibility_visible" });
    }
    this.#emitIfChanged();
  }

  /** 由 UI 每秒呼叫：重算剩餘時間，到點就依伺服端權威結束（AC-6）。 */
  tick(): void {
    if (this.#endsAtMs === null) return;
    if (this.#state !== "recording" && this.#state !== "interrupted") return;
    if (!limitStatus(this.#endsAtMs, this.#deps.now()).reached) return;
    this.#apply({ type: "limit_timeout" });
    void this.#deps.session.stop("limit").catch(() => {});
    this.#emitIfChanged();
  }

  /** 伺服端說已到上限（例如重新回到 App 時同步到的狀態）。 */
  markLimitReached(): void {
    if (this.#state !== "recording" && this.#state !== "interrupted") return;
    this.#apply({ type: "limit_timeout" });
    this.#emitIfChanged();
  }

  /** 開始嘗試失敗：狀態回 idle、釋放資源、中止伺服端 session、留下說明。 */
  #fail(reason: StartFailureReason): void {
    this.#attempt += 1;
    this.#pending = false;
    this.#apply({ type: "start_failed", reason });
    void this.#deps.session.stop("aborted").catch(() => {});
    this.#emitIfChanged();
  }

  #apply(event: RecEvent): void {
    const result = transition(this.#state, event);
    this.#state = result.state;
    if (result.notice !== undefined) this.#notice = result.notice;
    this.#runEffects(result.effects);
  }

  #runEffects(effects: RecEffect[]): void {
    for (const effect of effects) {
      switch (effect) {
        case "acquire_mic":
          this.#acquireInFlight = this.#acquireMic();
          break;
        case "release_mic":
          void this.#deps.capture.release();
          break;
        case "freeze_timer":
          this.#freezeTimer();
          break;
        case "mark_transcript_gap":
          this.#gapMarked += 1;
          break;
        case "request_session_start":
          break; // start() 自己處理（需要在取麥克風之前完成）
      }
    }
  }

  async #acquireMic(): Promise<void> {
    try {
      await this.#deps.capture.acquire();
    } catch {
      // 續錄時拿不到麥克風：退回中斷狀態並明說，不讓畫面停在「好像又在錄」。
      this.#state = transition(this.#state, { type: "visibility_hidden" }).state;
      this.#notice = {
        code: "DEVICE_UNAVAILABLE",
        message: "續錄時抓不到麥克風。請確認麥克風沒有被其他 App 占用，再試一次。",
      };
      this.#emitIfChanged();
    }
  }

  #freezeTimer(): void {
    if (this.#startedAtMs === null) return;
    this.#frozenElapsedMs = Math.min(
      Math.max(0, this.#deps.now() - this.#startedAtMs),
      MEETING_MAX_MS,
    );
  }

  #emitIfChanged(): void {
    const snapshot = this.snapshot;
    const signature = `${snapshot.state}|${snapshot.notice?.code ?? ""}|${snapshot.gapMarked}`;
    if (signature === this.#lastEmitted) return;
    this.#lastEmitted = signature;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
