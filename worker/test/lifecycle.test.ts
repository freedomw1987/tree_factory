// TECH-004：`HarnessLifecycle` —— DO 內 harness 的單例、懶初始化、alarms 接力、重建。
//
// 這些測試用一個假的 harness（就是個物件）來驗壽命邏輯本身；
// 真 Harness + 真 SQLite 的持久化另見 harness-persistence.test.ts。

import { describe, expect, it } from "vitest";

import { HarnessLifecycle } from "../src/harness/lifecycle.js";

interface FakeHarness {
  readonly seq: number;
}

function makeLifecycle(options: { now?: () => number; failFirstOpen?: boolean; deferredOpen?: boolean } = {}) {
  const pendingOpens: Array<(harness: FakeHarness) => void> = [];
  const state = {
    opens: 0,
    closes: [] as number[],
    alarms: [] as number[],
    alarm: null as number | null,
    opened: [] as FakeHarness[],
    failures: 0,
    /** 交付（resolve）目前還掛著的那次 open()；給「交易/P1-2 競態」測試控制時機用。 */
    settleOpen(): FakeHarness {
      const resolve = pendingOpens.shift();
      if (resolve === undefined) {
        throw new Error("沒有掛著的 open()");
      }
      const harness = { seq: state.opened.length + 1 };
      state.opened.push(harness);
      resolve(harness);
      return harness;
    },
  };
  const lifecycle = new HarnessLifecycle<FakeHarness>({
    open: async () => {
      if (options.failFirstOpen === true && state.opens === 0) {
        state.opens += 1;
        state.failures += 1;
        throw new Error("open failed");
      }
      state.opens += 1;
      if (options.deferredOpen === true) {
        return new Promise<FakeHarness>((resolve) => {
          pendingOpens.push(resolve);
        });
      }
      const harness = { seq: state.opened.length + 1 };
      state.opened.push(harness);
      return harness;
    },
    close: async (harness) => {
      state.closes.push(harness.seq);
    },
    setAlarm: async (atMs) => {
      state.alarms.push(atMs);
      state.alarm = atMs;
    },
    getAlarm: async () => state.alarm,
    now: options.now ?? (() => 1_000_000),
  });
  return { lifecycle, state };
}

