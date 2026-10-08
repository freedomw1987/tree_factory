/**
 * M01-US-108「錄音續航」：用 Screen Wake Lock 壓住螢幕不自動關。
 *
 * 這個檔案是**純狀態機**：不直接碰 `navigator`（由呼叫端注入 adapter）。
 * 為什麼要這樣切：真正會出錯的是狀態轉移（進背景被系統釋放後要重取、系統釋放要重試且有上限、
 * 結束會議要收乾淨），而不是「有沒有呼叫 API」——注入 adapter 之後這些全部可測。
 *
 * 產品前提（SPIKE-002）：webview 進背景就收不到音，所以這一票只能防「螢幕自動關」，
 * 防不了「使用者主動鎖屏」；後者由 M01-US-107 的缺口列誠實交代。
 */

export type WakeLockState =
  | "idle"
  | "active"
  | "suspended"
  | "unsupported"
  | "denied"
  | "lost";

/** 只要求我們真的會用到的部分（`WakeLockSentinel` 的結構化子集）。 */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockAdapter {
  isSupported(): boolean;
  request(): Promise<WakeLockSentinelLike>;
}

export interface WakeLockOptions {
  adapter: WakeLockAdapter;
  onChange?: (state: WakeLockState) => void;
  /**
   * 同一場錄音內，因「系統自己收走」而自動重取的次數上限（預設 1）。
   * 為什麼要有上限：無限重試是 M01-US-107 F5 那類問題——打一個註定失敗的請求，
   * 使用者只會看到永遠不會好的提示。
   */
  maxRetries?: number;
  /**
   * `request()` 多久沒回來就當作失敗（毫秒，預設 10_000；<= 0 表示不設逾時）。
   * 為什麼需要：一個永不 settle 的 `request()` 會讓狀態停在 `idle`，而 `wakeLockHint("idle")` 是
   * `null`——畫面只寫「錄音中」，使用者卻完全沒有螢幕保護，正是這一票要消滅的失敗型態。
   * 為什麼是 10 秒：真機授予鎖是毫秒級，10 秒足夠排除「慢但成功」；設更短會把慢成功誤判成失敗。
   */
  timeoutMs?: number;
}

/**
 * 給畫面用的提示句。`null` = 現在真的有保護（或根本沒在錄音），不用多說一句。
 *
 * 顯示條件刻意只看「是否真的有保護」：喊著「已防止螢幕關閉」但其實沒生效，
 * 比不提示更糟——使用者會把手機丟在桌上，回來才發現整場沒錄到。
 */
export function wakeLockHint(state: WakeLockState): string | null {
  switch (state) {
    case "unsupported":
      return "此裝置不支援防止螢幕關閉；請保持畫面開啟，離開會中斷錄音";
    case "denied":
      // 「被拒」與「逾時」共用這個狀態（D11）：兩種原因都要說得到，否則逾時的使用者只會看到「省電模式」而找錯方向。
      return "系統未允許防止螢幕關閉（可能開啟了省電模式，或系統沒有回應）；請保持畫面開啟，離開會中斷錄音";
    case "lost":
      return "螢幕保護已失效（例如按下電源鍵）；請保持畫面開啟，離開會中斷錄音";
    default:
      return null;
  }
}

export class WakeLockManager {
  readonly #adapter: WakeLockAdapter;
  readonly #onChange: ((state: WakeLockState) => void) | undefined;
  readonly #maxRetries: number;
  #state: WakeLockState = "idle";
  #sentinel: WakeLockSentinelLike | null = null;
  /** 我方主動放掉（suspend / stop）：此時 sentinel 的 release 事件不代表「失去保護」。 */
  #intentional = false;
  /** 曾經真的取得過 → 之後的失敗算「失去保護（lost）」而不是「沒被允許（denied）」。 */
  #everActive = false;
  #retries = 0;
  readonly #timeoutMs: number;
  /** 有一個 `request()` 正在飛：避免同時兩次取得（會洩漏第二個鎖）。 */
  #acquiring = false;
  /**
   * 每次 `stop()` / `suspend()` 遞增；`acquire()` 在 await 前記下當下的世代，
   * 回來時若世代已變就**立刻放掉剛拿到的鎖**——不然「取得還在飛時按了結束」會留下幽靈保護。
   */
  #generation = 0;

  constructor(options: WakeLockOptions) {
    this.#adapter = options.adapter;
    this.#onChange = options.onChange;
    this.#maxRetries = options.maxRetries ?? 1;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get state(): WakeLockState {
    return this.#state;
  }

