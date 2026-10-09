// TECH-012：會議級聚段緩衝的持久層（DO SQLite）。
//
// 這一層的職責只有兩件事：
//   ① 把「還沒講完的那半句」持久化（DO 可能被回收，記憶體緩衝會消失 → US-103 P0-1）
//   ② 讀回來的時候**嚴格驗證**——壞資料要「大聲壞掉」，不得當成「沒有緩衝」繼續（那正是靜默少字）

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  StreamBufferCorruptError,
  StreamBufferStore,
  parseStreamBufferState,
  type StreamBufferSql,
  type StreamBufferState,
} from "../src/storage/stream-buffer-store.js";

function sqlFrom(db: DatabaseSync): StreamBufferSql {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0 ? db.prepare(query).all(...(bindings as never[])) : db.prepare(query).all();
        return { toArray: () => rows };
      }
      if (bindings.length > 0) {
        db.prepare(query).run(...(bindings as never[]));
        return { toArray: () => [] };
      }
      db.exec(query);
      return { toArray: () => [] };
    },
  };
}

function device(): { db: DatabaseSync; store: StreamBufferStore } {
  const db = new DatabaseSync(":memory:");
  return { db, store: new StreamBufferStore(sqlFrom(db)) };
}

const NOW = 1_700_000_000_000;

function state(overrides: Partial<StreamBufferState> = {}): StreamBufferState {
  return {
    meetingOffsetMs: 0,
    words: [{ word: "你好", speaker: 0, start: 0.5, end: 0.9 }],
    pendingUtteranceEnd: false,
    ...overrides,
  };
}

