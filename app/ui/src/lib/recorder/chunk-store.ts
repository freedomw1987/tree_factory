/**
 * M01-US-102：本機分段持久化（IndexedDB）。
 *
 * 為什麼是 IndexedDB（設計 §2 D3）：webview 被系統殺掉、程序重啟之後，只有真正落到
 * 瀏覽器儲存層的資料還在；localStorage 放不下音訊（5MB 上限且是同步 API，會卡 UI）。
 *
 * 兩條不可妥協的規則：
 *   1. **任何時候都不會自己刪**：只有 `remove()`（在伺服端 ack 之後，或使用者明確丟棄）才會刪。
 *   2. **不可宣稱有備份**：IndexedDB 不可用時（隱私模式、儲存被拒）回報 `durable: false`，
 *      讓畫面照實說「這場會議沒有本地備份」，而不是假裝有恢復能力。
 */

import type { ChunkBlobRecord, ChunkBlobStore } from "./uploader";

const DB_NAME = "tree_factory.audio.v1";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

export interface OpenedChunkStore {
  store: ChunkBlobStore;
  /** true = 真的落到 IndexedDB；false = 只存在記憶體（重啟後就沒了）。 */
  durable: boolean;
}

function keyOf(meetingId: string, seq: number): string {
  return `${meetingId}:${seq}`;
}

/** 記憶體版（IndexedDB 不可用時的誠實退路）。 */
export class MemoryChunkStore implements ChunkBlobStore {
  readonly #items = new Map<string, ChunkBlobRecord>();

  async put(item: ChunkBlobRecord): Promise<void> {
    this.#items.set(keyOf(item.meetingId, item.seq), item);
  }

  async list(meetingId: string): Promise<ChunkBlobRecord[]> {
    return [...this.#items.values()]
      .filter((item) => item.meetingId === meetingId)
      .sort((a, b) => a.seq - b.seq);
  }

  async remove(meetingId: string, seq: number): Promise<void> {
    this.#items.delete(keyOf(meetingId, seq));
  }

  async meetings(): Promise<string[]> {
    return [...new Set([...this.#items.values()].map((item) => item.meetingId))];
  }
}

/** IndexedDB 版。 */
export class IndexedDbChunkStore implements ChunkBlobStore {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  #transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.#db.transaction(STORE_NAME, mode);
      const request = work(transaction.objectStore(STORE_NAME));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB 操作失敗")));
    });
  }

  async put(item: ChunkBlobRecord): Promise<void> {
    // key 與 meetingId 一起存：list() 要用 index 查，remove() 要用 key 刪。
    await this.#transaction("readwrite", (store) =>
      store.put({ ...item, key: keyOf(item.meetingId, item.seq) }),
    );
  }

  async list(meetingId: string): Promise<ChunkBlobRecord[]> {
    const rows = await this.#transaction<Array<ChunkBlobRecord & { key?: string }>>("readonly", (store) =>
      store.getAll(),
    );
    return rows
      .filter((row) => row.meetingId === meetingId)
      .map(({ meetingId: id, seq, hash, blob }) => ({ meetingId: id, seq, hash, blob }))
      .sort((a, b) => a.seq - b.seq);
  }

  async remove(meetingId: string, seq: number): Promise<void> {
    await this.#transaction("readwrite", (store) => store.delete(keyOf(meetingId, seq)));
  }

  async meetings(): Promise<string[]> {
    const rows = await this.#transaction<Array<ChunkBlobRecord>>("readonly", (store) => store.getAll());
    return [...new Set(rows.map((row) => row.meetingId))];
  }
}

/** 開一個本機分段儲存；失敗時退回記憶體版並回報 `durable: false`（不假裝有備份）。 */
export async function openChunkStore(): Promise<OpenedChunkStore> {
  const indexedDb = globalThis.indexedDB;
  if (indexedDb === undefined) {
    return { store: new MemoryChunkStore(), durable: false };
  }
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(DB_NAME, DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB 開啟失敗")));
      request.addEventListener("blocked", () => reject(new Error("IndexedDB 被其他分頁卡住")));
    });
    return { store: new IndexedDbChunkStore(db), durable: true };
  } catch {
    return { store: new MemoryChunkStore(), durable: false };
  }
}
