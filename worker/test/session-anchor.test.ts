/**
 * TECH-014 純函式層單元測試（Gate 1）。
 *
 * 覆蓋 AC-1（MAC 形式）／AC-5（fail-closed：金鑰正規化）／AC-7-②（持有金鑰者可重簽）。
 * DO 層（甦醒時驗、同步閘門、改寫路徑）的整合測試在 `session-clock.test.ts`。
 */

import { describe, it, expect } from "vitest";

import {
  ANCHOR_VERSION,
  anchorEquals,
  anchorKey,
  anchorMac,
  sessionAnchorMessage,
} from "../src/session-anchor.js";

describe("sessionAnchorMessage", () => {
  it("格式 = v<version>|<meetingId>|<startedAtMs>|<endsAtMs>", () => {
    expect(sessionAnchorMessage(1, "m1", 1000, 3_000)).toBe("v1|m1|1000|3000");
  });
  it("版本號會進字串（未來改覆蓋範圍時可分辨）", () => {
    expect(sessionAnchorMessage(2, "m1", 1000, 3000)).toBe("v2|m1|1000|3000");
  });
});

describe("anchorKey 正規化（AC-5 fail-closed）", () => {
  it("未設 → null", () => {
    expect(anchorKey(undefined)).toBeNull();
    expect(anchorKey({})).toBeNull();
  });
  it("不是字串 → null", () => {
    expect(anchorKey({ SESSION_ANCHOR_KEY: 123 as unknown as string })).toBeNull();
  });
  it("空字串 → null", () => {
    expect(anchorKey({ SESSION_ANCHOR_KEY: "" })).toBeNull();
  });
  it("只有空白（包含換行／tab／全形空白）→ null", () => {
    expect(anchorKey({ SESSION_ANCHOR_KEY: "   " })).toBeNull();
    expect(anchorKey({ SESSION_ANCHOR_KEY: "\n\t  \r" })).toBeNull();
  });
  it("首尾空白被 trim", () => {
    expect(anchorKey({ SESSION_ANCHOR_KEY: "  abc  " })).toBe("abc");
  });
  it("正常金鑰原樣回傳", () => {
    expect(anchorKey({ SESSION_ANCHOR_KEY: "a-real-key-32-bytes-or-more" })).toBe("a-real-key-32-bytes-or-more");
  });
});

describe("anchorMac（AC-1）", () => {
  it("同一輸入同樣輸出（決定性）", async () => {
    const m1 = await anchorMac("k", "m1", 1000, 3000);
    const m2 = await anchorMac("k", "m1", 1000, 3000);
    expect(m1).toBe(m2);
    expect(m1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("改 meetingId → 變", async () => {
    const m1 = await anchorMac("k", "m1", 1000, 3000);
    const m2 = await anchorMac("k", "m2", 1000, 3000);
    expect(m1).not.toBe(m2);
  });
  it("改 startedAtMs → 變", async () => {
    const m1 = await anchorMac("k", "m1", 1000, 3000);
    const m2 = await anchorMac("k", "m1", 1001, 3000);
    expect(m1).not.toBe(m2);
  });
  it("改 endsAtMs → 變", async () => {
    const m1 = await anchorMac("k", "m1", 1000, 3000);
    const m2 = await anchorMac("k", "m1", 1000, 3001);
    expect(m1).not.toBe(m2);
  });
  it("改金鑰 → 變", async () => {
    const m1 = await anchorMac("k1", "m1", 1000, 3000);
    const m2 = await anchorMac("k2", "m1", 1000, 3000);
    expect(m1).not.toBe(m2);
  });
  it("(AC-7-②) 持有金鑰者重新呼叫同樣輸入 → 同樣 MAC（可重簽）", async () => {
    const m1 = await anchorMac("k", "m1", 1000, 3000);
    const m2 = await anchorMac("k", "m1", 1000, 3000);
    expect(m1).toBe(m2);
  });
  it("ANCHOR_VERSION 當下是 1（給未來變更留線索）", () => {
    expect(ANCHOR_VERSION).toBe(1);
  });
});

describe("anchorEquals", () => {
  it("兩 null → false（呼叫端要的是『明確不一致』，不是『兩邊都空』）", () => {
    expect(anchorEquals(null, null)).toBe(false);
  });
  it("一 null 一有值 → false", () => {
    expect(anchorEquals(null, { mac: "a".repeat(64) })).toBe(false);
    expect(anchorEquals({ mac: "a".repeat(64) }, null)).toBe(false);
  });
  it("同 mac → true", () => {
    expect(anchorEquals({ mac: "abc" }, { mac: "abc" })).toBe(true);
  });
  it("不同 mac → false", () => {
    expect(anchorEquals({ mac: "abc" }, { mac: "abd" })).toBe(false);
  });
  it("長度不同 → false（沿用 constantTimeEquals，不走早退）", () => {
    expect(anchorEquals({ mac: "abc" }, { mac: "abcd" })).toBe(false);
  });
});
