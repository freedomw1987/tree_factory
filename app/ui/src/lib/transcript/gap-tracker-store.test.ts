import { describe, expect, it } from "vitest";

import { RecorderStore, type CaptureAdapter, type SessionClient } from "../recorder/store";
import { GapTracker, type GapApi, type GapRecord, type GapStorage, type TranscriptGap } from "./gap-tracker";

/**
 * M01-US-107 Gate 4 F4：**store × tracker 的接縫測試**。
 *
 * 為什麼需要這一層：缺口追蹤器本身只會「用你給它的 elapsed 收尾」，單獨測它永遠是綠的。
 * 真正會出錯的地方是接縫——`RecorderStore` 在中斷時刻意凍結 `snapshot.elapsedMs`
 * （畫面計時不跳），若缺口讀那個值，3 分鐘的中斷會被記成 0 秒，
 * 而且畫面跟伺服端帳本會「一致地說謊」。所以這裡把真的 store 和真的 GapTracker 接起來，
 * 用真的狀態轉移（`notifyVisibility` / `resume`）跑一次。
 *
 * 這裡的 orchestration 刻意跟 `app.svelte.ts` 一致（那支是 runes 檔，vitest 不宜載入）：
 * - hidden（且正在錄音）→ `handleHidden()`
 * - visible → **只** `sync()`，不關缺口（`state.ts` 的 `visibility_visible` 不自動續錄）
 * - 真的續錄（或結束會議 / 上限到點）→ `handleVisible()`
 */

class FakeCapture implements CaptureAdapter {
  async acquire(): Promise<void> {}
  release(): void {}
}

class FakeSession implements SessionClient {
  async start(): Promise<{ startedAtMs: number; endsAtMs: number }> {
    return { startedAtMs: 0, endsAtMs: 7_200_000 };
  }

  async stop(): Promise<void> {}
}

class FakeGapApi implements GapApi {
  readonly written: TranscriptGap[] = [];

  async writeGap(input: TranscriptGap): Promise<void> {
    this.written.push({ ...input });
  }

  async listGaps(): Promise<TranscriptGap[]> {
    return [];
  }
}

class FakeGapStorage implements GapStorage {
  records: GapRecord[] = [];

  read(): GapRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  write(gaps: GapRecord[]): void {
    this.records = gaps.map((record) => ({ ...record }));
  }
}

function makeWired(options: { elapsedOf?: (store: RecorderStore) => number } = {}) {
  const clock = { t: 0 };
  const store = new RecorderStore({
    now: () => clock.t,
    capture: new FakeCapture(),
    session: new FakeSession(),
    startTimeoutMs: 3_000,
  });
  const api = new FakeGapApi();
  const storage = new FakeGapStorage();
  const tracker = new GapTracker({
    api,
    storage,
    elapsedMs: () => (options.elapsedOf ?? ((s: RecorderStore) => s.wallClockElapsedMs))(store),
  });
  return { store, tracker, api, storage, clock };
}

describe("M01-US-107 store × tracker 接縫", () => {
  it("M01-Given 錄音 12 秒後切背景、3 分鐘後才續錄 When 收尾 Then 缺口長度是 3 分鐘（不是 0）", async () => {
    const { store, tracker, api, clock } = makeWired();
    await store.start();
    clock.t = 12_000;
    store.notifyVisibility(true);
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 12_000, toMs: null, synced: true }]);

    // 回到前景：只同步、不關缺口（錄音還沒恢復）。
    clock.t = 192_000;
    store.notifyVisibility(false);
    await tracker.sync();
    expect(tracker.gaps()[0]?.toMs).toBeNull();
    expect(api.written.at(-1)).toEqual({ seq: 1, fromMs: 12_000, toMs: null });

    // 使用者按下「繼續這場會議？」→ 才是真的結束中斷。
    await store.resume();
    await tracker.handleVisible();
    const [gap] = tracker.gaps();
    expect(gap?.toMs).toBe(192_000);
    expect((gap?.toMs ?? 0) - (gap?.fromMs ?? 0)).toBe(180_000);
  });

  it("M01-Given 中斷後直接結束會議 When 收尾 Then 缺口涵蓋整段中斷（中斷多久就記多久）", async () => {
    const { store, tracker, clock } = makeWired();
    await store.start();
    clock.t = 10_000;
    store.notifyVisibility(true);
    await tracker.handleHidden();

    clock.t = 70_000; // 中斷 60 秒後使用者直接長按結束
    await store.stopByUser();
    clock.t = 70_000;
    await tracker.handleVisible();
    const [gap] = tracker.gaps();
    expect(gap?.toMs).toBe(70_000);
    expect((gap?.toMs ?? 0) - (gap?.fromMs ?? 0)).toBe(60_000);
  });

  it("M01-Given 若把缺口接上凍結的 snapshot.elapsedMs、又在「回到前景」就收尾 When 收尾 Then 得到 0 長度且永遠補不回來（這就是 F1）", async () => {
    // 這條是防回歸的「反面教材」：把錯的接法留在測試裡，改壞時一眼看得出來。
    const { store, tracker, clock } = makeWired({ elapsedOf: (s) => s.snapshot.elapsedMs });
    await store.start();
    clock.t = 12_000;
    store.notifyVisibility(true);
    await tracker.handleHidden();

    // 舊行為：`visibility_visible` 就呼叫 handleVisible——但 state 還是 interrupted，
    // 所以 snapshot.elapsedMs 是凍結的 12_000，缺口被記成 0 秒。
    clock.t = 192_000;
    store.notifyVisibility(false);
    await tracker.handleVisible();
    expect(tracker.gaps()[0]?.toMs).toBe(12_000); // 凍結值
    expect((tracker.gaps()[0]?.toMs ?? 0) - (tracker.gaps()[0]?.fromMs ?? 0)).toBe(0);

    // 而且 #openSeq 已被清掉，真的續錄時再呼叫一次也救不回來：0 秒就永久定案。
    await store.resume();
    await tracker.handleVisible();
    expect(tracker.gaps()[0]?.toMs).toBe(12_000);
    expect((tracker.gaps()[0]?.toMs ?? 0) - (tracker.gaps()[0]?.fromMs ?? 0)).toBe(0);
  });
});
