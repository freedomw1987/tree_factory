// M01-US-102：DO 的音訊分段路由與逐字稿分段冪等（用真 node:sqlite 當 DO SQLite 替身）。
//
// 這裡要證明的是**跨請求持久化**的行為，不是記憶體裡的 Map：
// 重送 3 次仍然一列、一句；同 seq 不同內容一定 409 且不覆蓋；
// 被守門員擋下的寫入不會把 seq 燒掉。

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

/** 把 node:sqlite 包成 DO storage（`rowsWritten` 對應 workerd 的欄位名）。 */
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

interface CallOptions {
  method?: string;
  body?: BodyInit;
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(
    new Request(`https://meeting.test${path}`, { method: options.method ?? "GET", ...(options.body === undefined ? {} : { body: options.body, duplex: "half" } as never) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function started(nowMs = 1_700_000_000_000): { durable: MeetingDurableObject; tick: (ms: number) => void } {
  const { ctx, tick } = sqliteContext(nowMs);
  const durable = new MeetingDurableObject(ctx, {} as MeetingBindings);
  return { durable, tick };
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("M01-US-102 音訊分段路由", () => {
  it("M01-Given 會議已開始 When 上傳第 1 段 Then 201 accepted 且 expectedNextSeq=2", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    const { status, body } = await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes(1, 2, 3) });
    expect(status).toBe(201);
    expect(body).toMatchObject({ accepted: true, duplicate: false, seq: 1, count: 1, expectedNextSeq: 2 });
  });

  it("M01-Given 同一段重送 3 次 When 上傳 Then 每次都成功但帳本只有一列（AC-2 冪等，跨請求持久）", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes(9, 9) });
    const second = await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes(9, 9) });
    const third = await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes(9, 9) });
    expect(second.status).toBe(201);
    expect(second.body.duplicate).toBe(true);
    expect(third.body.duplicate).toBe(true);
    expect(third.body.count).toBe(1);
    const ledger = await call(durable, "/audio/chunks");
    expect(ledger.body.count).toBe(1);
    expect(ledger.body.expectedNextSeq).toBe(2);
  });

  it("M01-Given 同 seq 不同內容 When 上傳 Then 409 SEQ_CONFLICT 且原本那列不變（不覆蓋）", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    await call(durable, "/audio/chunk?seq=2", { method: "POST", body: bytes(1) });
    const conflict = await call(durable, "/audio/chunk?seq=2", { method: "POST", body: bytes(2) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("SEQ_CONFLICT");
    const ledger = await call(durable, "/audio/chunks");
    expect(ledger.body.chunks).toEqual([{ seq: 2, byteLen: 1, hash: expect.any(String) }]);
  });

  it("M01-Given seq 不合法（缺 / 非數字）When 上傳 Then 400 SEQ_INVALID（不可默默當成 1）", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    const missing = await call(durable, "/audio/chunk", { method: "POST", body: bytes(1) });
    const nan = await call(durable, "/audio/chunk?seq=abc", { method: "POST", body: bytes(1) });
    for (const result of [missing, nan]) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("SEQ_INVALID");
    }
  });

  it("M01-Given 空內容 When 上傳 Then 400（空段不該佔用一個 seq）", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    const { status, body } = await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes() });
    expect(status).toBe(400);
    expect(body.error).toBe("SEQ_INVALID");
  });

  it("M01-Given 會議沒開始 When 上傳 / 讀帳本 Then 404 SESSION_NOT_STARTED", async () => {
    const { durable } = started();
    const upload = await call(durable, "/audio/chunk?seq=1", { method: "POST", body: bytes(1) });
    const ledger = await call(durable, "/audio/chunks");
    expect(upload.status).toBe(404);
    expect(ledger.status).toBe(404);
    expect(ledger.body.error).toBe("SESSION_NOT_STARTED");
  });

  it("M01-Given 已收 1,2,4（缺 3）When 讀帳本 Then expectedNextSeq=3 且附帶保留天數政策", async () => {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    for (const seq of [1, 2, 4]) {
      await call(durable, `/audio/chunk?seq=${seq}`, { method: "POST", body: bytes(seq) });
    }
    const ledger = await call(durable, "/audio/chunks");
    expect(ledger.body.expectedNextSeq).toBe(3);
    expect(ledger.body.chunks).toHaveLength(3);
    expect(ledger.body.retentionDays).toBe(7);
  });
});

describe("M01-US-102 逐字稿分段冪等（AC-4 無重複句）", () => {
  async function startedMeeting(): Promise<MeetingDurableObject> {
    const { durable } = started();
    await call(durable, "/session/start", { method: "POST" });
    return durable;
  }

  function transcript(durable: MeetingDurableObject, payload: Record<string, unknown>) {
    return call(durable, "/transcript", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    } as never);
  }

  it("M01-Given 同一 chunkSeq 送兩次 When 寫逐字稿 Then 第二次 duplicate 且計數不變", async () => {
    const durable = await startedMeeting();
    const first = await transcript(durable, { text: "第一段內容", chunkSeq: 3 });
    const second = await transcript(durable, { text: "第一段內容", chunkSeq: 3 });
    expect(first.body).toMatchObject({ accepted: true, duplicate: false, transcriptWrites: 1 });
    expect(second.body).toMatchObject({ accepted: false, duplicate: true, transcriptWrites: 1 });
  });

  it("M01-Given 不同 chunkSeq When 寫逐字稿 Then 各自接受、計數累加", async () => {
    const durable = await startedMeeting();
    await transcript(durable, { text: "A", chunkSeq: 1 });
    const second = await transcript(durable, { text: "B", chunkSeq: 2 });
    expect(second.body).toMatchObject({ accepted: true, transcriptWrites: 2 });
  });

  it("M01-Given 沒帶 chunkSeq When 寫兩次同內容 Then 都接受（舊行為：不做去重，避免把重複發言誤判成重送）", async () => {
    const durable = await startedMeeting();
    await transcript(durable, { text: "同樣的話" });
    const second = await transcript(durable, { text: "同樣的話" });
    expect(second.body).toMatchObject({ accepted: true, transcriptWrites: 2 });
  });

  it("M01-Given 空內文被擋下 When 補上內容用同一 seq Then 仍算第一次（seq 不會被燒掉）", async () => {
    const durable = await startedMeeting();
    const rejected = await transcript(durable, { text: "   ", chunkSeq: 5 });
    expect(rejected.status).toBe(400);
    const accepted = await transcript(durable, { text: "真的有內容", chunkSeq: 5 });
    expect(accepted.body).toMatchObject({ accepted: true, duplicate: false, transcriptWrites: 1 });
  });

  it("M01-Given 會議已結束 When 重送已收過的 chunkSeq Then 回 duplicate（冪等優先於 409）", async () => {
    const durable = await startedMeeting();
    await transcript(durable, { text: "內容", chunkSeq: 4 });
    await call(durable, "/session/stop", {
      method: "POST",
      body: JSON.stringify({ reason: "user_ended" }),
      headers: { "content-type": "application/json" },
    } as never);
    const repeat = await transcript(durable, { text: "內容", chunkSeq: 4 });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ accepted: false, duplicate: true });
  });
});
