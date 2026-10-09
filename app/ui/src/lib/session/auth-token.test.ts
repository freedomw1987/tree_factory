// TECH-009：裝置端（UI）這一側的兩個契約——憑證注入與失敗文案。
//
// 這一層驗的是**送出去的請求長什麼樣**與**使用者看到什麼字**，
// 兩者都是「伺服端回 401 之後會發生什麼」的一部分：
// 少了憑證，UI 會在正式環境完全打不動；文案錯，使用者會被送去查不存在的網路問題。

import { describe, expect, it } from "vitest";

import { HttpSessionClient, SessionApiError, deviceTokenFrom, sessionFailureMessage, withDeviceToken } from "./api";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeClient(token?: string): { client: HttpSessionClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers,
    });
    return new Response(JSON.stringify({ meetingId: "m1", phase: "recording", startedAtMs: 1, endsAtMs: 2, remainingMs: 1, warn: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { client: new HttpSessionClient({ baseUrl: "http://w.test", meetingId: "m1", fetchImpl, token }), calls };
}

describe("TECH-009 AC-6：HttpSessionClient 注入裝置憑證", () => {
  it("TECH-009 AC-6：有 token 時，session 與逐字稿/音檔路徑都要帶 `Authorization: Bearer`", async () => {
    const { client, calls } = makeClient("tok-1");
    await client.start();
    await client.uploadChunk({ seq: 1, blob: new Blob([new Uint8Array([1])]) });
    await client.listSegments({ since: null, limit: 10 });
    expect(calls).toHaveLength(3);
    for (const entry of calls) {
      expect(entry.headers.authorization, entry.url).toBe("Bearer tok-1");
      // 憑證必須**每一個**請求都帶：上傳音檔那條路徑沒有憑證，音檔就整場丟失。
    }
  });

  it("TECH-009 AC-6：沒有 token（`undefined`／空字串）時不得送出 `Bearer undefined` 或空的 `Bearer `（寧可讓伺服端回 401）", async () => {
    // 空字串要跟 undefined 一樣被當成「沒有憑證」：`Bearer ` 這種標頭在伺服端
    // 只會被判成格式錯，但它在瀏覽器／代理的日誌裡長得**像**有帶憑證，
    // 會讓「忘了設定 VITE_DEVICE_TOKEN」變成一個看不出來的 401（突變測試抓到）。
    for (const token of [undefined, ""]) {
      const { client, calls } = makeClient(token);
      await client.start();
      expect(calls[0]?.headers.authorization, `token=${JSON.stringify(token)}`).toBeUndefined();
    }
  });

  it("TECH-009 AC-6：注入不得蓋掉既有標頭（content-type 仍要在）", async () => {
    const { client, calls } = makeClient("tok-2");
    await client.uploadChunk({ seq: 2, blob: new Blob([new Uint8Array([2])]) });
    expect(calls[0]?.headers["content-type"]).toBe("application/octet-stream");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-2");
  });

  it("TECH-009 AC-6：呼叫端自己帶了 authorization 時，以 client 的 token 為準（單一來源）", async () => {
    // 這一條刻意的：憑證由 client 統一注入，避免「某處自己塞了一個舊 token」的漂移。
    const seen: Record<string, string>[] = [];
    const inner = (async (_input: unknown, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const decorated = withDeviceToken(inner, "right");
    await decorated("http://w.test/x", { headers: { authorization: "Bearer stale", "x-meeting-id": "m1" } });
    expect(seen[0]?.authorization).toBe("Bearer right");
    expect(seen[0]?.["x-meeting-id"]).toBe("m1");
  });

  it("TECH-009 AC-6：沒有 token 的裝飾器不得改動請求（連 headers 都不該被憑空建立）", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const inner = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const decorated = withDeviceToken(inner, undefined);
    await decorated("http://w.test/x");
    expect(new Headers(seen[0]?.headers).get("authorization")).toBeNull();
  });
});

describe("TECH-009 AC-6：失敗文案（401 不能再叫使用者查網路）", () => {
  it("TECH-009 AC-6：401 → 說「裝置授權已失效，請重新配對」（DESIGN §5.1 的預先規劃文案）", () => {
    const message = sessionFailureMessage(new SessionApiError(401, "AUTH_INVALID", "unauthorized"));
    expect(message).toBe("裝置授權已失效，請重新配對");
    expect(message).not.toContain("網路");
  });

  it("TECH-009 AC-6：429 → 是可重試的忙線，不是「伺服器沒有接受」（不得引導去查網路）", () => {
    const message = sessionFailureMessage(new SessionApiError(429, "RATE_LIMITED", "too many"));
    expect(message).toContain("稍後再試");
    expect(message).not.toContain("請確認網路");
  });

  it("TECH-009 AC-6：500 AUTH_NOT_CONFIGURED → 講「伺服器還沒設定」，不要把伺服器的錯說成使用者的錯", () => {
    const message = sessionFailureMessage(new SessionApiError(500, "AUTH_NOT_CONFIGURED", "no secret"));
    expect(message).toContain("尚未完成設定");
    expect(message).toContain("AUTH_NOT_CONFIGURED");
  });

  it("TECH-009 AC-6：其他 SessionApiError 與非 API 錯誤維持既有文案（不回歸）", () => {
    expect(sessionFailureMessage(new SessionApiError(409, "SESSION_ENDED", "x"))).toBe(
      "伺服端沒有接受這場會議（SESSION_ENDED）。請確認網路後再試。",
    );
    expect(sessionFailureMessage(new Error("boom"))).toBe("無法開始會議：boom");
    expect(sessionFailureMessage("nope")).toBe("無法開始會議：nope");
  });
});

describe("TECH-009 `deviceTokenFrom`：建置期設定的憑證值", () => {
  it("TECH-009 AC-6：有值就用它（並去掉複製貼上常帶的前後空白）", () => {
    expect(deviceTokenFrom("tok-1")).toBe("tok-1");
    expect(deviceTokenFrom("  tok-1  ")).toBe("tok-1");
  });

  it("TECH-009 AC-6：沒設／空字串／只有空白／不是字串 → undefined（**不得**退化成任何預設憑證）", () => {
    // 為什麼這條重要：預設一把「大家都知道」的憑證比沒有憑證更糟——它看起來像有鎖，
    // 而且會讓「正式環境忘了設 VITE_DEVICE_TOKEN」變成一個沒人發現的靜默狀態。
    for (const value of [undefined, null, "", "   ", 0, {}, []]) {
      expect(deviceTokenFrom(value)).toBeUndefined();
    }
  });
});
