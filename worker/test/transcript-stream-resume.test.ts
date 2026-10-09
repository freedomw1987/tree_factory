// TECH-012：聚段緩衝的「跨請求等價」——同一場會議拆成多個請求，帳本必須一模一樣。
//
// 這裡刻意**不是**用一個長命的 stream 物件，而是每個請求建一個新的（模擬 route 的行為），
// 中間只帶 `snapshot()` 出去、用 `resume` 帶回來。沒有這條路，就回到 US-103 的 P0-1：
// 切在句子中間 → 那半句隨物件消失，且**沒有任何錯誤回報**。

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MAX_BUFFER_WORDS, TranscriptStream, requireMeetingOffset } from "../src/transcript-stream.js";
import {
  MAX_TEXT_CHARS,
  TranscriptLedger,
  TranscriptInvalidError,
  type TranscriptSql,
} from "../src/storage/transcript-store.js";
import type { StreamBufferState } from "../src/storage/stream-buffer-store.js";

const FIXTURE = JSON.parse(
  readFileSync(`${new URL(".", import.meta.url).pathname}../../spike/results/spike-001-ws-diarize.json`, "utf8"),
) as { messages: unknown[] };

const NOW = 1_700_000_000_000;
const CONTEXT = { nowMs: NOW, maxMs: 300_000 };

function sqlFrom(db: DatabaseSync): TranscriptSql {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0 ? db.prepare(query).all(...(bindings as never[])) : db.prepare(query).all();
        return { toArray: () => rows };
      }
      if (bindings.length > 0) {
        db.prepare(query).run(...(bindings as never[]));
        return { toArray: () => [], changes: 0 };
      }
      db.exec(query);
      return { toArray: () => [] };
    },
  };
}

/** 一個「請求」：用傳進來的快照建 stream、餵訊息、回傳快照（模擬 route 的讀→餵→寫）。 */
function request(
  ledger: TranscriptLedger,
  messages: readonly unknown[],
  carried: StreamBufferState | null,
  options: {
    finalize?: boolean;
    meetingOffsetMs?: number;
    maxBufferWords?: number;
    maxTextChars?: number;
  } = {},
): { report: ReturnType<TranscriptStream["ingest"]>; state: StreamBufferState } {
  const stream = new TranscriptStream({
    sink: ledger,
    meetingOffsetMs: options.meetingOffsetMs ?? carried?.meetingOffsetMs ?? 0,
    ...(carried === null ? {} : { resume: carried }),
    ...(options.maxBufferWords === undefined ? {} : { maxBufferWords: options.maxBufferWords }),
    ...(options.maxTextChars === undefined ? {} : { maxTextChars: options.maxTextChars }),
  });
  const report = stream.ingest(messages, CONTEXT);
  const tail = options.finalize === true ? stream.finalize(CONTEXT) : null;
  if (tail !== null) report.appended.push(...tail.appended);
  return { report, state: stream.snapshot() };
}

type FakeWord = { word: string; start: number; end: number; speaker: number; punctuated_word?: string };

function results(words: FakeWord[], final = true): Record<string, unknown> {
  return { type: "Results", is_final: final, channel: { alternatives: [{ words }] } };
}

