// TECH-004：`DoSqliteDatabase` facade —— 把 Durable Object 的 SQLite 接成
// pi-durable `storage/sqlite` 期望的六個方法，並鎖住三個容易寫錯的行為。
//
// 這裡刻意用手寫的假 storage，而不是 node:sqlite：要驗的是「我方 facade 的契約」
// （繫結轉換、排隊、交易回滾），真 SQLite 的整合留給 harness-persistence 測試。

import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
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

  // 下面 4 個測試是 reviewer 稽核（獨立 subagent）抓到的缺口的鎖：
  // 原本的 `#inTransaction` 布林會在交易 await 期間放行「無關操作」，與官方契約第 2 條牴觸。
  it("契約第 2 條：交易回呼 await 期間到達的無關操作必須排隊（不可被放行進交易）", async () => {
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
        const result = await callback({ rollback: () => order.push("rollback") });
        order.push("commit");
        return result;
      },
    };
    const db = new DoSqliteDatabase(storage);

    const inTransaction = db.transaction(async (handle) => {
      order.push("tx:start");
      await gate; // 交易在 await 期間對外「開著」
      order.push("tx:end");
      await handle.run("TX_WRITE");
    });

    await new Promise((resolve) => setTimeout(resolve, 0)); // 讓交易真的進到 await gate
    const outside = db.run("UNRELATED_OUTSIDE");
    releaseTransaction();
    await inTransaction;
    await outside;

    expect(order).toEqual([
      "begin",
      "tx:start",
      "tx:end",
      "sql:TX_WRITE",
      "commit",
      "sql:UNRELATED_OUTSIDE",
    ]);
  });

  it("契約第 1 條：交易 handle 在回呼結束後失效（再用要丟錯，不可靜默執行）", async () => {
    const fake = fakeStorage();
    const db = new DoSqliteDatabase(fake.storage);
    let handle!: SqliteExecutor;

    await db.transaction(async (transaction) => {
      handle = transaction;
    });

    await expect(handle.run("select 1")).rejects.toThrow(/已失效/);
    await expect(handle.all("select 1")).rejects.toThrow(/已失效/);
  });

  it("契約第 1 條：在回呼裡誤用資料庫本身也必須排隊（不會繞過交易）", async () => {
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
        const result = await callback({ rollback: () => order.push("rollback") });
        order.push("commit");
        return result;
      },
    };
    const db = new DoSqliteDatabase(storage);
    let misuse: Promise<void> = Promise.resolve();

    const inTransaction = db.transaction(async (handle) => {
      order.push("tx:start");
      misuse = db.run("MISUSE").then(() => {
        order.push("misuse-settled");
      });
      await gate;
      await handle.run("TX_WRITE");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["begin", "tx:start"]); // 誤用的語句還沒跑
    releaseTransaction();
    await inTransaction;
    await misuse;

    expect(order).toEqual([
      "begin",
      "tx:start",
      "sql:TX_WRITE",
      "commit",
      "sql:MISUSE",
      "misuse-settled",
    ]);
  });

  it("契約第 3 條：回滾失敗時以 AggregateError 拒絕（不可讓呼叫端誤以為已回滾）", async () => {
    const callbackError = new Error("callback failed");
    const rollbackError = new Error("rollback failed");
    const storage: DoSqlStorageLike = {
      sql: { exec: () => ({ toArray: () => [] }) },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        await callback({ rollback: () => {} });
        throw rollbackError; // 平台的交易在回滾階段失敗
      },
    };
    const db = new DoSqliteDatabase(storage);

    const rejected = await db
      .transaction(async () => {
        throw callbackError;
      })
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).errors).toEqual([callbackError, rollbackError]);
  });

  it("cursor 形狀不認得時丟錯（不可靜默回空結果）", async () => {
    const storage: DoSqlStorageLike = {
      sql: { exec: () => ({}) as never }, // 既沒有 toArray() 也不能 iterate
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    };
    const db = new DoSqliteDatabase(storage);

    await expect(db.all("select 1")).rejects.toThrow(/cursor/i);
    await expect(db.get("select 1")).rejects.toThrow(/cursor/i);
  });

  it("handle 在回呼 settle 後、COMMIT 之前就已失效（對齊官方 NodeSqliteDatabase 的順序）", async () => {
    // 官方 `node.js` 在 `await callback(...)` 之後、「COMMIT」之前就把 scope 標成失效；
    // 若晚到平台 transaction 整個 resolve 才失效，呼叫端把 handle 存起來就可能在 commit
    // 窗口內靜默執行（第二輪 checker 實測 NEW-P2-1）。
    const events: string[] = [];
    let commitWindow = "N/A";
    let captured: SqliteExecutor | null = null;
    const storage: DoSqlStorageLike = {
      sql: { exec: () => ({ toArray: () => [] }) as never },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        events.push("begin");
        const result = await callback({ rollback: () => {} });
        events.push("callback-settled");
        try {
          // 探的是**我方**交給呼叫端的 handle，不是平台自己的 tx 物件。
          await (captured as unknown as SqliteExecutor).exec("probe: still in commit window?");
          events.push("executed-in-commit-window");
          commitWindow = "EXECUTED";
        } catch {
          events.push("rejected-in-commit-window");
          commitWindow = "THREW";
        }
        events.push("commit");
        return result;
      },
    };
    const db = new DoSqliteDatabase(storage);

    await db.transaction(async (handle) => {
      captured = handle;
      return "ok";
    });

    expect(commitWindow).toBe("THREW");
    expect(events).toEqual([
      "begin",
      "callback-settled",
      "rejected-in-commit-window",
      "commit",
    ]);
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