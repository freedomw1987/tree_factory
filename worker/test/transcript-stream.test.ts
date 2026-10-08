// M01-US-103：串流落地管線（nova 事件 → 聚段 → 帳本）。
//
// 三條 AC 都在這裡被釘住：
//   AC-6 interim 混餵不得產生重複句（結構上：interim 不落地）
//   AC-7 UtteranceEnd 早於停頓門檻時必須切段，且不得產生兩個重疊段
//   AC-4 重疊發言不得靜默丟句（段數 ≥ 語音段數、字詞一字不少、並留下 overlap_ms）

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { parseNovaMessage } from "../src/nova-events.js";
import { TranscriptStream } from "../src/transcript-stream.js";
import { TranscriptInvalidError, TranscriptLedger, type TranscriptSql } from "../src/storage/transcript-store.js";

const FIXTURE = JSON.parse(
  readFileSync(`${new URL(".", import.meta.url).pathname}../../spike/results/spike-001-ws-diarize.json`, "utf8"),
) as { messages: unknown[] };

const NOW = 1_700_000_000_000;
const MAX_MS = 300_000;

function sqlFrom(db: DatabaseSync): TranscriptSql {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0 ? db.prepare(query).all(...(bindings as never[])) : db.prepare(query).all();
        return { toArray: () => rows };
      }
      if (bindings.length > 0) {
        const result = db.prepare(query).run(...(bindings as never[]));
        return { toArray: () => [], changes: Number(result.changes) };
      }
      db.exec(query);
      return { toArray: () => [] };
    },
  };
}

function stream(options: { meetingOffsetMs?: number } = {}): {
  stream: TranscriptStream;
  ledger: TranscriptLedger;
} {
  const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
  const stream = new TranscriptStream({
    sink: ledger,
    meetingOffsetMs: options.meetingOffsetMs ?? 0,
  });
  return { stream, ledger };
}

const context = { nowMs: NOW, maxMs: MAX_MS };

/** 合成一個 nova `Results` 訊息（真跡之外的案例用）。 */
function results(
  words: { word: string; start: number; end: number; speaker: number }[],
  final = true,
): Record<string, unknown> {
  return { type: "Results", is_final: final, channel: { alternatives: [{ words }] } };
}

