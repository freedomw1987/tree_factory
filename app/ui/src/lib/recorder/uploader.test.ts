// M01-US-102：上傳協調者（先落盤、後上傳、ack 才刪）。
//
// 這支測試守住整張票最核心的三條：
//   1. 沒 ack 的分段一定還在本機（AC-1）。
//   2. 網路斷了要停下來退避，而不是把後面的段一直往失敗的網路塞（AC-2）。
//   3. 恢復時只補「伺服端沒有的」段，不重送已確認的（AC-2 / AC-4）。

import { describe, expect, it } from "vitest";

import { ChunkApiError } from "../session/api";
import { ChunkQueue } from "./chunk-queue";
import { ChunkUploader, type ChunkBlobRecord, type ChunkBlobStore, type ChunkUploadApi } from "./uploader";

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

  async put(item: Stored): Promise<void> {
    this.items.set(this.#key(item.meetingId, item.seq), item);
  }

  async list(meetingId: string): Promise<Stored[]> {
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
  readonly responses: Array<"accepted" | "duplicate" | Error> = [];
  /** 這些 seq 一律回 409（模擬伺服端已有同 seq 的其他內容）。 */
  readonly conflictSeqs: number[] = [];
  ledgerError: Error | null = null;
  acked: number[] = [];
  /** 伺服端帳本帶回的內容指紋（沒設＝該 seq 不帶指紋）。 */
  hashes: Record<number, string> = {};

  async upload(_meetingId: string, chunk: { seq: number; hash: string; blob: Blob }): Promise<"accepted" | "duplicate"> {
    if (this.conflictSeqs.includes(chunk.seq)) {
      throw new ChunkApiError("SEQ_CONFLICT", `seq=${chunk.seq} 已有不同內容`);
    }
    const next = this.responses.shift() ?? "accepted";
    if (next instanceof Error) throw next;
    this.uploaded.push(chunk.seq);
    if (!this.acked.includes(chunk.seq)) this.acked.push(chunk.seq);
    return next;
  }

  async ledger(): Promise<{ acked: number[]; expectedNextSeq: number; hashes: Record<number, string> }> {
    if (this.ledgerError !== null) throw this.ledgerError;
    const acked = [...this.acked].sort((a, b) => a - b);
    let expected = 1;
    while (acked.includes(expected)) expected += 1;
    return { acked, expectedNextSeq: expected, hashes: this.hashes };
  }
}

function blob(text: string): Blob {
  return new Blob([text], { type: "audio/webm" });
}

interface Harness {
  uploader: ChunkUploader;
  store: FakeStore;
  api: FakeApi;
  queue: ChunkQueue;
  setNow: (value: number) => void;
}

function build(): Harness {
  const store = new FakeStore();
  const api = new FakeApi();
  const queue = new ChunkQueue();
  let now = 1_000;
  const uploader = new ChunkUploader({ store, api, queue, now: () => now });
  return { uploader, store, api, queue, setNow: (value: number) => (now = value) };
}

describe("M01-US-102 ChunkUploader", () => {
  it("M01-Given 收到一段 When save Then 先落盤（上傳前本機已有檔案，AC-1 前提）", async () => {
    const { uploader, store } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    expect(await store.list("m1")).toHaveLength(1);
  });

  it("M01-Given 上傳成功 When flush Then 本機才刪除，且送出順序是 seq 升序", async () => {
    const { uploader, store, api } = build();
    for (const seq of [3, 1, 2]) {
      await uploader.save({ meetingId: "m1", seq, hash: `h${seq}`, blob: blob(`c${seq}`) });
    }
    const outcome = await uploader.flush("m1");
    expect(api.uploaded).toEqual([1, 2, 3]);
    expect(outcome).toMatchObject({ sent: 3, duplicates: 0, pending: 0, gapSeqs: [] });
    // 帳本是**上傳前**讀的，所以 expectedNextSeq 是讀取當下的值（1）；上傳後的正確下一個是 4，
    // 但那要下一次讀帳本才知道——這裡不推測。
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 網路失敗 When flush Then 停下來退避（不再送後面的段），本機檔案全部保留", async () => {
    const { uploader, store, api } = build();
    for (const seq of [1, 2, 3]) {
      await uploader.save({ meetingId: "m1", seq, hash: `h${seq}`, blob: blob(`c${seq}`) });
    }
    api.responses.push("accepted", new ChunkApiError("NETWORK", "斷線"));

    const outcome = await uploader.flush("m1");
    expect(api.uploaded).toEqual([1]); // 第 2 段失敗後不再試第 3 段
    expect(outcome).toMatchObject({ sent: 1, pending: 2 });
    expect(outcome.retryAtMs).toBe(1_000 + 1_000); // 第一次失敗 → 退避 1 秒
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([2, 3]);
  });

  it("M01-Given 退避時間還沒到 When flush Then 一段都不送（不可 busy loop）", async () => {
    const { uploader, api } = build();
    for (const seq of [1, 2]) {
      await uploader.save({ meetingId: "m1", seq, hash: `h${seq}`, blob: blob(`c${seq}`) });
    }
    api.responses.push(new ChunkApiError("NETWORK", "斷線"));
    await uploader.flush("m1");
    const again = await uploader.flush("m1");
    expect(api.uploaded).toEqual([]);
    expect(again.sent).toBe(0);
  });

  it("M01-Given 伺服端說重送（duplicate）When flush Then 視為成功並刪本機檔（冪等讓恢復可自癒）", async () => {
    const { uploader, store, api } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    api.responses.push("duplicate");
    const outcome = await uploader.flush("m1");
    expect(outcome).toMatchObject({ sent: 0, duplicates: 1, pending: 0 });
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 同 seq 內容衝突 When flush Then 保留本機檔並回報衝突段（不覆蓋、不假裝成功）", async () => {
    const { uploader, store, api } = build();
    await uploader.save({ meetingId: "m1", seq: 2, hash: "h-old", blob: blob("old") });
    api.conflictSeqs.push(2); // 伺服端已有 seq=2 的其他內容 → 409

    const outcome = await uploader.flush("m1");
    expect(outcome.conflictSeqs).toEqual([2]);
    expect(outcome.sent).toBe(0);
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([2]);
  });

  it("M01-Given 衝突過的段 When 之後 flush Then 不再重試同一段（不讓 409 變成無限噪音）", async () => {
    const { uploader, api } = build();
    await uploader.save({ meetingId: "m1", seq: 2, hash: "h-old", blob: blob("old") });
    api.conflictSeqs.push(2);
    await uploader.flush("m1");
    const before = api.uploaded.length;
    const again = await uploader.flush("m1");
    expect(api.uploaded.length).toBe(before);
    expect(again.conflictSeqs).toEqual([2]);
  });

  it("M01-Given 讀不到伺服端帳本 When flush Then 不送任何段（無權威帳本就不敢刪本機檔）", async () => {
    const { uploader, store, api } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    api.ledgerError = new ChunkApiError("NETWORK", "斷線");
    const outcome = await uploader.flush("m1");
    expect(api.uploaded).toEqual([]);
    expect(outcome.pending).toBe(1);
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([1]);
  });

  it("M01-Given 本機 1,2,3 而伺服端已收 1,3 When flush Then 只回補 2（不重送已確認的）", async () => {
    const { uploader, store, api } = build();
    for (const seq of [1, 2, 3]) {
      await uploader.save({ meetingId: "m1", seq, hash: `h${seq}`, blob: blob(`c${seq}`) });
    }
    api.acked = [1, 3];
    const outcome = await uploader.flush("m1");
    expect(api.uploaded).toEqual([2]);
    expect(outcome).toMatchObject({ sent: 1, pending: 0 });
    expect(await store.list("m1")).toEqual([]);
  });

  it("M01-Given 另有其他會議的未完成分段 When 讀未完成清單 Then 逐會議列出（恢復要問對人）", async () => {
    const { uploader } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    await uploader.save({ meetingId: "m2", seq: 1, hash: "h1", blob: blob("b") });
    await uploader.save({ meetingId: "m2", seq: 2, hash: "h2", blob: blob("c") });
    expect(await uploader.unfinished()).toEqual([
      { meetingId: "m1", pending: 1 },
      { meetingId: "m2", pending: 2 },
    ]);
  });

  it("M01-Given 使用者選擇丟棄 When discard Then 本機分段刪除（只有明確指令才丟，AC-3）", async () => {
    const { uploader, store } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    await uploader.discard("m1");
    expect(await store.list("m1")).toEqual([]);
  });

  // ↓ 以下三條是 Gate 4 審查的 P1/P2 修正探針（F3 缺段偵測、F4 內容對帳、F7 衝突卡住後面的段）。
  it("M01-Given 伺服端已收 1,3 但本機沒有第 2 段 When flush Then 回報 gapSeqs=[2]（缺段不得無聲跳過，AC-4）", async () => {
    const { uploader, store, api } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    await uploader.save({ meetingId: "m1", seq: 3, hash: "h3", blob: blob("c") });
    api.acked = [1, 3];

    const outcome = await uploader.flush("m1");
    expect(outcome.gapSeqs).toEqual([2]);
    expect(outcome.expectedNextSeq).toBe(2); // 伺服端帳本說下一個缺的就是 2
    expect(outcome.pending).toBe(0);
  });

  it("M01-Given 同 seq 但伺服端是別的內容 When flush Then 不刪本機檔、列為 contentMismatch（不覆蓋，設計 §6）", async () => {
    const { uploader, store, api } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "local-hash", blob: blob("local") });
    api.acked = [1];
    api.hashes = { 1: "server-other-hash" };

    const outcome = await uploader.flush("m1");
    expect(outcome.contentMismatchSeqs).toEqual([1]);
    expect(outcome.conflictSeqs).toEqual([1]);
    expect(outcome.sent).toBe(0);
    expect((await store.list("m1")).map((item) => item.seq)).toEqual([1]); // 本機檔必須還在
  });

  it("M01-Given 第 1 段永久衝突 When flush Then 後面的第 2 段仍要送出（不可被沖突段卡死，F7）", async () => {
    const { uploader, api } = build();
    await uploader.save({ meetingId: "m1", seq: 1, hash: "h1", blob: blob("a") });
    await uploader.save({ meetingId: "m1", seq: 2, hash: "h2", blob: blob("b") });
    api.conflictSeqs.push(1);

    const outcome = await uploader.flush("m1");
    expect(api.uploaded).toEqual([2]);
    expect(outcome).toMatchObject({ sent: 1, pending: 0, conflictSeqs: [1] });
  });
});
