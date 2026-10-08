// M01-US-102：分段管線與恢復流程（AC-2 回補 / AC-3 不得自動丟棄 / AC-4 不重複）。
//
// 最關鍵的一條是「斷電情境」：模擬程序被殺（同一個 store，全新的 pipeline 與 queue），
// 重開之後必須看得到未完成的會議、續傳時只補缺的段、且未經使用者同意不得刪檔。

import { describe, expect, it } from "vitest";

import { ChunkApiError } from "../session/api";
import { ChunkPipeline, ChunkRecovery, chunkUploadApi, type ChunkUploadClient } from "./chunk-pipeline";
import type { ChunkBlobRecord, ChunkBlobStore, ChunkUploadApi } from "./uploader";

interface Stored {
  meetingId: string;
  seq: number;
  hash: string;
  blob: Blob;
}

class FakeStore implements ChunkBlobStore {
  readonly items = new Map<string, Stored>();

  #key(meetingId: string, seq: number): string {
    return `${meetingId}:${seq}`;
  }

  async put(item: ChunkBlobRecord): Promise<void> {
    this.items.set(this.#key(item.meetingId, item.seq), {
      meetingId: item.meetingId,
      seq: item.seq,
      hash: item.hash,
      blob: item.blob,
    });
  }

  async list(meetingId: string): Promise<ChunkBlobRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.meetingId === meetingId)
      .sort((a, b) => a.seq - b.seq);
  }

  async remove(meetingId: string, seq: number): Promise<void> {
    this.items.delete(this.#key(meetingId, seq));
  }

  async meetings(): Promise<string[]> {
    return [...new Set([...this.items.values()].map((item) => item.meetingId))];
  }
}

class FakeApi implements ChunkUploadApi {
  readonly uploaded: number[] = [];
  acked: number[] = [];
  /** 這些 seq 一律回 409。 */
  readonly conflictSeqs: number[] = [];
  ledgerError: Error | null = null;
  /** 讓某個 seq 的第一次上傳失敗一次（模擬斷網）。 */
  failOnce = new Set<number>();

  async upload(_meetingId: string, chunk: { seq: number; blob: Blob }): Promise<"accepted" | "duplicate"> {
    if (this.conflictSeqs.includes(chunk.seq)) {
      throw new ChunkApiError("SEQ_CONFLICT", `seq=${chunk.seq} 已有不同內容`);
    }
    if (this.failOnce.has(chunk.seq)) {
      this.failOnce.delete(chunk.seq);
      throw new ChunkApiError("NETWORK", "斷線");
    }
    this.uploaded.push(chunk.seq);
    if (!this.acked.includes(chunk.seq)) this.acked.push(chunk.seq);
    return this.acked.filter((seq) => seq === chunk.seq).length > 1 ? "duplicate" : "accepted";
  }

  async ledger(): Promise<{ acked: number[]; expectedNextSeq: number }> {
    if (this.ledgerError !== null) throw this.ledgerError;
    const acked = [...this.acked].sort((a, b) => a - b);
    let expected = 1;
    while (acked.includes(expected)) expected += 1;
    return { acked, expectedNextSeq: expected };
  }
}

function blob(text: string): Blob {
  return new Blob([text], { type: "audio/webm" });
}

describe("M01-US-102 ChunkPipeline", () => {
  it("M01-Given 一段音訊 When ingest Then 先落盤且上傳成功後刪本機檔（AC-1 順序）", async () => {
    const store = new FakeStore();
    const api = new FakeApi();
    const pipeline = new ChunkPipeline({ meetingId: "m1", store, api });

    const outcome = await pipeline.ingest({ seq: 1, blob: blob("hello") });

    expect(outcome).toMatchObject({ sent: 1, pending: 0 });
    expect(api.uploaded).toEqual([1]);
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 上傳失敗 When ingest Then 本機檔仍在，且同一段重試不會產生第二列（AC-1/AC-2）", async () => {
    const store = new FakeStore();
    const api = new FakeApi();
    api.failOnce.add(1);
    let now = 1_000;
    const pipeline = new ChunkPipeline({ meetingId: "m1", store, api, now: () => now });

    const failed = await pipeline.ingest({ seq: 1, blob: blob("hello") });
    expect(failed).toMatchObject({ sent: 0, pending: 1 });
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([1]);

    // 退避時間過了才重試（不可 busy loop）。
    now += 5_000;
    const retried = await pipeline.flush();
    expect(retried.sent).toBe(1);
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 同 seq 不同內容 When ingest Then 回報衝突且不覆蓋本機檔（AC-2 不可覆蓋）", async () => {
    const store = new FakeStore();
    const api = new FakeApi();
    api.conflictSeqs.push(2);
    const pipeline = new ChunkPipeline({ meetingId: "m1", store, api });

    const outcome = await pipeline.ingest({ seq: 2, blob: blob("changed") });
    expect(outcome.conflictSeqs).toEqual([2]);
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([2]);
  });
});

