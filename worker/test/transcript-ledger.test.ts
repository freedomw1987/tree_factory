// M01-US-103：逐字稿帳本（append-only，DO SQLite）。
//
// 這裡用**真 node:sqlite**（不是 mock）當 DO SQLite 替身：
// 「重送不新增」「同鍵不同內容不覆寫」「跨 instance 仍在」這三件事都只有真的 SQL 能證明。

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MAX_TEXT_CHARS,
  TRANSCRIPT_SKEW_TOLERANCE_MS,
  TranscriptInvalidError,
  TranscriptLedger,
  type TranscriptSql,
} from "../src/storage/transcript-store.js";

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

const NOW = 1_700_000_000_000;
const MAX_MS = 120_000 + TRANSCRIPT_SKEW_TOLERANCE_MS;

function ledger(): { ledger: TranscriptLedger; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return { ledger: new TranscriptLedger(sqlFrom(db)), db };
}

function segment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { idempotencyKey: "seg:0:0", speakerId: 0, text: "第一句", startMs: 0, endMs: 1_000, ...overrides };
}

describe("M01-US-103 TranscriptLedger", () => {
  it("M01-AC-3：連續寫入三段 → seq 由 1 單調遞增，list() 依 seq 排序", () => {
    const { ledger: log } = ledger();
    for (const [index, text] of ["一", "二", "三"].entries()) {
      log.record({ ...segment({ text, idempotencyKey: `seg:0:${index * 2_000}`, startMs: index * 2_000, endMs: index * 2_000 + 1_000 }), maxMs: MAX_MS, nowMs: NOW });
    }
    const rows = log.list();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.text)).toEqual(["一", "二", "三"]);
    expect(log.count()).toBe(3);
  });

  it("M01-D6：重疊只看「起點更早」的那一列——同步開始與亂序補送都不算重疊", () => {
    const { ledger: log } = ledger();
    const put = (key: string, speakerId: number, text: string, startMs: number, endMs: number) =>
      log.record({
        ...segment({ idempotencyKey: key, speakerId, text, startMs, endMs }),
        maxMs: MAX_MS,
        nowMs: NOW,
      });
    put("seg:0:1000", 0, "A", 1_000, 2_000);
    // 兩人同時開口（起點相同）：若把同起點也算「前面」，兩人一起說的話會被記成整段重疊。
    put("seg:1:1000", 1, "B", 1_000, 2_500);
    put("seg:0:5000", 0, "C", 5_000, 6_000);
    // 亂序補送（起點 1000 的長段晚到）：它的「前面」是起點更早的列，不是它自己。
    put("seg:0:1000b", 0, "D", 1_000, 5_500);
    expect(log.list().map((row) => [row.startMs, row.endMs, row.overlapMs])).toEqual([
      [1_000, 2_000, 0],
      [1_000, 2_500, 0],
      [5_000, 6_000, 0],
      [1_000, 5_500, 0],
    ]);
    // `previousEndMs` 的定義就是這個判準：起點**嚴格更早**的列之中，起點最大的那一列。
    expect(log.previousEndMs(1_000)).toBeNull();
  });

  it("M01-D6：`previousEndMs` 取的是「起點更早」那一列的結束時間（單列時可精確驗證）", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment({ startMs: 1_000, endMs: 2_000 }), maxMs: MAX_MS, nowMs: NOW });
    expect(log.previousEndMs(1_000)).toBeNull(); // 同起點不算「前面」
    expect(log.previousEndMs(1_500)).toBe(2_000);
    expect(log.previousEndMs(9_999)).toBe(2_000);
  });

  it("M01-AC-3：append-only 是「沒有 API 可以改」——record 之後再讀，內容與 seq 完全不變", () => {
    const { ledger: log } = ledger();
    const first = log.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW });
    expect(first.accepted).toBe(true);
    expect(log.record({ ...segment({ text: "改寫版" }), maxMs: MAX_MS, nowMs: NOW + 1 })).toMatchObject({
      accepted: false,
      conflict: true,
    });
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]).toMatchObject({ seq: 1, text: "第一句" });
  });

  it("M01-AC-6：同一 idempotencyKey 重送相同內容 → duplicate:true，列數不變", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW });
    const again = log.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW + 5 });
    expect(again).toMatchObject({ accepted: false, duplicate: true, count: 1 });
    expect(log.count()).toBe(1);
  });

  it("M01-D8：同一 idempotencyKey 不同內容 → conflict:true，且回傳 existing 與 incoming 全文（不得靜默）", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment({ text: "短版" }), maxMs: MAX_MS, nowMs: NOW });
    const conflict = log.record({ ...segment({ text: "長版的內容", endMs: 2_000 }), maxMs: MAX_MS, nowMs: NOW + 1 });
    expect(conflict.accepted).toBe(false);
    if (conflict.accepted || !("conflict" in conflict)) throw new Error("預期 conflict");
    expect(conflict.existing.text).toBe("短版");
    expect(conflict.incoming.text).toBe("長版的內容");
    expect(conflict.incoming.endMs).toBe(2_000);
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]?.text).toBe("短版");
  });

  it("M01-驗證：speakerId 非 0 起算整數 → TRANSCRIPT_INVALID；被擋下的請求不得寫入", () => {
    const { ledger: log } = ledger();
    for (const bad of [-1, 1.5, "0", null, 64]) {
      expect(() => log.record({ ...segment({ speakerId: bad }), maxMs: MAX_MS, nowMs: NOW })).toThrow(
        TranscriptInvalidError,
      );
    }
    expect(log.count()).toBe(0);
  });

  it("M01-驗證：空白內文／超長內文／endMs<startMs／endMs 落在未來／overlapMs 超過段長 一律擋下", () => {
    const { ledger: log } = ledger();
    const cases: Record<string, unknown>[] = [
      { text: "   " },
      { text: "x".repeat(MAX_TEXT_CHARS + 1) },
      { startMs: 5_000, endMs: 4_000 },
      { endMs: MAX_MS + 1 },
      { startMs: 1_000, endMs: 2_000, overlapMs: 1_001 },
      { idempotencyKey: "" },
      { idempotencyKey: "k".repeat(129) },
      { text: 123 },
    ];
    for (const overrides of cases) {
      expect(() => log.record({ ...segment(overrides), maxMs: MAX_MS, nowMs: NOW })).toThrow(TranscriptInvalidError);
    }
    expect(log.count()).toBe(0);
  });

  it("M01-驗證：被擋下來的請求不燒 seq（下一個成功的段落仍是 1）", () => {
    const { ledger: log } = ledger();
    expect(() => log.record({ ...segment({ text: "  " }), maxMs: MAX_MS, nowMs: NOW })).toThrow();
    const ok = log.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW });
    expect(ok.accepted).toBe(true);
    if (!ok.accepted) throw new Error("預期 accepted");
    expect(ok.segment.seq).toBe(1);
  });

  it("M01-D8：conflict 也不燒 seq（下一個成功的段落緊接其後，帳本沒有洞）", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW });
    log.record({ ...segment({ text: "不同內容" }), maxMs: MAX_MS, nowMs: NOW });
    const next = log.record({ ...segment({ idempotencyKey: "seg:1:2000", speakerId: 1, startMs: 2_000, endMs: 3_000 }), maxMs: MAX_MS, nowMs: NOW });
    expect(next.accepted).toBe(true);
    if (!next.accepted) throw new Error("預期 accepted");
    expect(next.segment.seq).toBe(2);
  });

  it("M01-跨 instance：換一個 TranscriptLedger 讀同一份 DB 仍看得到同樣的列（不是記憶體帳本）", () => {
    const { ledger: first, db } = ledger();
    first.record({ ...segment(), maxMs: MAX_MS, nowMs: NOW });
    first.record({ ...segment({ idempotencyKey: "seg:1:2000", speakerId: 1, startMs: 2_000, endMs: 3_000 }), maxMs: MAX_MS, nowMs: NOW });
    const second = new TranscriptLedger(sqlFrom(db));
    expect(second.list().map((row) => [row.seq, row.speakerId, row.text])).toEqual([
      [1, 0, "第一句"],
      [2, 1, "第一句"],
    ]);
  });

  it("M01-AC-4：overlapMs 會被存下來（重疊發言在資料裡看得出來）", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment({ startMs: 0, endMs: 1_000 }), maxMs: MAX_MS, nowMs: NOW });
    log.record({
      ...segment({ idempotencyKey: "seg:1:900", speakerId: 1, startMs: 900, endMs: 1_800, overlapMs: 100 }),
      maxMs: MAX_MS,
      nowMs: NOW,
    });
    expect(log.list().map((row) => row.overlapMs)).toEqual([0, 100]);
  });

  it("M01-AC-1：speakerId 跨句保持一致（0 與 1 交替寫入後，讀回來仍是交替）", () => {
    const { ledger: log } = ledger();
    const speakers = [0, 1, 0, 1];
    for (const [index, speakerId] of speakers.entries()) {
      log.record({
        ...segment({ idempotencyKey: `seg:${speakerId}:${index * 2_000}`, speakerId, startMs: index * 2_000, endMs: index * 2_000 + 1_500 }),
        maxMs: MAX_MS,
        nowMs: NOW,
      });
    }
    expect(log.list().map((row) => row.speakerId)).toEqual(speakers);
  });

  it("M01-AC-2：時間戳相對會議開始、單位毫秒（原樣存回，不做秒的換算）", () => {
    const { ledger: log } = ledger();
    log.record({ ...segment({ startMs: 3_680, endMs: 7_960 }), maxMs: MAX_MS, nowMs: NOW });
    expect(log.list()[0]).toMatchObject({ startMs: 3_680, endMs: 7_960 });
  });
});