  /** 錄音中呼叫（開始錄音 / 續錄成功 / 回到前景）。重複呼叫是安全的。 */
  async acquire(): Promise<void> {
    if (this.#state === "active" || this.#acquiring) return;
    if (!this.#adapter.isSupported()) {
      this.#set("unsupported");
      return;
    }
    this.#acquiring = true;
    const generation = this.#generation;
    const pending = this.#adapter.request();
    let timedOut = false;
    try {
      const sentinel = await this.#withTimeout(pending, () => {
        timedOut = true;
      });
      if (generation !== this.#generation) {
        // 在等的期間已經結束／進背景了：不要留下沒人知道、也沒人放掉的鎖。
        this.#releaseQuietly(sentinel);
        return;
      }
      this.#adopt(sentinel);
    } catch {
      // best-effort：任何失敗都只反映在狀態上，不得讓錄音流程失敗（D8）。
      if (timedOut) this.#adoptLate(pending, generation);
      if (generation !== this.#generation) return;
      this.#sentinel = null;
      this.#set(this.#everActive ? "lost" : "denied");
    } finally {
      // 只有「還是我的世代」才能清旗標：姍姍來遲的舊請求若把**別人**（較新那次）的 in-flight
      // 旗標清掉，之後就會多打一次 `request()`，變成兩把鎖同時在飛、其中一把沒人放掉。
      if (generation === this.#generation) this.#acquiring = false;
    }
  }

  /**
   * 等 `request()` 回來，但最多等 `#timeoutMs`：真機授予鎖是毫秒級，卡住的請求幾乎都是
   * 「永遠不會回來」，此時**必須**降級並顯示提示，而不是讓畫面靜默地假裝沒事。
   */
  async #withTimeout(
    pending: Promise<WakeLockSentinelLike>,
    onTimeout: () => void,
  ): Promise<WakeLockSentinelLike> {
    if (this.#timeoutMs <= 0) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new Error("wake lock request timeout"));
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 收下一把剛拿到的鎖（掛 listener、記成 active）。 */
  #adopt(sentinel: WakeLockSentinelLike): void {
    this.#sentinel = sentinel;
    this.#intentional = false;
    sentinel.addEventListener("release", this.#onRelease);
    this.#everActive = true;
    this.#retries = 0;
    this.#set("active");
  }

  /**
   * 逾時之後才回來的鎖：若這場錄音還在、而我們現在正宣稱「沒有保護」，就把它收下。
   * 反過來（已經結束／進背景／已經有別的鎖）就安靜放掉。
   * 為什麼要收：不然會變成另一種假訊息——明明握著鎖，卻對使用者說「請保持畫面開啟」。
   */
  #adoptLate(pending: Promise<WakeLockSentinelLike>, generation: number): void {
    void pending.then(
      (sentinel) => {
        const stillWanted = this.#state === "denied" || this.#state === "lost";
        if (generation !== this.#generation || !stillWanted) {
          this.#releaseQuietly(sentinel);
          return;
        }
        this.#adopt(sentinel);
      },
      () => {
        // 逾時之後才失敗：狀態早已反映失敗，沒有別的事要做。
      },
    );
  }

  /** 進背景：系統會釋放 sentinel，這裡主動收乾淨並記成「暫時」——回前景可以再取。 */
  suspend(): void {
    // `hidden` 時 `request()` 在規格上本來就會被拒；若還在飛就取消它（世代 +1）。
    this.#generation += 1;
    // in-flight 旗標也要清：否則一個永不 settle 的 `request()` 會讓之後所有取得都靜默 no-op
    // （狀態停在 suspended/idle、提示是 null → 「沒保護卻什麼都不說」）。舊結果已被世代守衛作廢。
    this.#acquiring = false;
    if (this.#state !== "active") return;
    this.#releaseCurrent();
    this.#set("suspended");
  }

  /** 結束會議 / 錄音中斷 / 上限到點：回 idle，並且不再對外宣稱螢幕受保護。 */
  stop(): void {
    this.#generation += 1;
    this.#acquiring = false; // 同上：不得被一個卡死的請求永久鎖住
    this.#releaseCurrent();
    this.#everActive = false;
    this.#retries = 0;
    this.#set("idle");
  }

  #releaseCurrent(): void {
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel === null) return;
    this.#intentional = true;
    sentinel.removeEventListener("release", this.#onRelease);
    this.#releaseQuietly(sentinel);
  }

  /**
   * 安靜地放掉一個 sentinel：**同步**例外與 rejected promise 都不能往上丟。
   * 為什麼要特別寫 try/catch：`Promise.resolve(x)` 會先求值 `x`，
   * 若 `release()` 同步 throw，例外不會進 `.catch()`，而 `stop()`／`suspend()` 是
   * 每秒的 tick 與 `visibilitychange` 處理器在呼叫的——漏掉就會變成每秒一次的事件處理器例外。
   */
  #releaseQuietly(sentinel: WakeLockSentinelLike): void {
    try {
      void Promise.resolve(sentinel.release()).catch(() => {
        // 釋放失敗不影響使用（瀏覽器最終會自己放掉），不往上丟。
      });
    } catch {
      // 同步丟錯同理：只當作「這次沒放成功」，狀態機照常走。
    }
  }

  /** sentinel 自己說「我沒了」——使用者按電源鍵、或系統基於省電強制釋放。 */
  readonly #onRelease = (): void => {
    if (this.#intentional) return;
    // suspend() 之後瀏覽器也會補一個 release 事件，那個不是「失去保護」。
    if (this.#state !== "active") return;
    this.#sentinel = null;
    // 先誠實降級再重取：這一刻螢幕真的沒有保護，UI 不該還顯示「active」。
    // 用 `suspended`（不給提示）是因為重取只花幾毫秒，閃一下提示反而是噪音；
    // 若重取失敗，下面的 `acquire()` 會把它降成 `lost`（因為 `#everActive` 已是 true）並顯示提示。
    this.#set("suspended");
    if (this.#retries >= this.#maxRetries) {
      this.#set("lost");
      return;
    }
    this.#retries += 1;
    void this.acquire();
  };

  #set(state: WakeLockState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onChange?.(state);
  }
}
