/**
 * M01-US-101/US-102：真實麥克風 adapter（把瀏覽器/Tauri webview 的收音包成 `CaptureAdapter`）。
 *
 * v1 的誠實前提（SPIKE-002）：webview 一進背景/鎖屏就停止收音，所以這一層**不做**背景續錄。
 * 它負責：
 * 1. `acquire()` 真的拿到麥克風（失敗時把瀏覽器錯誤名稱原樣往上拋，讓 store 分類成
 *    「權限被拒 / 裝置不可用」並給使用者說明 —— AC-3 不得靜默失敗）。
 * 2. `release()` 真的放掉（停 recorder、停 tracks），避免紅燈熄了麥克風卻還開著。
 * 3. **M01-US-102：每 30 秒 stop/start 一次**，讓每個分段都是「獨立可解碼的檔」。
 *    為什麼不沿用 `start(timeslice)`：timeslice 吐的是同一個容器的片段，單獨一段解不開，
 *    也就無法達到 AC-1 的「上傳成功才刪」（刪掉的片段不能當成一段音訊重建）。
 *    代價是換段處有 < 100ms 的空隙——這是已知限制，缺口由 M01-US-107 標記。
 */

import { CHUNK_DURATION_MS } from "./chunk-plan";
import type { CaptureAdapter } from "./store";

export interface CaptureChunk {
  /** 1 起算＝伺服端冪等鍵（見設計 §2 D2）。 */
  seq: number;
  blob: Blob;
  /** 這一段開始錄的相對時間（毫秒；診斷用，不參與冪等）。 */
  startedAtMs: number;
}

export interface MediaRecorderCaptureOptions {
  /** 錄音 mimeType；iOS Safari 15+ 支援 audio/mp4。 */
  mimeType?: string;
  /** 分段長度（毫秒）；預設 30 秒（`CHUNK_DURATION_MS`）。 */
  chunkMs?: number;
  /** 一段收尾時的通知（落盤 + 上傳就掛在這裡）。 */
  onChunk?: (chunk: CaptureChunk) => void;
  /** 可注入的時鐘／排程器（測試用）。 */
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class MediaRecorderCapture implements CaptureAdapter {
  readonly #options: MediaRecorderCaptureOptions;
  readonly #now: () => number;
  readonly #setTimer: (handler: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #timer: unknown = null;
  /** 已落盤的分段數 = 下一個 seq（1 起算，伺服端冪等鍵）。 */
  #segmentSeq = 0;
  #segmentStartedAtMs = 0;

  constructor(options: MediaRecorderCaptureOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((handler, delayMs) => globalThis.setTimeout(handler, delayMs));
    this.#clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
  }

  /** 目前是否真的持有麥克風（測試與除錯用）。 */
  get active(): boolean {
    return this.#stream !== null && this.#stream.getAudioTracks().some((track) => track.readyState === "live");
  }

  async acquire(): Promise<void> {
    const media = globalThis.navigator?.mediaDevices;
    if (media === undefined || typeof media.getUserMedia !== "function") {
      // 非安全來源（http:// 非 localhost）或舊環境：明說原因，不要讓它變成「不知道為什麼錄不到」。
      throw Object.assign(new Error("這個環境沒有可用的麥克風 API（需要 https 或 localhost）"), {
        name: "NotReadableError",
      });
    }
    const stream = await media.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.#stream = stream;
    // ⚠️ 這裡**不可**把 `#segmentSeq` 歸零：同一個 capture 實例會被同一場會議重複 acquire
    // （US-101 AC-4「切到背景 → 回來續錄」就是 release() → acquire()）。歸零會讓續錄後的第一段
    // 又拿到 seq=1，而伺服端 seq=1 已經 ack／或本機 seq=1 已存在 → 舊音檔被覆蓋、或新音檔
    // 被當成「已 ack」直接刪掉（靜默遺失；正是 AC-1/AC-2 要防的事）。
    // 新會議會建立新的 capture 實例（app.svelte.ts confirmStart），所以全新場次仍是從 1 起算。
    this.#startSegment(stream);
  }

  release(): void {
    this.#clearRotationTimer();
    const recorder = this.#recorder;
    this.#recorder = null;
    if (recorder !== null && recorder.state !== "inactive") {
      try {
        // 先停 recorder 讓最後一段收尾（`stop` 事件會把剩下的位元組吐出來），再放掉麥克風。
        recorder.stop();
      } catch {
        // 已經停掉就算了：這裡的目標是「不要留著開著的麥克風」。
      }
    }
    const stream = this.#stream;
    this.#stream = null;
    for (const track of stream?.getAudioTracks() ?? []) track.stop();
  }

  /** 取消下一個換段排程（重複呼叫安全）。 */
  #clearRotationTimer(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  /** 開始一段新的錄音（新 MediaRecorder = 新的獨立容器）。 */
  #startSegment(stream: MediaStream): void {
    // 這一段的開始時間必須**在這裡固定住**：換段時 `#rotate()` 會先開新段（改寫 #segmentStartedAtMs）
    // 才讓舊 recorder 的 dataavailable 回來，讀欄位會拿到新段的時間（診斷時間軸會整段偏移）。
    const startedAtMs = this.#now();
    this.#segmentStartedAtMs = startedAtMs;
    const recorder = this.#createRecorder(stream);
    this.#recorder = recorder;
    // 每段都走「一段 recorder = 一個獨立可解碼檔」：因為沒有用 `start(timeslice)`，
    // `dataavailable` 只會在 `stop()` 時帶出**整個**分段，所以收尾就在這裡落地。
    // 為什麼不掛在 `stop` 事件：`stop` 的觸發時機在各家實作不同步（且不保證帶著資料），
    // 而真正可用的位元組在 `dataavailable`；以它為唯一的落盤點最誠實。
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size <= 0) return;
      this.#segmentSeq += 1;
      const blob = new Blob([event.data], { type: recorder.mimeType });
      this.#options.onChunk?.({ seq: this.#segmentSeq, blob, startedAtMs });
    });
    recorder.start();
    this.#scheduleRotation();
  }

  /** 依實際經過時間排下一次換段（有延遲時修正，避免累積漂移）。 */
  #scheduleRotation(): void {
    const chunkMs = this.#options.chunkMs ?? CHUNK_DURATION_MS;
    const elapsed = this.#now() - this.#segmentStartedAtMs;
    const delayMs = Math.max(chunkMs - elapsed, 0);
    this.#timer = this.#setTimer(() => this.#rotate(), delayMs);
  }

  /** 換段：**先停舊的**（收尾最後一段）**再開新的**（同一條 stream 不並存兩個 recorder）。 */
  #rotate(): void {
    this.#timer = null;
    const recorder = this.#recorder;
    if (recorder === null) return; // 已經 release 過了：不可偷偷重啟麥克風
    const stream = this.#stream;
    this.#recorder = null;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // 停不掉就不硬停：下面的新段仍會繼續錄，缺口由 M01-US-107 標記。
      }
    }
    if (stream === null) return;
    this.#startSegment(stream);
  }

  #createRecorder(stream: MediaStream): MediaRecorder {
    const options =
      this.#options.mimeType === undefined ? undefined : { mimeType: this.#options.mimeType };
    try {
      return options === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, options);
    } catch {
      // 有些環境不支援指定 mimeType；退回預設值（收音本身不受影響）。
      return new MediaRecorder(stream);
    }
  }
}
