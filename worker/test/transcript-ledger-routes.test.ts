// M01-US-103：DO 路由層（寫入守門 + 帳本 + 串流落地 + 讀回）。
//
// 這裡用**真 node:sqlite** 當 DO SQLite，並且會刻意「換一個 DO instance」重讀同一份 DB——
// 若實作把逐字稿放在記憶體，這個斷言會直接紅。

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

const FIXTURE = JSON.parse(
  readFileSync(`${new URL(".", import.meta.url).pathname}../../spike/results/spike-001-ws-diarize.json`, "utf8"),
) as { messages: unknown[] };

function sqliteContext(nowMs = 1_700_000_000_000): {
  ctx: MeetingDurableObjectContext;
  db: DatabaseSync;
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
              bindings.length > 0 ? db.prepare(query).all(...(bindings as never[])) : db.prepare(query).all();
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
  return { ctx, db, tick: (ms: number) => (now += ms) };
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
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
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
  const durable = new MeetingDurableObject(ctx, {} as MeetingBindings);
  return { durable, ctx, tick };
}

async function startMeeting(durable: MeetingDurableObject): Promise<void> {
  const started = await call(durable, "/session/start", {});
  expect(started.status).toBe(201);
}

const oneSegment = {
  idempotencyKey: "seg:0:0",
  speakerId: 0,
  text: "第一句",
  startMs: 0,
  endMs: 1_000,
};