describe("TECH-012 跨請求的聚段緩衝", () => {
  it("M01-D1：快照帶走半句，下一個請求把它補完 → 帳本只有一列、全文完整", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const first = request(ledger, [results([{ word: "我們", start: 0, end: 0.4, speaker: 0 }])], null);
    // 第一個請求還沒收尾：帳本空的，但快照裡有那半句
    expect(ledger.count()).toBe(0);
    expect(first.state.words.map((word) => word.word)).toEqual(["我們"]);
    expect(first.report.pending).toMatchObject({ speakerId: 0, text: "我們" });

    const second = request(ledger, [results([{ word: "開始", start: 0.4, end: 0.9, speaker: 0 }])], first.state);
    expect(ledger.count()).toBe(0);
    const third = request(ledger, [], second.state, { finalize: true });
    expect(third.report.appended).toHaveLength(1);
    expect(ledger.list()[0]).toMatchObject({ text: "我們 開始", startMs: 0, endMs: 900, speakerId: 0 });
  });

  it("M01-D1／D7：真跡 38 則訊息在**每一個**切點拆成兩請求，結果都與一次送完相同", () => {
    const whole = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    request(whole, FIXTURE.messages, null, { finalize: true });
    const expected = whole.list();
    expect(expected.length).toBe(6);

    for (let cut = 1; cut < FIXTURE.messages.length; cut += 1) {
      const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
      const first = request(ledger, FIXTURE.messages.slice(0, cut), null);
      const second = request(ledger, FIXTURE.messages.slice(cut), first.state, { finalize: true });
      expect(ledger.list(), `切在第 ${cut} 則之後`).toEqual(expected);
      expect(second.state.words).toEqual([]);
    }
  });

  it("M01-D7：收尾時才發現壞字（落在未來）→ 前半已落地的列留著、錯誤原樣拋出", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0 });
    // 「早」先喊了 endpointing 訊號收段、「也」接著講（第二句還留在緩衝）
    stream.ingest(
      [
        results([{ word: "早", start: 0, end: 0.5, speaker: 0 }]),
        { type: "UtteranceEnd" },
        results([{ word: "也", start: 0.5, end: 0.6, speaker: 0 }]),
      ],
      CONTEXT,
    );
    expect(ledger.count()).toBe(1);
    // 壞掉的那句落在未來時間窗 → 它一落地就會被擋（400 由路由轉譯）
    stream.ingest([results([{ word: "晚", start: 400, end: 400.5, speaker: 0 }])], CONTEXT);
    expect(ledger.count()).toBe(2);
    expect(() => stream.finalize(CONTEXT)).toThrow(TranscriptInvalidError);
    // 拋錯之後路由不會把快照寫回去 → 已經落地的兩句仍在，重送同一批是安全的（upsert 收斂）
    expect(ledger.count()).toBe(2);
  });

  it("M01-D2：`pendingUtteranceEnd` 也要跨請求（訊號在前、final 在下一個請求）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const first = request(ledger, [{ type: "UtteranceEnd" }], null);
    expect(first.state.pendingUtteranceEnd).toBe(true);
    const second = request(
      ledger,
      [results([{ word: "你好", start: 0, end: 0.5, speaker: 0 }])],
      first.state,
      { finalize: true },
    );
    expect(second.report.appended).toHaveLength(1);
    expect(ledger.list()[0]?.text).toBe("你好");
  });

  it("M01-D6：resume 之後 pending 立刻看得到未完的那一句（顯示與落地同源）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const first = request(ledger, [results([{ word: "半", start: 0, end: 0.3, speaker: 1 }], false)], null);
    // 只餵 interim 的請求：落地緩衝是空的（interim 不落地），但顯示緩衝有內容
    expect(first.state.words).toEqual([]);
    expect(first.report.pending).toMatchObject({ text: "半" });

    // 有 final 字的情境才有東西可以跨請求（display 用落地緩衝當種子）
    const landing = request(ledger, [results([{ word: "半句", start: 0, end: 0.3, speaker: 1 }])], null);
    const restored = request(ledger, [], landing.state);
    expect(restored.report.pending).toMatchObject({ speakerId: 1, text: "半句" });
  });

  it("M01-D3／D6：finalize 之後快照只剩 offset（字清空、延後訊號也消費掉）→ 下一條串流從乾淨的緩衝開始", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0 });
    stream.ingest(
      [results([{ word: "半", start: 0, end: 0.3, speaker: 0 }]), { type: "UtteranceEnd" }],
      { nowMs: NOW, maxMs: NOW + 60_000 },
    );
    expect(stream.snapshot()).toMatchObject({
      words: [{ word: "半", speaker: 0, start: 0, end: 0.3 }],
      pendingUtteranceEnd: true,
    });
    stream.finalize({ nowMs: NOW, maxMs: NOW + 60_000 });
    expect(stream.snapshot()).toEqual({ meetingOffsetMs: 0, words: [], pendingUtteranceEnd: false });
    // 再接回同一個快照：沒有殘留的 endpointing 訊號 → 新句子不會被白白切一刀
    const resumed = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, resume: stream.snapshot() });
    const report = resumed.ingest([results([{ word: "新句", start: 5, end: 5.4, speaker: 0 }])], {
      nowMs: NOW,
      maxMs: NOW + 60_000,
    });
    expect(report.appended).toEqual([]);
    expect(report.pending).toMatchObject({ text: "新句" });
  });

  it("M01-D5：緩衝到上限 → 先強制收段（forcedFlushes=1），再餵新字，一個字都不丟", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxBufferWords: 3 });
    stream.ingest(
      [results([
        { word: "一", start: 0, end: 0.2, speaker: 0 },
        { word: "二", start: 0.2, end: 0.4, speaker: 0 },
        { word: "三", start: 0.4, end: 0.6, speaker: 0 },
      ])],
      CONTEXT,
    );
    expect(ledger.count()).toBe(0);
    const report = stream.ingest(
      [results([{ word: "四", start: 0.6, end: 0.8, speaker: 0 }])],
      CONTEXT,
    );
    expect(report.forcedFlushes).toBe(1);
    expect(ledger.count()).toBe(1);
    expect(ledger.list()[0]?.text).toBe("一 二 三");
    expect(stream.snapshot().words.map((word) => word.word)).toEqual(["四"]);
  });

  it("M01-D5：上限是「緩衝＋本批」一起算，恰好等於上限時**不得**先收段", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxBufferWords: 3 });
    stream.ingest([results([{ word: "一", start: 0, end: 0.2, speaker: 0 }])], CONTEXT);
    const report = stream.ingest(
      [results([
        { word: "二", start: 0.2, end: 0.4, speaker: 0 },
        { word: "三", start: 0.4, end: 0.6, speaker: 0 },
      ])],
      CONTEXT,
    );
    expect(report.forcedFlushes).toBe(0);
    expect(ledger.count()).toBe(0);
    expect(stream.snapshot().words).toHaveLength(3);
  });

  it("M01-D5：預設上限是 2000 字（常數本身是契約，呼叫端要能預期）", () => {
    expect(MAX_BUFFER_WORDS).toBe(2000);
  });

  it("M01-D5：強制收段的段落與正常收尾段落有一樣的欄位（offset 也要加上去）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 1000, maxBufferWords: 2 });
    stream.ingest(
      [results([
        { word: "一", start: 0, end: 0.2, speaker: 3 },
        { word: "二", start: 0.2, end: 0.5, speaker: 3 },
      ])],
      CONTEXT,
    );
    stream.ingest([results([{ word: "三", start: 0.5, end: 0.7, speaker: 3 }])], CONTEXT);
    expect(ledger.list()[0]).toMatchObject({
      speakerId: 3,
      text: "一 二",
      startMs: 1000,
      endMs: 1500,
      idempotencyKey: "seg:3:1000",
    });
  });

  it("M01-D2：`requireMeetingOffset` 是唯一驗證點（不合法 → 400 訊息指名欄位）", () => {
    expect(requireMeetingOffset(0)).toBe(0);
    expect(requireMeetingOffset(1500)).toBe(1500);
    for (const bad of [-1, 1.5, "0", null, undefined, Number.NaN]) {
      expect(() => requireMeetingOffset(bad)).toThrow(TranscriptInvalidError);
    }
    expect(() => requireMeetingOffset(-1)).toThrow(/meetingOffsetMs/);
  });

  it("M01-D10：重播的批次裡含已落地的字 → 丟掉它們，緩衝不得反向（否則之後每個請求都 400）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    // 甲 乙（0~0.9）之後停頓 2 秒才講丙 → 前一段在丙進來時收段落地，緩衝只留丙
    const batch = results([
      { word: "甲", start: 0, end: 0.5, speaker: 0 },
      { word: "乙", start: 0.5, end: 0.9, speaker: 0 },
      { word: "丙", start: 3, end: 3.5, speaker: 0 },
    ]);
    const first = request(ledger, [batch], null);
    expect(ledger.list().map((row) => row.text)).toEqual(["甲 乙"]);
    expect(first.state.words.map((word) => word.word)).toEqual(["丙"]);

    // 回應掉了、裝置端原樣重送同一批：甲／乙 已經落地 → 不得再被餵進緩衝
    // （餵進去會變成 [丙, 甲, 乙]：時間軸反向，下一次落地 400，而且壞順序已寫回 SQLite）
    const again = request(ledger, [batch], first.state);
    expect(again.report).toMatchObject({
      appended: [],
      duplicates: [],
      conflicts: [],
      // D9（加法欄位）：丟掉的重播字要看得見（甲、乙），不能靜默吞掉
      replayedWords: 2,
    });
    expect(again.state.words.map((word) => word.word)).toEqual(["丙"]);
    expect(ledger.list().map((row) => row.text)).toEqual(["甲 乙"]);

    // 重播之後這條會議必須還能繼續（修好之前：下一批 400 `endMs=900 必須 ≥ startMs=3000`）
    const next = request(
      ledger,
      [results([{ word: "丁", start: 4, end: 4.5, speaker: 0 }])],
      again.state,
      { finalize: true },
    );
    expect(next.report.appended.map((row) => row.text)).toEqual(["丙 丁"]);
    expect(ledger.list().map((row) => [row.text, row.startMs, row.endMs])).toEqual([
      ["甲 乙", 0, 900],
      ["丙 丁", 3000, 4500],
    ]);
  });

  it("M01-D10：判準比的是終點——起點剛好接在已落地那列終點上的新字不得被吞", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    // 判準只在「緩衝還有沒落地的字」時才啟用，所以這一題必須先讓緩衝有內容才碰得到它：
    // 甲 乙 用 UtteranceEnd 收段落地（0~900），下一句的 戊 留在緩衝。
    const first = request(
      ledger,
      [
        results([
          { word: "甲", start: 0, end: 0.5, speaker: 0 },
          { word: "乙", start: 0.5, end: 0.9, speaker: 0 },
        ]),
        { type: "UtteranceEnd" },
      ],
      null,
    );
    const second = request(ledger, [results([{ word: "戊", start: 5, end: 5.5, speaker: 0 }])], first.state);
    expect(ledger.list().map((row) => row.text)).toEqual(["甲 乙"]);
    expect(second.state.words.map((word) => word.word)).toEqual(["戊"]);

    // 丙 的起點剛好等於已落地那列的終點（900ms），終點 1300 > 900 → 是新字，必須收下。
    // 若判準拿「起點」去比（900 ≤ 900）就會把它當成重播丟掉：正常接續的句子被吃掉。
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, resume: second.state });
    const report = stream.ingest([results([{ word: "丙", start: 0.9, end: 1.3, speaker: 0 }])], CONTEXT);
    expect(report.appended).toEqual([]);
    expect(stream.snapshot().words.map((word) => word.word)).toContain("丙");
  });
});

