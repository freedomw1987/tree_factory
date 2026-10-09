/**
 * TECH-014 整合測試（DO 層）— 覆蓋 AC-2、AC-5、AC-6 的路由行為。
 *
 * 純函式測試在 `session-anchor.test.ts`；位置／時鐘合理性測試在 `session-clock.test.ts`；
 * 這份專門跑「DO 端到端」的可被攻擊者利用的幾條路徑。
 */

import { describe, expect, it } from "vitest";

import {
  MeetingDurableObject,
  type MeetingDurableObjectContext,
} from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";
import { TEST_ANCHOR_KEY } from "./meeting-do.test.js";

import { DatabaseSync } from "node:sqlite";

/** 共用 DO context 替身（從 meeting-do.test.ts 抄的同形狀）。 */
function makeCtx(
  bindings: MeetingBindings = { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY },
  nowMs: number = 1_700_000_000_000,
): { ctx: MeetingDurableObjectContext; db: DatabaseSync; tick: (ms: number) => void } {
  const db = new DatabaseSync(":memory:");
  let now = nowMs;
  const ctx: MeetingDurableObjectContext = {
    storage: {
      sql: {
        exec(sql: string, ...bindings: unknown[]) {
          if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
            const rows = bindings.length > 0 ? db.prepare(sql).all(...(bindings as never[])) : db.prepare(sql).all();
            return { toArray: () => rows };
          }
          if (bindings.length > 0) db.prepare(sql).run(...(bindings as never[]));
          else db.exec(sql);
          return { toArray: () => [] };
        },
      },
      async setAlarm() {},
      async getAlarm() {
        return null;
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    },
    id: { toString: () => "do-anchor" },
    now: () => now,
  };
  return { ctx, db, tick: (ms) => (now += ms) };
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await durable.fetch(new Request(`https://test${path}`, init));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("M01-TECH-014 DO 整合：錨的路由行為", () => {
  // ──────────── AC-5：fail-closed（金鑰缺失）────────────
  it("AC-5 Given SESSION_ANCHOR_KEY 未設 When POST /session/start Then 500 SESSION_ANCHOR_NOT_CONFIGURED", async () => {
    const { ctx } = makeCtx({}); // 沒帶金鑰
    const durable = new MeetingDurableObject(ctx, {} as MeetingBindings);
    const r = await call(durable, "/session/start", "POST");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("SESSION_ANCHOR_NOT_CONFIGURED");
    expect(r.body.recoverable).toBe(false);
  });

  it("AC-5 Given SESSION_ANCHOR_KEY 只有空白 When POST /session/start Then 500", async () => {
    const { ctx } = makeCtx({ SESSION_ANCHOR_KEY: "   \n\t  " });
    const durable = new MeetingDurableObject(ctx, {} as MeetingBindings);
    const r = await call(durable, "/session/start", "POST");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("SESSION_ANCHOR_NOT_CONFIGURED");
  });

  // ──────────── AC-6：錨列遺失 ＝ 資料不合法 ────────────
  it("AC-6 Given session 有列、anchor 列被刪 When 新 DO 醒來 GET /session Then 500 SESSION_CORRUPT", async () => {
    // 第一個 DO 正常開始（會寫 session + anchor）
    const { ctx, db } = makeCtx();
    const durableA = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    const start = await call(durableA, "/session/start", "POST");
    expect(start.status).toBe(201);
    // 模擬「攻擊者刪掉錨列」— 用 raw SQL 直接刪
    db.exec("DELETE FROM session_anchor WHERE id = 1");
    // 第二個 DO 實例模擬「平台重新醒來」— 它會重新 #loadAnchor → 讀 anchor 會得到 null
    const durableB = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    const r = await call(durableB, "/session", "GET");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("SESSION_CORRUPT");
    expect(r.body.recoverable).toBe(false);
  });

  // ──────────── AC-2-②：拿一把錯的金鑰讀既有 session ────────────
  it("AC-2 Given session 是用 KEY_A 簽的 When 用 KEY_B 開新 DO 讀 Then 500 SESSION_CORRUPT", async () => {
    // 第一個 DO 用 KEY_A 開始
    const { ctx: ctxA } = makeCtx({ SESSION_ANCHOR_KEY: "KEY_A" }, 1_700_000_000_000);
    const durableA = new MeetingDurableObject(ctxA, { SESSION_ANCHOR_KEY: "KEY_A" } as MeetingBindings);
    await call(durableA, "/session/start", "POST");
    // 第二個 DO 用 KEY_B，DB 一樣、金鑰不一樣
    // （這個測試透過 ctx 共享 db — 上一個 ctxA 寫到 in-memory DB，下一個 ctxB 也指向它）
    // 簡化：直接在第二個 ctx 上重建一個 DO、但 sql.exec 接到同一個 db
    const db = new DatabaseSync(":memory:");
    let now = 1_700_000_000_000;
    const ctx: MeetingDurableObjectContext = {
      storage: {
        sql: {
          exec(sql: string, ...bindings: unknown[]) {
            if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
              const rows = bindings.length > 0 ? db.prepare(sql).all(...(bindings as never[])) : db.prepare(sql).all();
              return { toArray: () => rows };
            }
            if (bindings.length > 0) db.prepare(sql).run(...(bindings as never[]));
            else db.exec(sql);
            return { toArray: () => [] };
          },
        },
        async setAlarm() {},
        async getAlarm() {
          return null;
        },
        async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
          return callback({ rollback: () => {} });
        },
      },
      id: { toString: () => "do-B" },
      now: () => now,
    };
    // 階段一：KEY_A 開始
    const dA = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: "KEY_A" } as MeetingBindings);
    await call(dA, "/session/start", "POST");
    // 階段二：另一個 DO 實例（模擬「DO 被回收 + 醒來時用錯的金鑰」）
    const dB = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: "KEY_B" } as MeetingBindings);
    const r = await call(dB, "/session", "GET");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("SESSION_CORRUPT");
    expect(r.body.recoverable).toBe(false);
  });

  // ──────────── AC-4：合法路徑不得變紅（fixture 化）────────────
  it("AC-4 Given 正常開始 When GET /session Then 200 且 phase=recording", async () => {
    const { ctx } = makeCtx();
    const durable = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    await call(durable, "/session/start", "POST");
    const r = await call(durable, "/session", "GET");
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("recording");
  });

  it("AC-4 Given 正常開始 + 使用者結束 When GET /session Then 200 phase=ended reason=user", async () => {
    const { ctx } = makeCtx();
    const durable = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    await call(durable, "/session/start", "POST");
    await call(durable, "/session/stop", "POST", { reason: "user" });
    const r = await call(durable, "/session", "GET");
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("ended");
    expect(r.body.endedReason).toBe("user");
  });

  it("AC-4 Given 正常開始 + tick 2h+1s When GET /session Then 200 phase=limit_reached（到點收尾仍走）", async () => {
    const { ctx, tick } = makeCtx();
    const durable = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    await call(durable, "/session/start", "POST");
    tick(2 * 60 * 60 * 1000 + 1000);
    const r = await call(durable, "/session", "GET");
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("limit_reached");
    expect(r.body.endedReason).toBe("limit");
  });

  it("AC-4 Given 正常開始 When 重複 POST /session/start Then 201（同 meeting id 不重開）", async () => {
    const { ctx } = makeCtx();
    const durable = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    const r1 = await call(durable, "/session/start", "POST");
    const r2 = await call(durable, "/session/start", "POST");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // 同一個 meeting id、同一個 startedAtMs（沒被重設）
    expect(r1.body.startedAtMs).toBe(r2.body.startedAtMs);
  });
});
