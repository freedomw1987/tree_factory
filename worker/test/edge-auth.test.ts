// TECH-009：邊緣認證的純函式。
//
// 這一層刻意不碰 Request / Response，也不碰 env：
// 「憑證怎麼解析」「怎麼比」「判定順序」是可以單獨驗的**產品行為**，
// 混進入口就只能在整合測試裡看得到，失敗時也分不清是解析錯還是順序錯。

import { describe, expect, it } from "vitest";

import { authDecision, bearerToken, constantTimeEquals, DEVICE_TOKEN_HEADER } from "../src/edge-auth.js";

describe("TECH-009 憑證解析（bearerToken）", () => {
  it("TECH-009 AC-2：`Bearer <token>` → 取出 token（scheme 大小寫不拘）", () => {
    expect(bearerToken("Bearer s3cret")).toBe("s3cret");
    expect(bearerToken("bearer s3cret")).toBe("s3cret");
    expect(bearerToken("BEARER s3cret")).toBe("s3cret");
    expect(bearerToken("  Bearer s3cret  ")).toBe("s3cret");
  });

  it("TECH-009 AC-2：缺少／空／非 Bearer／只有 scheme → 一律 null（不得退化成空字串通過）", () => {
    for (const raw of [null, "", "   ", "s3cret", "Basic s3cret", "Bearer", "Bearer ", "Bearer  "]) {
      expect(bearerToken(raw), `header=${JSON.stringify(raw)}`).toBeNull();
    }
  });

  it("TECH-009 AC-2：token 本身含空白時不得被 trim 成另一把（比對要嚴格）", () => {
    // `Bearer a b` 的 token 是 `a b`；不可只取到 `a`（那就變成兩把不同的憑證）。
    expect(bearerToken("Bearer a b")).toBe("a b");
    expect(bearerToken("Bearer a  ")).toBe("a");
  });
});

describe("TECH-009 常數時間比較（constantTimeEquals）", () => {
  it("TECH-009 AC-2：相同字串為 true（含空字串與長字串）", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("s3cret", "s3cret")).toBe(true);
    expect(constantTimeEquals("x".repeat(512), "x".repeat(512))).toBe(true);
  });

  it("TECH-009 AC-2：長度相同但內容不同為 false（含只有最後一位不同）", () => {
    expect(constantTimeEquals("abcd", "abce")).toBe(false);
    expect(constantTimeEquals("s3cret-a", "s3cret-b")).toBe(false);
  });

  it("TECH-009 AC-2：長度不同為 false（含前綴相同的情況，不得被前綴騙成 true）", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("abc", "ab")).toBe(false);
    expect(constantTimeEquals("", "a")).toBe(false);
    expect(constantTimeEquals("a", "")).toBe(false);
  });
});

describe("TECH-009 判定（authDecision）", () => {
  it("TECH-009 AC-1：未設定憑證（undefined／空字串）→ not_configured，即使對方帶了正確的值也一樣", () => {
    expect(authDecision(null, undefined)).toBe("not_configured");
    expect(authDecision(null, "")).toBe("not_configured");
    // 這一條是刻意的：設定為空＝沒設定，**不得**讓「空字串等於空憑證」放行。
    expect(authDecision("Bearer ", "")).toBe("not_configured");
    expect(authDecision("Bearer whatever", "")).toBe("not_configured");
  });

  it("TECH-009 AC-2：有設定且相符 → ok；不相符或沒帶 → invalid", () => {
    expect(authDecision("Bearer s3cret", "s3cret")).toBe("ok");
    expect(authDecision("Bearer s3crey", "s3cret")).toBe("invalid");
    expect(authDecision(null, "s3cret")).toBe("invalid");
    expect(authDecision("Bearer s3cret-extra", "s3cret")).toBe("invalid");
  });

  it("TECH-009 AC-2：憑證內部多空白不算同一把（避免「trim 後相等」變成兩把等價憑證）", () => {
    // `Bearer` 之後多一個空白 → 取到的 token 是 `" s3cret"`，與設定的 `s3cret` 不是同一把。
    expect(authDecision("Bearer  s3cret", "s3cret")).toBe("invalid");
    expect(authDecision("Bearer s3cret x", "s3cret")).toBe("invalid");
    // 但標頭**整體**的前後空白是 HTTP 層的正常現象（客戶端／proxy 都可能加），容忍它：
    // 這與 `bearerToken("  Bearer s3cret  ")` 取得到 token 是同一條規則。
    expect(authDecision("Bearer s3cret ", "s3cret")).toBe("ok");
    expect(authDecision("  Bearer s3cret  ", "s3cret")).toBe("ok");
  });

  it("TECH-009 AC-2：標頭名稱為 `authorization`（避免各處硬寫字串）", () => {
    expect(DEVICE_TOKEN_HEADER).toBe("authorization");
  });
});
