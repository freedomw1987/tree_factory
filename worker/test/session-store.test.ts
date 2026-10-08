// M01-US-101：session 的持久化接縫（DO SQLite）。
//
// 用 `node:sqlite` 當 DO SQLite 的替身（與 TECH-004 的 harness-persistence 同做法）：
// 這裡要證明的是「DO 被回收後重開，同一場會議讀得回同一份權威時間軸」，
// 而不是「記憶體裡的物件還在」。

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { startSession, stopSession } from "../src/session.js";
import { SessionStore, type SessionSql } from "../src/storage/session-store.js";

/** 把 node:sqlite 包成 DO `storage.sql` 的形狀。 */
function sqlDevice(): { db: DatabaseSync; sql: SessionSql } {
  const db = new DatabaseSync(":memory:");
  const sql: SessionSql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0
            ? db.prepare(query).all(...(bindings as never[]))
            : db.prepare(query).all();
        return { toArray: () => rows };
      }
      if (bindings.length > 0) {
        db.prepare(query).run(...(bindings as never[]));
      } else {
        db.exec(query);
      }
      return { toArray: () => [] };
    },
  };
  return { db, sql };
}

describe("M01-US-101 session 持久化", () => {
  const STARTED = 1_700_000_000_000;

  it("M01-Given 全新 DO When 讀 session Then null（還沒開始，不是一筆空 session）", () => {
    const { sql } = sqlDevice();
    expect(new SessionStore(sql).read()).toBeNull();
  });

  it("M01-Given 開始一場會議 When 寫入後重讀 Then 權威時間軸逐欄一致（含逐字稿寫入次數）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 7 });
    const read = store.read();
    expect(read?.session).toEqual(startSession("m-1", STARTED));
    expect(read?.transcriptWrites).toBe(7);
  });

  it("M01-Given 同一個 DO（同一場會議）When 重複寫入 Then 只有一列、以最後一次為準", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 1 });
    const stopped = stopSession(startSession("m-1", STARTED), STARTED + 1_000, "user");
    store.write({ session: stopped, transcriptWrites: 2 });
    const rows = sql.exec("SELECT COUNT(*) AS n FROM meeting_session").toArray() as { n: number }[];
    expect(rows[0]?.n).toBe(1);
    expect(store.read()?.session).toEqual(stopped);
    expect(store.read()?.transcriptWrites).toBe(2);
  });

  it("M01-Given 另一個 store 實例（模擬 DO 被回收後重開）When 讀同一份 storage Then 同一份資料", () => {
    const { sql } = sqlDevice();
    new SessionStore(sql).write({ session: startSession("m-1", STARTED), transcriptWrites: 3 });
    const reopened = new SessionStore(sql).read();
    expect(reopened?.session.meetingId).toBe("m-1");
    expect(reopened?.session.endsAtMs).toBe(STARTED + 7_200_000);
    expect(reopened?.transcriptWrites).toBe(3);
  });

  it("M01-Given 有人偷改 ends_at（想延長上限）When 讀取 Then 直接報錯（權威時間軸不得被改）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    // 模擬外部/舊版把上限往後推（繞過 store 的驗證，例如另一支 migration 寫壞）。
    sql.exec("UPDATE meeting_session SET ends_at_ms = ? WHERE id = 1", STARTED + 99_999_999);
    expect(() => store.read()).toThrowError(/SESSION_CORRUPT/);
  });

  it("M01-Given 想寫入不是 2 小時的 session When write Then 立刻擋下，且不留下任何列", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    const tampered = { ...startSession("m-1", STARTED), endsAtMs: STARTED + 10 * 60 * 60 * 1000 };
    expect(() => store.write({ session: tampered, transcriptWrites: 0 })).toThrowError(
      /SESSION_CORRUPT/,
    );
    expect(store.read()).toBeNull();
  });

  it("M01-Given 想寫入非法 state When 寫入 Then SQLite CHECK 擋下（資料庫層是第二道防線）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    expect(() =>
      sql.exec("UPDATE meeting_session SET state = ? WHERE id = 1", "paused"),
    ).toThrowError(/CHECK constraint/);
  });
});
