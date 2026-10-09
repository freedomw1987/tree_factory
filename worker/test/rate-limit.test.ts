// TECH-009：邊緣速率限制（per-isolate 固定窗）。
//
// 時間一律由參數注入，所以「窗過期」「淘汰」都是立刻可驗的事實，不用真的等 60 秒。
// 這一層要驗的是**計數語意**；「429 真的長什麼樣」由 index-auth.test.ts 與真 workerd 驗。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX,
  DEFAULT_WINDOW_MS,
  FixedWindowLimiter,
  MAX_KEYS,
  clientKey,
  rateLimitConfig,
  tokenFingerprint,
} from "../src/rate-limit.js";

const CFG = { windowMs: 60_000, max: 3 };

describe("TECH-009 速率限制設定（rateLimitConfig）", () => {
  it("TECH-009 AC-4：未設定 → 預設（60 秒 / 300 次）", () => {
    expect(rateLimitConfig({})).toEqual({ windowMs: DEFAULT_WINDOW_MS, max: DEFAULT_MAX });
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_MAX).toBe(300);
  });

  it("TECH-009 AC-4：合法十進位字串 → 採用（可含前後空白）", () => {
    expect(rateLimitConfig({ RATE_LIMIT_MAX: "12", RATE_LIMIT_WINDOW_MS: "2500" })).toEqual({
      windowMs: 2500,
      max: 12,
    });
    expect(rateLimitConfig({ RATE_LIMIT_MAX: " 12 " })).toEqual({
      windowMs: DEFAULT_WINDOW_MS,
      max: 12,
    });
  });

  it("TECH-009 AC-4：不合法值（0／負數／小數／十六進位／科學記號／亂字串）→ 回預設，不得變成無限制", () => {
    for (const raw of ["0", "-5", "1.5", "0x1f", "1e3", "abc", " ", "12px"]) {
      expect(rateLimitConfig({ RATE_LIMIT_MAX: raw }).max, `RATE_LIMIT_MAX=${JSON.stringify(raw)}`).toBe(
        DEFAULT_MAX,
      );
      expect(rateLimitConfig({ RATE_LIMIT_WINDOW_MS: raw }).windowMs).toBe(DEFAULT_WINDOW_MS);
    }
  });
});

describe("TECH-009 速率限制計數（FixedWindowLimiter）", () => {
  it("TECH-009 AC-4：同一窗內前 N 次放行、第 N+1 次被擋，且 remaining 遞減", () => {
    const limiter = new FixedWindowLimiter();
    const t = 1_000_000;
    expect(limiter.check("k", t, CFG)).toMatchObject({ allowed: true, remaining: 2, limit: 3 });
    expect(limiter.check("k", t + 1, CFG)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("k", t + 2, CFG)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = limiter.check("k", t + 3, CFG);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // 被擋的那一次不再往後推窗（否則洪水可以讓同一個窗無限延長）。
    expect(limiter.check("k", t + 4, CFG).allowed).toBe(false);
  });

  it("TECH-009 AC-4：被擋時 retryAfterMs = 窗起點 + 窗長 − 現在（精確值，供 Retry-After 換算）", () => {
    const limiter = new FixedWindowLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) limiter.check("k", t, CFG);
    expect(limiter.check("k", t + 10_000, CFG).retryAfterMs).toBe(50_000);
    // 窗的最後一刻被擋 → 只要再等 1ms
    expect(limiter.check("k", t + 59_999, CFG).retryAfterMs).toBe(1);
    // 窗過後就是「沒有等待時間」，不是一個負數或殘留值。
    expect(limiter.check("k", t + 60_000, CFG).retryAfterMs).toBe(0);
  });

  it("TECH-009 AC-4：窗過後恢復（同一個 key 重新計數，不必有人清理）", () => {
    const limiter = new FixedWindowLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 4; i += 1) limiter.check("k", t, CFG);
    expect(limiter.check("k", t + 60_000, CFG)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("TECH-009 AC-4：不同 key 互不影響（同一顆 isolate 內各裝置、各 IP 各自一個桶）", () => {
    const limiter = new FixedWindowLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 4; i += 1) limiter.check("a", t, CFG);
    expect(limiter.check("a", t, CFG).allowed).toBe(false);
    expect(limiter.check("b", t, CFG).allowed).toBe(true);
  });

  it("TECH-009 AC-4：記錄數不得超過 MAX_KEYS；滿了就淘汰最舊的（FIFO），不能無上限長大", () => {
    const limiter = new FixedWindowLimiter();
    const tight = { windowMs: 60_000, max: 1 };
    for (let i = 0; i < MAX_KEYS; i += 1) limiter.check(`k${i}`, 1_000, tight);
    expect(limiter.size).toBe(MAX_KEYS);
    limiter.check("newcomer", 1_001, tight);
    expect(limiter.size).toBe(MAX_KEYS);
    // 最舊的 `k0` 已被遺忘 → 它的計數重新開始（誠實：這就是「洪水可擠掉別人的桶」）
    expect(limiter.check("k0", 1_002, tight)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("TECH-009 AC-4：淘汰前先清過期（過期的桶不佔名額）", () => {
    const limiter = new FixedWindowLimiter();
    for (let i = 0; i < MAX_KEYS; i += 1) limiter.check(`k${i}`, 1_000, CFG);
    expect(limiter.size).toBe(MAX_KEYS);
    // 窗已過 → 新 key 進來時應該先清掉舊的，而不是淘汰一個還沒過期的桶。
    limiter.check("newcomer", 1_000 + CFG.windowMs, CFG);
    expect(limiter.size).toBe(1);
  });
});

describe("TECH-009 限流鍵（token 指紋 + IP）", () => {
  it("TECH-009 AC-4：指紋是定長十六進位、可重現、不相等於原字串（不把憑證放進記憶體 key）", async () => {
    const a = await tokenFingerprint("s3cret-token");
    const b = await tokenFingerprint("s3cret-token");
    const c = await tokenFingerprint("s3cret-toke2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("s3cret");
  });

  it("TECH-009 AC-4：同一指紋不同 IP → 不同鍵；沒帶 IP（本機／測試）→ 用 `-` 佔位", () => {
    expect(clientKey("abc", "1.2.3.4")).not.toBe(clientKey("abc", "5.6.7.8"));
    expect(clientKey("abc", null)).toBe("abc|-");
    expect(clientKey("abc", "1.2.3.4")).toBe("abc|1.2.3.4");
  });
});
