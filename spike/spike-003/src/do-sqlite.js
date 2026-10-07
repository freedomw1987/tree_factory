/**
 * SPIKE-003：把 Cloudflare Durable Object 的 SQLite 接成 pi-durable 的 `SqliteDatabase` facade。
 *
 * 為什麼只需要這一層：`@earendil-works/pi-durable` 的 `/storage/sqlite` 是可攜核心，
 * 官方 README 明說它「run without Node APIs, for example on Bun or in Cloudflare Durable Objects,
 * given an asynchronous SqliteDatabase facade」——本檔就是那個 facade。
 *
 * 需要的六個方法（見 pi-durable 的 storage/sqlite/database.d.ts）：
 *   exec(sql) / run(sql, ...params) / get(sql, ...params) / all(sql, ...params)
 *   transaction(cb) / close()
 */

/** DO SQL 接受的繫結型別：null | number | string | ArrayBuffer | ArrayBufferView。 */
function bind(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    // DO SQL 不吃 bigint；本系統的 id 皆為字串或安全整數，轉 number 即可
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

export class DoSqliteDatabase {
  #storage;
  #tail = Promise.resolve();
  #closed = false;

  /** @param storage Cloudflare 的 `ctx.storage`（需有 `.sql.exec` 與 `.transaction`） */
  constructor(storage) {
    this.#storage = storage;
  }

  #cursor(sql, params) {
    return this.#storage.sql.exec(sql, ...params.map(bind));
  }

  async exec(sql) {
    this.#storage.sql.exec(sql); // 多語句 DDL 用；DO 會自行執行整串
  }

  async run(sql, ...params) {
    this.#cursor(sql, params);
  }

  /** DO 的 cursor 可迭代、也有 `.toArray()`；兩種都支援以便測試時換成別的 shim。 */
  #rows(cursor) {
    if (typeof cursor.toArray === "function") return cursor.toArray();
    return [...cursor];
  }

  async get(sql, ...params) {
    const rows = this.#rows(this.#cursor(sql, params));
    return rows.length > 0 ? rows[0] : undefined;
  }

  async all(sql, ...params) {
    return this.#rows(this.#cursor(sql, params));
  }

  /**
   * 契約要求：交易期間不得有其他操作插隊，且回呼內只能用傳入的 handle。
   * 這裡用一條 promise 鏈把非交易操作排隊，交易本身則交給 DO 的 `storage.transaction`
   * （它負責 BEGIN / COMMIT / ROLLBACK）。
   */
  async transaction(callback) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let result;
      let failure;
      await this.#storage.transaction(async (transaction) => {
        try {
          result = await callback(this);
        } catch (error) {
          failure = error;
          transaction.rollback();
        }
      });
      if (failure !== undefined) throw failure;
      return result;
    } finally {
      release();
    }
  }

  async close() {
    this.#closed = true; // DO 的 SQLite 由平台管理，這裡只需符合介面
  }

  get closed() {
    return this.#closed;
  }
}
