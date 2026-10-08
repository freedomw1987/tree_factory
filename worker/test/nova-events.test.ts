// M01-US-103：nova-3 原始串流訊息 → 我們的分段事件。
//
// 這一層的價值是「真跡可重播」：SPIKE-001 當時真的連上 nova-3（`diarize` 開啟）收了 38 則訊息，
// 那份檔案就在 `spike/results/spike-001-ws-diarize.json`。下面的斷言直接吃那份真跡，
// 所以「每個字都帶 speaker」不是文件裡的一句話，而是每次跑測試都會被重新檢查的事實。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseNovaMessage } from "../src/nova-events.js";

const FIXTURE = JSON.parse(
  readFileSync(`${new URL(".", import.meta.url).pathname}../../spike/results/spike-001-ws-diarize.json`, "utf8"),
) as { messages: unknown[] };

const parsed = FIXTURE.messages.map((message) => parseNovaMessage(message));
const wordsEvents = parsed.flat().filter((event) => event.type === "words");
const finalEvents = wordsEvents.filter((event) => event.final);
const allWords = wordsEvents.flatMap((event) => event.words);

describe("M01-US-103 parseNovaMessage（真跡重播）", () => {
  it("M01-真跡：31 則 Results 中 30 則有字（最後一則 final 是空 transcript）→ final 6 則、interim 24 則", () => {
    expect(wordsEvents).toHaveLength(30);
    expect(finalEvents).toHaveLength(6);
    expect(wordsEvents.length - finalEvents.length).toBe(24);
  });

  it("M01-真跡：空 transcript 的 final 不回事件（不得讓聚段器收到空段而吐空句）", () => {
    // 真跡最後一則：`{is_final:true, channel:{alternatives:[{transcript:"", words:[]}]}}`（Deepgram 收尾時會回這個）。
    const empty = FIXTURE.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "Results" &&
        ((message as { channel?: { alternatives?: { words?: unknown[] }[] } }).channel?.alternatives?.[0]?.words
          ?.length ?? 0) === 0,
    );
    expect(empty).toHaveLength(1);
    expect(parseNovaMessage(empty[0])).toEqual([]);
  });

  it("M01-真跡：原始檔每個字都帶數字 speaker（只有 0 與 1，且兩種都出現）", () => {
    // 這一條刻意驗**原始檔**而不是解析結果：`parseNovaMessage` 對缺 speaker 的字會補 0（D11），
    // 所以只驗解析後的字是恆真的，證明不了「nova 真的回了 diarization」。
    const rawWords = FIXTURE.messages.flatMap((message) => {
      const words = (message as { channel?: { alternatives?: { words?: unknown }[] } }).channel?.alternatives?.[0]
        ?.words;
      return Array.isArray(words) ? (words as { speaker?: unknown }[]) : [];
    });
    expect(rawWords).toHaveLength(242);
    for (const word of rawWords) {
      expect(Number.isInteger(word.speaker)).toBe(true);
    }
    const speakers = new Set(rawWords.map((word) => word.speaker as number));
    expect([...speakers].sort()).toEqual([0, 1]);
    expect(allWords.length).toBe(242);
  });

  it("M01-真跡：final 66 個字，且時間戳不倒退（同一則訊息內 start 與 end 都非遞減）", () => {
    const words = finalEvents.flatMap((event) => event.words);
    expect(words).toHaveLength(66);
    for (const word of words) {
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      expect(Number.isFinite(word.start)).toBe(true);
    }
    // 「不倒退」要驗在**同一則訊息內**：真跡的 interim 是累積重送（每則重述整句到目前為止的全文），
    // 跨訊息比 start 本來就會看到較小的值。同一則之內則必須非遞減——把字洗牌會讓這裡變紅。
    let comparisons = 0;
    for (const event of finalEvents) {
      for (let index = 1; index < event.words.length; index += 1) {
        const previous = event.words[index - 1]!;
        const current = event.words[index]!;
        expect(current.start).toBeGreaterThanOrEqual(previous.start);
        expect(current.end).toBeGreaterThanOrEqual(previous.end);
        comparisons += 1;
      }
    }
    expect(comparisons).toBe(60); // 6 則 final / 66 個字 → 60 次相鄰比較
  });

  it("M01-真跡：6 則 SpeechStarted 解析成毫秒事件（真跡既沒有 UtteranceEnd，也沒有 speech_final）", () => {
    const started = parsed.flat().filter((event) => event.type === "speech_started");
    expect(started).toHaveLength(6);
    expect(started[0]).toEqual({ type: "speech_started", timestampMs: 70 });
    const ends = parsed.flat().filter((event) => event.type === "utterance_end");
    expect(ends).toHaveLength(0);
    // 這一條要寫清楚：真跡 31 則 Results 的 `speech_final` **全是 false**（0 則 true）。
    // 所以「nova-3 會回 endpointing 訊號」在本票裡是**規格**、不是實測結果——
    // AC-7 的證據只能是「合成 UtteranceEnd + 真跡事件重播」，不能假裝是真跡。
    const results = FIXTURE.messages.filter(
      (message) => (message as { type?: unknown }).type === "Results",
    ) as { speech_final?: unknown }[];
    expect(results).toHaveLength(31);
    expect(results.filter((message) => message.speech_final === true)).toHaveLength(0);
  });

  it("M01-AC-7：合成的 UtteranceEnd 可解析（真跡沒有，這一條不能假裝是真跡）", () => {
    expect(parseNovaMessage({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 12.53 })).toEqual([
      { type: "utterance_end" },
    ]);
    expect(parseNovaMessage({ type: "UtteranceEnd" })).toEqual([{ type: "utterance_end" }]);
  });

  it("M01-壞訊息：不認識的型別／Metadata／缺 words／null／字串一律回空陣列（不得丟錯）", () => {
    for (const bad of [
      { type: "Metadata", duration: 22.897 },
      { type: "SomethingElse" },
      { type: "Results" },
      { type: "Results", channel: { alternatives: [] } },
      { type: "Results", channel: { alternatives: [{ transcript: "嗨" }] } },
      { type: "Results", channel: { alternatives: [{ words: [] }] } },
      null,
      undefined,
      42,
      "Results",
      [],
    ]) {
      expect(parseNovaMessage(bad)).toEqual([]);
    }
  });

  it("M01-缺 speaker 的字：當成 speaker 0（單人模式不得讓整段消失）", () => {
    const [event] = parseNovaMessage({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ words: [{ word: "hi", start: 0.1, end: 0.3 }] }] },
    });
    expect(event).toEqual({ type: "words", final: true, words: [{ word: "hi", start: 0.1, end: 0.3, speaker: 0 }] });
  });

  it("M01-壞字：時間戳非數字／缺 start 的字被丟掉，其餘仍保留（不得整段陪葬）", () => {
    const [event] = parseNovaMessage({
      type: "Results",
      is_final: true,
      channel: {
        alternatives: [
          {
            words: [
              { word: "ok", start: 0.1, end: 0.3, speaker: 1 },
              { word: "broken", start: "x", end: 0.5, speaker: 1 },
              { word: "also-ok", start: 0.6, end: 0.9, speaker: 1, punctuated_word: "also-ok." },
            ],
          },
        ],
      },
    });
    expect(event).toEqual({
      type: "words",
      final: true,
      words: [
        { word: "ok", start: 0.1, end: 0.3, speaker: 1 },
        { word: "also-ok", start: 0.6, end: 0.9, speaker: 1, punctuated_word: "also-ok." },
      ],
    });
  });

  it("M01-interim 旗標：`is_final:false` 必須忠實回報（管線靠它決定落不落地）", () => {
    const [event] = parseNovaMessage({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ words: [{ word: "嗯", start: 0, end: 0.2, speaker: 0 }] }] },
    });
    expect(event).toEqual({ type: "words", final: false, words: [{ word: "嗯", start: 0, end: 0.2, speaker: 0 }] });
  });
});
