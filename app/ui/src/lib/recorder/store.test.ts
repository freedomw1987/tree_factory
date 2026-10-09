import { describe, expect, it, vi } from "vitest";

import { RecorderStore, type CaptureAdapter, type SessionClient } from "./store";

/**
 * M01-US-101 錄音 store（狀態機 + 真實資源的黏著層）。
 *
 * 這一層負責「狀態機不知道、但錯了會很嚴重」的事：
 * - 重複點「開始會議」不得開兩次麥克風；
 * - mic 3 秒沒起來要明說（AC-1），不得停在「好像錄到了」的狀態；
 * - 計時器在中斷時要凍結、復原後要接續（不得重置時間軸）；
 * - 到 2 小時上限要真的停止收音 + 通知伺服端（AC-6，權威在伺服端）。
 */

class FakeCapture implements CaptureAdapter {
  acquireCalls = 0;
  releaseCalls = 0;
  #behavior: () => Promise<void>;

  constructor(behavior: () => Promise<void> = async () => {}) {
    this.#behavior = behavior;
  }

  setBehavior(behavior: () => Promise<void>): void {
    this.#behavior = behavior;
  }

  async acquire(): Promise<void> {
    this.acquireCalls += 1;
    await this.#behavior();
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class FakeSession implements SessionClient {
  startCalls = 0;
  stopReasons: string[] = [];
  /** TECH-009：讓 `start()` 丟錯（模擬伺服端拒絕：401／429／500）。 */
  failWith: unknown = null;
  #endsAtMs: number;

  constructor(endsAtMs = 7_200_000) {
    this.#endsAtMs = endsAtMs;
  }

  async start(): Promise<{ startedAtMs: number; endsAtMs: number }> {
    this.startCalls += 1;
    if (this.failWith !== null) throw this.failWith;
    return { startedAtMs: 0, endsAtMs: this.#endsAtMs };
  }

  async stop(reason: "user" | "limit" | "aborted"): Promise<void> {
    this.stopReasons.push(reason);
  }
}

function makeStore(options: { capture?: FakeCapture; session?: FakeSession; clock?: { t: number } } = {}) {
  const capture = options.capture ?? new FakeCapture();
  const session = options.session ?? new FakeSession();
  const clock = options.clock ?? { t: 0 };
  const store = new RecorderStore({
    now: () => clock.t,
    capture,
    session,
    startTimeoutMs: 3_000,
  });
  return { store, capture, session, clock };
}

describe("M01-US-101 錄音 store", () => {
  it("M01-Given idle When 開始成功 Then 開 session + 取得麥克風各一次，狀態 recording、計時從 0 起、剩餘 2:00:00", async () => {
    const { store, capture, session } = makeStore();
    await store.start();
    const s = store.snapshot;
    expect(session.startCalls).toBe(1);
    expect(capture.acquireCalls).toBe(1);
    expect(s.state).toBe("recording");
    expect(s.pending).toBe(false);
    expect(s.elapsedMs).toBe(0);
    expect(s.remainingMs).toBe(7_200_000);
  });

  it("M01-Given 正在等 mic（pending）When 連點第二次開始 Then 不得再開第二個麥克風", async () => {
    const capture = new FakeCapture(() => new Promise<void>(() => {})); // 永不 resolve：模擬慢速授權
    const { store } = makeStore({ capture });
    void store.start();
    await store.start();
    expect(capture.acquireCalls).toBe(1);
  });

  it("M01-Given 權限被拒 When 開始 Then 狀態回 idle、給 PERMISSION_DENIED 說明、釋放資源並中止 session", async () => {
    const capture = new FakeCapture(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    const { store, session } = makeStore({ capture });
    await store.start();
    const s = store.snapshot;
    expect(s.state).toBe("idle");
    expect(s.pending).toBe(false);
    expect(s.notice?.code).toBe("PERMISSION_DENIED");
    expect(s.notice?.settingsLink).toBe(true);
    expect(capture.releaseCalls).toBeGreaterThan(0);
    expect(session.stopReasons).toContain("aborted");
  });

  it("TECH-009 AC-6：伺服端拒絕（401）When 開始 Then 明說 SESSION_REJECTED、回 idle，且把錯誤往上拋給呼叫端", async () => {
    // 為什麼要「往上拋」：401 的文案（裝置授權已失效／請重新配對）屬 UI 層，
    // store 不該知道那些字。它只要把「這是伺服端拒絕」講清楚，並讓呼叫端能分辨。
    const session = new FakeSession();
    session.failWith = Object.assign(new Error("裝置授權已失效"), { status: 401, code: "AUTH_INVALID" });
    const capture = new FakeCapture();
    const { store } = makeStore({ capture, session });
    await expect(store.start()).rejects.toThrow("裝置授權已失效");
    const s = store.snapshot;
    expect(s.state).toBe("idle");
    expect(s.pending).toBe(false);
    expect(s.notice?.code).toBe("SESSION_REJECTED");
    // 最關鍵的一條：不得把「伺服端拒絕」講成裝置問題——那會叫使用者去關掉別的錄音 App。
    expect(s.notice?.code).not.toBe("DEVICE_UNAVAILABLE");
    expect(capture.acquireCalls).toBe(0);
  });

  it("TECH-009 AC-6：麥克風權限被拒**不**往上拋（那條路已經有阻斷頁，拋出去只會多一句重複的 toast）", async () => {
    const capture = new FakeCapture(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    const { store } = makeStore({ capture });
    await expect(store.start()).resolves.toBeUndefined();
  });

  it("M01-Given mic 3 秒沒起來 When 超過 3 秒 Then 明說 START_TIMEOUT、狀態回 idle、不限於靜默等待（AC-1）", async () => {
    vi.useFakeTimers();
    try {
      const capture = new FakeCapture(() => new Promise<void>(() => {}));
      const { store } = makeStore({ capture });
      void store.start();
      await vi.advanceTimersByTimeAsync(3_001);
      const s = store.snapshot;
      expect(s.state).toBe("idle");
      expect(s.notice?.code).toBe("START_TIMEOUT");
      expect(s.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M01-Given 錄音中 When 切背景 Then 計時凍結、缺口只標一次；回到前景續錄後時間軸接續（不得重置）", async () => {
    const { store, clock } = makeStore();
    await store.start();
    clock.t = 10_000;
    expect(store.snapshot.elapsedMs).toBe(10_000);
    store.notifyVisibility(true);
    expect(store.snapshot.state).toBe("interrupted");
    expect(store.snapshot.gapMarked).toBe(1);
    store.notifyVisibility(true); // 同段不得重複標記
    expect(store.snapshot.gapMarked).toBe(1);
    clock.t = 40_000; // 中斷期間經過 30 秒
    expect(store.snapshot.elapsedMs).toBe(10_000); // 凍結：不得跟著跳
    await store.resume();
    expect(store.snapshot.state).toBe("recording");
    expect(store.snapshot.elapsedMs).toBe(40_000); // 接續：不重置，也不把中斷期間算進去
  });

  it("M01-Given 錄音中 When 達到 2 小時上限 Then 自動熄燈、停止收音、通知伺服端（AC-6）", async () => {
    const { store, capture, session, clock } = makeStore();
    await store.start();
    clock.t = 300_000; // 剩 1:55:00
    store.tick();
    expect(store.snapshot.remainingMs).toBe(6_900_000);
    expect(store.snapshot.warn).toBe(false);
    clock.t = 6_900_000; // 剩 5:00 → 黃橫幅，紅燈仍亮
    store.tick();
    expect(store.snapshot.warn).toBe(true);
    expect(store.snapshot.state).toBe("recording");
    clock.t = 7_200_000; // 到點
    store.tick();
    const s = store.snapshot;
    expect(s.state).toBe("limit_reached");
    expect(s.notice?.code).toBe("LIMIT_REACHED");
    expect(s.remainingMs).toBe(0);
    expect(capture.releaseCalls).toBeGreaterThan(0);
    expect(session.stopReasons).toContain("limit");
  });

  it("M01-Given 已達上限 When 使用者想續錄 Then 不得重新取得麥克風（不得延長）", async () => {
    const { store, capture, clock } = makeStore();
    await store.start();
    clock.t = 7_200_000;
    store.tick();
    const before = capture.acquireCalls;
    await store.resume();
    expect(store.snapshot.state).toBe("limit_reached");
    expect(capture.acquireCalls).toBe(before);
  });

  it("M01-Given 錄音中 When 使用者結束會議 Then 回 idle、停止收音、保留 session（reason=user）", async () => {
    const { store, capture, session } = makeStore();
    await store.start();
    await store.stopByUser();
    expect(store.snapshot.state).toBe("idle");
    expect(capture.releaseCalls).toBeGreaterThan(0);
    expect(session.stopReasons).toContain("user");
  });

  it("M01-Given 中斷（計時凍結）When 讀 wallClockElapsedMs Then 仍跟著牆鐘前進（缺口長度才不會被記成 0）", async () => {
    // M01-US-107 D7 + Gate 4 F1：缺口長度 = 真的中斷了多久。`snapshot.elapsedMs` 中斷時凍結（刻意），
    // 所以缺口追蹤必須讀這個「不受狀態影響」的牆鐘值：12 秒時切背景、3 分鐘後才回來，缺口就是 3 分鐘。
    const { store, clock } = makeStore();
    await store.start();
    clock.t = 12_000;
    store.notifyVisibility(true);
    clock.t = 192_000; // 3 分鐘後回到前景（還沒按續錄）
    expect(store.snapshot.state).toBe("interrupted");
    expect(store.snapshot.elapsedMs).toBe(12_000); // 凍結：畫面時鐘不跳
    expect(store.wallClockElapsedMs).toBe(192_000);
    await store.resume();
    expect(store.wallClockElapsedMs).toBe(192_000); // 續錄後兩者一致
    expect(store.snapshot.elapsedMs).toBe(192_000);
  });

  it("M01-Given 錄音中 When 訂閱者存在 Then 每次狀態變化都被通知（UI 不得靠輪詢猜狀態）", async () => {
    const { store, clock } = makeStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.state));
    await store.start();
    store.notifyVisibility(true);
    clock.t = 7_200_000;
    store.tick();
    unsubscribe();
    expect(seen).toEqual(["recording", "interrupted", "limit_reached"]);
  });
});
