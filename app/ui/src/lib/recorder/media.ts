/**
 * M01-US-101 真實麥克風 adapter（把瀏覽器/Tauri webview 的收音包成 `CaptureAdapter`）。
 *
 * v1 的誠實前提（SPIKE-002）：webview 一進背景/鎖屏就停止收音，所以這一層**不做**背景續錄。
 * 它只負責：
 * 1. `acquire()` 真的拿到麥克風（失敗時把瀏覽器錯誤名稱原樣往上拋，讓 store 分類成
 *    「權限被拒 / 裝置不可用」並給使用者說明 —— AC-3 不得靜默失敗）。
 * 2. `release()` 真的放掉（停 recorder、停 tracks），避免紅燈熄了麥克風卻還開著。
 *
 * 錄下來的音訊在 v1 只留在本地（分段落盤是 M01-US-102）；這裡先建立 MediaRecorder
 * 以確保串流真的活著（也能讓 iOS 的收音指示燈行為可觀察）。
 */

import type { CaptureAdapter } from "./store";

export interface MediaRecorderCaptureOptions {
  /** 錄音 mimeType；iOS Safari 15+ 支援 audio/mp4。 */
  mimeType?: string;
  /** 收到資料時的通知（M01-US-102 會拿它落盤/上傳；現在只做為生命週期證據）。 */
  onChunk?: (chunk: Blob) => void;
}

export class MediaRecorderCapture implements CaptureAdapter {
  readonly #options: MediaRecorderCaptureOptions;
  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;

  constructor(options: MediaRecorderCaptureOptions = {}) {
    this.#options = options;
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
    this.#recorder = this.#startRecorder(stream);
  }

  release(): void {
    const recorder = this.#recorder;
    this.#recorder = null;
    if (recorder !== null && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // 已經停掉就算了：這裡的目標是「不要留著開著的麥克風」。
      }
    }
    const stream = this.#stream;
    this.#stream = null;
    for (const track of stream?.getAudioTracks() ?? []) track.stop();
  }

  #startRecorder(stream: MediaStream): MediaRecorder | null {
    if (typeof MediaRecorder === "undefined") return null;
    const options =
      this.#options.mimeType === undefined ? undefined : { mimeType: this.#options.mimeType };
    let recorder: MediaRecorder;
    try {
      recorder = options === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, options);
    } catch {
      // 有些環境不支援指定 mimeType；退回預設值（收音本身不受影響）。
      recorder = new MediaRecorder(stream);
    }
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.#options.onChunk?.(event.data);
    });
    recorder.start(1_000); // 每秒一個 chunk（US-102 的分段緩存會用到）
    return recorder;
  }
}
