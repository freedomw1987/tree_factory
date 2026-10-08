// M01-US-102：分段計畫（純函式）。
//
// 為什麼要「計畫」而不是「邊錄邊算」：分段序號必須與時間軸一一對應，
// 恢復時才能用 `expectedNextSeq` 判斷「缺哪一段」（AC-4：時間軸連續、無缺段）。
//
// 契約：分段長度固定 30 秒（D1：MediaRecorder 每 30 秒 stop/start，每段獨立可解碼）。

import { describe, expect, it } from "vitest";

import {
  CHUNK_DURATION_MS,
  chunkIndexAt,
  planChunks,
  rotationDue,
} from "./chunk-plan";

describe("M01-US-102 chunk-plan", () => {
  it("M01-Given 沒有實作 When 讀常數 Then 分段長度 = 30 秒（設計 D1 的單一來源）", () => {
    expect(CHUNK_DURATION_MS).toBe(30_000);
  });

  it("M01-Given 錄音 75 秒 When 計畫分段 Then 3 段（30+30+15），seq 從 1 遞增", () => {
    const plan = planChunks(75_000);
    expect(plan.map((chunk) => chunk.seq)).toEqual([1, 2, 3]);
    expect(plan.map((chunk) => chunk.durationMs)).toEqual([30_000, 30_000, 15_000]);
    expect(plan.map((chunk) => chunk.startsAtMs)).toEqual([0, 30_000, 60_000]);
  });

  it("M01-Given 恰好整段（60 秒）When 計畫分段 Then 2 段（不產生空的第 3 段）", () => {
    expect(planChunks(60_000)).toHaveLength(2);
  });

  it("M01-Given 0 或負數 When 計畫分段 Then 0 段（沒有音訊就沒有分段）", () => {
    expect(planChunks(0)).toEqual([]);
    expect(planChunks(-1)).toEqual([]);
  });

  it("M01-Given 邊界時間點 When 問第幾段 Then 以 30 秒為界（29999→0、30000→1）", () => {
    expect(chunkIndexAt(0)).toBe(0);
    expect(chunkIndexAt(29_999)).toBe(0);
    expect(chunkIndexAt(30_000)).toBe(1);
    expect(chunkIndexAt(60_000)).toBe(2);
  });

  it("M01-Given 目前在第 0 段 When 累積到 30 秒 Then 該換段；未到則不換", () => {
    expect(rotationDue(29_999, 0)).toBe(false);
    expect(rotationDue(30_000, 0)).toBe(true);
    expect(rotationDue(30_001, 1)).toBe(false);
    expect(rotationDue(60_000, 1)).toBe(true);
  });

  it("M01-Given 超過一整段才發現（時間跳躍）When 問是否換段 Then true（不可漏掉）", () => {
    expect(rotationDue(75_000, 0)).toBe(true);
  });
});
