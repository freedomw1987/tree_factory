// TECH-012：`/transcript/stream` 的跨請求緩衝（路由層）。
//
// 這裡用**真 node:sqlite** 當 DO SQLite，並且每個請求都可以換一個 DO instance——
// 如果實作把「還沒講完的那半句」放在記憶體，下面第一題（拆在半句中間）就會紅：
// 第二個請求看不到前一個請求的字 → 帳本少字，而且**沒有任何錯誤回報**（US-103 P0-1）。

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

const NOW = 1_700_000_000_000;
const TWO_HOURS_MS = 7_200_000;

function sqliteContext(nowMs = NOW): {
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

function durableFor(ctx: MeetingDurableObjectContext): MeetingDurableObject {
  return new MeetingDurableObject(ctx, {} as MeetingBindings);
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(
    new Request(`https://meeting.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function started(nowMs = NOW): Promise<{
  ctx: MeetingDurableObjectContext;
  db: DatabaseSync;
  durable: MeetingDurableObject;
  tick: (ms: number) => void;
}> {
  const { ctx, db, tick } = sqliteContext(nowMs);
  const durable = durableFor(ctx);
  const began = await call(durable, "/session/start", {});
  expect(began.status).toBe(201);
  return { ctx, db, durable, tick };
}

/** 一則 STT 事件（只保留 route 需要的欄位）。 */
function words(
  items: { word: string; start: number; end: number; speaker: number }[],
  final = true,
): Record<string, unknown> {
  return { type: "Results", is_final: final, channel: { alternatives: [{ words: items }] } };
}

/**
 * 直接讀 DO 的 SQLite 看緩衝列。
 * 「表還不存在」＝「一列都沒有」（offset 不合法時我們在**開表之前**就回 400 了）；
 * `state` 解析成物件再比，才不會被 JSON 的鍵序影響。
 */
function bufferedRows(db: DatabaseSync): { session_id: string; state: unknown }[] {
  let rows: { session_id: string; state: string }[];
  try {
    rows = db.prepare("SELECT session_id, state FROM stream_buffer").all() as {
      session_id: string;
      state: string;
    }[];
  } catch {
    return [];
  }
  return rows.map((row) => ({ session_id: row.session_id, state: JSON.parse(row.state) }));
}

describe("TECH-012 /transcript/stream 跨請求緩衝", () => {
  it("M01-D1：斷在半句中間的兩個請求 → 帳本是完整一句（不是兩段殘句，也不是少字）", async () => {
    const { durable } = await started();
    const first = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "我們", start: 0, end: 0.4, speaker: 0 }])],
    });
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(0);
    expect(first.body.bufferedWords).toBe(1);

    const second = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "開始", start: 0.4, end: 0.9, speaker: 0 }]), { type: "UtteranceEnd" }],
    });
    // `UtteranceEnd`（endpointing 訊號）的真實順序是「在那句的 final 之後」才到，
    // 所以要等**下一顆字**進來才會收段（US-103 既有語意，這裡不變）。
    expect(second.status).toBe(200);
    expect(second.body.accepted).toBe(0);
    expect(second.body.bufferedWords).toBe(2);

    const third = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "了", start: 2, end: 2.3, speaker: 0 }])],
    });
    expect(third.status).toBe(200);
    expect(third.body.accepted).toBe(1);
    expect(third.body.appended).toMatchObject([{ speakerId: 0, text: "我們 開始", startMs: 0, endMs: 900 }]);
    expect(third.body.bufferedWords).toBe(1);

    const listed = await call(durable, "/transcript/segments");
    expect(listed.body.count).toBe(1);
  });

  it("M01-D1：換一個 DO instance（模擬被回收後重啟）也接得回來——緩衝活在 SQLite，不是記憶體", async () => {
    const { ctx, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "半", start: 0, end: 0.5, speaker: 0 }])],
    });
    // 新的 instance、同一份 storage：真實世界就是 DO 被 evict 之後的下一次請求
    const revived = durableFor(ctx);
    const done = await call(revived, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "句", start: 0.5, end: 0.9, speaker: 0 }])],
      finalize: true,
    });
    expect(done.body.appended).toMatchObject([{ text: "半 句", startMs: 0, endMs: 900 }]);
    expect(done.body.bufferedWords).toBe(0);
  });

  it("M01-D9：回應帶 meetingOffsetMs / bufferedWords / forcedFlushes（裝置端看得出緩衝狀態）", async () => {
    const { durable } = await started();
    const ok = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 1500,
      messages: [words([{ word: "甲", start: 0, end: 0.5, speaker: 0 }])],
    });
    expect(ok.body).toMatchObject({ meetingOffsetMs: 1500, bufferedWords: 1, forcedFlushes: 0 });
    // 既有欄位不得被拿掉（accepted / duplicates / conflicts / transcriptWrites / appended / pending）
    for (const field of ["accepted", "duplicates", "conflicts", "transcriptWrites", "appended", "pending"]) {
      expect(Object.keys(ok.body)).toContain(field);
    }
  });

  it("M01-D2：offset 第一次寫定；換一個值 → 409 OFFSET_MISMATCH 並回現值，且**一個字都沒寫**", async () => {
    const { db, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 1500,
      messages: [words([{ word: "甲", start: 0, end: 0.5, speaker: 0 }])],
    });
    const before = bufferedRows(db);
    const drift = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 2000,
      messages: [words([{ word: "乙", start: 0.5, end: 0.9, speaker: 0 }])],
    });
    expect(drift.status).toBe(409);
    expect(drift.body).toMatchObject({ error: "OFFSET_MISMATCH", meetingOffsetMs: 1500 });
    expect(bufferedRows(db)).toEqual(before);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);

    // 帶回正確的 offset 就繼續（不是整場會議卡死）
    const again = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 1500,
      messages: [words([{ word: "乙", start: 0.5, end: 0.9, speaker: 0 }])],
      finalize: true,
    });
    expect(again.status).toBe(200);
    expect(again.body.appended).toMatchObject([{ text: "甲 乙", startMs: 1500, endMs: 2400 }]);
  });

  it("M01-D2：offset 不合法（負 / 小數 / 字串）→ 400，且不得留下緩衝", async () => {
    const { db, durable } = await started();
    for (const bad of [-1, 1.5, "0"]) {
      const response = await call(durable, "/transcript/stream", {
        meetingOffsetMs: bad,
        messages: [words([{ word: "甲", start: 0, end: 0.5, speaker: 0 }])],
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("TRANSCRIPT_INVALID");
      expect(response.body.message).toContain("meetingOffsetMs");
    }
    expect(bufferedRows(db)).toEqual([]);
  });

  it("M01-D3：finalize 把最後一段落地、緩衝的字清空；第二次 finalize 不再多一列（冪等）", async () => {
    const { db, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "最後", start: 0, end: 0.6, speaker: 2 }])],
    });
    const first = await call(durable, "/transcript/stream", { meetingOffsetMs: 0, messages: [], finalize: true });
    expect(first.body).toMatchObject({ accepted: 1, bufferedWords: 0 });
    // 真 workerd 實測抓到：把整列刪掉的話，重連的裝置端可以帶新的 offset 繼續寫，
    // 落地時間軸就整個漂移。所以收尾只清「字」，`meetingOffsetMs` 的釘樁留著。
    expect(bufferedRows(db)).toEqual([
      { session_id: "do-test", state: { meetingOffsetMs: 0, words: [], pendingUtteranceEnd: false } },
    ]);

    const second = await call(durable, "/transcript/stream", { meetingOffsetMs: 0, messages: [], finalize: true });
    expect(second.body.accepted).toBe(0);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
  });

  it("M01-D3：finalize 之後 offset 仍釘住 → 換一個值還是 409（收尾不是解鎖）", async () => {
    const { durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 1500,
      messages: [words([{ word: "那句", start: 0, end: 0.5, speaker: 0 }])],
    });
    await call(durable, "/transcript/stream", { meetingOffsetMs: 1500, messages: [], finalize: true });
    const afterFinalize = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 4000,
      messages: [words([{ word: "下一句", start: 1, end: 1.4, speaker: 0 }])],
    });
    expect(afterFinalize.status).toBe(409);
    expect(afterFinalize.body).toMatchObject({ error: "OFFSET_MISMATCH", meetingOffsetMs: 1500 });
    // 帶回原本的值就繼續（重連的裝置端不必重開會議，只要沿用同一條時間軸）
    const resumed = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 1500,
      messages: [words([{ word: "下一句", start: 1, end: 1.4, speaker: 0 }])],
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ meetingOffsetMs: 1500, bufferedWords: 1 });
  });

  it("M01-D4：會議已結束仍送 stream → 409 + droppedBufferedWords（那半句沒落地，要說得出來）", async () => {
    const { db, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([
        { word: "沒", start: 0, end: 0.2, speaker: 0 },
        { word: "講", start: 0.2, end: 0.4, speaker: 0 },
        { word: "完", start: 0.4, end: 0.6, speaker: 0 },
      ])],
    });
    await call(durable, "/session/stop", { reason: "user" });
    const rejected = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "後", start: 0.6, end: 0.8, speaker: 0 }])],
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "SESSION_ENDED", accepted: 0, droppedBufferedWords: 3 });
    expect(bufferedRows(db)).toEqual([]);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(0);
  });

  it("M01-D4：到 2 小時上限 → LIMIT_REACHED 也要併同丟掉緩衝並回報字數", async () => {
    const { db, durable, tick } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "尾", start: 0, end: 0.5, speaker: 0 }])],
    });
    tick(TWO_HOURS_MS + 1);
    const rejected = await call(durable, "/transcript/stream", { meetingOffsetMs: 0, messages: [] });
    expect(rejected.body).toMatchObject({ error: "LIMIT_REACHED", droppedBufferedWords: 1 });
    expect(bufferedRows(db)).toEqual([]);
  });

  it("M01-D4：沒有緩衝時被擋 → droppedBufferedWords 是 0（不是 undefined、不是 null）", async () => {
    const { durable } = await started();
    await call(durable, "/session/stop", { reason: "user" });
    const rejected = await call(durable, "/transcript/stream", { meetingOffsetMs: 0, messages: [] });
    expect(rejected.body.droppedBufferedWords).toBe(0);
  });

  it("M01-D4：批次路徑（/transcript/segments）不得動到串流緩衝（兩條路徑互不干涉）", async () => {
    const { db, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "串", start: 0, end: 0.5, speaker: 0 }])],
    });
    const before = bufferedRows(db);
    await call(durable, "/transcript/segments", {
      segments: [{ idempotencyKey: "seg:1:1000", speakerId: 1, text: "批次", startMs: 1000, endMs: 2000 }],
    });
    expect(bufferedRows(db)).toEqual(before);

    // 真正會分辨的那一半：會議結束後批次路徑也會被擋（409），此時它更不能去動串流緩衝——
    // 「丟掉緩衝」是串流路徑的語意（那半句屬於它），批次路徑沒有資格替它決定，也不該回報字數。
    await call(durable, "/session/stop", { reason: "user" });
    const ended = await call(durable, "/transcript/segments", {
      segments: [{ idempotencyKey: "seg:1:3000", speakerId: 1, text: "批次2", startMs: 3000, endMs: 4000 }],
    });
    expect(ended.status).toBe(409);
    expect(ended.body.error).toBe("SESSION_ENDED");
    expect(ended.body).not.toHaveProperty("droppedBufferedWords");
    expect(bufferedRows(db)).toEqual(before);
  });

  it("M01-D1：不同會議（不同 meeting id）各自一份緩衝，不得互相汙染", async () => {
    const { durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "甲會", start: 0, end: 0.5, speaker: 0 }])],
    });
    const other = await call(
      durable,
      "/transcript/stream",
      { meetingOffsetMs: 0, messages: [words([{ word: "乙會", start: 0, end: 0.5, speaker: 0 }])] },
      { "x-meeting-id": "m-other" },
    );
    // 另一個 meeting id 看不到甲的緩衝（各一場會議一份）
    expect(other.body.bufferedWords).toBe(1);
    const otherDone = await call(
      durable,
      "/transcript/stream",
      { meetingOffsetMs: 0, messages: [], finalize: true },
      { "x-meeting-id": "m-other" },
    );
    expect(otherDone.body.appended).toMatchObject([{ text: "乙會" }]);
  });

  it("M01-D7：中途拋錯 → 緩衝不得前進（快照寫在整批成功之後），重送同一批是安全的", async () => {
    const { db, durable } = await started();
    const batch = {
      meetingOffsetMs: 0,
      messages: [words([{ word: "早", start: 0, end: 0.5, speaker: 0 }])],
    };
    await call(durable, "/transcript/stream", batch);
    const before = bufferedRows(db);
    // 這批的第 2 則落在未來：第 1 則先落地（帳本 1 列），第 2 則在收尾才被擋 → 400，
    // 而且緩衝必須維持原狀（路由沒寫快照）→ 重送同一批只會 upsert 到同一列。
    const bad = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [
        words([{ word: "再", start: 0.5, end: 0.9, speaker: 0 }]),
        words([{ word: "未來", start: 400, end: 400.5, speaker: 0 }]),
      ],
      finalize: true,
    });
    expect(bad.status).toBe(400);
    expect((await call(durable, "/transcript/segments")).body.count).toBe(1);
    expect(bufferedRows(db)).toEqual(before);
  });

  it("M01-D8：DB 裡的緩衝壞掉 → 500 STREAM_BUFFER_CORRUPT、recoverable:false（不得當成沒有緩衝）", async () => {
    const { db, durable } = await started();
    await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "甲", start: 0, end: 0.5, speaker: 0 }])],
    });
    db.prepare("UPDATE stream_buffer SET state = ?").run('{"meetingOffsetMs":-1,"words":[]}');
    const broken = await call(durable, "/transcript/stream", { meetingOffsetMs: 0, messages: [] });
    expect(broken.status).toBe(500);
    expect(broken.body).toMatchObject({ error: "STREAM_BUFFER_CORRUPT", recoverable: false });
  });

  it("M01-D6：只餵 interim 的請求 → 落地緩衝不動，但 pending 看得到那句（顯示用）", async () => {
    const { durable } = await started();
    const interim = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "暫", start: 0, end: 0.4, speaker: 1 }], false)],
    });
    expect(interim.body).toMatchObject({ accepted: 0, bufferedWords: 0 });
    expect(interim.body.pending).toMatchObject({ speakerId: 1, text: "暫" });
  });

  it("M01-D7：同一批重送兩次 → 帳本不變、緩衝不變（冪等鍵擋重複）", async () => {
    const { db, durable } = await started();
    const batch = {
      meetingOffsetMs: 0,
      messages: [words([{ word: "甲", start: 0, end: 0.5, speaker: 0 }])],
    };
    await call(durable, "/transcript/stream", batch);
    const before = bufferedRows(db);
    const again = await call(durable, "/transcript/stream", batch);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 0, bufferedWords: 1 });
    expect(bufferedRows(db)).toEqual(before);
  });

  it("M01-D10：重播的批次裡有已落地的字 → 緩衝不得被汙染，之後的正常字照常落得了地", async () => {
    const { db, durable } = await started();
    // 「回應掉了、裝置端原樣重送」的真實形狀：整批事件裡**同時**有已經落地的那半句之後的字
    // （甲／乙 在丙進來時已收段落地）與還在緩衝裡的字（丙）。
    const batch = {
      meetingOffsetMs: 0,
      messages: [
        words([
          { word: "甲", start: 0, end: 0.5, speaker: 0 },
          { word: "乙", start: 0.5, end: 0.9, speaker: 0 },
          { word: "丙", start: 3, end: 3.5, speaker: 0 },
        ]),
      ],
    };
    const first = await call(durable, "/transcript/stream", batch);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: 1, bufferedWords: 1 });
    expect(first.body.appended).toMatchObject([{ text: "甲 乙", startMs: 0, endMs: 900 }]);
    const before = bufferedRows(db);

    // 原樣重送：甲／乙 已經在帳本裡（時間軸覆蓋到它們的終點）→ 不可以再進緩衝。
    // 修好之前，這一趟會把緩衝變成 [丙, 甲, 乙]（時間軸反向）並寫回 SQLite。
    const again = await call(durable, "/transcript/stream", batch);
    const afterReplay = bufferedRows(db);

    // 之後的正常字必須落得了地。修好前這裡是 400（`endMs=900 必須 ≥ startMs=3000`），
    // 而且**每一個**後續請求都 400：甲／乙 這兩顆字只在會議結束以 droppedBufferedWords 出現。
    const next = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [words([{ word: "丁", start: 4, end: 4.5, speaker: 0 }])],
      finalize: true,
    });
    expect(next.status).toBe(200);
    expect(next.body.appended).toMatchObject([{ text: "丙 丁", startMs: 3000, endMs: 4500 }]);
    const listed = await call(durable, "/transcript/segments");
    expect(listed.body.count).toBe(2);

    // 根因：重播的那批不得把已落地的字塞進緩衝（修好前這裡是 3：`[丙, 甲, 乙]`，時間軸反向）
    expect(again.status).toBe(200);
    // replayedWords＝被判定成「早就落地的重播字」而沒進緩衝的字數（甲、乙）：丟得對，但要看得見
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 0, bufferedWords: 1, replayedWords: 2 });
    expect(afterReplay).toEqual(before);
  });
});
