import { describe, expect, it } from "vitest";

import { formatDuration, formatGapText, sortBySeq } from "./gap-text";

/**
 * M01-US-107 AC-2：逐字稿的缺口列必須寫出**時間範圍**；
 * 還沒閉合的缺口必須明說「結束時間未知」，不得假裝範圍已知。
 */
describe("M01-US-107 缺口文案", () => {
  it("M01-Given 已閉合的缺口 When 顯示 Then 寫出起訖與長度", () => {
    expect(formatGapText({ fromMs: 12_000, toMs: 230_000 })).toBe(
      "此段未錄到（00:12 – 03:50，共 3 分 38 秒）",
    );
  });

  it("M01-Given 未閉合的缺口 When 顯示 Then 明說結束時間未知（不編一個假的結束時間）", () => {
    expect(formatGapText({ fromMs: 63_000, toMs: null })).toBe(
      "此段未錄到（從 01:03 起中斷，結束時間未知）",
    );
  });

  it("M01-Given 超過一小時的會議 When 顯示 Then 時間含小時位（沿用 formatClock）", () => {
    expect(formatGapText({ fromMs: 3_600_000, toMs: 3_725_000 })).toBe(
      "此段未錄到（1:00:00 – 1:02:05，共 2 分 5 秒）",
    );
  });

  it("M01-Given 極短或怪異的區間 When 顯示 Then 不得出現負數或 NaN", () => {
    expect(formatGapText({ fromMs: 5_000, toMs: 5_000 })).toBe("此段未錄到（00:05 – 00:05，長度不到 1 秒）");
    expect(formatDuration(-1)).toBe("不到 1 秒");
    expect(formatDuration(Number.NaN)).toBe("不到 1 秒");
    expect(formatGapText({ fromMs: -5_000, toMs: 1_000 })).toBe("此段未錄到（00:00 – 00:01，共 6 秒）");
  });

  it("M01-Given 長度換算 When 顯示 Then 整分不寫「0 秒」、小時不寫「0 分」", () => {
    expect(formatDuration(60_000)).toBe("1 分");
    expect(formatDuration(90_000)).toBe("1 分 30 秒");
    expect(formatDuration(3_600_000)).toBe("1 小時");
    expect(formatDuration(3_660_000)).toBe("1 小時 1 分");
    expect(formatDuration(59_000)).toBe("59 秒");
  });

  it("M01-Given 缺口與句子混在一起 When 排序 Then 一律依 seq（逐字稿的閱讀順序）", () => {
    expect(sortBySeq([{ seq: 3 }, { seq: 1 }, { seq: 2 }]).map((item) => item.seq)).toEqual([1, 2, 3]);
  });
});