describe("TECH-012 D5：字元預算（帳本上限）——緩衝不得長到落不了地", () => {
  /** 造 `count` 顆固定 5 字元的字（`w0000`…），方便手算字元預算。 */
  function monologue(count: number): { word: string; start: number; end: number; speaker: number }[] {
    return Array.from({ length: count }, (_, index) => {
      const start = Number((index * 0.05).toFixed(4));
      return { word: `w${String(index).padStart(4, "0")}`, start, end: Number((start + 0.04).toFixed(4)), speaker: 0 };
    });
  }

  /**
   * 造一串 2 字元的字（`aa`、`bb`…），時間軸從第 `from` 顆（0.1 秒一格）開始。
   * `from` 不是裝飾：片段的冪等鍵是「講者＋起點」，第二個片段若從 0 秒重新開始，
   * 撞到的會是第一個片段的鍵（變成 duplicate／conflict），那就不是這條測試要驗的事了。
   */
  function twoChar(
    labels: readonly string[],
    from = 0,
  ): { word: string; start: number; end: number; speaker: number }[] {
    return labels.map((label, index) => {
      const start = Number(((from + index) * 0.1).toFixed(4));
      return { word: label, start, end: Number((start + 0.08).toFixed(4)), speaker: 0 };
    });
  }

  it("M01-D5：一批字超過字元預算 → 切成多段、每段都在預算內、一字不丟", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxTextChars: 12 });
    const report = stream.ingest([results(twoChar(["aa", "bb", "cc", "dd", "ee"]))], CONTEXT);
    // 「aa bb cc dd」= 11 字元；再收下第 5 個字會變 14 → 先落地（不是丟掉）
    expect(report.forcedFlushes).toBe(1);
    expect(ledger.list().map((row) => row.text)).toEqual(["aa bb cc dd"]);
    expect(stream.snapshot().words.map((word) => word.word)).toEqual(["ee"]);

    const tail = stream.finalize(CONTEXT);
    expect(tail.appended.map((row) => row.text)).toEqual(["ee"]);
    expect(ledger.list().map((row) => row.text)).toEqual(["aa bb cc dd", "ee"]);
    expect(ledger.list().flatMap((row) => row.text.split(" "))).toHaveLength(5);
  });

  it("M01-D5：真上限下的一段超長獨白也要全部落地（無 400、字數守恆）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0 });
    // 2001 顆 5 字元的字、停頓都遠小於門檻 → 聚段器只看得到「一段」；
    // 沒有這道守衛，它會變成一顆 10889 字元的段落，帳本每次都 400（Gate 4 oracle 實測）。
    const report = stream.ingest([results(monologue(2001))], CONTEXT);
    const tail = stream.finalize(CONTEXT);
    const rows = ledger.list();
    // 6 次是**字元預算**觸發的（每段 333 字）；字數上限 2000 一次都沒用到
    expect(report.forcedFlushes).toBe(6);
    expect(tail.appended).toHaveLength(1);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.text.length, `段落「${row.text.slice(0, 20)}…」超過帳本上限`).toBeLessThanOrEqual(
        MAX_TEXT_CHARS,
      );
    }
    expect(rows.flatMap((row) => row.text.split(" "))).toHaveLength(2001);
  });

  it("M01-D5：緩衝＋本批恰好等於字元預算時不得先切（切了會多出沒人要的碎句）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxTextChars: 5 });
    const first = stream.ingest([results(twoChar(["aa", "bb"]))], CONTEXT);
    expect(first.forcedFlushes).toBe(0);
    expect(ledger.count()).toBe(0);
    expect(stream.snapshot().words).toHaveLength(2); // 「aa bb」= 恰好 5 字元

    const second = stream.ingest([results(twoChar(["cc"], 2))], CONTEXT);
    expect(second.forcedFlushes).toBe(1);
    expect(ledger.list().map((row) => row.text)).toEqual(["aa bb"]);
  });

  it("M01-D5：resume 回來的緩衝也要算進字元預算（否則接續的請求會做出落不了地的段落）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const first = request(ledger, [results(twoChar(["aa", "bb"]))], null, { maxTextChars: 6 });
    expect(first.state.words).toHaveLength(2);
    const second = request(ledger, [results(twoChar(["cc"], 2))], first.state, {
      maxTextChars: 6,
      finalize: true,
    });
    expect(second.report.forcedFlushes).toBe(1);
    expect(ledger.list().map((row) => row.text)).toEqual(["aa bb", "cc"]);
  });

  it("M01-D5：字元預算算的是「真正落地的字」（punctuated_word 較長時也要算它）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxTextChars: 8 });
    // 落地用的是 `punctuated_word`（`buildSegment()` 的選擇），所以預算也必須算它：
    // 「aaa aaa」= 7 字元放得下，第 3 顆會變 11 → 先落地。只看 `word`（2 字元）會誤判成放得下。
    const words: { word: string; start: number; end: number; speaker: number; punctuated_word: string }[] =
      [0, 1, 2].map((index) => ({
        word: "aa",
        punctuated_word: "aaa",
        start: Number((index * 0.1).toFixed(4)),
        end: Number((index * 0.1 + 0.08).toFixed(4)),
        speaker: 0,
      }));
    const report = stream.ingest([results(words)], CONTEXT);
    expect(report.forcedFlushes).toBe(1);
    expect(ledger.list().map((row) => row.text)).toEqual(["aaa aaa"]);
    const tail = stream.finalize(CONTEXT);
    expect(tail.appended.map((row) => row.text)).toEqual(["aaa"]);
    expect(ledger.list().map((row) => row.text)).toEqual(["aaa aaa", "aaa"]);
  });

  it("M01-D5：字元預算把字與字之間的空白算進去（少算 1 會讓緩衝長到落不了地）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0, maxTextChars: 5 });
    // 「ab c」＝ 4 字元（2 ＋ 空白 ＋ 1）；再收一顆 1 字元的字 → 4＋1＋1＝6 > 5 → 先落地。
    // 守衛若少算那個空白（4＋1＝5，不超過），緩衝會變成「ab c d」＝ 6 字元的段落 → 收尾時 400。
    const first = stream.ingest([results(twoChar(["ab", "c"]))], CONTEXT);
    expect(first.forcedFlushes).toBe(0);
    const second = stream.ingest([results(twoChar(["d"], 2))], CONTEXT);
    expect(second.forcedFlushes).toBe(1);
    expect(ledger.list().map((row) => row.text)).toEqual(["ab c"]);
    const tail = stream.finalize(CONTEXT);
    expect(tail.appended.map((row) => row.text)).toEqual(["d"]);
  });

  it("M01-D5：單一 token 超過帳本上限 → 當批就大聲擋下，緩衝留著乾淨狀態（不是毒藥）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const stream = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0 });
    // 一顆字自己就比帳本上限長 → 放進任何段落都落不了地（沒有合法切點）。這種 token 實務上
    // 不存在（STT 的一顆字不會有 2000 字元）。第一輪的處置是「讓帳本擋」——但 Gate 4 第二輪
    // oracle 實測出外溢症狀：那顆字會先被收進緩衝，之後**連正常字都落不了地**（每個請求 400），
    // 直到會議結束以 `droppedBufferedWords` 收場。所以改成在 ingest 就擋：不進緩衝。
    expect(() =>
      stream.ingest(
        [results([{ word: "z".repeat(MAX_TEXT_CHARS + 1), start: 0, end: 0.5, speaker: 0 }])],
        CONTEXT,
      ),
    ).toThrow(TranscriptInvalidError);
    expect(ledger.count()).toBe(0);
    expect(stream.snapshot().words).toEqual([]);

    // 這才是本條修法的目的：壞 token 之後，同一條串流的正常字照常落得了地。
    const report = stream.ingest([results([{ word: "正常", start: 1, end: 1.4, speaker: 0 }])], CONTEXT);
    expect(report.appended).toEqual([]);
    const tail = stream.finalize(CONTEXT);
    expect(tail.appended.map((row) => row.text)).toEqual(["正常"]);
    expect(ledger.list().map((row) => row.text)).toEqual(["正常"]);
  });
});