describe("TECH-012 StreamBufferStore", () => {
  it("M01-D1：沒有列時 read 回 null（不是空字串、不是丟例外）", () => {
    const { store } = device();
    expect(store.read("m-1")).toBeNull();
  });

  it("M01-D1：寫入後讀回，三個欄位逐欄相同（含小數秒不得被取整）", () => {
    const { store } = device();
    const written = state({
      meetingOffsetMs: 1500,
      words: [
        { word: "a", punctuated_word: "A", speaker: 2, start: 0.5, end: 1.25 },
        { word: "b", speaker: 2, start: 1.25, end: 1.5 },
      ],
      pendingUtteranceEnd: true,
    });
    store.write("m-1", written, NOW);
    expect(store.read("m-1")).toEqual(written);
  });

  it("M01-D1：不同 session 各自一列（互不覆蓋）", () => {
    const { store } = device();
    store.write("m-1", state({ meetingOffsetMs: 11 }), NOW);
    store.write("m-2", state({ meetingOffsetMs: 22 }), NOW);
    expect(store.read("m-1")?.meetingOffsetMs).toBe(11);
    expect(store.read("m-2")?.meetingOffsetMs).toBe(22);
  });

  it("M01-D1：同一個 session 再寫一次 → 以新的為準（只有一列）", () => {
    const { db, store } = device();
    store.write("m-1", state({ meetingOffsetMs: 11 }), NOW);
    store.write("m-1", state({ meetingOffsetMs: 22, words: [] }), NOW);
    expect(store.read("m-1")).toEqual({ meetingOffsetMs: 22, words: [], pendingUtteranceEnd: false });
    const rows = db.prepare("SELECT COUNT(*) AS count FROM stream_buffer").all() as { count: number }[];
    expect(rows[0]?.count).toBe(1);
  });

  it("M01-D4：clear 之後 read 回 null；對不存在的列 clear 不得失敗（冪等）", () => {
    const { store } = device();
    store.write("m-1", state(), NOW);
    store.clear("m-1");
    expect(store.read("m-1")).toBeNull();
    expect(() => store.clear("m-1")).not.toThrow();
  });

  it("M01-D8：state 不是物件（null／陣列／字串）→ 丟 StreamBufferCorruptError", () => {
    for (const bad of [null, [], "x", 3, true]) {
      expect(() => parseStreamBufferState(bad)).toThrow(StreamBufferCorruptError);
    }
    expect(() => parseStreamBufferState(null)).toThrow(/STREAM_BUFFER_CORRUPT/);
  });

  it("M01-D8：meetingOffsetMs 不是非負整數（-1／1.5／「0」／NaN）→ 丟錯", () => {
    for (const bad of [-1, 1.5, "0", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(() => parseStreamBufferState({ ...state(), meetingOffsetMs: bad })).toThrow(
        StreamBufferCorruptError,
      );
    }
  });

  it("M01-D8：words 不是陣列 → 丟錯；合法的空陣列要放行（緩衝可能是空的）", () => {
    expect(() => parseStreamBufferState({ ...state(), words: {} })).toThrow(StreamBufferCorruptError);
    expect(parseStreamBufferState({ ...state(), words: [] }).words).toEqual([]);
  });

  it("M01-D8：單字缺欄位／型別錯 → 丟錯（word / speaker / start / end 各一題）", () => {
    const cases: unknown[] = [
      { speaker: 0, start: 0, end: 1 },
      { word: "a", start: 0, end: 1 },
      { word: "a", speaker: -1, start: 0, end: 1 },
      { word: "a", speaker: 0.5, start: 0, end: 1 },
      { word: "a", speaker: 0, end: 1 },
      { word: "a", speaker: 0, start: Number.NaN, end: 1 },
      { word: "a", speaker: 0, start: 0, end: "1" },
    ];
    for (const bad of cases) {
      expect(() => parseStreamBufferState({ ...state(), words: [bad] })).toThrow(StreamBufferCorruptError);
    }
  });

  it("M01-D8：end < start 的時間戳 → 丟錯（壞掉的時間軸不得進帳本）", () => {
    expect(() =>
      parseStreamBufferState({ ...state(), words: [{ word: "a", speaker: 0, start: 2, end: 1 }] }),
    ).toThrow(StreamBufferCorruptError);
  });

  it("M01-D8：pendingUtteranceEnd 非布林 → 丟錯；未填的未知欄位要忽略（向前相容）", () => {
    expect(() => parseStreamBufferState({ ...state(), pendingUtteranceEnd: "yes" })).toThrow(
      StreamBufferCorruptError,
    );
    const parsed = parseStreamBufferState({ ...state(), futureField: 1 });
    expect(parsed).toEqual(state());
  });

  it("M01-D8：欄位齊全時回傳的內容與輸入等值（punctuated_word 選填）", () => {
    const input = state({ words: [{ word: "a", punctuated_word: "A", speaker: 1, start: 0, end: 0.5 }] });
    expect(parseStreamBufferState(input)).toEqual(input);
    const bare = state({ words: [{ word: "a", speaker: 1, start: 0, end: 0.5 }] });
    expect(parseStreamBufferState(bare)).toEqual(bare);
  });

  it("M01-D8：DB 裡是壞 JSON 文字 → read 丟 StreamBufferCorruptError（不是當成沒有緩衝）", () => {
    const { db, store } = device();
    store.write("m-1", state(), NOW);
    db.prepare("UPDATE stream_buffer SET state = ? WHERE session_id = ?").run("{not json", "m-1");
    expect(() => store.read("m-1")).toThrow(StreamBufferCorruptError);
  });

  it("M01-D8：DB 裡是合法 JSON 但欄位不合法 → read 一樣丟錯", () => {
    const { db, store } = device();
    store.write("m-1", state(), NOW);
    db.prepare("UPDATE stream_buffer SET state = ? WHERE session_id = ?").run(
      JSON.stringify({ meetingOffsetMs: "0", words: [], pendingUtteranceEnd: false }),
      "m-1",
    );
    expect(() => store.read("m-1")).toThrow(StreamBufferCorruptError);
  });

  it("M01-D4：drop 回報丟掉幾個字並清掉那列（會議結束時要說得出來）", () => {
    const { store } = device();
    store.write("m-1", state({ words: [{ word: "a", speaker: 0, start: 0, end: 1 }] }), NOW);
    expect(store.drop("m-1")).toBe(1);
    expect(store.read("m-1")).toBeNull();
    // 沒有列時 drop 回 0（不得例外、不得回 undefined）
    expect(store.drop("m-1")).toBe(0);
  });

  it("M01-D4：drop 遇到壞資料也要清掉（清不掉才是問題），回 0 且不丟例外", () => {
    const { db, store } = device();
    store.write("m-1", state(), NOW);
    db.prepare("UPDATE stream_buffer SET state = ? WHERE session_id = ?").run("{{", "m-1");
    expect(store.drop("m-1")).toBe(0);
    expect(store.read("m-1")).toBeNull();
  });

  it("M01-D7：updated_ms 會被寫進去（維運用：看得出緩衝有多舊）", () => {
    const { db, store } = device();
    store.write("m-1", state(), NOW);
    const rows = db.prepare("SELECT updated_ms FROM stream_buffer WHERE session_id = ?").all("m-1") as {
      updated_ms: number;
    }[];
    expect(rows[0]?.updated_ms).toBe(NOW);
  });
});
