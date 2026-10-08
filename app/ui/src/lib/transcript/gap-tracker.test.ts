import { describe, expect, it } from "vitest";

import { GapTracker, createLocalGapStorage, listPendingGapMeetings, type GapApi, type GapRecord, type GapStorage, type TranscriptGap } from "./gap-tracker";

/**
 * M01-US-107：缺口追蹤器的單元測試。
 *
 * 這裡是 AC-1 / AC-3 的主戰場：`hidden` 當下就要有一筆（而且只有一筆），
 * 離線不得丟、重開不得重算 seq（重算會讓伺服端把新缺口當成重送而丟掉）。
 */

class FakeStorage implements GapStorage {
  records: GapRecord[] = [];
  writes = 0;

  read(): GapRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  write(gaps: GapRecord[]): void {
    this.writes += 1;
    this.records = gaps.map((record) => ({ ...record }));
  }
}

class FakeApi implements GapApi {
  readonly written: Array<{ seq: number; fromMs: number; toMs: number | null }> = [];
  server: TranscriptGap[] = [];
  failWrites = false;
  failList = false;
  conflictSeqs: number[] = [];
  permanentSeqs: number[] = [];

  async writeGap(input: { seq: number; fromMs: number; toMs: number | null }): Promise<void> {
    if (this.failWrites) throw new Error("NETWORK");
    if (this.conflictSeqs.includes(input.seq)) {
      const error = new Error("同 seq 但中斷起點不同") as Error & { code: string };
      error.code = "GAP_CONFLICT";
      throw error;
    }
    if (this.permanentSeqs.includes(input.seq)) {
      const error = new Error("伺服端不再接受這筆缺口（SESSION_ENDED）") as Error & { code: string };
      error.code = "PERMANENT";
      throw error;
    }
    this.written.push({ ...input });
    const existing = this.server.find((gap) => gap.seq === input.seq);
    if (existing === undefined) {
      this.server.push({ ...input });
    } else if (input.toMs !== null) {
      existing.toMs = existing.toMs === null ? input.toMs : Math.max(existing.toMs, input.toMs);
    }
  }

  async listGaps(): Promise<TranscriptGap[]> {
    if (this.failList) throw new Error("NETWORK");
    return this.server.map((gap) => ({ ...gap }));
  }
}

function makeTracker(options: { storage?: FakeStorage; api?: FakeApi; elapsed?: () => number } = {}): {
  tracker: GapTracker;
  storage: FakeStorage;
  api: FakeApi;
  changes: GapRecord[][];
  setElapsed: (ms: number) => void;
} {
  const storage = options.storage ?? new FakeStorage();
  const api = options.api ?? new FakeApi();
  let elapsed = 0;
  const changes: GapRecord[][] = [];
  const tracker = new GapTracker({
    api,
    storage,
    elapsedMs: options.elapsed ?? (() => elapsed),
    onChange: (gaps) => changes.push(gaps.map((gap) => ({ ...gap }))),
  });
  return { tracker, storage, api, changes, setElapsed: (ms) => (elapsed = ms) };
}

