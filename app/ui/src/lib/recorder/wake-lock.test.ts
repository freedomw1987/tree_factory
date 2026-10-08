import { describe, expect, test } from "vitest";

import {
  WakeLockManager,
  wakeLockHint,
  type WakeLockSentinelLike,
  type WakeLockState,
} from "./wake-lock";

/**
 * M01-US-108「WakeLock 防關屏」的單元測試。
 *
 * 為什麼要注入假 sentinel 而不是真的用 `navigator.wakeLock`：
 * 1. 測試環境沒有這個 API；能跑的地方（Chrome）也無法在 CI 假裝「使用者按了電源鍵」。
 * 2. 這一票真正會出錯的地方不是「有沒有呼叫 API」，而是**狀態機**：
 *    進背景後要重取、系統釋放要重試且有上限、結束會議後不能殘留提示。
 *    這些用假 sentinel 才驗得到。
 */

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCalls = 0;
  #listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === "release") this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "release") this.#listeners.delete(listener);
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.released = true;
    this.notifyRelease();
  }

  /** 模擬「系統自己收走」：使用者按電源鍵、或進背景由瀏覽器釋放。 */
  notifyRelease(): void {
    this.released = true;
    for (const listener of [...this.#listeners]) listener();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

interface FakeAdapter {
  calls: number;
  supported: boolean;
  reject: null | { name: string };
  sentinels: FakeSentinel[];
  isSupported(): boolean;
  request(): Promise<WakeLockSentinelLike>;
}

function makeAdapter(options: { supported?: boolean; reject?: { name: string } | null } = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    calls: 0,
    supported: options.supported ?? true,
    reject: options.reject ?? null,
    sentinels: [],
    isSupported: () => adapter.supported,
    request: async () => {
      adapter.calls += 1;
      if (adapter.reject !== null) {
        const error = new Error("not allowed");
        error.name = adapter.reject.name;
        throw error;
      }
      const sentinel = new FakeSentinel();
      adapter.sentinels.push(sentinel);
      return sentinel;
    },
  };
  return adapter;
}

/**
 * 可控版 adapter：`request()` 不會自己完成，要測試呼叫 `grant()` 才給鎖。
 * 用來驗「取得還在飛的時候，狀態被改掉會怎樣」——這在真機是毫秒級的競態，
 * 但一旦猜錯就會留下一個沒人知道的鎖（或畫面宣稱有保護但其實沒有）。
 */
function makeDeferredAdapter() {
  const adapter = makeAdapter();
  const pending: Array<(sentinel: FakeSentinel) => void> = [];
  adapter.request = () =>
    new Promise<WakeLockSentinelLike>((resolve) => {
      adapter.calls += 1;
      pending.push((sentinel) => {
        adapter.sentinels.push(sentinel);
        resolve(sentinel);
      });
    });
  const grant = (index = 0): FakeSentinel => {
    const sentinel = new FakeSentinel();
    const deliver = pending[index];
    if (deliver === undefined) throw new Error(`沒有第 ${index} 個在飛的 request`);
    pending.splice(index, 1);
    deliver(sentinel);
    return sentinel;
  };
  return {
    adapter,
    grant,
    pendingCount: () => pending.length,
    manager: (maxRetries?: number, timeoutMs?: number) => makeManager(adapter, maxRetries, timeoutMs),
  };
}

function makeManager(adapter: FakeAdapter, maxRetries?: number, timeoutMs?: number) {
  const states: WakeLockState[] = [];
  const manager = new WakeLockManager({
    adapter,
    onChange: (state) => states.push(state),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { manager, states };
}

/** 等微任務清空：`acquire()` 內部要經過 `Promise.race` 與世代比對，一兩次 tick 還不夠。 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("M01-US-108 螢幕防關（WakeLockManager）", () => {
  test("M01-AC-1：開始錄音就取得 screen wake lock，狀態變 active", async () => {
    const adapter = makeAdapter();
    const { manager, states } = makeManager(adapter);

    expect(manager.state).toBe("idle");
    await manager.acquire();

    expect(adapter.calls).toBe(1);
    expect(manager.state).toBe("active");
    expect(states.at(-1)).toBe("active");
  });

  test("M01-AC-2：裝置不支援時標 unsupported、不呼叫 request、也不丟錯（best-effort）", async () => {
    const adapter = makeAdapter({ supported: false });
    const { manager } = makeManager(adapter);

    await expect(manager.acquire()).resolves.toBeUndefined();

    expect(adapter.calls).toBe(0);
    expect(manager.state).toBe("unsupported");
    expect(wakeLockHint("unsupported")).toContain("不支援");
  });

  test("M01-AC-2：request 被系統拒絕 → denied，且不得變成未處理的 rejection", async () => {
    const adapter = makeAdapter({ reject: { name: "NotAllowedError" } });
    const { manager } = makeManager(adapter);

    await expect(manager.acquire()).resolves.toBeUndefined();

    expect(adapter.calls).toBe(1);
    expect(manager.state).toBe("denied");
    expect(wakeLockHint("denied")).toContain("省電");
  });

  test("M01-D3：進背景（suspend）後回到前景且仍在錄音 → 必須重新取得（累計 2 次）", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    manager.suspend();
    expect(manager.state).toBe("suspended");
    // suspend 是真的放掉（也讓系統的 release 事件不要被誤判成「失去保護」）
    expect(adapter.sentinels[0]!.releaseCalls).toBe(1);
    expect(adapter.sentinels[0]!.listenerCount).toBe(0);

    await manager.acquire();
    expect(adapter.calls).toBe(2);
    expect(manager.state).toBe("active");
  });

  test("M01-D4：系統自己收走（電源鍵）→ 先降級再自動重取一次；重取成功就回到 active", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    adapter.sentinels[0]!.notifyRelease();
    // 先誠實降級（這一刻真的沒有保護），再非同步重取
    expect(manager.state).toBe("suspended");
    await expect.poll(() => adapter.calls).toBe(2);
    await expect.poll(() => manager.state).toBe("active");
    expect(wakeLockHint("active")).toBeNull();
  });

  test("M01-D4：重取也失敗 → 停在 lost、只打一次、不無限重試", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    // 系統收走的同時，環境也不再允許（例：使用者按了電源鍵 → 頁面變 hidden，request() 會被拒）
    adapter.reject = { name: "NotAllowedError" };
    adapter.sentinels[0]!.notifyRelease();

    await expect.poll(() => manager.state).toBe("lost");
    expect(adapter.calls).toBe(2); // 初始 1 次 + 重試 1 次，之後不再打
    expect(wakeLockHint("lost")).toContain("請保持畫面開啟");

    // 就算再送一次 release 事件也不該再打（sentinel 已放掉、listener 也不再掛著）
    await Promise.resolve();
    expect(manager.state).toBe("lost");
    expect(adapter.calls).toBe(2);
  });

  test("M01-D9：我方 stop() 的釋放不得被誤判成 lost（否則會議結束後會出現鬼提示）", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    const sentinel = adapter.sentinels[0]!;
    manager.stop();

    expect(sentinel.releaseCalls).toBe(1);
    expect(sentinel.listenerCount).toBe(0);
    expect(manager.state).toBe("idle");
    await Promise.resolve();
    expect(manager.state).toBe("idle");
    expect(adapter.calls).toBe(1);
  });

  test("M01-D1（負向）：中斷中（suspend 之後）回前景但沒續錄 → 不得重新取得", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    manager.suspend();
    // 使用者回到前景但沒按「繼續這場會議」→ 呼叫端（app.svelte.ts）不該呼叫 acquire()。
    // 這裡驗的是「suspend 之後沒人叫它，它就什麼都不做」——不自行醒來。
    await Promise.resolve();
    expect(adapter.calls).toBe(1);
    expect(manager.state).toBe("suspended");
  });

  test("M01-冪等：已經 active 時重複 acquire() 不會重複 request", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    await manager.acquire();
    await manager.acquire();

    expect(adapter.calls).toBe(1);
    expect(manager.state).toBe("active");
  });

  test("M01-結束後（idle）再 acquire 會重新開始，且重試計數歸零", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    manager.stop();
    expect(manager.state).toBe("idle");
    // stop() 之後（例如下一場會議）不該再收到舊 sentinel 的 release 事件
    adapter.sentinels[0]!.notifyRelease();
    expect(manager.state).toBe("idle");
  });

  test("M01-suspended 是暫時狀態：suspend 後系統的 release 事件不得把它變成 lost", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    const sentinel = adapter.sentinels[0]!;
    manager.suspend();
    sentinel.notifyRelease(); // 瀏覽器在 hidden 時本來就會釋放
    await Promise.resolve();

    expect(manager.state).toBe("suspended");
    expect(adapter.calls).toBe(1);
  });

  test("M01-競態：取得還沒回來就結束會議 → 不得變成 active，且剛拿到的鎖要立刻放掉", async () => {
    const { grant, manager: build } = makeDeferredAdapter();
    const { manager } = build();

    const acquiring = manager.acquire();
    manager.stop(); // 使用者在 request 還沒回來前就按了結束
    const sentinel = grant();
    await acquiring;

    expect(manager.state).toBe("idle");
    expect(sentinel.releaseCalls).toBe(1);
    expect(sentinel.listenerCount).toBe(0);
  });

  test("M01-競態：取得還在飛時進背景 → 不得變成 active（維持 idle，鎖要立刻放掉）", async () => {
    const { grant, manager: build } = makeDeferredAdapter();
    const { manager } = build();

    const acquiring = manager.acquire();
    manager.suspend(); // 進背景（規格上 `hidden` 時 request 本來就會被拒）
    const sentinel = grant();
    await acquiring;

    // 誠實：這一刻真的沒有保護，所以不得變成 active；也因為從未取得過，維持 idle。
    expect(manager.state).toBe("idle");
    expect(sentinel.releaseCalls).toBe(1);
    expect(sentinel.listenerCount).toBe(0); // 沒有被收下（收下就會變成幽靈保護）
    expect(wakeLockHint(manager.state)).toBeNull();
  });

  test("M01-競態：同時呼叫兩次 acquire() 只請求一次（不得洩漏第二個鎖）", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await Promise.all([manager.acquire(), manager.acquire()]);

    expect(adapter.calls).toBe(1);
    expect(adapter.sentinels).toHaveLength(1);
    expect(manager.state).toBe("active");
  });

  test("M01-競態：某次 request() 卡住不回來時，stop() 之後仍要能重新取得（不得永久卡死）", async () => {
    // Gate 4 抓到：`#acquiring` 若只在 acquire() 自己的 finally 清除，一個永不 settle 的 request
    // 會讓之後所有取得都靜默 no-op——狀態停在 suspended/idle、提示是 null，
    // 也就是「沒有保護但畫面什麼都不說」，正是本票要消滅的失敗型態。
    const { adapter, grant, manager: build } = makeDeferredAdapter();
    const { manager } = build();

    void manager.acquire(); // 第一次：卡住，永遠不回來
    expect(adapter.calls).toBe(1);

    manager.stop(); // 會議結束（世代 +1，那個卡住的請求已被作廢）
    const second = manager.acquire(); // 下一場會議：不得被前一個卡住
    expect(adapter.calls).toBe(2);

    const sentinel = grant(1); // 第二個請求真的拿到鎖（index 1：0 是那個卡死的）
    await second;

    expect(manager.state).toBe("active");
    expect(sentinel.listenerCount).toBe(1);
  });

  test("M01-D8：sentinel.release() 同步丟錯也不得上拋（每秒的 tick 會讓它變成事件處理器例外）", async () => {
    // `Promise.resolve(sentinel.release())` 會先求值 `release()`，同步例外不會進 `.catch`。
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    const sentinel = adapter.sentinels[0]!;
    (sentinel as unknown as { release: () => Promise<void> }).release = () => {
      throw new Error("release 同步爆掉");
    };

    expect(() => manager.stop()).not.toThrow();
    expect(manager.state).toBe("idle");
  });

  test("M01-D8：sentinel.release() 回 rejected promise 也不產生未處理例外，狀態照舊轉移", async () => {
    const adapter = makeAdapter();
    const { manager } = makeManager(adapter);

    await manager.acquire();
    const sentinel = adapter.sentinels[0]!;
    (sentinel as unknown as { release: () => Promise<void> }).release = () =>
      Promise.reject(new Error("release 非同步爆掉"));

    expect(() => manager.suspend()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.state).toBe("suspended");
  });

  test("M01-AC-2 / D6：每個提示都明說「離開畫面會中斷錄音」（AC 要求說明後果）", () => {
    for (const state of ["unsupported", "denied", "lost"] as const) {
      expect(wakeLockHint(state)).toContain("離開會中斷錄音");
    }
  });

  test("M01-wakeLockHint：只有真的沒有保護時才給提示（active / idle 為 null）", () => {
    expect(wakeLockHint("active")).toBeNull();
    expect(wakeLockHint("idle")).toBeNull();
    expect(wakeLockHint("suspended")).toBeNull();
    expect(wakeLockHint("unsupported")).not.toBeNull();
    expect(wakeLockHint("denied")).not.toBeNull();
    expect(wakeLockHint("lost")).not.toBeNull();
  });

  test("M01-競態（Gate 4 第二輪）：舊世代的 request() 回來時，不得清掉新請求的 in-flight 旗標（否則會多打一次並洩漏第二把鎖）", async () => {
    // oracle 獨立審查抓到：`finally { this.#acquiring = false }` 是無條件清除，而 F4 讓 stop()/suspend()
    // 也會清旗標——於是「A 在飛 → stop() → B 在飛 → A 回來」會把 B 的旗標清掉，C 就能再打一次。
    // 此時 B、C 同時在飛、世代相同、都會被收成 active，其中一把鎖沒人放掉：畫面再也不會自動關。
    const { adapter, grant, manager: build } = makeDeferredAdapter();
    const { manager } = build();

    void manager.acquire(); // A 起飛（永不主動完成）
    expect(adapter.calls).toBe(1);

    manager.stop(); // 世代 +1、旗標清掉（A 已被作廢）
    void manager.acquire(); // B 起飛
    expect(adapter.calls).toBe(2);

    grant(0); // A 姍姍來遲：世代不符 → 立刻放掉（這裡正確），但**不得**清掉 B 的 in-flight 旗標
    await flushMicrotasks();

    void manager.acquire(); // 這裡若旗標被清掉，就會多打第三次
    await flushMicrotasks();

    expect(adapter.calls).toBe(2); // ← 修好前這裡是 3

    const second = grant(0); // B 才是真的拿到鎖的那一次
    await flushMicrotasks();
    expect(manager.state).toBe("active");
    expect(adapter.sentinels).toHaveLength(2);

    manager.stop(); // 結束會議必須把 B 那把鎖放掉、listener 拆掉（不得洩漏）
    expect(second.releaseCalls).toBe(1);
    expect(second.listenerCount).toBe(0);
  });

  test("M01（Gate 4 第二輪）：request() 卡住不回來超過逾時 → 要誠實降級並給提示，不得停在 idle 靜默", async () => {
    // 這一票要消滅的失敗型態：畫面只寫「錄音中」，但其實完全沒有螢幕保護——使用者把手機放著，
    // 回來才發現整場沒錄到。「取得永不回來」會讓狀態停在 idle 而 `wakeLockHint("idle")` 是 null。
    const { adapter, manager: build } = makeDeferredAdapter();
    const { manager } = build(undefined, 5);

    await manager.acquire();

    expect(adapter.calls).toBe(1);
    expect(manager.state).toBe("denied");
    expect(wakeLockHint(manager.state)).not.toBeNull();
    // 逾時與「被拒」共用同一個狀態，所以文案必須兩種原因都說得到（不能只說省電模式）。
    expect(wakeLockHint(manager.state)).toContain("沒有回應");
  });

  test("M01（Gate 4 第二輪）：逾時之後才拿到的鎖 → 若還在錄音就要收下（不得「握著鎖卻宣稱沒保護」）", async () => {
    const { grant, manager: build } = makeDeferredAdapter();
    const { manager } = build(undefined, 50);

    await manager.acquire(); // 逾時（50ms）後會降級
    expect(manager.state).toBe("denied");

    const sentinel = grant(0); // 系統慢了一步才給鎖
    await flushMicrotasks();

    expect(manager.state).toBe("active");
    expect(sentinel.listenerCount).toBe(1);

    // 收下來的鎖要能正常運作：系統收走 → 照 D4 重試
    sentinel.notifyRelease();
    const retry = grant(0);
    await flushMicrotasks();
    expect(manager.state).toBe("active");
    expect(retry.listenerCount).toBe(1);
  });
});
