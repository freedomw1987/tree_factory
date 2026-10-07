/**
 * SPIKE-003 一致性：用 pi-durable 官方的 storage 一致性測試庫驗 `DoSqliteDatabase`。
 *
 * 官方測試庫要求一個 Vitest/Jest 形狀的 runner（describe / it / expect），這裡用 node:test
 * 加一層最小 shim，這樣不必為了跑一致性測試引入整個 Vitest。
 * 目的：驗證 adapter 的**契約語意**正確，而不只是「我們試過的那幾個呼叫能跑」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DoSqliteDatabase } from "../src/do-sqlite.js";

/** 把 node:sqlite 包成 DO 的 `ctx.storage` 形狀（與 smoke.mjs 相同）。 */
export function doLikeStorage(db) {
  return {
    sql: {
      exec(sql, ...bindings) {
        if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
          const rows = db.prepare(sql).all(...bindings);
          return { toArray: () => rows };
        }
        if (bindings.length > 0) db.prepare(sql).run(...bindings);
        else db.exec(sql);
        return { toArray: () => [] };
      },
    },
    async transaction(callback) {
      db.exec("BEGIN");
      let rolledBack = false;
      try {
        const result = await callback({
          rollback: () => {
            db.exec("ROLLBACK");
            rolledBack = true;
          },
        });
        if (!rolledBack) db.exec("COMMIT");
        return result;
      } catch (error) {
        if (!rolledBack) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function messageOf(actual, expected) {
  return `値不符：expected ${JSON.stringify(expected)}，actual ${JSON.stringify(actual)}`;
}

function matchers(actual, mode) {
  const resolve = async () => {
    if (mode === "rejects") {
      try {
        await actual;
      } catch (error) {
        return error;
      }
      assert.fail("預期 promise 會被拒絕，但它成功了");
    }
    return mode === "resolves" ? await actual : actual;
  };
  const wrap = (fn) => (expected) =>
    mode === "sync" ? fn(actual, expected) : resolve().then((value) => fn(value, expected));
  const api = {
    toBe: wrap((a, e) => assert.strictEqual(a, e, messageOf(a, e))),
    toEqual: wrap((a, e) => assert.deepStrictEqual(a, e, messageOf(a, e))),
    toStrictEqual: wrap((a, e) => assert.deepStrictEqual(a, e, messageOf(a, e))),
    toBeUndefined: wrap((a) => assert.strictEqual(a, undefined, messageOf(a, undefined))),
    toBeDefined: wrap((a) => assert.notStrictEqual(a, undefined, "expected 已定義")),
    toBeTruthy: wrap((a) => assert.ok(a, "expected truthy")),
    toBeFalsy: wrap((a) => assert.ok(!a, "expected falsy")),
    toHaveLength: wrap((a, n) => assert.strictEqual(a?.length, n, messageOf(a?.length, n))),
    toContain: wrap((a, e) => assert.ok(a?.includes?.(e), `expected 包含 ${e}`)),
    toMatch: wrap((a, e) => assert.match(String(a), e)),
    toMatchObject: wrap((a, e) =>
      Object.entries(e).forEach(([k, v]) => assert.deepStrictEqual(a?.[k], v, `欄位 ${k} 不符`)),
    ),
    toThrow: wrap((a, e) => {
      const check = typeof e === "string" ? new RegExp(e) : e;
      assert.throws(a, check, "預期拋出錯誤");
    }),
  };
  return {
    ...api,
    get not() {
      const flipped = {};
      for (const [name, fn] of Object.entries(api)) {
        flipped[name] = (e) => {
          try {
            const out = fn(e);
            return out instanceof Promise ? out.then(() => assert.fail(`not.${name} 不該通過`)) : undefined;
          } catch {
            return undefined;
          }
        };
      }
      return flipped;
    },
    get rejects() {
      return matchers(actual, "rejects");
    },
    get resolves() {
      return matchers(actual, "resolves");
    },
  };
}

const runner = {
  describe,
  it: (name, test, timeoutMs) => it(name, test, timeoutMs),
  expect: (actual) => matchers(actual, "sync"),
};

registerStorageConformance(runner, "DoSqliteDatabase（DO SQLite 形狀）", async () => {
  const db = new DatabaseSync(":memory:");
  return await SqliteStorage.open(new DoSqliteDatabase(doLikeStorage(db)));
});