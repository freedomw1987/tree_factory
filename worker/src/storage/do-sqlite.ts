/**
 * TECH-004：把 Cloudflare Durable Object 的 SQLite 接成 pi-durable 需要的
 * `SqliteDatabase` facade（型別直接引用官方介面，不自己另立一套）。
 *
 * 官方契約（`pi-durable/dist/storage/sqlite/database.d.ts`）有三條硬要求，
 * 這支實作逐條對應：
 * 1. **交易中的工作必須用回呼傳入的 handle**（不是資料庫本身）；handle 在回呼結束後失效。
 * 2. **adapter 必須排隊「無關的操作與其他交易」直到交易結束**。
 * 3. 回呼拒絕時必須先 rollback 再以同一個錯誤拒絕。
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
  return [];
}

/**
 * 交易 handle：**不排隊**（官方契約要求交易中的工作直接執行）。
 * 與 `DoSqliteDatabase` 共用同一個底層 storage，所以看到的是同一個交易。
 */
class DoSqliteTransactionHandle implements SqliteExecutor {
  readonly #storage: DoSqlStorageLike;

  constructor(storage: DoSqlStorageLike) {
    this.#storage = storage;
  }

  async exec(sql: string): Promise<void> {
    this.#storage.sql.exec(sql);
  }

  async run(sql: string, ...params: SqlBinding[]): Promise<void> {
    this.#storage.sql.exec(sql, ...params.map(bind));
  }

  async get<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T | undefined> {
    const result = rows(this.#storage.sql.exec(sql, ...params.map(bind)));
    return result.length > 0 ? (result[0] as T) : undefined;
  }

  async all<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T[]> {
    return rows(this.#storage.sql.exec(sql, ...params.map(bind))) as T[];
  }
}

export class DoSqliteDatabase implements SqliteDatabase {
  readonly #storage: DoSqlStorageLike;
  /** 非交易操作排隊用的 promise 鏈（官方契約第 2 條）。 */
  #tail: Promise<void> = Promise.resolve();
  /** 交易回呼執行中：此時從資料庫本身進來的語句屬於這個交易，直接放行（避免死鎖）。 */
  #inTransaction = false;
  #closed = false;

  constructor(storage: DoSqlStorageLike) {
    this.#storage = storage;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async exec(sql: string): Promise<void> {
    await this.#waitTurn();
    this.#storage.sql.exec(sql);
  }

  async run(sql: string, ...params: SqlBinding[]): Promise<void> {
    await this.#waitTurn();
    this.#storage.sql.exec(sql, ...params.map(bind));
  }

  async get<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T | undefined> {
    await this.#waitTurn();
    const result = rows(this.#storage.sql.exec(sql, ...params.map(bind)));
    return result.length > 0 ? (result[0] as T) : undefined;
  }

  async all<T extends object>(sql: string, ...params: SqlBinding[]): Promise<T[]> {
    await this.#waitTurn();
    return rows(this.#storage.sql.exec(sql, ...params.map(bind))) as T[];
  }

  /**
   * 交易：先把 `#tail` 換成新的閘門（讓後續非交易操作排隊），
   * 再把 BEGIN/COMMIT/ROLLBACK 交給平台的 `storage.transaction`。
   *
   * 回呼拿到的是**獨立的 handle**（官方契約第 1 條）；
   * 但若有人誤用資料庫本身（`db.run(...)`）也不會死鎖——`#inTransaction` 會放行。
   */
  async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const handle = new DoSqliteTransactionHandle(this.#storage);
    this.#inTransaction = true;
    try {
      let result: T | undefined;
      let failure: unknown;
      let failed = false;
      await this.#storage.transaction(async (transaction) => {
        try {
          result = await callback(handle);
        } catch (error) {
          failed = true;
          failure = error;
          transaction.rollback();
        }
      });
      if (failed) {
        // 官方契約第 3 條：先 rollback（上面已做）再以同一個錯誤拒絕。
        throw failure;
      }
      return result as T;
    } finally {
      this.#inTransaction = false;
      release();
    }
  }

  /** DO 的 SQLite 由平台管理，這裡只標記狀態以符合介面。 */
  async close(): Promise<void> {
    this.#closed = true;
  }

  /** 交易外的操作必須等上一個交易結束。 */
  async #waitTurn(): Promise<void> {
    if (this.#inTransaction) {
      return;
    }
    await this.#tail;
  }
}