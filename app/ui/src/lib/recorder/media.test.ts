// M01-US-102：MediaRecorder 分段（每 30 秒 stop/start，每段都是獨立可解碼的檔）。
//
// 這裡用假的 MediaRecorder / 假 timer 驗「輪替契約」：
//   - 每段收尾都會發出一個帶 seq 的 Blob（seq 從 1 遞增，對應伺服端冪等鍵）。
//   - 輪替時**先停舊段、再開新段**（不能先開新的：同一條 stream 上兩個 recorder 並存，
//     iOS 的實作不保證誰錄到什麼）。
//   - release() 會把最後一段收尾發出（使用者按下結束不該弄丟最後 29 秒）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRecorderCapture } from "./media";

// Node 22 的 `globalThis.navigator` 是唯讀 getter，但這張票要注入假的 mediaDevices。
// 先把它降級成可覆寫的普通屬性（只影響測試程序，不動產品程式碼）。
Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });

class FakeTrack {
  readonly kind = "audio";
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeStream {
  readonly #tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.#tracks = tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.#tracks;
  }
}

type Listener = (event: { data: Blob }) => void;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  /** 真實瀏覽器的 dataavailable 是**非同步**回來的；要驗「換段後才收到舊段位元組」時開這個。 */
  static deferEmits = false;
  static pendingEmits: Array<() => void> = [];
  state: "inactive" | "recording" = "inactive";
  readonly #listeners = new Map<string, Listener[]>();
  /** 下一次 stop() 要吐出的內容（每個實例一份，模擬真實每段一個檔）。 */
  payload: Blob = new Blob(["segment"]);

  constructor(_stream: unknown, _options?: unknown) {
    FakeMediaRecorder.instances.push(this);
  }

  static flushEmits(): void {
    const queue = FakeMediaRecorder.pendingEmits;
    FakeMediaRecorder.pendingEmits = [];
    for (const emit of queue) emit();
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const emit = (): void => {
      for (const listener of this.#listeners.get("dataavailable") ?? []) listener({ data: this.payload });
    };
    if (FakeMediaRecorder.deferEmits) FakeMediaRecorder.pendingEmits.push(emit);
    else emit();
  }
}

interface TimerHandle {
  handler: () => void;
  delayMs: number;
  cancelled: boolean;
}