describe("M01-US-107 本機儲存與待補送掃描", () => {
  function fakeLocalStorage(seed: Record<string, string> = {}): Pick<Storage, "length" | "key" | "getItem"> {
    const map = new Map(Object.entries(seed));
    return {
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
    };
  }

  it("M01-Given 本機有未同步的缺口 When 重開掃描 Then 只有還沒送出去的會議被選中", () => {
    const storage = fakeLocalStorage({
      "tree_factory.transcript-gaps.v1:m-pending": JSON.stringify([
        { seq: 1, fromMs: 1_000, toMs: null, synced: false },
      ]),
      "tree_factory.transcript-gaps.v1:m-done": JSON.stringify([
        { seq: 1, fromMs: 1_000, toMs: 2_000, synced: true },
      ]),
      "tree_factory.meetings.v1": "[]",
    });
    expect(listPendingGapMeetings(storage)).toEqual(["m-pending"]);
  });

  it("M01-Given 只剩 terminal（永久送不出去）的缺口 When 掃描 Then 不算待補送（不然每次啟動都白試一次 409）", () => {
    const storage = fakeLocalStorage({
      "tree_factory.transcript-gaps.v1:m-terminal": JSON.stringify([
        { seq: 1, fromMs: 1_000, toMs: 2_000, synced: false, terminal: true },
      ]),
      "tree_factory.transcript-gaps.v1:m-pending": JSON.stringify([
        { seq: 1, fromMs: 1_000, toMs: null, synced: false },
      ]),
    });
    expect(listPendingGapMeetings(storage)).toEqual(["m-pending"]);
  });

  it("M01-Given 本機資料壞掉（亂碼 / 不是陣列）When 掃描 Then 不丟錯，當成沒有缺口", () => {
    const storage = fakeLocalStorage({
      "tree_factory.transcript-gaps.v1:m-bad": "{ not json",
      "tree_factory.transcript-gaps.v1:m-weird": JSON.stringify([{ seq: 0, fromMs: -1, synced: false }]),
    });
    expect(listPendingGapMeetings(storage)).toEqual([]);
  });

  it("M01-Given 沒有 localStorage（隱私模式）When 掃描 Then 回空陣列而不是爆掉", () => {
    expect(listPendingGapMeetings(undefined)).toEqual([]);
  });
});

