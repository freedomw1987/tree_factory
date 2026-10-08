// M01-US-101：MeetingDurableObject 的 session HTTP 介面（裝置端真正會打的路）。
//
// 這裡是 DoD 那條探針的落地位置：
//   「探針鎖定 2:00 之後不得再寫入逐字稿，且 2:00 前的資料不得被刪」。
// 用真 SQLite（node:sqlite）當 DO storage，時間由 `ctx.now` 注入 —— 所以「兩小時後」
// 在測試裡是立刻可驗的，不必真的等兩小時、也不必偽造系統時鐘。

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { MeetingBindings } from "../src/harness/meeting-harness.js";
import {
  MeetingDurableObject,
  type MeetingDurableObjectContext,
} from "../src/meeting-do.js";

interface Harness {
  durable: MeetingDurableObject;
  alarms: number[];
  setNow: (ms: number) => void;
}

function makeHarness(nowMs = 1_700_000_000_000): Harness {
  const db = new DatabaseSync(":memory:");
  const alarms: number[] = [];
  let currentAlarm: number | null = null;
  let now = nowMs;
  const ctx: MeetingDurableObjectContext = {
    storage: {
      sql: {
        exec(sql: string, ...bindings: never[]) {
          if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
            const rows =
              bindings.length > 0
                ? db.prepare(sql).all(...(bindings as never[]))
                : db.prepare(sql).all();
            return { toArray: () => rows };
          }
          if (bindings.length > 0) {
            db.prepare(sql).run(...(bindings as never[]));
          } else {
            db.exec(sql);
          }
          return { toArray: () => [] };
        },
      },
      async setAlarm(atMs: number) {
        alarms.push(atMs);
        currentAlarm = atMs;
      },
      async getAlarm() {
        return currentAlarm;
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    },
    id: { toString: () => "do-abc" },
    now: () => now,
  };
  const durable = new MeetingDurableObject(ctx, { HARNESS_PROVIDER: "faux" } as MeetingBindings);
  return {
    durable,
    alarms,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  harness: Harness,
  path: string,
  init: { method?: string; body?: unknown; meetingId?: string } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { "x-meeting-id": init.meetingId ?? "m-1" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await harness.durable.fetch(
    new Request(`https://meeting.test${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("M01-US-101 session 路由（設備端真正的路）", () => {
  const STARTED = 1_700_000_000_000;

  it("M01-Given 還沒開始 When GET /session Then 404 SESSION_NOT_STARTED（不明說「沒這回事」會讓裝置端亂猜）", async () => {
    const harness = makeHarness(STARTED);
    const { status, body } = await call(harness, "/session");
    expect(status).toBe(404);
    expect(body.error).toBe("SESSION_NOT_STARTED");
  });

  it("M01-Given 開始會議 When POST /session/start Then ends_at = 現在 + 2 小時，並排好到點 alarm", async () => {
    const harness = makeHarness(STARTED);
    const { status, body } = await call(harness, "/session/start", { method: "POST" });
    expect(status).toBe(201);
    expect(body.meetingId).toBe("m-1");
    expect(body.phase).toBe("recording");
    expect(body.startedAtMs).toBe(STARTED);
    expect(body.endsAtMs).toBe(STARTED + 7_200_000);
    expect(body.remainingMs).toBe(7_200_000);
    expect(body.warn).toBe(false);
    expect(harness.alarms).toEqual([STARTED + 7_200_000]);
  });

  it("M01-Given 已經開始 When 重複 POST /session/start Then 不重開（時間軸不得被重置）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 60_000);
    const { body } = await call(harness, "/session/start", { method: "POST" });
    expect(body.startedAtMs).toBe(STARTED);
    expect(body.endsAtMs).toBe(STARTED + 7_200_000);
    expect(harness.alarms).toEqual([STARTED + 7_200_000]); // 不得再排一次
  });

  it("M01-Given 距上限 5 分鐘 When GET /session Then warn=true 但 phase 仍是 recording（紅燈不得提前熄）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 7_200_000 - 300_000);
    const { body } = await call(harness, "/session");
    expect(body.warn).toBe(true);
    expect(body.phase).toBe("recording");
    expect(body.remainingMs).toBe(300_000);
  });

  it("M01-Given 已經到點 When GET /session Then phase=limit_reached（即使 alarm 還沒醒，時間就是權威）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 7_200_000);
    const { body } = await call(harness, "/session");
    expect(body.phase).toBe("limit_reached");
    expect(body.remainingMs).toBe(0);
  });

  it("M01-Given 到點後 When 再 GET Then 仍是 limit_reached（狀態已落地，不是每次現算）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 7_200_000);
    await call(harness, "/session");
    const { body } = await call(harness, "/session");
    expect(body.phase).toBe("limit_reached");
  });

  it("M01-Given 使用者提前結束 When POST /session/stop Then phase=ended 且 2:00 未到也拒收逐字稿", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    const stopped = await call(harness, "/session/stop", {
      method: "POST",
      body: { reason: "user" },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.phase).toBe("ended");
    const write = await call(harness, "/transcript", {
      method: "POST",
      body: { text: "會後才補的句子" },
    });
    expect(write.status).toBe(409);
    expect(write.body.error).toBe("SESSION_ENDED");
  });

  it("M01-Given 裝置端開始失敗 When POST /session/stop {reason:'aborted'} Then 收掉 session（不得留孤兒 session 到 alarm 才被當成錄到上限）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    const { status, body } = await call(harness, "/session/stop", {
      method: "POST",
      body: { reason: "aborted" },
    });
    expect(status).toBe(200);
    expect(body.phase).toBe("ended");
    expect(body.endedReason).toBe("aborted");
  });

  it("M01-Given stop 帶了非法 reason When POST /session/stop Then 400 REASON_INVALID（不得默默當 user）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    const { status, body } = await call(harness, "/session/stop", {
      method: "POST",
      body: { reason: "because" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("REASON_INVALID");
  });

  it("M01-Given 上限前 When POST /transcript Then 接受並累計寫入次數", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    const first = await call(harness, "/transcript", { method: "POST", body: { text: "第一句" } });
    const second = await call(harness, "/transcript", { method: "POST", body: { text: "第二句" } });
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(true);
    expect(first.body.transcriptWrites).toBe(1);
    expect(second.body.transcriptWrites).toBe(2);
  });

  it("M01-Given 已達 2:00 上限 When POST /transcript Then 409 LIMIT_REACHED 且寫入次數不變（DoD 探針）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    await call(harness, "/transcript", { method: "POST", body: { text: "上限前的句子" } });
    harness.setNow(STARTED + 7_200_000);
    const blocked = await call(harness, "/transcript", { method: "POST", body: { text: "上限後的句子" } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("LIMIT_REACHED");
    const status = await call(harness, "/session");
    expect(status.body.transcriptWrites).toBe(1); // 2:00 前的資料不得被刪、也不得再加
  });

  it("M01-Given 上限前 1ms When POST /transcript Then 仍接受（邊界：不得提前截斷）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 7_200_000 - 1);
    const { status } = await call(harness, "/transcript", { method: "POST", body: { text: "最後一句" } });
    expect(status).toBe(200);
  });

  it("M01-Given 還沒開始 When POST /transcript Then 409 SESSION_NOT_STARTED（不得寫進不存在的會議）", async () => {
    const harness = makeHarness(STARTED);
    const { status, body } = await call(harness, "/transcript", { method: "POST", body: { text: "無主句" } });
    expect(status).toBe(409);
    expect(body.error).toBe("SESSION_NOT_STARTED");
  });

  it("M01-Given 空字串 When POST /transcript Then 400 EMPTY_CONTENT（不得算一次寫入）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    const { status, body } = await call(harness, "/transcript", { method: "POST", body: { text: "   " } });
    expect(status).toBe(400);
    expect(body.error).toBe("EMPTY_CONTENT");
  });

  it("M01-Given alarm 在到點後醒來 When alarm() Then session 落地成 ended/limit（結束時間是 ends_at 不是醒來時間）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 7_200_000 + 30_000);
    await harness.durable.alarm();
    const { body } = await call(harness, "/session");
    expect(body.phase).toBe("limit_reached");
    expect(body.endedAtMs).toBe(STARTED + 7_200_000);
    expect(body.endedReason).toBe("limit");
  });

  it("M01-Given 使用者已結束 When 晚到的 alarm 醒來 Then 不得把原因改成 limit（不得覆寫使用者決定）", async () => {
    const harness = makeHarness(STARTED);
    await call(harness, "/session/start", { method: "POST" });
    harness.setNow(STARTED + 60_000);
    await call(harness, "/session/stop", { method: "POST", body: { reason: "user" } });
    harness.setNow(STARTED + 7_200_000 + 1);
    await harness.durable.alarm();
    const { body } = await call(harness, "/session");
    expect(body.endedReason).toBe("user");
    expect(body.endedAtMs).toBe(STARTED + 60_000);
  });
});
