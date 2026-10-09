// M01-US-107：背景／鎖屏缺口標記（`TRANSCRIPT_GAP`）。
//
// 這裡證明的是 AC-3（同一次中斷不得重複標記）與「跨 DO 重建仍在」：
// 用真 node:sqlite 當 DO SQLite 替身，並且**換一個 DO instance** 再讀同一份 DB
// ——若實作把缺口放在記憶體，這個斷言會直接紅。
//
// 缺口時間是「相對會議開始的毫秒」（見 design §3），所以測試裡的 fromMs/toMs
// 都必須落在「已過時間 + 容差」之內；超過的案例要走 400（未來的缺口是資料錯誤）。

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { TEST_ANCHOR_KEY } from "./meeting-do.test.js";

import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

function sqliteContext(nowMs = 1_700_000_000_000): {
  ctx: MeetingDurableObjectContext;
  tick: (ms: number) => void;
} {
  const db = new DatabaseSync(":memory:");
  let now = nowMs;
  const ctx: MeetingDurableObjectContext = {
    now: () => now,
    id: { toString: () => "do-test" },
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          if (/^\s*(select|with|pragma|explain)/i.test(query)) {
            const rows =
              bindings.length > 0
                ? db.prepare(query).all(...(bindings as never[]))
                : db.prepare(query).all();
            return { toArray: () => rows, rowsWritten: 0 };
          }
          if (bindings.length > 0) {
            const result = db.prepare(query).run(...(bindings as never[]));
            return { toArray: () => [], rowsWritten: Number(result.changes) };
          }
          db.exec(query);
          return { toArray: () => [], rowsWritten: 0 };
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
  } as unknown as MeetingDurableObjectContext;
  return { ctx, tick: (ms: number) => (now += ms) };
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(
    new Request(`https://meeting.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), duplex: "half" } as never),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function started(nowMs = 1_700_000_000_000): {
  durable: MeetingDurableObject;
  ctx: MeetingDurableObjectContext;
  tick: (ms: number) => void;
} {
  const { ctx, tick } = sqliteContext(nowMs);
  const durable = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
  return { durable, ctx, tick };
}

interface Gap {
  seq: number;
  fromMs: number;
  toMs: number | null;
}

describe("M01-US-107 逐字稿缺口標記路由", () => {
  it("M01-Given 會議已開始 When hidden 當下寫入缺口 Then 200 且 toMs=null（尚未閉合）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(12_000);
    const { status, body } = await call(durable, "/transcript/gap", {
      seq: 1,
      fromMs: 12_000,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      count: 1,
      gap: { seq: 1, fromMs: 12_000, toMs: null },
    });
  });

  it("M01-Given 同一次中斷 When 重複送同 seq Then 不新增第二筆（AC-3）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(5_000);
    await call(durable, "/transcript/gap", { seq: 1, fromMs: 5_000 });
    const again = await call(durable, "/transcript/gap", { seq: 1, fromMs: 5_000 });
    const third = await call(durable, "/transcript/gap", { seq: 1, fromMs: 5_000 });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(third.body.count).toBe(1);
    const listed = await call(durable, "/transcript/gaps");
    expect(listed.body.count).toBe(1);
    expect(listed.body.gaps).toHaveLength(1);
  });

  it("M01-Given 未閉合缺口 When 回到前台補 toMs Then 閉合；晚到的較小 toMs 不得縮短", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(10_000);
    await call(durable, "/transcript/gap", { seq: 1, fromMs: 10_000 });
    tick(8_000);
    const closed = await call(durable, "/transcript/gap", { seq: 1, fromMs: 10_000, toMs: 18_000 });
    expect(closed.body).toMatchObject({ gap: { seq: 1, fromMs: 10_000, toMs: 18_000 }, duplicate: true });
    const late = await call(durable, "/transcript/gap", { seq: 1, fromMs: 10_000, toMs: 12_000 });
    expect(late.body).toMatchObject({ gap: { toMs: 18_000 } });
    const longer = await call(durable, "/transcript/gap", { seq: 1, fromMs: 10_000, toMs: 20_000 });
    expect(longer.body).toMatchObject({ gap: { toMs: 20_000 } }); // 延長可以（涵蓋更長的中斷）
  });

  it("M01-Given 兩次各自中斷 When 標記 Then 兩筆不同 seq 各自保留（不是重複）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(3_000);
    await call(durable, "/transcript/gap", { seq: 1, fromMs: 3_000, toMs: 4_000 });
    tick(6_000);
    await call(durable, "/transcript/gap", { seq: 2, fromMs: 10_000, toMs: 11_000 });
    const listed = await call(durable, "/transcript/gaps");
    expect(listed.body.gaps).toEqual([
      { seq: 1, fromMs: 3_000, toMs: 4_000 },
      { seq: 2, fromMs: 10_000, toMs: 11_000 },
    ]);
  });

  it("M01-Given 不合法範圍 When 寫入 Then 400 GAP_INVALID（未來的缺口 / 逆轉 / 非正整數 seq）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(9_000);
    const cases: Array<Record<string, unknown>> = [
      { seq: 0, fromMs: 1_000 },
      { seq: 1.5, fromMs: 1_000 },
      { seq: 1, fromMs: -1 },
      { seq: 1, fromMs: 5_000, toMs: 4_000 },
      { seq: 1, fromMs: 600_000 }, // 遠超過已過時間（9 秒）+ 容差
      { seq: 1, fromMs: 1_000, toMs: 600_000 }, // 結束時間也不可以在未來
      { fromMs: 1_000 },
    ];
    for (const body of cases) {
      const result = await call(durable, "/transcript/gap", body);
      expect({ case: body, status: result.status, error: result.body.error }).toMatchObject({
        status: 400,
        error: "GAP_INVALID",
      });
    }
    const listed = await call(durable, "/transcript/gaps");
    expect(listed.body.count).toBe(0); // 被擋下的不得留下半筆
  });

  it("M01-Given 容差內的小幅時鐘漂移 When 寫入 Then 收下（不因幾毫秒就丟資料）", async () => {
    const { durable } = started();
    await call(durable, "/session/start", {});
    const { status } = await call(durable, "/transcript/gap", { seq: 1, fromMs: 30_000 });
    expect(status).toBe(200);
  });

  it("M01-Given 會議沒開始 When 寫入 / 讀取 Then 409 SESSION_NOT_STARTED", async () => {
    const { durable } = started();
    const write = await call(durable, "/transcript/gap", { seq: 1, fromMs: 0 });
    const list = await call(durable, "/transcript/gaps");
    expect(write.status).toBe(409);
    expect(list.status).toBe(409);
    expect(list.body.error).toBe("SESSION_NOT_STARTED");
  });

  it("M01-Given 會議已結束 When 補寫缺口 Then 409（會後補寫會讓逐字稿與時間軸對不上）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(3_000);
    await call(durable, "/session/stop", { reason: "user" });
    const afterEnd = await call(durable, "/transcript/gap", { seq: 1, fromMs: 1_000 });
    expect(afterEnd.status).toBe(409);
    expect(afterEnd.body.error).toBe("SESSION_ENDED");
  });

  it("M01-Given 到達 2 小時上限 When 補寫缺口 Then 409 LIMIT_REACHED（不讓缺口說謊超過上限）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(2 * 60 * 60 * 1000 + 1_000);
    const overLimit = await call(durable, "/transcript/gap", { seq: 1, fromMs: 60_000 });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.error).toBe("LIMIT_REACHED");
  });

  it("M01-Given 同 seq 卻是不同起點（序號被重用）When 寫入 Then 409 GAP_CONFLICT 且原列不變", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(9_000);
    await call(durable, "/transcript/gap", { seq: 1, fromMs: 5_000 });
    const conflict = await call(durable, "/transcript/gap", { seq: 1, fromMs: 6_000 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("GAP_CONFLICT");
    const listed = await call(durable, "/transcript/gaps");
    expect(listed.body.gaps).toEqual([{ seq: 1, fromMs: 5_000, toMs: null }]);
  });

  it("M01-Gate4 P2-3：合法 JSON 的 `null`／陣列／純量 body When 打缺口路由 Then 400（不得 500）", async () => {
    const { durable, tick } = started();
    await call(durable, "/session/start", {});
    tick(3_000);
    for (const bad of [null, [], "字串", 42]) {
      const { status, body } = await call(durable, "/transcript/gap", bad);
      expect(status).toBe(400);
      expect(body.error).toBe("TRANSCRIPT_INVALID");
    }
    const listed = await call(durable, "/transcript/gaps");
    expect(listed.body.count).toBe(0);
  });

  it("M01-Given 換一個 DO instance When 讀同一份 DB Then 缺口仍在（不是記憶體裡的 Map）", async () => {
    const { durable, ctx, tick } = started();
    await call(durable, "/session/start", {});
    tick(7_000);
    await call(durable, "/transcript/gap", { seq: 1, fromMs: 7_000, toMs: 8_000 });
    const revived = new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings);
    const listed = await call(revived, "/transcript/gaps");
    expect(listed.body.gaps as Gap[]).toEqual([{ seq: 1, fromMs: 7_000, toMs: 8_000 }]);
  });
});
