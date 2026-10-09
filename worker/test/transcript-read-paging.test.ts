// TECH-013：逐字稿讀取分頁／增量（`since` / `limit`）＋ 串流部分寫入的計數一致。
//
// 動手改 `meeting-do.ts` / `transcript-store.ts` 之前先紅的是 **8 條**：
//   * 分頁：US-103 的 GET 只有整場一次回傳 → 新欄位（`total`/`hasMore`/`nextSince`）不存在。
//   * 計數：失敗路徑與併發路徑都會少算（帳本有列、計數沒有）。
// 第 9 條「未知參數忽略」不是先紅的那群，它是**回歸護欄**：改動前後都要綠，
// 擋的是「未來把沒承諾的參數也當成錯誤」（突變 M12 就是證明它擋得住這個方向）。
// 第二輪獨立審查後又補了 3 條：預設 500 的截斷、批次儲存層錯誤的差額補記、舊路徑並發。

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TEST_ANCHOR_KEY } from "./meeting-do.test.js";

import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

function sqliteContext(
  nowMs = 1_700_000_000_000,
  options: { failTranscriptInsertAt?: number; pageLimitMax?: number } = {},
): {
  ctx: MeetingDurableObjectContext;
  tick: (ms: number) => void;
} {
  const db = new DatabaseSync(":memory:");
  let now = nowMs;
  let transcriptInserts = 0;
  const ctx: MeetingDurableObjectContext = {
    now: () => now,
    id: { toString: () => "do-test" },
    ...(options.pageLimitMax === undefined ? {} : { pageLimitMax: options.pageLimitMax }),
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          // 模擬**儲存層**錯誤：只算逐字稿的 INSERT，第 N 次才拋（＝前 N-1 列已經落地）。
          if (/^\s*insert\s+into\s+transcript_segments/i.test(query)) {
            transcriptInserts += 1;
            if (transcriptInserts === options.failTranscriptInsertAt) {
              throw new Error(`SQLITE_PROBE：第 ${transcriptInserts} 次逐字稿 INSERT 失敗`);
            }
          }
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
  return { ctx, tick: (ms: number) => (now += ms) };
}

function started(
  nowMs = 1_700_000_000_000,
  options: { failTranscriptInsertAt?: number; pageLimitMax?: number } = {},
): {
  durable: MeetingDurableObject;
  tick: (ms: number) => void;
} {
  const { ctx, tick } = sqliteContext(nowMs, options);
  return { durable: new MeetingDurableObject(ctx, { SESSION_ANCHOR_KEY: TEST_ANCHOR_KEY } as MeetingBindings), tick };
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

async function startMeeting(durable: MeetingDurableObject): Promise<void> {
  expect((await call(durable, "/session/start", {})).status).toBe(201);
}

/**
 * 在「請求已進到 handler、但還沒讀 body」的那一刻插入另一個請求。
 *
 * 這正是 D5 的併發窗口：`#readSession` 已經讀過快照，`await request.json()` 讓出執行權，
 * 另一個請求在這個時候落地一列。用注入 `json()` 讓它**必然**發生（真環境的交錯只是機率）。
 */
async function callWithInterleave(
  durable: MeetingDurableObject,
  path: string,
  body: unknown,
  duringAwait: () => Promise<void>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`https://meeting.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(request, "json", {
    value: async () => {
      await duringAwait();
      return JSON.parse(JSON.stringify(body)) as unknown;
    },
  });
  const response = await durable.fetch(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** 合成 nova `Results` 訊息（`final` 預設 true）。 */
function results(
  words: { word: string; start: number; end: number; speaker: number }[],
  final = true,
): Record<string, unknown> {
  return { type: "Results", is_final: final, channel: { alternatives: [{ words }] } };
}

const segment = (key: string, speakerId: number, text: string) => ({
  idempotencyKey: key,
  speakerId,
  text,
  startMs: 0,
  endMs: 1_000,
});

/** 三列（seq 1,2,3）的乾淨會議。 */
async function threeSegments(durable: MeetingDurableObject): Promise<void> {
  await startMeeting(durable);
  const written = await call(durable, "/transcript/segments", {
    segments: [segment("seg:0:0", 0, "第一句"), segment("seg:0:1", 0, "第二句"), segment("seg:0:2", 0, "第三句")],
  });
  expect(written.status).toBe(200);
  expect(written.body.accepted).toBe(3);
}

const seqsOf = (body: Record<string, unknown>): number[] =>
  (body.segments as { seq: number }[]).map((row) => row.seq);

describe("M01-TECH-013 AC-1：GET /transcript/segments 的增量與分頁", () => {
  it("M01-TECH-013 AC-1：`since` 是排他下界，且單趟就回報 hasMore / nextSince / total", async () => {
    const { durable } = started();
    await threeSegments(durable);

    const page = await call(durable, "/transcript/segments?since=2&limit=1");
    expect(page.status).toBe(200);
    expect(seqsOf(page.body)).toEqual([3]);
    expect(page.body.count).toBe(1);
    expect(page.body.total).toBe(3);
    expect(page.body.hasMore).toBe(false);
    expect(page.body.nextSince).toBe(3);
  });

  it("M01-TECH-013 AC-1：用 nextSince 續抓不漏不重（兩趟走完三列）", async () => {
    const { durable } = started();
    await threeSegments(durable);

    const first = await call(durable, "/transcript/segments?limit=2");
    expect(seqsOf(first.body)).toEqual([1, 2]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextSince).toBe(2);

    const second = await call(durable, `/transcript/segments?since=${first.body.nextSince as number}&limit=2`);
    expect(seqsOf(second.body)).toEqual([3]);
    expect(second.body.hasMore).toBe(false);
    expect([...seqsOf(first.body), ...seqsOf(second.body)]).toEqual([1, 2, 3]);
  });

  it("M01-TECH-013 AC-1：since 超過最後一列 → 空頁、nextSince=null（不是 404、不是回最後一頁）", async () => {
    const { durable } = started();
    await threeSegments(durable);

    const empty = await call(durable, "/transcript/segments?since=99");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ count: 0, total: 3, hasMore: false, nextSince: null });
    expect(seqsOf(empty.body)).toEqual([]);

    const notStarted = started();
    await startMeeting(notStarted.durable);
    const emptyLedger = await call(notStarted.durable, "/transcript/segments");
    expect(emptyLedger.body).toMatchObject({ count: 0, total: 0, hasMore: false, nextSince: null });
  });

  it("M01-TECH-013 AC-1：不帶參數與 ?limit=500 同形，且 count = segments.length（back-compat）", async () => {
    const { durable } = started();
    await threeSegments(durable);

    const plain = await call(durable, "/transcript/segments");
    const explicit = await call(durable, "/transcript/segments?limit=500");
    expect(seqsOf(plain.body)).toEqual([1, 2, 3]);
    expect(plain.body.count).toBe((plain.body.segments as unknown[]).length);
    expect(plain.body).toMatchObject({ total: 3, hasMore: false, nextSince: 3 });
    expect(seqsOf(explicit.body)).toEqual(seqsOf(plain.body));
    expect(explicit.body.count).toBe(plain.body.count);
    // `meetingId` 是 US-103 的既有欄位，不得因為加分頁而消失。
    expect(typeof plain.body.meetingId).toBe("string");
  });

  it("M01-TECH-013 AC-1：不帶參數時真的在上限截斷（下一列看得見，不是默默消失）", async () => {
    // 生產上限是 500（`SEGMENT_PAGE_LIMIT_MAX`）；這裡把上限注入成 50，
    // 這樣同一條斷言只要 51 列就能證明「預設值真的來自上限常數」（改壞預設值＝突變 M13 會紅），
    // 不必在單元測試裡湊到 501 列才看得出差別。上限本身也拿它當合法值的邊界（51 → 400）。
    const max = 50;
    const { durable } = started(1_700_000_000_000, { pageLimitMax: max });
    await startMeeting(durable);
    const total = max + 1;
    const rows = Array.from({ length: total }, (_ignored, index) =>
      segment(`seg:0:${index}`, 0, `第 ${index + 1} 句`),
    );
    const written = await call(durable, "/transcript/segments", { segments: rows });
    expect(written.status).toBe(200);
    expect(written.body.accepted).toBe(total);

    const plain = await call(durable, "/transcript/segments");
    expect(plain.body).toMatchObject({ count: max, total, hasMore: true, nextSince: max });
    expect((plain.body.segments as unknown[]).length).toBe(max);

    // 續抓：第 51 列不漏、也不重。（`since` 是排他下界，直接接 `nextSince` 就好。）
    const rest = await call(durable, `/transcript/segments?since=${plain.body.nextSince as number}`);
    expect(seqsOf(rest.body)).toEqual([total]);
    expect(rest.body).toMatchObject({ count: 1, total, hasMore: false, nextSince: total });

    // 超過上限的值不是被夾住，是 400。
    const over = await call(durable, `/transcript/segments?limit=${max + 1}`);
    expect(over.status).toBe(400);
    expect(String(over.body.message)).toContain("limit");
  });
});

describe("M01-TECH-013 AC-2：參數不合法要指名，不得靜默夾住", () => {
  it("M01-TECH-013 AC-2：壞參數 → 400 且訊息含欄位名", async () => {
    const { durable } = started();
    await threeSegments(durable);
    const cases: [string, string][] = [
      ["?limit=0", "limit"],
      ["?limit=501", "limit"],
      ["?limit=1.5", "limit"],
      ["?limit=abc", "limit"],
      ["?limit=", "limit"],
      ["?limit=1&limit=2", "limit"],
      ["?since=-1", "since"],
      ["?since=abc", "since"],
      ["?since=1.5", "since"],
      ["?since=", "since"],
      ["?since=1&since=2", "since"],
      // 第二輪審查點名要補的向量：空白、`+`、超大字串（不得被 `Number` 夾住）。
      ["?since=+5", "since"],
      ["?since=%20", "since"],
      ["?limit=99999999999999999999", "limit"],
    ];
    for (const [query, field] of cases) {
      const response = await call(durable, `/transcript/segments${query}`);
      expect(response.status, `${query} 應為 400`).toBe(400);
      expect(response.body.error, `${query} 的錯誤碼`).toBe("TRANSCRIPT_INVALID");
      expect(String(response.body.message), `${query} 的訊息`).toContain(field);
    }
  });

  it("M01-TECH-013 AC-2：未知參數忽略（沒承諾的參數不該讓請求失敗）", async () => {
    const { durable } = started();
    await threeSegments(durable);
    const response = await call(durable, "/transcript/segments?cursor=3");
    expect(response.status).toBe(200);
    expect(seqsOf(response.body)).toEqual([1, 2, 3]);
  });

  it("M01-TECH-013 AC-2：守門順序是 session（409）先於參數（400）", async () => {
    const { durable } = started();
    // 還沒有進行中的會議：壞參數不該搶先變成 400。
    expect((await call(durable, "/transcript/segments?limit=0")).status).toBe(409);
    expect((await call(durable, "/transcript/segments?since=abc")).status).toBe(409);
  });

  it("M01-TECH-013 AC-5：連續讀取（含壞參數）不得改變帳本", async () => {
    const { durable } = started();
    await threeSegments(durable);
    const before = await call(durable, "/transcript/segments");
    for (const query of ["?since=1", "?limit=1", "?since=abc", "?limit=0", "?since=99"]) {
      await call(durable, `/transcript/segments${query}`);
    }
    const after = await call(durable, "/transcript/segments");
    expect(seqsOf(after.body)).toEqual(seqsOf(before.body));
    expect(after.body.total).toBe(3);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(3);
  });
});

describe("M01-TECH-013 AC-3／AC-4：計數要追得上帳本", () => {
  it("M01-TECH-013 AC-3：串流中途 400 時，前面已落地的列仍要計入 transcriptWrites", async () => {
    const { durable } = started();
    await startMeeting(durable);
    // msg1 只是把緩衝餵起來；msg2 的講者切換讓 msg1 落地（0~1 秒，合法）；
    // msg3 再切一次 → 落地的是 msg2 那段（70 秒），超過「已過時間 + 60 秒容差」→ 400。
    const response = await call(durable, "/transcript/stream", {
      meetingOffsetMs: 0,
      messages: [
        results([{ word: "第一句", start: 0, end: 1, speaker: 0 }]),
        results([{ word: "第二句", start: 70, end: 71, speaker: 1 }]),
        results([{ word: "第三句", start: 80, end: 81, speaker: 0 }]),
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("TRANSCRIPT_INVALID");

    const ledger = await call(durable, "/transcript/segments");
    expect(ledger.body.total).toBe(1);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(1);
  });

  it("M01-TECH-013 AC-3：批次路徑在第 2 列才在儲存層失敗 → 帳本 1 列、計數也必須是 1", async () => {
    // 這一條是第二輪獨立審查的成果：審查者用真 workerd 探針證明「批次不會中途拋」是錯的
    //（`validateSegment` 過不代表 `record()` 的 INSERT／讀回不會炸），這裡把它釘成可重跑的單元測試。
    const { durable } = started(1_700_000_000_000, { failTranscriptInsertAt: 2 });
    await startMeeting(durable);
    const response = await call(durable, "/transcript/segments", {
      segments: [segment("seg:0:0", 0, "一"), segment("seg:0:1", 0, "二"), segment("seg:0:2", 0, "三")],
    });
    expect(response.status).toBe(500);
    expect((await call(durable, "/transcript/segments")).body.total).toBe(1);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(1);
  });

  it("M01-TECH-013 AC-4：請求 await 期間被插隊 → 計數不得被舊快照覆蓋", async () => {
    const { durable } = started();
    await startMeeting(durable);

    const result = await callWithInterleave(
      durable,
      "/transcript/segments",
      { segments: [segment("seg:0:0", 0, "先到的")] },
      async () => {
        const other = await call(durable, "/transcript/segments", {
          segments: [segment("seg:0:9", 0, "插隊的")],
        });
        expect(other.status).toBe(200);
        expect(other.body.transcriptWrites).toBe(1);
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.transcriptWrites).toBe(2);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(2);

    const ledger = await call(durable, "/transcript/segments");
    expect(ledger.body.total).toBe(2);
    expect(seqsOf(ledger.body)).toEqual([1, 2]);
  });

  it("M01-TECH-013 AC-4：舊路徑（/transcript）也在同一個競態裡 → 不得把計數寫回舊值", async () => {
    // US-101 的文字逐字稿路徑也是寫入。第二輪審查的探針：它在 `await request.json()` 期間
    // 被 `/transcript/segments`（2 列）插隊，若用進場快照 +1 就會寫回 1 → 帳本 2 列、計數 1。
    const { durable } = started();
    await startMeeting(durable);

    const result = await callWithInterleave(durable, "/transcript", { text: "舊路徑的一句話" }, async () => {
      const other = await call(durable, "/transcript/segments", {
        segments: [segment("seg:0:0", 0, "先到的"), segment("seg:0:1", 0, "再到的")],
      });
      expect(other.status).toBe(200);
      expect(other.body.transcriptWrites).toBe(2);
    });
    expect(result.status).toBe(200);
    expect(result.body.transcriptWrites).toBe(3);
    expect((await call(durable, "/session")).body.transcriptWrites).toBe(3);
  });
});