describe("M01-US-102 MediaRecorderCapture 分段", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.deferEmits = false;
    FakeMediaRecorder.pendingEmits = [];
  });

  afterEach(() => {
    // 不要把假的全域留在其他測試裡。
    Reflect.deleteProperty(globalThis as object, "MediaRecorder");
    Reflect.deleteProperty(globalThis as object, "navigator");
  });

  it("M01-Given 開始收音 When acquire Then 開啟 1 個 recorder 並排定換段（seq 從 1 起）", async () => {
    const timers: TimerHandle[] = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: (handle) => {
        const timer = timers[handle as number];
        if (timer !== undefined) timer.cancelled = true;
      },
      now: () => 0,
    });
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack()]) } },
    });

    await capture.acquire();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
    expect(timers[0]?.delayMs).toBe(1_000);
  });

  it("M01-Given 錄到換段時間 When timer 觸發 Then 舊段被收尾發出（seq=1）且新段立刻開始", async () => {
    const timers: TimerHandle[] = [];
    const emitted: Array<{ seq: number; size: number }> = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      onChunk: (chunk) => emitted.push({ seq: chunk.seq, size: chunk.blob.size }),
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: (handle) => {
        const timer = timers[handle as number];
        if (timer !== undefined) timer.cancelled = true;
      },
      now: () => 0,
    });
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack()]) } },
    });

    await capture.acquire();
    FakeMediaRecorder.instances[0]!.payload = new Blob(["first-segment"]);
    timers[0]!.handler();

    expect(emitted).toEqual([{ seq: 1, size: 13 }]);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1]?.state).toBe("recording");

    FakeMediaRecorder.instances[1]!.payload = new Blob(["second"]);
    timers[1]!.handler();
    expect(emitted.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("M01-Given 第二輪換段後使用者按下結束 When release Then 最後一段也發出、timer 被取消、麥克風放掉", async () => {
    const timers: TimerHandle[] = [];
    const emitted: number[] = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      onChunk: (chunk) => emitted.push(chunk.seq),
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: (handle) => {
        const timer = timers[handle as number];
        if (timer !== undefined) timer.cancelled = true;
      },
      now: () => 0,
    });
    const stream = new FakeStream([new FakeTrack()]);
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
    });

    await capture.acquire();
    timers[0]!.handler();
    capture.release();

    expect(emitted).toEqual([1, 2]);
    expect(timers[1]?.cancelled).toBe(true);
    expect(stream.getAudioTracks()[0]?.readyState).toBe("ended");
  });

  it("M01-Given 已經 release When 舊 timer 又觸發 Then 不再開新段（不可偷偷重啟麥克風）", async () => {
    const timers: TimerHandle[] = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: () => {},
      now: () => 0,
    });
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack()]) } },
    });

    await capture.acquire();
    capture.release();
    const before = FakeMediaRecorder.instances.length;
    timers[0]!.handler();
    expect(FakeMediaRecorder.instances).toHaveLength(before);
  });

  // ↓ 這兩條是 Gate 4 審查抓到的 P0（media.ts 曾在 acquire() 把 seq 歸零）的回歸探針。
  //   為什麼一定要有：US-101 AC-4「切到背景 → 回來續錄」＝ release() → acquire()，
  //   若 seq 重用，續錄後的第一段會撞上已 ack 的 seq → 本機新音檔被當成「伺服端已有」刪掉（靜默丟音）。
  it("M01-Given 切背景中斷後續錄 When 同一實例 acquire 第二次 Then seq 從上次接續（不得歸零重用）", async () => {
    const timers: TimerHandle[] = [];
    const emitted: number[] = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      onChunk: (chunk) => emitted.push(chunk.seq),
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: (handle) => {
        const timer = timers[handle as number];
        if (timer !== undefined) timer.cancelled = true;
      },
      now: () => 0,
    });
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack()]) } },
    });

    await capture.acquire();
    timers[0]!.handler(); // 換段 → 發出 seq=1
    capture.release(); // 切到背景：收尾 seq=2、放掉麥克風
    await capture.acquire(); // 回到前景：續錄
    timers[2]!.handler(); // 續錄後的第一次換段

    expect(emitted).toEqual([1, 2, 3]);
  });

  it("M01-Given 換段後舊段的 dataavailable 才回來 When 收尾 Then startedAtMs 仍是舊段自己的開始時間", async () => {
    let clock = 0;
    const timers: TimerHandle[] = [];
    const emitted: Array<{ seq: number; startedAtMs: number }> = [];
    const capture = new MediaRecorderCapture({
      chunkMs: 1_000,
      onChunk: (chunk) => emitted.push({ seq: chunk.seq, startedAtMs: chunk.startedAtMs }),
      setTimer: (handler, delayMs) => {
        timers.push({ handler, delayMs, cancelled: false });
        return timers.length - 1;
      },
      clearTimer: (handle) => {
        const timer = timers[handle as number];
        if (timer !== undefined) timer.cancelled = true;
      },
      now: () => clock,
    });
    Object.assign(globalThis, {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack()]) } },
    });

    await capture.acquire(); // 第 1 段自 0ms 起
    clock = 1_000;
    FakeMediaRecorder.deferEmits = true; // 舊段位元組延後回來（真實瀏覽器行為）
    timers[0]!.handler(); // 換段：第 2 段自 1000ms 起
    expect(emitted).toEqual([]);
    clock = 1_500;
    FakeMediaRecorder.flushEmits();

    expect(emitted).toEqual([{ seq: 1, startedAtMs: 0 }]);
  });
});
