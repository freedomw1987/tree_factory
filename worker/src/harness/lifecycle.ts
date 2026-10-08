/**
 * TECH-004：Durable Object 內 `Harness` 的生命週期封裝。
 *
 * 為什麼要這一層——SPIKE-003 實測出三個平台事實，每個都對應這裡的一條規則：
 *
 * 1. **`Harness.open()` 不便宜，且必須是單例**：同一個 DO instance 內重複開會拿到多個
 *    handle 各持一份 in-flight 狀態 → 規則：**單例 + 懶初始化 + 併發安全**（見 `current()`）。
 * 2. **`harness.close()` 會一併關掉 storage**：關掉後不能再用舊 handle → 規則：
 *    **重建整組**（`open()` 由呼叫端負責重建 adapter + storage + harness），
 *    `release()` 之後 `current()` 必須能重新開起來。
 * 3. **DO 隨時可能被回收，長工作不能只靠一個請求活著** → 規則：**alarms 接力**
 *    （`wakeIn()` 只往前調 alarm，`onAlarm()` 醒來時確保 harness 可用）。
 *
 * 這一層刻意**不 import pi-durable**：用泛型 `H` 注入 open/close，
 * 讓壽命邏輯（單例、接力、重建）能純單元測試；真 Harness 的持久化另做整合測試。
 */

export interface HarnessLifecycleDeps<H> {
  /** 建立一組新的 harness（呼叫端在此重建 adapter + storage + harness）。 */
  open: () => Promise<H>;
  /** 關閉 harness（pi-durable 的 `harness.close(ctx)`）。 */
  close: (harness: H) => Promise<void>;
  /** 設定絕對時間的 alarm（`ctx.storage.setAlarm(at)`）。 */
  setAlarm: (atMs: number) => Promise<void>;
  /** 讀取現有 alarm（`ctx.storage.getAlarm()`；回 `null` 表示沒有）。 */
  getAlarm?: () => Promise<number | null>;
  /** 注入時鐘（測試用）。 */
  now?: () => number;
}

export interface AlarmDecision {
  /** 這次呼叫是否真的改了 alarm。 */
  scheduled: boolean;
  /** 目標時間（毫秒，epoch）。 */
  at: number;
  /** 原本的 alarm（沒有則為 `null`）。 */
  previous: number | null;
}

export interface LifecycleStats {
  opens: number;
  closes: number;
  wakes: number;
  alarmsScheduled: number;
  isOpen: boolean;
}

export class HarnessLifecycle<H> {
  readonly #deps: HarnessLifecycleDeps<H>;
  readonly #now: () => number;
  #current: H | null = null;
  #opening: Promise<H> | null = null;
  #opens = 0;
  #closes = 0;
  #wakes = 0;
  #alarmsScheduled = 0;

  constructor(deps: HarnessLifecycleDeps<H>) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get stats(): LifecycleStats {
    return {
      opens: this.#opens,
      closes: this.#closes,
      wakes: this.#wakes,
      alarmsScheduled: this.#alarmsScheduled,
      isOpen: this.#current !== null,
    };
  }

  /**
   * 取得 harness（單例 + 懶初始化）。
   *
   * 併發安全：同時有多個請求進來時，**只會開一次**（共用同一個 in-flight promise）；
   * 開啟失敗時清掉 in-flight 狀態，讓下一次呼叫能重試（而不是永遠壞掉）。
   */
  async current(): Promise<H> {
    if (this.#current !== null) {
      return this.#current;
    }
    if (this.#opening !== null) {
      return this.#opening;
    }
    const opening = this.#deps.open().then(
      (harness) => {
        this.#current = harness;
        this.#opens += 1;
        return harness;
      },
      (error: unknown) => {
        this.#opening = null; // 允許重試
        throw error;
      },
    );
    this.#opening = opening;
    return opening;
  }

  /** 自願關閉（下次 `current()` 會重建）。DO 被回收時平台會直接切斷，不必呼叫。 */
  async release(): Promise<void> {
    const pending = this.#opening;
    if (pending !== null) {
      // 開到一半就被要求關閉：等它開完再關，避免洩漏一個沒人持有的 harness。
      try {
        await pending;
      } catch {
        this.#opening = null;
        return;
      }
    }
    const harness = this.#current;
    if (harness === null) {
      return;
    }
    this.#current = null;
    this.#opening = null;
    this.#closes += 1;
    await this.#deps.close(harness);
  }

  /**
   * alarm 接力：把「下一次該醒來」的時間往前調。
   *
   * **只往前不往後**：若已有一個更早的 alarm，就不動它——否則一次「排 5 分鐘後」的
   * 呼叫會把「30 秒後該做的收尾」推到 5 分鐘後，長工作就斷了。
   */
  async wakeIn(delayMs: number): Promise<AlarmDecision> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`wakeIn 需要非負的毫秒數，收到 ${String(delayMs)}`);
    }
    const at = this.#now() + delayMs;
    const previous = this.#deps.getAlarm === undefined ? null : await this.#deps.getAlarm();
    if (previous !== null && previous <= at) {
      return { scheduled: false, at, previous };
    }
    await this.#deps.setAlarm(at);
    this.#alarmsScheduled += 1;
    return { scheduled: true, at, previous };
  }

  /**
   * alarm 醒來：確保 harness 可用（DO 被回收過就重建，資料從同一份 storage 讀回）。
   * @returns 醒來後可用的 harness
   */
  async onAlarm(): Promise<H> {
    this.#wakes += 1;
    return this.current();
  }
}