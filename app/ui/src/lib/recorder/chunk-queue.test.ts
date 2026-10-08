// M01-US-102：本機分段佇列（純邏輯，持久化由 chunk-store 負責）。
//
// 這支檔案是整張票的「不變式守門員」：
//   不變式 1：沒有 ack 的分段**永遠不會**被刪除（AC-1 原文）。
//   不變式 2：重送不改變順序（seq 升序），且不會把同一段送兩次而不自知。
//   不變式 3：伺服端 ack 才是權威（reconcile 用伺服端 ledger 校正本機）。

import { describe, expect, it } from "vitest";

import {
  ChunkQueue,
  backoffMs,
  missingSeqs,
  nextExpectedSeq,
  timelineGaps,
  type NewChunkRecord,
} from "./chunk-queue";

const M = "meeting-1";

function record(seq: number, hash = `hash-${seq}`): NewChunkRecord {
  return { meetingId: M, seq, hash, bytes: 1024 * seq };
}

describe("M01-US-102 ChunkQueue", () => {
  it("M01-Given 全新佇列 When 加入 3 段 Then pending 依 seq 升序（回補要照時間軸）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(3));
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    expect(queue.pending().map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("M01-Given 同一段重複 enqueue When 讀 pending Then 只有一筆（就地更新，不長大）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1, "h1"));
    queue.enqueue(record(1, "h1"));
    expect(queue.pending()).toHaveLength(1);
  });

  it("M01-Given 未 ack 的分段 When 問可刪除清單 Then 空（不變式 1：沒 ack 永不刪）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    expect(queue.deletionCandidates()).toEqual([]);
  });

  it("M01-Given ack 第 1 段 When 問可刪除清單 Then 只有 [1]；第 2 段仍在 pending", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    queue.ack(1);
    expect(queue.deletionCandidates()).toEqual([1]);
    expect(queue.pending().map((item) => item.seq)).toEqual([2]);
  });

  it("M01-Given 剛剛失敗過 When 立即重試 Then 退避時間內不該再送（不 busy loop）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.fail(1, 1_000);
    expect(queue.nextDue(1_000)).toBeUndefined();
    expect(queue.nextDue(1_500)).toBeUndefined();
    expect(queue.nextDue(2_000)?.seq).toBe(1);
  });

  it("M01-Given 連續失敗 When 問退避秒數 Then 指數成長且有上限（1s→2s→4s→…≤30s）", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(5)).toBe(16_000);
    expect(backoffMs(6)).toBe(30_000);
    expect(backoffMs(20)).toBe(30_000);
  });

  it("M01-Given 失敗後成功 When ack Then 重試次數歸零（下一段不受前一段拖累）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    queue.fail(1, 0);
    queue.ack(1);
    expect(queue.pending()[0]).toMatchObject({ seq: 2, attempts: 0 });
  });

  it("M01-Given 本機有 1,2,3 而伺服端已收 1,3 When 對帳 Then 只需回補 2（不重送已確認的）", () => {
    const queue = new ChunkQueue();
    for (const seq of [1, 2, 3]) queue.enqueue(record(seq));
    const result = queue.reconcile([1, 3]);
    expect(result.ackedNow).toBe(2);
    expect(queue.pending().map((item) => item.seq)).toEqual([2]);
  });

  it("M01-Given 伺服端說全部都收過 When 對帳 Then pending 清空（本機標記只是快取，伺服端才是權威）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    queue.reconcile([1, 2]);
    expect(queue.pending()).toEqual([]);
    expect(queue.deletionCandidates()).toEqual([1, 2]);
  });
});

describe("M01-US-102 時間軸連續性（純函式）", () => {
  it("M01-Given 已收 1,2,3 When 問下一段 Then 4", () => {
    expect(nextExpectedSeq([1, 2, 3])).toBe(4);
    expect(nextExpectedSeq([])).toBe(1);
  });

  it("M01-Given 已收 1,3（缺 2）When 問下一段 Then 2（先補洞，不可跳過）", () => {
    expect(nextExpectedSeq([1, 3])).toBe(2);
  });

  it("M01-Given 本機 1..5、伺服端只到 3 When 問缺哪些 Then [4,5]", () => {
    expect(missingSeqs([1, 2, 3, 4, 5], [1, 2, 3])).toEqual([4, 5]);
  });

  it("M01-Given 兩邊都有洞 When 問缺哪些 Then 只列本機有的（本機沒有的段不可能補）", () => {
    expect(missingSeqs([1, 4], [1, 2, 3])).toEqual([4]);
  });

  it("M01-Given 伺服端已收 1,3、本機也只有 1,3 When 問時間軸缺口 Then [2]（補不回來，只能回報）", () => {
    expect(timelineGaps([1, 3], [1, 3])).toEqual([2]);
  });

  it("M01-Given 伺服端有洞但本機還留著那段 When 問時間軸缺口 Then 不算缺口（本地可以補）", () => {
    expect(timelineGaps([1, 3], [2, 3])).toEqual([]);
  });
});

describe("M01-US-102 永久衝突段的排除（Gate 4 F7）", () => {
  it("M01-Given 第 1 段被標為永久衝突 When 問待送清單 Then 第 2 段仍可送（不被前面的衝突卡死）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.enqueue(record(2));
    queue.block(1);
    expect(queue.pending().map((item) => item.seq)).toEqual([2]);
    expect(queue.nextDue(0)?.seq).toBe(2);
    expect(queue.blockedSeqs()).toEqual([1]);
  });

  it("M01-Given 同一 seq 重新落盤 When 加入佇列 Then 先前的衝突標記解除（新內容可以再試）", () => {
    const queue = new ChunkQueue();
    queue.enqueue(record(1));
    queue.block(1);
    queue.enqueue(record(1, "hash-new"));
    expect(queue.pending().map((item) => item.seq)).toEqual([1]);
    expect(queue.blockedSeqs()).toEqual([]);
  });
});
