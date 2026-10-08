// TECH-004：`DoSqliteDatabase` facade —— 把 Durable Object 的 SQLite 接成
// pi-durable `storage/sqlite` 期望的六個方法，並鎖住三個容易寫錯的行為。
//
// 這裡刻意用手寫的假 storage，而不是 node:sqlite：要驗的是「我方 facade 的契約」
// （繫結轉換、排隊、交易回滾），真 SQLite 的整合留給 harness-persistence 測試。

import { describe, expect, it, vi } from "vitest";

import { DoSqliteDatabase, type DoSqlStorageLike, type SqlBinding } from "../src/storage/do-sqlite.js";

interface Recorded {
  sql: string;
  bindings: SqlBinding[];
}

function fakeStorage(
  handler: (sql: string, bindings: SqlBinding[]) => unknown[] = () => [],
): { storage: DoSqlStorageLike; calls: Recorded[]; rollbacks: number } {
  const calls: Recorded[] = [];
  const state = { rollbacks: 0 };
  const storage: DoSqlStorageLike = {
    sql: {
      exec(sql: string, ...bindings: SqlBinding[]) {
        calls.push({ sql, bindings });
        return { toArray: () => handler(sql, bindings) };
      },
    },
    async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
      return callback({
        rollback: () => {
          state.rollbacks += 1;
        },
      });
    },
  };
  return {
    storage,
    calls,
    get rollbacks() {
      return state.rollbacks;
    },
  };
}

describe("DoSqliteDatabase（M01 / TECH-004）", () => {
  it("run/exec 把語句傳給 DO SQL，且 exec 不帶繫結", async () => {
    const fake = fakeStorage();
    const db = new DoSqliteDatabase(fake.storage);

    await db.exec("create table t (id text)");
    await db.run("insert into t values (?)", "a");

    expect(fake.calls).toEqual([
      { sql: "create table t (id text)", bindings: [] },
      { sql: "insert into t values (?)", bindings: ["a"] },
    ]);
  });

  it("繫結值轉換：undefined/null → null、bigint → number、Uint8Array 只帶精確位元組", async () => {
    const fake = fakeStorage();
    const db = new DoSqliteDatabase(fake.storage);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await db.run("insert into t values (?, ?, ?, ?, ?)", undefined as unknown as SqlBinding, null, 7n, bytes.subarray(1, 4), "x");

    const bindings = fake.calls[0]?.bindings ?? [];
    expect(bindings[0]).toBeNull();
    expect(bindings[1]).toBeNull();
    expect(bindings[2]).toBe(7);
    expect(bindings[3]).toBeInstanceOf(Uint8Array);
    expect([...(bindings[3] as Uint8Array)]).toEqual([2, 3, 4]);
    expect(bindings[4]).toBe("x");
  });

  it("get 回第一列、沒有資料回 undefined；all 回全部（兩種 cursor 形狀都支援）", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const withToArray = fakeStorage(() => rows);
    const db1 = new DoSqliteDatabase(withToArray.storage);
    expect(await db1.get("select * from t")).toEqual({ id: "a" });
    expect(await db1.all("select * from t")).toEqual(rows);

    // 只提供迭代器的 cursor（DO 未提供 toArray 時）
    const iterableOnly: DoSqlStorageLike = {
      sql: {
        exec: () => ({ [Symbol.iterator]: () => rows[Symbol.iterator]() }),
      },
      transaction: async (callback) => callback({ rollback: () => {} }),
    };
    const db2 = new DoSqliteDatabase(iterableOnly);
    expect(await db2.all("select * from t")).toEqual(rows);

    const empty = fakeStorage(() => []);
    const db3 = new DoSqliteDatabase(empty.storage);
    expect(await db3.get("select * from t")).toBeUndefined();
  });

  it("交易：回呼拿到獨立的 handle，且非交易操作會排隊等交易結束", async () => {
    const order: string[] = [];
    let releaseTransaction!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const storage: DoSqlStorageLike = {
      sql: {
        exec(sql: string) {
          order.push(`sql:${sql}`);
          return { toArray: () => [] };
        },
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        order.push("begin");
        await gate;
        const result = await callback({ rollback: () => order.push("rollback") });
        order.push("commit");
        return result;
      },
    };
    const db = new DoSqliteDatabase(storage);

    const inTransaction = db.transaction(async (handle) => {
      expect(handle).not.toBe(db);
      await handle.run("insert into t values (1)");
      return "done";
    });
    // 交易還沒結束就來的操作，必須排在 commit 之後。
    const queued = db.run("insert into t values (2)");
    releaseTransaction();
    expect(await inTransaction).toBe("done");
    await queued;

    expect(order).toEqual(["begin", "sql:insert into t values (1)", "commit", "sql:insert into t values (2)"]);
  });

  it("交易：回呼拋錯時呼叫 rollback 並把錯誤往上拋", async () => {
    const fake = fakeStorage();
    const db = new DoSqliteDatabase(fake.storage);
    const error = new Error("boom");

    await expect(
      db.transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(fake.rollbacks).toBe(1);
  });

  it("close 只標記狀態（DO 的 SQLite 由平台管理）", async () => {
    const fake = fakeStorage();
    const db = new DoSqliteDatabase(fake.storage);
    expect(db.closed).toBe(false);
    await db.close();
    expect(db.closed).toBe(true);
    // 關閉後仍不 throw：平台會直接切斷，這裡只是記錄狀態。
    await expect(db.run("select 1")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});