describe("M01-US-103 TranscriptStream", () => {
  it("M01-AC-6：interim 與 final 混餵同一段 → 只產生一段；interim 期間帳本仍是空的", () => {
    const { stream: pipe, ledger } = stream();
    const interim = results([{ word: "我", start: 0, end: 0.4, speaker: 0 }], false);
    const final = results([{ word: "我們", start: 0, end: 0.4, speaker: 0 }], true);

    const afterInterim = pipe.ingest([interim], context);
    expect(afterInterim.appended).toHaveLength(0);
    expect(ledger.count()).toBe(0);
    // interim 仍在記憶體裡（給 US-104 顯示用），只是不落地。
    expect(pipe.pending()).toMatchObject({ speakerId: 0, text: "我" });

    pipe.ingest([final], context);
    // final 只是「這段話不再變動」，但**還沒結束**（停頓 / UtteranceEnd / 收尾才算結束）。
    expect(ledger.count()).toBe(0);
    pipe.finalize(context);
    expect(ledger.count()).toBe(1);
    expect(ledger.list()[0]).toMatchObject({ speakerId: 0, text: "我們" });
  });

  it("M01-AC-6：同一 final 重送兩次 → 仍只有一段（duplicate 不是新增）", () => {
    const { stream: pipe, ledger } = stream();
    const final = results([{ word: "一", start: 0, end: 0.4, speaker: 0 }]);
    pipe.ingest([final], context);
    expect(pipe.finalize(context).appended).toHaveLength(1);
    expect(ledger.count()).toBe(1);
    pipe.ingest([final], context);
    const second = pipe.finalize(context);
    expect(second.appended).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it("M01-真跡：重播真人輪流說話的 final → 6 段，speaker 依序 0/1/0/1/0/1", () => {
    const { stream: pipe, ledger } = stream();
    const finals = FIXTURE.messages.filter((message) => {
      const [event] = parseNovaMessage(message);
      return event !== undefined && event.type === "words" && event.final;
    });
    pipe.ingest(finals, context);
    pipe.finalize(context);
    expect(ledger.list().map((row) => row.speakerId)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(ledger.list()[0]).toMatchObject({ startMs: 0, endMs: 3_680 });
    expect(ledger.list()[0]?.text).toContain("Good morning");
    expect(ledger.list().at(-1)?.text).toContain("training budget");
  });

  it("M01-AC-1：同一段音檔重播兩次 → 段落內容與編號完全一致（編號不漂移）", () => {
    const finals = FIXTURE.messages.filter((message) => {
      const [event] = parseNovaMessage(message);
      return event !== undefined && event.type === "words" && event.final;
    });
    const first = stream();
    const second = stream();
    for (const message of finals) {
      first.stream.ingest([message], context);
      second.stream.ingest([message], context);
    }
    first.stream.finalize(context);
    second.stream.finalize(context);
    const shape = (ledger: TranscriptLedger): unknown =>
      ledger.list().map((row) => [row.speakerId, row.text, row.startMs, row.endMs]);
    expect(shape(first.ledger)).toEqual(shape(second.ledger));
    expect(shape(first.ledger)).toHaveLength(6);
  });

  it("M01-AC-3：整段真跡（interim + final 混雜）重播第二次 → 全部 duplicate，列數不變", () => {
    const { stream: pipe, ledger } = stream();
    pipe.ingest(FIXTURE.messages, context);
    pipe.finalize(context);
    const rows = ledger.count();
    expect(rows).toBe(6);
    const replay = pipe.ingest(FIXTURE.messages, context);
    expect(replay.appended).toHaveLength(0);
    // 重播時前面 5 段在事件流裡就會被判成 duplicate；第 6 段一樣要等收尾才吐出來
    // （這一條本身就是「只有 final 進帳本、最後一段必須 flush」的證據）。
    expect(replay.duplicates).toHaveLength(5);
    const tail = pipe.finalize(context);
    expect(tail.appended).toHaveLength(0);
    expect(tail.duplicates).toHaveLength(1);
    expect(ledger.count()).toBe(rows);
  });

  it("M01-AC-2：meetingOffsetMs 會被加到每個字上（音訊第一幀 ≠ 會議開始）", () => {
    const { stream: pipe, ledger } = stream({ meetingOffsetMs: 2_500 });
    pipe.ingest([results([{ word: "嗨", start: 0, end: 1, speaker: 0 }])], context);
    pipe.finalize(context);
    expect(ledger.list()[0]).toMatchObject({ startMs: 2_500, endMs: 3_500 });
  });

  it("M01-AC-2：meetingOffsetMs 不合法（負／NaN／非整數）→ 不得默默當 0", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    for (const bad of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new TranscriptStream({ sink: ledger, meetingOffsetMs: bad })).toThrow(TranscriptInvalidError);
    }
  });

  it("M01-AC-7：靜音 1.1 秒時，UtteranceEnd 切開（沒有 UtteranceEnd 則依 1200ms 門檻併成一段）", () => {
    const withEnd = stream();
    withEnd.stream.ingest([results([{ word: "第一句", start: 0, end: 1, speaker: 0 }])], context);
    withEnd.stream.ingest([{ type: "UtteranceEnd", last_word_end: 2.1 }], context);
    withEnd.stream.ingest([results([{ word: "第二句", start: 2.1, end: 3, speaker: 0 }])], context);
    withEnd.stream.finalize(context);
    const cut = withEnd.ledger.list();
    expect(cut.map((row) => [row.text, row.startMs, row.endMs])).toEqual([
      ["第一句", 0, 1_000],
      ["第二句", 2_100, 3_000],
    ]);
    // 不得有兩個內容重疊的段落：先驗時間不重疊，再驗**落地欄位**本身是 0。
    expect(cut[0]!.endMs).toBeLessThanOrEqual(cut[1]!.startMs);
    expect(cut.map((row) => row.overlapMs)).toEqual([0, 0]);

    const withoutEnd = stream();
    withoutEnd.stream.ingest([results([{ word: "第一句", start: 0, end: 1, speaker: 0 }])], context);
    withoutEnd.stream.ingest([results([{ word: "第二句", start: 2.1, end: 3, speaker: 0 }])], context);
    withoutEnd.stream.finalize(context);
    expect(withoutEnd.ledger.list().map((row) => row.text)).toEqual(["第一句 第二句"]);
  });

  it("M01-D12 已知後果（釘樁）：過期的 UtteranceEnd 會多切一刀，但不得丟字", () => {
    // 這一條刻意把**已知缺陷**固定下來（不是「測到就對了」）：`parseNovaMessage` 丟掉
    // `UtteranceEnd.last_word_end`，所以遲到的訊號會被下一句吃掉。寧可多一條邊界，不可以少字。
    const withStale = stream();
    withStale.stream.ingest([results([{ word: "A", start: 0, end: 1, speaker: 0 }])], context);
    // 停頓 2.0s > 1200ms 門檻 → A 已被切走，緩衝只剩 B。
    withStale.stream.ingest([results([{ word: "B", start: 3, end: 4, speaker: 0 }])], context);
    // 一則「其實是 A 的」訊號遲到：旗標被 B 吃掉（D12）。
    withStale.stream.ingest([{ type: "UtteranceEnd", last_word_end: 1.05 }], context);
    withStale.stream.ingest([results([{ word: "C", start: 4.1, end: 5, speaker: 0 }])], context);
    withStale.stream.ingest([results([{ word: "D", start: 5.1, end: 6, speaker: 0 }])], context);
    withStale.stream.finalize(context);
    const cut = withStale.ledger.list();
    // B 與 C 本來會依停頓門檻併成一段，過期訊號把他們切開 → 多一條邊界（已知，接受）。
    expect(cut.map((row) => row.text)).toEqual(["A", "B", "C D"]);
    // 但不變量仍成立：四個字一個都沒少。
    expect(cut.flatMap((row) => row.text.split(" "))).toEqual(["A", "B", "C", "D"]);

    // 對照組：拿掉那則過期訊號，B C D 就會在同一段裡（證明那一刀真的來自過期訊號）。
    const withoutStale = stream();
    withoutStale.stream.ingest([results([{ word: "A", start: 0, end: 1, speaker: 0 }])], context);
    withoutStale.stream.ingest([results([{ word: "B", start: 3, end: 4, speaker: 0 }])], context);
    withoutStale.stream.ingest([results([{ word: "C", start: 4.1, end: 5, speaker: 0 }])], context);
    withoutStale.stream.ingest([results([{ word: "D", start: 5.1, end: 6, speaker: 0 }])], context);
    withoutStale.stream.finalize(context);
    expect(withoutStale.ledger.list().map((row) => row.text)).toEqual(["A", "B C D"]);
  });

  it("M01-AC-4：兩人同時說話（交錯字詞）→ 段數 ≥ 語音段數，字詞一字不少，且後到的重疊段有 overlapMs", () => {
    const { stream: pipe, ledger } = stream();
    pipe.ingest(
      [
        results([
          { word: "A1", start: 0, end: 0.5, speaker: 0 },
          { word: "B1", start: 0.4, end: 0.9, speaker: 1 },
          { word: "A2", start: 0.95, end: 1.4, speaker: 0 },
          { word: "B2", start: 1.5, end: 2, speaker: 1 },
        ]),
      ],
      context,
    );
    pipe.finalize(context);
    const rows = ledger.list();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.speakerId)).toEqual([0, 1, 0, 1]);
    // 一字不少：四個字都還在帳本裡。
    expect(rows.map((row) => row.text)).toEqual(["A1", "B1", "A2", "B2"]);
    // 重疊留痕：B1 (400-900) 與前一段 A1 (0-500) 重疊 100ms。
    expect(rows.map((row) => row.overlapMs)).toEqual([0, 100, 0, 0]);
  });

  it("M01-D10：finalize 把緩衝的最後一段落地，第二次 finalize 不再重複落地（SPIKE-001 的掉尾風險）", () => {
    const { stream: pipe, ledger } = stream();
    pipe.ingest([results([{ word: "最後一句", start: 0, end: 1, speaker: 0 }])], context);
    expect(ledger.count()).toBe(0);
    const flushed = pipe.finalize(context);
    expect(flushed.appended).toHaveLength(1);
    expect(ledger.count()).toBe(1);
    pipe.finalize(context);
    expect(ledger.count()).toBe(1);
  });

  it("M01-壞訊息不會毒死管線：中間夾雜壞訊息，前後的字仍正確分段", () => {
    const { stream: pipe, ledger } = stream();
    pipe.ingest(
      [
        { type: "Metadata" },
        results([{ word: "前半", start: 0, end: 1, speaker: 0 }]),
        "not-json",
        { type: "Results", channel: { alternatives: [] } },
      ],
      context,
    );
    pipe.ingest([results([{ word: "後半", start: 2.1, end: 3, speaker: 1 }])], context);
    pipe.finalize(context);
    expect(ledger.list().map((row) => [row.speakerId, row.text])).toEqual([
      [0, "前半"],
      [1, "後半"],
    ]);
  });

  it("M01-UtteranceEnd 而緩衝為空 → 不得產生空句", () => {
    const { stream: pipe, ledger } = stream();
    const report = pipe.ingest([{ type: "UtteranceEnd" }], context);
    expect(report.appended).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it("M01-AC-7：UtteranceEnd 早於那句的 final（endpointing 訊號的真實順序）→ 仍必須切開", () => {
    const { stream: pipe, ledger } = stream();
    // `UtteranceEnd` 的語意是「上一句到這裡結束」，它比那句的 final **早到**是正常順序，
    // 也是 AC-6 的 Given（interim → UtteranceEnd → final → final）。
    // 早期實作一到就收段，此時落地緩衝還是空的 → 訊號等於沒作用（AC-7 的 Then 不成立）。
    pipe.ingest([results([{ word: "第一句", start: 0, end: 0.4, speaker: 0 }], false)], context);
    pipe.ingest([{ type: "UtteranceEnd", last_word_end: 0.4 }], context);
    pipe.ingest([results([{ word: "第一句", start: 0, end: 0.4, speaker: 0 }])], context);
    pipe.ingest([results([{ word: "第二句", start: 1.5, end: 2.4, speaker: 0 }])], context);
    pipe.finalize(context);
    expect(ledger.list().map((row) => [row.text, row.startMs, row.endMs])).toEqual([
      ["第一句", 0, 400],
      ["第二句", 1_500, 2_400],
    ]);
    // 對照：這兩句只隔 1.1 秒（小於 1200ms 門檻），沒有訊號就會被併成一段。
  });

  it("M01-AC-2：offset 屬於段落身分——同一則事件用不同 offset 送出 → 兩列都留著（不覆寫、不算重複）", () => {
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    const message = results([{ word: "嗨", start: 0, end: 1, speaker: 0 }]);
    for (const offset of [2_500, 3_000]) {
      const pipe = new TranscriptStream({ sink: ledger, meetingOffsetMs: offset });
      pipe.ingest([message], context);
      pipe.finalize(context);
    }
    expect(ledger.list().map((row) => [row.startMs, row.endMs])).toEqual([
      [2_500, 3_500],
      [3_000, 4_000],
    ]);
    // 同一個 offset 重播才是 duplicate（冪等鍵含 offset 的必然結果）。
    const again = new TranscriptStream({ sink: ledger, meetingOffsetMs: 2_500 });
    again.ingest([message], context);
    expect(again.finalize(context).duplicates).toHaveLength(1);
    expect(ledger.count()).toBe(2);
  });

  it("M01-D4：interim 是累積重送 → pending() 不得把同一句疊成好幾份（US-104 直接顯示它）", () => {
    const { stream: pipe } = stream();
    const interims = FIXTURE.messages.filter((message) => {
      const [event] = parseNovaMessage(message);
      return event !== undefined && event.type === "words" && !event.final;
    });
    expect(interims).toHaveLength(24);
    const repeated = (text: string, size: number): boolean => {
      const words = text.split(" ");
      const seen = new Set<string>();
      for (let index = 0; index + size <= words.length; index += 1) {
        const gram = words.slice(index, index + size).join(" ");
        if (seen.has(gram)) return true;
        seen.add(gram);
      }
      return false;
    };
    let exact = 0;
    for (const message of interims) {
      pipe.ingest([message], context);
      const [first] = parseNovaMessage(message);
      if (first === undefined || first.type !== "words") throw new Error("真跡的 interim 應該是 words 事件");
      const batch = first.words.map((word) => word.punctuated_word ?? word.word).join(" ");
      const pending = pipe.pending()?.text ?? "";
      if (pending === batch) exact += 1;
      // 真跡每一則 interim 都重述「這句到目前為止」的全文 → 顯示緩衝的尾巴必須等於這一則，
      // 而且整段不得出現重複的 4-gram（早期實作會疊到 4 份，實測）。
      expect(pending.endsWith(batch)).toBe(true);
      expect(repeated(pending, 4)).toBe(false);
    }
    // 24 則裡有 **23** 則的緩衝「恰好等於該則」、1 則（真跡 @1254 的 C1）多帶了前一講者的殘句。
    // 這個數字只在**只餵 interim** 的餵法成立：真跡重播會把 final 也餵進顯示緩衝，那時是 19/24。
    // 之所以釘住它，是因為前兩個斷言對那 1 則異常**也成立** → 沒有這個數字就不會有鑑別力
    // （Gate 4 第二輪 P2-1：判準若改回「比緩衝起點」，這個數字會掉）。
    expect(exact).toBe(23);
  });

  it("M01-呼叫端契約（P0-1）：聚段緩衝活在物件裡——同一場會議拆成「每則一請求」就開始漏字", () => {
    const finals = FIXTURE.messages.filter((message) => {
      const [event] = parseNovaMessage(message);
      return event !== undefined && event.type === "words" && event.final;
    });
    expect(finals).toHaveLength(6);
    const words = (rows: { text: string }[]): number =>
      rows.reduce((total, row) => total + row.text.split(" ").length, 0);

    // 正確用法：一個串流物件收完所有訊息才收尾 → 6 段、66 字（一個字都不少）。
    const whole = stream();
    const wholeReport = whole.stream.ingest(finals, context);
    const wholeTail = whole.stream.finalize(context);
    expect(whole.ledger.count()).toBe(6);
    expect(words([...wholeReport.appended, ...wholeTail.appended])).toBe(66);

    // 反面用法（每則訊息各自一個請求物件、而且都不收尾）：
    // 只有「自己就自成一段」的字會落地——4 段 28 字，其餘 38 個字隨物件一起被丟掉，
    // 而且**不會有任何錯誤回報**。這就是為什麼 `/transcript/stream` 的呼叫端契約是
    // 「同一場會議的事件要在同一個請求裡送完」（見 DESIGN §「呼叫端契約」）。
    const split = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    for (const message of finals) {
      const pipe = new TranscriptStream({ sink: split, meetingOffsetMs: 0 });
      pipe.ingest([message], context);
    }
    expect(split.count()).toBe(4);
    expect(words(split.list())).toBe(28);
  });

  it("M01-呼叫端契約（P0-1）：每則一請求、每則都收尾 → 66 個字都在，但被切成 10 段（切法與一次送完不同）", () => {
    const finals = FIXTURE.messages.filter((message) => {
      const [event] = parseNovaMessage(message);
      return event !== undefined && event.type === "words" && event.final;
    });
    const ledger = new TranscriptLedger(sqlFrom(new DatabaseSync(":memory:")));
    for (const message of finals) {
      const pipe = new TranscriptStream({ sink: ledger, meetingOffsetMs: 0 });
      pipe.ingest([message], context);
      pipe.finalize(context);
    }
    expect(ledger.count()).toBe(10);
    expect(ledger.list().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ledger.list().reduce((total, row) => total + row.text.split(" ").length, 0)).toBe(66);
  });
});
