/**
 * M01-US-102：把「分段 → 落盤 → 上傳 → ack 才刪」串成一條可測的管線，並提供恢復流程。
 *
 * 為什麼需要這一層（`ChunkUploader` 之上的薄殼）：
 * - `ChunkUploader` 需要呼叫端自己算 hash、自己帶 meetingId；在畫面裡做等於把
 *   「先落盤」的順序散在 UI 事件裡（見 uploader.ts 的說明）。這裡固定住順序。
 * - 恢復（AC-3）需要「換一個 app 生命週期之後，對著同一份本機儲存重建管線」；
 *   把它做成 `ChunkRecovery`，就能用「同一個 store、全新的 pipeline」在單元測試裡
 *   重現**程序被殺後重開**（斷電情境），不必真的開瀏覽器。
 *
 * 伺服端 ledger 仍是唯一權威（設計 §2 D4）：`ChunkRecovery.resume()` 不問使用者
 * 「哪些送過」，一律先讀帳本再決定要補哪些段。
 */

import { sha256Hex16 } from "./chunk-hash";
import { ChunkQueue } from "./chunk-queue";
import {
  ChunkUploader,
  type ChunkBlobStore,
  type ChunkUploadApi,
  type UploadOutcome,
} from "./uploader";

/** 一段剛收尾的音訊（seq 對應伺服端冪等鍵）。 */
export interface IncomingChunk {
  seq: number;
  blob: Blob;
}

export interface ChunkPipelineDeps {
  meetingId: string;
  store: ChunkBlobStore;
  api: ChunkUploadApi;
  queue?: ChunkQueue;
  now?: () => number;
}

/** 一場會議的即時上傳管線（單次生命週期內一個）。 */
export class ChunkPipeline {
  readonly #meetingId: string;
  readonly #uploader: ChunkUploader;

  constructor(deps: ChunkPipelineDeps) {
    this.#meetingId = deps.meetingId;
    this.#uploader = new ChunkUploader({
      store: deps.store,
      api: deps.api,
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  get meetingId(): string {
    return this.#meetingId;
  }

  /**
   * 一段收尾的完整處理：算指紋 → **先落盤** → 才嘗試上傳。
   * 上傳失敗不影響「已經在本機」這件事（AC-1），錯誤由 `outcome` 回報給畫面。
   */
  async ingest(chunk: IncomingChunk): Promise<UploadOutcome> {
    const hash = await sha256Hex16(await chunk.blob.arrayBuffer());
    await this.#uploader.save({ meetingId: this.#meetingId, seq: chunk.seq, hash, blob: chunk.blob });
    return this.#uploader.flush(this.#meetingId);
  }

  /** 補送目前為止還沒確認的分段（網路恢復、回到前景、定時器都可以呼叫）。 */
  async flush(): Promise<UploadOutcome> {
    return this.#uploader.flush(this.#meetingId);
  }

  /** 內容衝突的段（永久性問題；畫面必須照實說，不可假裝還在排隊）。 */
  conflictSeqs(): number[] {
    return this.#uploader.conflictSeqs();
  }

  /** 使用者明確選擇丟棄本機分段（AC-3：只有明確指令才丟，不得自動丟棄）。 */
  async discard(): Promise<void> {
    await this.#uploader.discard(this.#meetingId);
  }
}

/** 恢復畫面的輸入：哪場會議還留著幾段。 */
export interface RecoveryEntry {
  meetingId: string;
  pending: number;
}

export interface ChunkRecoveryDeps {
  store: ChunkBlobStore;
  /** false = 本機儲存只在記憶體（不可宣稱有備份，見 chunk-store.ts）。 */
  durable: boolean;
  /** 依會議 id 取得「該場會議」的上傳 API（正式環境＝新的 HttpSessionClient）。 */
  apiFor(meetingId: string): ChunkUploadApi;
  now?: () => number;
}

/**
 * 斷電 / app 被殺之後的恢復入口。
 *
 * 兩個對外動作刻意分開（AC-3）：
 * - `resume()`：送未確認的段（伺服端冪等，重送安全）。
 * - `discard()`：**只有使用者明確選擇**才會刪本機檔；這裡不做任何自動清理。
 */
export class ChunkRecovery {
  readonly #deps: ChunkRecoveryDeps;

  constructor(deps: ChunkRecoveryDeps) {
    this.#deps = deps;
  }

  get durable(): boolean {
    return this.#deps.durable;
  }

  /** 掃本機儲存，列出還有未確認分段的會議（恢復畫面的資料源）。 */
  async scan(): Promise<RecoveryEntry[]> {
    const entries: RecoveryEntry[] = [];
    for (const meetingId of await this.#deps.store.meetings()) {
      const items = await this.#deps.store.list(meetingId);
      if (items.length > 0) entries.push({ meetingId, pending: items.length });
    }
    return entries;
  }

  /** 使用者選擇續傳：重建管線並依帳本回補（不動已確認的段）。 */
  async resume(meetingId: string): Promise<UploadOutcome> {
    const pipeline = new ChunkPipeline({
      meetingId,
      store: this.#deps.store,
      api: this.#deps.apiFor(meetingId),
      ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
    });
    return pipeline.flush();
  }

  /** 使用者選擇丟棄（畫面必須先二次確認）：刪掉本機分段。 */
  async discard(meetingId: string): Promise<void> {
    const pipeline = new ChunkPipeline({
      meetingId,
      store: this.#deps.store,
      api: this.#deps.apiFor(meetingId),
      ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
    });
    await pipeline.discard();
  }
}

/** `HttpSessionClient` 風格的客户端 → `ChunkUploadApi` 的最小介面。 */
export interface ChunkUploadClient {
  uploadChunk(chunk: { seq: number; blob: Blob }): Promise<"accepted" | "duplicate">;
  chunkLedger(): Promise<{ acked: number[]; expectedNextSeq: number; hashes?: Record<number, string> }>;
}

/** 把「綁定單場會議」的 client 轉成 uploader 要的 `ChunkUploadApi`。 */
export function chunkUploadApi(client: ChunkUploadClient): ChunkUploadApi {
  return {
    upload: (_meetingId, chunk) => client.uploadChunk({ seq: chunk.seq, blob: chunk.blob }),
    ledger: () => client.chunkLedger(),
  };
}