describe("HarnessLifecycle（TECH-004）", () => {
  it("懶初始化：沒人呼叫 current() 就不會 open()", async () => {
    const { lifecycle, state } = makeLifecycle();
    expect(lifecycle.stats).toEqual({
      opens: 0,
      closes: 0,
      wakes: 0,
      alarmsScheduled: 0,
      deferredReleases: 0,
      isOpen: false,
    });
    expect(state.opens).toBe(0);
  });

  it("單例：連續呼叫 current() 只開一次並拿到同一個 harness", async () => {
    const { lifecycle, state } = makeLifecycle();
    const first = await lifecycle.current();
    const second = await lifecycle.current();
    expect(first).toBe(second);
    expect(state.opens).toBe(1);
    expect(lifecycle.stats.isOpen).toBe(true);
  });

  it("併發安全：同時 5 個請求只會開一次，且都拿到同一個 harness", async () => {
    const { lifecycle, state } = makeLifecycle();
    const all = await Promise.all([
      lifecycle.current(),
      lifecycle.current(),
      lifecycle.current(),
      lifecycle.current(),
      lifecycle.current(),
    ]);
    expect(new Set(all).size).toBe(1);
    expect(state.opens).toBe(1);
    expect(lifecycle.stats.opens).toBe(1);
  });

  it("開啟失敗可重試：第一次丟錯不會讓 lifecycle 永久壞掉", async () => {
    const { lifecycle, state } = makeLifecycle({ failFirstOpen: true });
    await expect(lifecycle.current()).rejects.toThrow("open failed");
    const harness = await lifecycle.current();
    expect(harness.seq).toBe(1);
    expect(lifecycle.stats.isOpen).toBe(true);
    expect(state.failures).toBe(1);
  });

  it("release() 關閉後再 current() 會重建（close 會關掉 storage，必須全鏈重建）", async () => {
    const { lifecycle, state } = makeLifecycle();
    const first = await lifecycle.current();
    await lifecycle.release();
    expect(lifecycle.stats.closes).toBe(1);
    expect(state.closes).toEqual([first.seq]);
    expect(lifecycle.stats.isOpen).toBe(false);

    const second = await lifecycle.current();
    expect(second).not.toBe(first);
    expect(second.seq).toBe(2);
    expect(state.opens).toBe(2);
  });

  it("release() 對沒開過的 lifecycle 是 no-op（不 throw、不計次）", async () => {
    const { lifecycle } = makeLifecycle();
    await expect(lifecycle.release()).resolves.toEqual({ released: false, deferred: false });
    expect(lifecycle.stats.closes).toBe(0);
    expect(lifecycle.stats.deferredReleases).toBe(0);
  });

  it("併發 release()：不會關掉一隻正在交付中的 harness（呼叫端不可拿到已關閉的 harness）", async () => {
    const { lifecycle, state } = makeLifecycle({ deferredOpen: true });

    const currentP = lifecycle.current(); // open 還在飛
    // release() 插進來：它不能把「即將交出去」的那隻關掉，只能延後。
    await expect(lifecycle.release()).resolves.toEqual({ released: false, deferred: true });
    expect(state.closes).toEqual([]);

    state.settleOpen(); // 交付 h1
    const delivered = await currentP;
    expect(state.closes).toEqual([]); // 交付的這隻是活的
    expect(lifecycle.stats.isOpen).toBe(true);
    expect(lifecycle.stats.deferredReleases).toBe(1);

    // 下一次 release() 才真的放掉它。
    await expect(lifecycle.release()).resolves.toEqual({ released: true, deferred: false });
    expect(state.closes).toEqual([delivered.seq]);
    expect(lifecycle.stats.isOpen).toBe(false);
    expect(state.opens).toBe(1); // 沒有為了避開競態多開一隻
  });

  it("alarm 接力：第一次 wakeIn 會設定 alarm，且時間 = now + delay", async () => {
    const { lifecycle, state } = makeLifecycle({ now: () => 5_000 });
    const decision = await lifecycle.wakeIn(1_500);
    expect(decision).toEqual({ scheduled: true, at: 6_500, previous: null });
    expect(state.alarms).toEqual([6_500]);
  });

  it("alarm 接力只往前：已有更早的 alarm 時不動它（避免長工作被延後）", async () => {
    const { lifecycle, state } = makeLifecycle({ now: () => 5_000 });
    await lifecycle.wakeIn(1_000); // 6_000
    const later = await lifecycle.wakeIn(60_000); // 65_000
    expect(later.scheduled).toBe(false);
    expect(later.previous).toBe(6_000);
    expect(state.alarms).toEqual([6_000]);

    // 更早的請求仍可往前調
    const earlier = await lifecycle.wakeIn(100); // 5_100
    expect(earlier.scheduled).toBe(true);
    expect(state.alarms).toEqual([6_000, 5_100]);
    expect(lifecycle.stats.alarmsScheduled).toBe(2);
  });

  it("alarm 接力：拒絕負數或非有限值（避免設出過去的 alarm 造成忙迴圈）", async () => {
    const { lifecycle } = makeLifecycle();
    await expect(lifecycle.wakeIn(-1)).rejects.toThrow(/非負/);
    await expect(lifecycle.wakeIn(Number.NaN)).rejects.toThrow(/非負/);
    await expect(lifecycle.wakeIn(Number.POSITIVE_INFINITY)).rejects.toThrow(/非負/);
  });

  it("onAlarm()：醒來時若 harness 已被釋放（等價 DO 被回收），會重建並計入 wakes", async () => {
    const { lifecycle, state } = makeLifecycle();
    await lifecycle.current();
    await lifecycle.release();

    const harness = await lifecycle.onAlarm();
    expect(harness.seq).toBe(2);
    expect(state.opens).toBe(2);
    expect(lifecycle.stats.wakes).toBe(1);
  });

  it("onAlarm()：harness 還在時直接重用（不重建）", async () => {
    const { lifecycle, state } = makeLifecycle();
    const first = await lifecycle.current();
    const onAlarm = await lifecycle.onAlarm();
    expect(onAlarm).toBe(first);
    expect(state.opens).toBe(1);
    expect(lifecycle.stats.wakes).toBe(1);
  });

  it("getAlarm 未提供時視為沒有 alarm（仍會設定）", async () => {
    const alarms: number[] = [];
    const lifecycle = new HarnessLifecycle<FakeHarness>({
      open: async () => ({ seq: 1 }),
      close: async () => {},
      setAlarm: async (atMs) => {
        alarms.push(atMs);
      },
      now: () => 0,
    });
    const decision = await lifecycle.wakeIn(250);
    expect(decision).toEqual({ scheduled: true, at: 250, previous: null });
    expect(alarms).toEqual([250]);
  });
});