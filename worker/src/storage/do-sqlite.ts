/**
 * TECH-004：把 Cloudflare Durable Object 的 SQLite 接成 pi-durable 需要的
 * `SqliteDatabase` facade（型別直接引用官方介面，不自己另立一套）。
 *
 * 官方契約（`pi-durable/dist/storage/sqlite/database.d.ts`）有四條硬要求，逐條對應：
 * 1. **交易中的工作必須用回呼傳入的 handle**（不是資料庫本身）；handle 在回呼結束後失效。
 * 2. **adapter 必須排隊「無關的操作與其他交易」直到交易結束**——排隊機制直接移植官方
 *    參考實作（`dist/storage/sqlite/node.js` 的 `SerialOperationQueue`）。
 * 3. 回呼拒絕時必須先 rollback，再以同一個錯誤拒絕；**若回滾本身也失敗，必須用不同的
 *    錯誤拒絕**（這裡用 `AggregateError`），呼叫端才不會誤以為一定回滾成功。
 * 4. 由第 1、2 條推得：**在回呼裡呼叫資料庫本身（含 `transaction` / `close`）依契約就是
 *    會卡住**（排在自己後面）。這不是 bug，是官方明訂的行為；要做事就用 handle。
 *
 * ⚠️ 這裡曾經用一個 `#inTransaction` 布林值去「放行」交易期間從資料庫本身進來的語句，
 * 想避免誤用者死鎖。那是**違反第 2 條的發明**：交易回呼 `await` 期間到達的無關操作
 * 會直接跑進交易裡（獨立 reviewer 用真原始碼重現）。現在改成與官方參考實作一致。
 *
 * 平台事實：DO SQL **不接受** `bigint` 繫結、也不授權 `sqlite_version()`（SPIKE-003 實測），
 * 所以 `bind()` 會把 `bigint` 轉成 number、`Uint8Array` 轉成 ArrayBuffer。
 */

import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** DO SQL 可接受的繫結值（官方 `SqliteValue` 的子集）。 */
export type SqlBinding = SqliteValue | undefined;

/** DO cursor 與 node:sqlite shim 的共同形狀。 */
export interface SqlCursorLike {
  toArray?: () => unknown[];
  [Symbol.iterator]?: () => Iterator<unknown>;
}

/** `ctx.storage` 我們真正用到的最小介面（避免綁死 @cloudflare/workers-types 版本）。 */
export interface DoSqlStorageLike {
  sql: {
    exec(sql: string, ...bindings: SqlBinding[]): SqlCursorLike;
  };
  transaction<T>(callback: (transaction: { rollback(): void }) => T | Promise<T>): Promise<T>;
}

/** DO SQL 不接受 `bigint` / `undefined`；本系統的 id 皆為字串或安全整數。 */
function bind(value: SqlBinding): SqliteValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    // 複製一份精確位元組：DO SQL 接受 ArrayBufferView，但不要帶著外部的 offset/length 進場。
    return new Uint8Array(value);
  }
  return value;
}

function rows(cursor: SqlCursorLike): unknown[] {
  if (typeof cursor.toArray === "function") {
    return cursor.toArray();
  }
  if (typeof cursor[Symbol.iterator] === "function") {
    return [...(cursor as Iterable<unknown>)];
  }
  // 不認得的 cursor 形狀＝我們的介面假設錯了：丟錯（不可靜默回空結果，
  // 那會讓「查不到」跟「讀不出來」長得一模一樣）。
  throw new Error("無法讀取 DO SQL cursor：既沒有 toArray() 也不能 iterate（cursor 形狀不認得）");
}

const NOOP = (): void => {};

/**
 * 官方參考實作 `SerialOperationQueue` 的移植（`pi-durable/dist/storage/sqlite/node.js`）：
 *
 * - 依呼叫順序執行；**佇列空時立刻開始**（不白等一個 microtask，這對交易外的查詢很重要）。
 * - 非同步操作會佔住佇列直到 settle。
 * - `runAsync` 在**開始前**先把柵欄放進 `#tail`，所以這次操作同步發出的後續呼叫
 *   （例如交易回呼裡的 `db.run(...)`）一定會排到它後面——這正是契約第 2 條要的行為。
 */
class SerialOperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  /** 同步操作：佇列空時立刻執行，否則排在隊尾。 */
  run<T>(operation: () => T): Promise<T> {
    if (this.#pending > 0) {
      return this.#enqueue(operation);
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** 非同步操作：佇列空時立刻開始（並先立柵欄），否則排在隊尾。 */
  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending > 0) {
      return this.#enqueue(operation);
    }
    this.#pending += 1;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    this.#tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.#pending -= 1;
      releaseBarrier();
    });
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#pending += 1;
    return this.#release(this.#tail.then(operation));
  }

  #release<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      this.#pending -= 1;
    });
    this.#tail = settled.then(NOOP, NOOP);
    return settled;
  }
}

