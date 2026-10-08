// M01-US-102：音訊分段帳本 + 逐字稿去重帳本的持久化接縫（DO SQLite）。
//
// 用 `node:sqlite` 當 DO SQLite 的替身（與 session-store / harness-persistence 同做法）：
// 這裡要證明的是「重送 n 次仍然只有一列、一句」，而不是「記憶體裡的 Map 還在」。
//
// 冪等必須是**原子**的（`INSERT OR IGNORE` + `changes()`）：先讀再寫在並行重送下會雙寫。

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AudioChunkStore,
  ChunkConflictError,
  TranscriptChunkLedger,
  type ChunkSql,
} from "../src/storage/chunk-store.js";

/** 把 node:sqlite 包成 DO `storage.sql` 的形狀。 */
function sqlDevice(): { db: DatabaseSync; sql: ChunkSql } {
  const db = new DatabaseSync(":memory:");
  const sql: ChunkSql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0
            ? db.prepare(query).all(...(bindings as never[]))
            : db.prepare(query).all();
        return { toArray: () => rows, changes: 0 };
      }
      if (bindings.length > 0) {
        const result = db.prepare(query).run(...(bindings as never[]));
        return { toArray: () => [], changes: Number(result.changes) };
      }
      db.exec(query);
      return { toArray: () => [], changes: 0 };
    },
  };
  return { db, sql };
}

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

describe("M01-US-102 AudioChunkStore", () => {
  it("M01-Given 全新 DO When 讀帳本 Then 空帳本且 expectedNextSeq=1", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    expect(store.list()).toEqual([]);
    expect(store.expectedNextSeq()).toBe(1);
  });

  it("M01-Given 送第 1 段 When 記錄 Then 201 語意的 accepted + 帳本一列", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    const result = store.record({ seq: 1, byteLen: 4096, contentHash: HASH_A, nowMs: 1_700_000_000_000 });
    expect(result).toMatchObject({ duplicate: false, seq: 1, count: 1, lastSeq: 1 });
    expect(store.list()).toEqual([{ seq: 1, byteLen: 4096, hash: HASH_A }]);
  });

  it("M01-Given 同一段重送 3 次 When 記錄 Then 帳本仍只有一列（AC-2 冪等）", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    const args = { seq: 1, byteLen: 4096, contentHash: HASH_A, nowMs: 1_700_000_000_000 };
    store.record(args);
    expect(store.record(args).duplicate).toBe(true);
    expect(store.record(args).duplicate).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.expectedNextSeq()).toBe(2);
  });

  it("M01-Given 同 seq 但內容不同 When 記錄 Then 丟 ChunkConflictError 且不改動原本那列（不覆蓋）", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    store.record({ seq: 2, byteLen: 10, contentHash: HASH_A, nowMs: 1 });
    expect(() =>
      store.record({ seq: 2, byteLen: 99, contentHash: HASH_B, nowMs: 2 }),
    ).toThrow(ChunkConflictError);
    expect(store.list()).toEqual([{ seq: 2, byteLen: 10, hash: HASH_A }]);
  });

  it("M01-Given 有洞（1,2,4）When 問 expectedNextSeq Then 回 3（缺段要指出來，不可跳過）", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    for (const seq of [1, 2, 4]) {
      store.record({ seq, byteLen: 10, contentHash: HASH_A, nowMs: 1 });
    }
    expect(store.expectedNextSeq()).toBe(3);
    expect(store.count()).toBe(3);
    expect(store.lastSeq()).toBe(4);
  });

  it("M01-Given 亂序到達（3,1,2）When 讀帳本 Then 依 seq 升序（裝置端回補才能照序）", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    for (const seq of [3, 1, 2]) {
      store.record({ seq, byteLen: seq, contentHash: HASH_A, nowMs: 1 });
    }
    expect(store.list().map((chunk) => chunk.seq)).toEqual([1, 2, 3]);
    expect(store.expectedNextSeq()).toBe(4);
  });

  it("M01-Given seq 不合法（0 / 負 / 非整數）When 記錄 Then 丟錯（不默默收下）", () => {
    const { sql } = sqlDevice();
    const store = new AudioChunkStore(sql);
    for (const seq of [0, -1, 1.5]) {
      expect(() => store.record({ seq, byteLen: 1, contentHash: HASH_A, nowMs: 1 })).toThrow();
    }
  });
});

describe("M01-US-102 TranscriptChunkLedger", () => {
  it("M01-Given 同一 chunkSeq 第一次 When 認領 Then true（可以寫入）", () => {
    const { sql } = sqlDevice();
    const ledger = new TranscriptChunkLedger(sql);
    expect(ledger.claim(7, 1)).toBe(true);
    expect(ledger.has(7)).toBe(true);
  });

  it("M01-Given 同一 chunkSeq 第二次 When 認領 Then false（重送不得產生第二句，AC-4）", () => {
    const { sql } = sqlDevice();
    const ledger = new TranscriptChunkLedger(sql);
    ledger.claim(7, 1);
    expect(ledger.claim(7, 2)).toBe(false);
    expect(ledger.claim(7, 3)).toBe(false);
    expect(ledger.list()).toEqual([7]);
  });

  it("M01-Given 沒帶 chunkSeq（undefined）When 認領 Then true（舊行為：不做去重）", () => {
    const { sql } = sqlDevice();
    const ledger = new TranscriptChunkLedger(sql);
    expect(ledger.claim(undefined, 1)).toBe(true);
    expect(ledger.list()).toEqual([]);
  });

  it("M01-Given 未認領過 When has Then false", () => {
    const { sql } = sqlDevice();
    expect(new TranscriptChunkLedger(sql).has(3)).toBe(false);
  });
});