describe("M01-US-103 /transcript/segments（寫入 + 讀回）", () => {
  it("M01-Given 還沒開始 When 寫入 Then 409 SESSION_NOT_STARTED（不得寫進不存在的會議）", async () => {
    const { durable } = started();
    const { status, body } = await call(durable, "/transcript/segments", { segments: [oneSegment] });
    expect(status).toBe(409);
    expect(body.error).toBe("SESSION_NOT_STARTED");
    expect(await call(durable, "/transcript/segments")).toMatchObject({ status: 409 });
  });

  it("M01-Given 進行中 When 寫入兩段 Then GET 依 seq 讀回，且 transcriptWrites 跟著累計", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const write = await call(durable, "/transcript/segments", {
      segments: [oneSegment, { idempotencyKey: "seg:1:2000", speakerId: 1, text: "第二句", startMs: 2_000, endMs: 3_500 }],
    });
    expect(write.status).toBe(200);
    expect(write.body.accepted).toBe(2);

    const listed = await call(durable, "/transcript/segments");
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(2);
    expect(listed.body.segments).toMatchObject([
      { seq: 1, speakerId: 0, text: "第一句", startMs: 0, endMs: 1_000 },
      { seq: 2, speakerId: 1, text: "第二句", startMs: 2_000, endMs: 3_500 },
    ]);

    const session = await call(durable, "/session");
    expect(session.body.transcriptWrites).toBe(2);
  });

  it("M01-AC-6：同一鍵重送 → duplicate:true、列數不變、計數不增加", async () => {
    const { durable } = started();
    await startMeeting(durable);
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    const again = await call(durable, "/transcript/segments", { segments: [oneSegment] });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 1 });
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(1);
  });

  it("M01-D8：同鍵不同內容 → conflict 回報（含兩份全文），列數不變", async () => {
    const { durable } = started();
    await startMeeting(durable);
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    const conflict = await call(durable, "/transcript/segments", {
      segments: [{ ...oneSegment, text: "重講的版本", endMs: 1_500 }],
    });
    expect(conflict.status).toBe(200);
    expect(conflict.body.accepted).toBe(0);
    expect(conflict.body.conflicts).toMatchObject([
      { existing: { text: "第一句" }, incoming: { text: "重講的版本" } },
    ]);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
  });

  it("M01-驗證：壞內容（空白內文／負 speaker／endMs 在未來）→ 400 TRANSCRIPT_INVALID 且一列都沒寫", async () => {
    const { durable } = started();
    await startMeeting(durable);
    for (const bad of [
      { ...oneSegment, text: "   " },
      { ...oneSegment, speakerId: -1 },
      { ...oneSegment, endMs: 10 * 60 * 1000 },
    ]) {
      const { status, body } = await call(durable, "/transcript/segments", { segments: [bad] });
      expect(status).toBe(400);
      expect(body.error).toBe("TRANSCRIPT_INVALID");
    }
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });

  it("M01-驗證：一批裡面有一個壞的 → 整批不寫（不得只寫一半）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const { status } = await call(durable, "/transcript/segments", {
      segments: [oneSegment, { ...oneSegment, idempotencyKey: "seg:1:2000", text: "" }],
    });
    expect(status).toBe(400);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });

  it("M01-AC-2：單一物件（非陣列）也可以寫，時間戳原樣存回", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const { status } = await call(durable, "/transcript/segments", { ...oneSegment, startMs: 12_345, endMs: 13_000 });
    expect(status).toBe(200);
    expect((await call(durable, "/transcript/segments")).body.segments).toMatchObject([
      { startMs: 12_345, endMs: 13_000 },
    ]);
  });

  it("M01-US-101 舊路徑：/transcript 仍只計數、不落地（帳本是文字的唯一真實來源）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const legacy = await call(durable, "/transcript", { text: "舊客戶端的句子" });
    expect(legacy.status).toBe(200);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(1);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });

  it("M01-AC-5（DoD 探針）：已達 2 小時上限後不得再寫，且列數不變", async () => {
    const { durable, tick } = started();
    await startMeeting(durable);
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    tick(7_200_000 + 1);
    const blocked = await call(durable, "/transcript/segments", {
      segments: [{ ...oneSegment, idempotencyKey: "seg:0:200000", startMs: 200_000, endMs: 201_000 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("LIMIT_REACHED");
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
  });

  it("M01-跨 DO instance：換一個 DO 讀同一份 DB 仍看得到逐字稿（不是記憶體帳本）", async () => {
    const { ctx } = sqliteContext();
    const first = new MeetingDurableObject(ctx, {} as MeetingBindings);
    await startMeeting(first);
    await call(first, "/transcript/segments", { segments: [oneSegment] });
    const second = new MeetingDurableObject(ctx, {} as MeetingBindings);
    const listed = await call(second, "/transcript/segments");
    expect(listed.body).toMatchObject({ count: 1 });
    expect(listed.body.segments).toMatchObject([{ seq: 1, text: "第一句" }]);
  });
});

describe("M01-US-103 /transcript/stream（串流事件落地）", () => {
  it("M01-AC-4/AC-1：真跡重播 → 6 段、編號 0/1 交替；再重播一次全部 duplicate", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const first = await call(durable, "/transcript/stream", {
      messages: FIXTURE.messages,
      meetingOffsetMs: 0,
      finalize: true,
    });
    expect(first.status).toBe(200);
    expect(first.body.appended).toHaveLength(6);
    const listed = await call(durable, "/transcript/segments");
    expect(
      (listed.body.segments as { speakerId: number }[]).map((row) => row.speakerId),
    ).toEqual([0, 1, 0, 1, 0, 1]);

    const replay = await call(durable, "/transcript/stream", {
      messages: FIXTURE.messages,
      meetingOffsetMs: 0,
      finalize: true,
    });
    expect(replay.body.appended).toHaveLength(0);
    expect(replay.body.duplicates).toBe(6);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(6);
  });

  it("M01-AC-7：串流路徑也吃 UtteranceEnd（切在 1.0 秒，不與下一段重疊）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const body = {
      meetingOffsetMs: 0,
      finalize: true,
      messages: [
        { type: "Results", is_final: true, channel: { alternatives: [{ words: [{ word: "一", start: 0, end: 1, speaker: 0 }] }] } },
        { type: "UtteranceEnd", last_word_end: 2 },
        { type: "Results", is_final: true, channel: { alternatives: [{ words: [{ word: "二", start: 2, end: 3, speaker: 0 }] }] } },
      ],
    };
    const { status } = await call(durable, "/transcript/stream", body);
    expect(status).toBe(200);
    const segments = (await call(durable, "/transcript/segments")).body.segments as {
      text: string;
      startMs: number;
      endMs: number;
    }[];
    expect(segments.map((row) => [row.text, row.startMs, row.endMs])).toEqual([
      ["一", 0, 1_000],
      ["二", 2_000, 3_000],
    ]);
  });

  it("M01-AC-2：缺少 meetingOffsetMs 或給了負數 → 400（不得默默當 0）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const missing = await call(durable, "/transcript/stream", { messages: [] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("TRANSCRIPT_INVALID");
    const negative = await call(durable, "/transcript/stream", { messages: [], meetingOffsetMs: -1 });
    expect(negative.status).toBe(400);
  });

  it("M01-Given 未開始 When 串流落地 Then 409（守門與寫入路徑一致）", async () => {
    const { durable } = started();
    const { status, body } = await call(durable, "/transcript/stream", { messages: FIXTURE.messages, meetingOffsetMs: 0 });
    expect(status).toBe(409);
    expect(body.error).toBe("SESSION_NOT_STARTED");
  });

  it("M01-呼叫端契約（P0-1）：同一批事件拆成「每則一請求」→ 切法不同（每請求一個聚段器）", async () => {
    const finals = FIXTURE.messages.filter(
      (message) => (message as { is_final?: unknown }).is_final === true,
    );
    expect(finals).toHaveLength(7); // 含最後那則空 transcript 的 final（它不產生段落）
    const withWords = finals.filter((message) => {
      const words = (message as { channel?: { alternatives?: { words?: unknown[] }[] } }).channel?.alternatives?.[0]
        ?.words;
      return (words?.length ?? 0) > 0;
    });
    expect(withWords).toHaveLength(6);

    // 一次送完：6 段、seq 1..6。
    const whole = started();
    await startMeeting(whole.durable);
    const oneShot = await call(whole.durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      finalize: true,
      messages: withWords,
    });
    expect(oneShot.status).toBe(200);
    expect(oneShot.body.accepted).toBe(6);
    const oneShotRows = (await call(whole.durable, "/transcript/segments")).body.segments as { seq: number }[];
    expect(oneShotRows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // 拆成 6 個請求（每個都收尾）：字一個不少，但被切成 10 段——這就是 P0-1 指出的差異。
    const split = started();
    await startMeeting(split.durable);
    for (const message of withWords) {
      const { status } = await call(split.durable, "/transcript/stream", {
        meetingOffsetMs: 0,
        finalize: true,
        messages: [message],
      });
      expect(status).toBe(200);
    }
    const splitRows = (await call(split.durable, "/transcript/segments")).body.segments as {
      seq: number;
      text: string;
    }[];
    expect(splitRows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(splitRows.reduce((total, row) => total + row.text.split(" ").length, 0)).toBe(66);
  });

  it("M01-D9：重送不得讓 transcriptWrites 膨脹（新增才計數，重播夾在中間也一樣）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    const second = { idempotencyKey: "seg:1:2000", speakerId: 1, text: "第二句", startMs: 2_000, endMs: 3_500 };
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    const replay = await call(durable, "/transcript/segments", { segments: [oneSegment] });
    expect(replay.body).toMatchObject({ accepted: 0, duplicates: 1 });
    const fresh = await call(durable, "/transcript/segments", { segments: [second] });
    // 正確：1（首寫）+ 1（新段）= 2。把重送也當成寫入會變 3——守門員看到的數字就說謊了。
    expect(fresh.body.transcriptWrites).toBe(2);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(2);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(2);
  });

  it("M01-append-only 的 HTTP 面：DELETE / PUT / PATCH 不得偷偷寫入（405 且列數不變）", async () => {
    const { durable } = started();
    await startMeeting(durable);
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const response = await durable.fetch(
        new Request("https://meeting.test/transcript/segments", { method }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, HEAD");
    }
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
  });

  it("M01-正式路徑的動詞守門：非 POST 打在 /transcript/stream → 405 allow: POST，且不得偷寫一列", async () => {
    // 第一輪審查只抓到 `/transcript/segments` 漏守門；第二輪抓到**本票的正式路徑**也漏——
    // 當時 `DELETE /transcript/stream` 帶合法 body 會回 200 並真的寫進一列。這一條把它釘死。
    const finalWithWords = FIXTURE.messages.find((message) => {
      const words = (message as { channel?: { alternatives?: { words?: unknown[] }[] } }).channel?.alternatives?.[0]
        ?.words;
      return (message as { is_final?: unknown }).is_final === true && (words?.length ?? 0) > 0;
    });
    const { durable } = started();
    await startMeeting(durable);
    await call(durable, "/transcript/segments", { segments: [oneSegment] });
    const body = JSON.stringify({ meetingOffsetMs: 0, finalize: true, messages: [finalWithWords] });
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const response = await durable.fetch(
        new Request("https://meeting.test/transcript/stream", {
          method,
          body,
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(((await response.json()) as { error: string }).error).toBe("METHOD_NOT_ALLOWED");
    }
    // 讀路徑也不在 stream 上：GET／HEAD 同樣 405（不是 400「body 不合法」——這條路沒有讀的模式）。
    for (const method of ["GET", "HEAD"]) {
      const response = await durable.fetch(new Request("https://meeting.test/transcript/stream", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    // 重點：上面全部沒有偷偷寫入任何一列。
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
  });

  it("M01-壞請求：finalize 非布林（\"yes\" / 1 / \"true\"）→ 400，不得靜默吃掉最後一段", async () => {
    // `finalize` 只認 `true`；若照收非布林值，最後一段會留在緩衝裡默默不落地（與 P0-1 同一類陷阱）。
    const finalWithWords = FIXTURE.messages.find((message) => {
      const words = (message as { channel?: { alternatives?: { words?: unknown[] }[] } }).channel?.alternatives?.[0]
        ?.words;
      return (message as { is_final?: unknown }).is_final === true && (words?.length ?? 0) > 0;
    });
    const { durable } = started();
    await startMeeting(durable);
    for (const finalize of ["yes", 1, "true"]) {
      const response = await durable.fetch(
        new Request("https://meeting.test/transcript/stream", {
          method: "POST",
          body: JSON.stringify({ meetingOffsetMs: 0, finalize, messages: [finalWithWords] }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("TRANSCRIPT_INVALID");
      expect(body.message).toContain("finalize");
    }
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
    // 對照組：同一個請求把 finalize 換成 `true` 就落地（證明被擋的是型別，不是內容）。
    const ok = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      finalize: true,
      messages: [finalWithWords],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.accepted as number).toBeGreaterThan(0);
  });

  it("M01-D9：串流路徑的重播同樣不計入 transcriptWrites", async () => {
    const finals = FIXTURE.messages.filter((message) => {
      const words = (message as { channel?: { alternatives?: { words?: unknown[] }[] } }).channel?.alternatives?.[0]
        ?.words;
      return (message as { is_final?: unknown }).is_final === true && (words?.length ?? 0) > 0;
    });
    const { durable } = started();
    await startMeeting(durable);
    const body = (message: unknown): Record<string, unknown> => ({
      meetingOffsetMs: 0,
      finalize: true,
      messages: [message],
    });
    expect((await call(durable, "/transcript/stream", body(finals[0]))).body).toMatchObject({
      accepted: 1,
      transcriptWrites: 1,
    });
    expect((await call(durable, "/transcript/stream", body(finals[0]))).body).toMatchObject({
      accepted: 0,
      duplicates: 1,
      transcriptWrites: 1,
    });
    const second = await call(durable, "/transcript/stream", body(finals[1]));
    // 這一則 final 自成 2 段（講者換人）——重點是計數＝1（首寫）+ 2（新增），不含前面那次重送。
    expect(second.body.accepted).toBe(2);
    expect(second.body.transcriptWrites).toBe(3);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(3);
  });

  it("M01-壞請求：body 不是 JSON 物件（null／陣列／純量／空）→ 400，不得 500", async () => {
    const { durable } = started();
    await startMeeting(durable);
    for (const payload of [null, [], "字串", 42]) {
      const response = await durable.fetch(
        new Request("https://meeting.test/transcript/stream", {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("TRANSCRIPT_INVALID");
    }
    const empty = await durable.fetch(new Request("https://meeting.test/transcript/stream", { method: "POST" }));
    expect(empty.status).toBe(400);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });

  it("M01-壞請求：segments 給了非陣列（字串／純量／物件／含 null）→ 400，不得 500", async () => {
    const { durable } = started();
    await startMeeting(durable);
    for (const segments of ["abc", 42, { a: 1 }]) {
      const { status, body } = await call(durable, "/transcript/segments", { segments });
      expect(status).toBe(400);
      expect(body.error).toBe("TRANSCRIPT_INVALID");
      // 訊息要指向「segments 型別錯」，而不是讓呼叫端以為是某個欄位漏了（F9）。
      expect(String(body.message)).toContain("segments");
    }
    const inArray = await call(durable, "/transcript/segments", { segments: [null] });
    expect(inArray.status).toBe(400);
    expect(inArray.body.error).toBe("TRANSCRIPT_INVALID");
    // 訊息要指向**第幾個**元素壞掉，否則呼叫端只知道「有東西不對」（第二輪審查 P2-3）。
    expect(String(inArray.body.message)).toContain("segments[0]");
    const secondBad = await call(durable, "/transcript/segments", { segments: [oneSegment, null] });
    expect(secondBad.status).toBe(400);
    expect(String(secondBad.body.message)).toContain("segments[1]");
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });
});