/**
 * 交易 handle：**不排隊**（契約第 1 條：交易中的工作直接用 handle），
 * 但**在回呼結束後失效**（再用就丟錯，不可以靜默執行）。
 * 與 `DoSqliteDatabase` 共用同一個底層 storage，所以看到的是同一個交易。
 */
class DoSqliteTransactionHandle implements SqliteExecutor {
  readonly #storage: DoSqlStorageLike;
  readonly #scope: { active: boolean };

  constructor(storage: DoSqlStorageLike, scope: { active: boolean }) {
    this.#storage = storage;
    this.#scope = scope;
  }

  #assertActive(): void {
    if (!this.#scope.active) {
      throw new Error("交易 handle 已失效：回呼結束後不可再使用（契約第 1 條）");
    }
  }

  async exec(sql: string): Promise<void> {
    this.#assertActive();
    this.#storage.sql.exec(sql);
  }

  async run(sql: string, ...params: SqlBinding[]): Promise<void> {
    this.#assertActive();
    this.#storage.sql.exec(sql, ...params.map(bind));
  }

  async get<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T | undefined> {
    this.#assertActive();
    const result = rows(this.#storage.sql.exec(sql, ...params.map(bind)));
    return result.length > 0 ? (result[0] as T) : undefined;
  }

  async all<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T[]> {
    this.#assertActive();
    return rows(this.#storage.sql.exec(sql, ...params.map(bind))) as T[];
  }
}

export class DoSqliteDatabase implements SqliteDatabase {
  readonly #storage: DoSqlStorageLike;
  /** 依呼叫順序排隊（契約第 2 條）；交易期間到達的操作一律排到交易結束之後。 */
  readonly #access = new SerialOperationQueue();
  #closed = false;

  constructor(storage: DoSqlStorageLike) {
    this.#storage = storage;
  }

  get closed(): boolean {
    return this.#closed;
  }

  exec(sql: string): Promise<void> {
    return this.#access.run(() => {
      this.#storage.sql.exec(sql);
    });
  }

  run(sql: string, ...params: SqlBinding[]): Promise<void> {
    return this.#access.run(() => {
      this.#storage.sql.exec(sql, ...params.map(bind));
    });
  }

  get<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T | undefined> {
    return this.#access.run(() => {
      const result = rows(this.#storage.sql.exec(sql, ...params.map(bind)));
      return result.length > 0 ? (result[0] as T) : undefined;
    });
  }

  all<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T[]> {
    return this.#access.run(() => rows(this.#storage.sql.exec(sql, ...params.map(bind))) as T[]);
  }

  /**
   * 交易：整段佔住佇列（契約第 2 條），BEGIN/COMMIT/ROLLBACK 交給平台的 `storage.transaction`。
   *
   * 回呼拿到的是**獨立的 handle**（契約第 1 條，回呼結束後失效）；
   * 從資料庫本身進來的語句會排在整段交易之後（契約第 4 條推論，官方明訂如此）。
   */
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#access.runAsync(async () => {
      const scope = { active: true };
      const handle = new DoSqliteTransactionHandle(this.#storage, scope);
      let result: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        await this.#storage.transaction(async (transaction) => {
          try {
            result = await callback(handle);
            // 契約第 1 條：回呼一 settle 就失效——**在平台的 COMMIT 之前**。
            // 官方 `NodeSqliteDatabase` 就是這個順序（`node.js`：`scope.active = false`
            // 緊接在 `await callback(...)` 之後、`COMMIT` 之前）；若拖到平台整個 promise
            // resolve 才失效，呼叫端把 handle 存起來就能在 commit 窗口內靜默執行
            // （第二輪 checker 實測 NEW-P2-1）。
            scope.active = false;
          } catch (error) {
            scope.active = false;
            failed = true;
            failure = error;
            transaction.rollback();
          }
        });
      } catch (platformError) {
        // 平台在回滾階段失敗（契約第 3 條）：用 AggregateError 讓呼叫端分得出
        // 「回呼的錯誤」與「回滾失敗」，不會誤以為回滾一定成功。
        if (!failed) {
          throw platformError;
        }
        throw new AggregateError(
          [failure, platformError],
          "SQLite transaction failed and rollback failed",
        );
      }
      if (failed) {
        // 契約第 3 條：先 rollback（上面已做）再以同一個錯誤拒絕。
        throw failure;
      }
      return result as T;
    });
  }

  /** DO 的 SQLite 由平台管理，這裡只標記狀態以符合介面（一樣排在佇列裡）。 */
  close(): Promise<void> {
    return this.#access.run(() => {
      this.#closed = true;
    });
  }
}