describe("M01-US-107 GapTracker", () => {
  it("M01-Given 正在錄音 When hidden 當下 Then 立刻有一筆未閉合缺口（AC-1）", async () => {
    const { tracker, storage, api, changes, setElapsed } = makeTracker();
    setElapsed(12_000);
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 12_000, toMs: null, synced: true }]);
    expect(storage.records).toHaveLength(1);
    expect(api.written).toEqual([{ seq: 1, fromMs: 12_000, toMs: null }]);
    expect(changes.at(-1)).toHaveLength(1);
  });

  it("M01-Given 同一次中斷 When hidden 重複觸發 Then 不得新增第二筆（AC-3）", async () => {
    const { tracker, api, setElapsed } = makeTracker();
    setElapsed(5_000);
    await tracker.handleHidden();
    setElapsed(9_000); // iOS webview 會晚一點再送一次
    await tracker.handleHidden();
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 5_000, toMs: null, synced: true }]);
    expect(api.written).toHaveLength(1);
  });

  it("M01-Given 未閉合缺口 When 回到前台 Then 補上 toMs；再次中斷則是新的一筆", async () => {
    const { tracker, api, setElapsed } = makeTracker();
    setElapsed(10_000);
    await tracker.handleHidden();
    setElapsed(18_000);
    await tracker.handleVisible();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 10_000, toMs: 18_000, synced: true }]);
    setElapsed(40_000);
    await tracker.handleHidden();
    expect(tracker.gaps().map((gap) => gap.seq)).toEqual([1, 2]);
    expect(tracker.gaps().at(-1)).toEqual({ seq: 2, fromMs: 40_000, toMs: null, synced: true });
    expect(api.written.at(-1)).toEqual({ seq: 2, fromMs: 40_000, toMs: null });
  });

  it("M01-Given 回到前景但沒有未閉合缺口 When handleVisible 再來一次 Then 不做任何事（不亂關、不重送）", async () => {
    const { tracker, api, setElapsed } = makeTracker();
    setElapsed(3_000);
    await tracker.handleHidden();
    setElapsed(9_000);
    await tracker.handleVisible();
    // 收尾用的是**呼叫當下**的 elapsed（不是 hidden 的 3_000）：這裡的 9_000 代表
    // 「真的過了 6 秒」。上層傳進來的必須是牆鐘值，不然缺口會變成 0 秒（Gate 4 F1）。
    await tracker.handleVisible();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 3_000, toMs: 9_000, synced: true }]);
    // 一次「開」＋一次「閉」＝ 2 次；第二次 visible 不得再多送（它根本沒在開著）。
    expect(api.written).toEqual([
      { seq: 1, fromMs: 3_000, toMs: null },
      { seq: 1, fromMs: 3_000, toMs: 9_000 },
    ]);
  });

  it("M01-Given hidden 當下離線 When 補送失敗 Then 本機仍在且標記未同步，恢復連線後補送", async () => {
    const { tracker, storage, api, setElapsed } = makeTracker();
    api.failWrites = true;
    setElapsed(7_000);
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 7_000, toMs: null, synced: false }]);
    expect(storage.records).toEqual([{ seq: 1, fromMs: 7_000, toMs: null, synced: false }]);

    api.failWrites = false;
    await tracker.sync();
    expect(api.written).toEqual([{ seq: 1, fromMs: 7_000, toMs: null }]);
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 7_000, toMs: null, synced: true }]);
  });

  it("M01-Given 本機已有 seq 1..3（被殺掉過）When 重開後再中斷 Then 新缺口用 seq 4（不重算）", async () => {
    const storage = new FakeStorage();
    storage.records = [
      { seq: 1, fromMs: 1_000, toMs: 2_000, synced: true },
      { seq: 2, fromMs: 5_000, toMs: null, synced: false },
      { seq: 3, fromMs: 6_000, toMs: 7_000, synced: true },
    ];
    const { tracker, api, setElapsed } = makeTracker({ storage });
    await tracker.load();
    setElapsed(30_000);
    await tracker.handleHidden();
    expect(tracker.gaps().map((gap) => gap.seq)).toEqual([1, 2, 3, 4]);
    expect(tracker.gaps().at(-1)?.fromMs).toBe(30_000);
    // 被殺掉時留下的未閉合缺口（seq 2）要一起補送，不能只送新的那一筆。
    await tracker.sync();
    expect(api.written.map((item) => item.seq).sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it("M01-Given 伺服端有本機沒有的缺口（換裝置/清過本機）When sync Then 拉回來補齊", async () => {
    const api = new FakeApi();
    api.server = [
      { seq: 1, fromMs: 1_000, toMs: 4_000 },
      { seq: 2, fromMs: 9_000, toMs: null },
    ];
    const { tracker } = makeTracker({ api });
    await tracker.sync();
    expect(tracker.gaps()).toEqual([
      { seq: 1, fromMs: 1_000, toMs: 4_000, synced: true },
      { seq: 2, fromMs: 9_000, toMs: null, synced: true },
    ]);
  });

  it("M01-Given 離線 When sync（讀清單也失敗）Then 本機資料不得被清掉", async () => {
    const storage = new FakeStorage();
    storage.records = [{ seq: 1, fromMs: 2_000, toMs: 5_000, synced: false }];
    const api = new FakeApi();
    api.failWrites = true;
    api.failList = true;
    const { tracker } = makeTracker({ storage, api });
    await tracker.load();
    await tracker.sync();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 2_000, toMs: 5_000, synced: false }]);
    await tracker.sync(); // 再丟一次也不得炸
    expect(tracker.gaps()).toHaveLength(1);
  });

  it("M01-Given 本機的「結束時間」還沒被伺服端收下 When 對帳時伺服端仍說開著 Then 不得改判為已同步（不然畫面說有結束、伺服端說未知）", async () => {
    // 這個組合真的會發生：hidden 時開啟缺口成功（伺服端有那筆、toMs=null），
    // 回到前景要補 toMs 時遇上「會議已結束 / 上限到點」而被 409 拒收，
    // 之後 sync() 先 push（同樣失敗）再 list（成功）——若這裡把 synced 改成 true，
    // 那個 toMs 就永遠不會再送，使用者在畫面上看到一個伺服端並不存在的結束時間。
    const storage = new FakeStorage();
    storage.records = [{ seq: 1, fromMs: 1_000, toMs: 8_000, synced: false }];
    const api = new FakeApi();
    api.failWrites = true;
    api.server = [{ seq: 1, fromMs: 1_000, toMs: null }];
    const { tracker } = makeTracker({ storage, api });
    await tracker.load();
    await tracker.sync();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 1_000, toMs: 8_000, synced: false }]);
  });

  it("M01-Given 本機已閉合、伺服端還開著 When sync Then 以較長的範圍為準（不縮短）", async () => {
    const storage = new FakeStorage();
    storage.records = [{ seq: 1, fromMs: 1_000, toMs: 8_000, synced: true }];
    const api = new FakeApi();
    api.server = [{ seq: 1, fromMs: 1_000, toMs: null }];
    const { tracker } = makeTracker({ storage, api });
    await tracker.load();
    await tracker.sync();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 1_000, toMs: 8_000, synced: true }]);
  });

  it("M01-Given 伺服端說同 seq 不同起點（409 GAP_CONFLICT）When push Then 停止重送並誠實標示", async () => {
    const api = new FakeApi();
    api.conflictSeqs = [1];
    const { tracker, storage, setElapsed } = makeTracker({ api });
    setElapsed(4_000);
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 4_000, toMs: null, synced: true, conflict: true }]);
    expect(storage.records[0]?.conflict).toBe(true);
    await tracker.sync();
    expect(api.written).toEqual([]); // 永久性錯誤不再打伺服端
  });

  it("M01-Given 本機與伺服端同 seq 但起點不同 When sync（拉回來）Then 以伺服端為準並標示衝突", async () => {
    const storage = new FakeStorage();
    storage.records = [{ seq: 1, fromMs: 4_000, toMs: null, synced: true }];
    const api = new FakeApi();
    api.server = [{ seq: 1, fromMs: 9_000, toMs: 12_000 }];
    const { tracker } = makeTracker({ storage, api });
    await tracker.load();
    await tracker.sync();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 9_000, toMs: 12_000, synced: true, conflict: true }]);
  });

  it("M01-Given 同 seq 但起點不同、且伺服端那筆還開著 When sync Then 整筆用伺服端那份（不得拼出 toMs < fromMs）", async () => {
    // Gate 4 F2：舊寫法把「伺服端的 fromMs」＋「本機的 toMs」拼起來，會生出兩邊都沒有的區間，
    // 甚至 toMs < fromMs（伺服端自己保證 toMs >= fromMs），畫面就變成「20:00 – 09:06」這種鬼區間。
    const storage = new FakeStorage();
    storage.records = [{ seq: 1, fromMs: 9_000, toMs: 9_100, synced: false }];
    const api = new FakeApi();
    api.conflictSeqs = [1]; // 真的伺服端會 409（FakeApi 不校驗，這裡手動讓它跟真的行為一致）
    api.server = [{ seq: 1, fromMs: 20_000, toMs: null }];
    const { tracker } = makeTracker({ storage, api });
    await tracker.load();
    await tracker.sync();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 20_000, toMs: null, synced: true, conflict: true }]);
    const [gap] = tracker.gaps();
    expect(gap!.toMs === null || gap!.toMs >= gap!.fromMs).toBe(true);
  });

  it("M01-Given 伺服端已結束這一場（409 SESSION_ENDED）When push Then 保留本機但標 terminal 且不再重試", async () => {
    const api = new FakeApi();
    api.permanentSeqs = [1];
    const { tracker, storage, setElapsed } = makeTracker({ api });
    setElapsed(6_000);
    await tracker.handleHidden();
    expect(tracker.gaps()).toEqual([{ seq: 1, fromMs: 6_000, toMs: null, synced: false, terminal: true }]);
    expect(storage.records[0]?.terminal).toBe(true);

    await tracker.sync();
    await tracker.sync();
    expect(api.written).toEqual([]); // 永久性：一次都不該再打伺服端
    // 本機那筆不能因為「送不出去」就被刪掉：使用者已經看過「這段未錄到」。
    expect(tracker.gaps()).toHaveLength(1);
  });

  it("M01-Given sync 之後 When 再 sync Then 已同步的不得重送（不吵伺服端）", async () => {
    const { tracker, api, setElapsed } = makeTracker();
    setElapsed(2_000);
    await tracker.handleHidden();
    await tracker.sync();
    await tracker.sync();
    expect(api.written).toHaveLength(1);
  });
});