describe("M01-US-102 ChunkRecovery（斷電 / app 被殺重開）", () => {
  it("M01-Given 程序被殺後重開 When scan Then 列出未完成會議（AC-3 不得自動丟棄）", async () => {
    const store = new FakeStore();
    // 模擬「第一次生命週期」：落盤了但沒送出去（斷網）就整台被殺。
    const api = new FakeApi();
    api.ledgerError = new ChunkApiError("NETWORK", "斷線");
    const first = new ChunkPipeline({ meetingId: "m1", store, api });
    await first.ingest({ seq: 1, blob: blob("a") });
    await first.ingest({ seq: 2, blob: blob("b") });

    // 全新的 ChunkRecovery（新的 queue、新的 api）＝重開 app。
    const recovery = new ChunkRecovery({
      store,
      durable: true,
      apiFor: () => new FakeApi(),
    });
    expect(await recovery.scan()).toEqual([{ meetingId: "m1", pending: 2 }]);
    // 掃描本身不得刪任何東西。
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([1, 2]);
  });

  it("M01-Given 本機 1,2 而伺服端已收 1 When resume Then 只回補 2，本機清空（AC-2/AC-4）", async () => {
    const store = new FakeStore();
    // 第一次生命週期：斷網所以兩段都留在本機。
    const offlineApi = new FakeApi();
    offlineApi.ledgerError = new ChunkApiError("NETWORK", "斷線");
    const seed = new ChunkPipeline({ meetingId: "m1", store, api: offlineApi });
    await seed.ingest({ seq: 1, blob: blob("a") });
    await seed.ingest({ seq: 2, blob: blob("b") });

    // 重開之後：伺服端帳本說 seq1 已經收過。
    const api = new FakeApi();
    api.acked = [1];
    const recovery = new ChunkRecovery({ store, durable: true, apiFor: () => api });

    const outcome = await recovery.resume("m1");
    expect(api.uploaded).toEqual([2]);
    expect(outcome).toMatchObject({ sent: 1, pending: 0 });
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 使用者選擇丟棄 When discard Then 才刪本機檔（AC-3 只有明確指令才丟）", async () => {
    const store = new FakeStore();
    const offlineApi = new FakeApi();
    offlineApi.ledgerError = new ChunkApiError("NETWORK", "斷線");
    const seed = new ChunkPipeline({ meetingId: "m1", store, api: offlineApi });
    await seed.ingest({ seq: 1, blob: blob("a") });

    const recovery = new ChunkRecovery({ store, durable: true, apiFor: () => new FakeApi() });
    expect(await recovery.scan()).toEqual([{ meetingId: "m1", pending: 1 }]);

    await recovery.discard("m1");
    expect(await store.list("m1")).toEqual([]);
    expect(await recovery.scan()).toEqual([]);
  });

  it("M01-Given 本機儲存不持久 When scan Then durable=false（不可宣稱有備份）", async () => {
    const recovery = new ChunkRecovery({ store: new FakeStore(), durable: false, apiFor: () => new FakeApi() });
    expect(recovery.durable).toBe(false);
  });
});

describe("M01-US-102 chunkUploadApi（HttpSessionClient 轉接）", () => {
  it("M01-Given 綁定單場會議的 client When 轉接 Then seq 與 blob 原樣傳遞，ledger 直通", async () => {
    const seen: Array<{ seq: number; size: number }> = [];
    const client: ChunkUploadClient = {
      async uploadChunk(chunk) {
        seen.push({ seq: chunk.seq, size: chunk.blob.size });
        return "duplicate";
      },
      async chunkLedger() {
        return { acked: [1, 2], expectedNextSeq: 3 };
      },
    };
    const api = chunkUploadApi(client);

    const result = await api.upload("m1", { meetingId: "m1", seq: 5, hash: "h", blob: blob("xyz") });
    expect(result).toBe("duplicate");
    expect(seen).toEqual([{ seq: 5, size: 3 }]);
    expect(await api.ledger("m1")).toEqual({ acked: [1, 2], expectedNextSeq: 3 });
  });
});
