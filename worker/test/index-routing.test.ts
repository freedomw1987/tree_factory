// M01-US-101：worker 入口（轉發 + CORS）；TECH-009 起再加上憑證／來源／速率三關。
//
// 這裡用假的 DO namespace 驗「入口本身」的行為：
// 路徑/query 是否原樣轉進 DO、會議 id 有沒有帶進去、CORS 標頭是否只在允許來源出現。
// DO 的內容行為由 session-routes.test.ts（注入時鐘）與 do-smoke（真 workerd）負責。

import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index.js";

interface Seen {
  path: string;
  search: string;
  meetingId: string | null;
}

function makeEnv(allowed?: string): { env: Env; seen: Seen[] } {
  const seen: Seen[] = [];
  const env = {
    MEETING: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          seen.push({
            path: url.pathname,
            search: url.search,
            meetingId: request.headers.get("x-meeting-id"),
          });
          return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
    ...(allowed === undefined ? {} : { ALLOWED_ORIGINS: allowed }),
    DEVICE_TOKEN: "test-token",
  } as unknown as Env;
  return { env, seen };
}

/**
 * TECH-009：這個入口的每個請求都要帶憑證（憑證關在 Origin 關之後）。
 * 集中一個 helper，避免某幾個測試忘了帶而變成在驗 401。
 */
function authed(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test-token");
  return { ...init, headers };
}

describe("M01-US-101 worker 入口（轉發與 CORS）", () => {
  it("M01-Given 未帶路徑 When GET / Then 回服務說明與路由清單（TECH-009：首頁仍公開）", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://w.test/"), env);
    const body = (await response.json()) as { service: string; routes: string[] };
    expect(response.status).toBe(200);
    expect(body.service).toBe("tree-factory-worker");
    expect(body.routes).toContain("POST /m/:meetingId/session/start");
    // TECH-009 AC-5：會改狀態的兩個端點都必須是 POST（simple GET 不得再改狀態）。
    expect(body.routes).toContain("POST /m/:meetingId/wake?ms=");
    expect(body.routes).toContain("POST /m/:meetingId/release");
    expect(body.routes.some((route) => route.startsWith("GET /m/:meetingId/wake"))).toBe(false);
    expect(body.routes.some((route) => route.startsWith("GET /m/:meetingId/release"))).toBe(false);
  });

  it("M01-Given 裝置端打 session 路徑 When 轉進 DO Then 路徑與會議 id 都正確", async () => {
    const { env, seen } = makeEnv();
    await worker.fetch(
      new Request("https://w.test/m/abc/session/start", authed({ method: "POST", body: "{}" })),
      env,
    );
    expect(seen).toEqual([{ path: "/session/start", search: "", meetingId: "abc" }]);
  });

  it("M01-Given 沒帶子路徑 When 轉進 DO Then 預設走 /health（與 TECH-004 一致）", async () => {
    const { env, seen } = makeEnv();
    await worker.fetch(new Request("https://w.test/m/abc", authed()), env);
    expect(seen[0]?.path).toBe("/health");
  });

  it("M01-Given 有 query When 轉進 DO Then query 不得被吃掉（?ms= 的舊坑）", async () => {
    const { env, seen } = makeEnv();
    // TECH-009 D7：`/wake` 是 POST-only，這裡用 POST 才對得上真實契約（query 仍要被帶進 DO）。
    await worker.fetch(new Request("https://w.test/m/abc/wake?ms=1500", authed({ method: "POST" })), env);
    expect(seen[0]).toEqual({ path: "/wake", search: "?ms=1500", meetingId: "abc" });
  });

  it("M01-Given 允許來源 When 回應 Then 帶 CORS 標頭（app 才打得動）", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://w.test/m/abc/session", authed({ headers: { origin: "http://localhost:1420" } })),
      env,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  it("M01-Given 清單外來源 When 回應 Then 403 且**不進 DO**（TECH-009 D5：副作用不得發生）", async () => {
    const { env, seen } = makeEnv();
    const response = await worker.fetch(
      new Request("https://w.test/m/abc/session", authed({ headers: { origin: "https://evil.example" } })),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // 舊契約是「不給 CORS 標頭但照常轉發」——那等於「讀不到，但寫入已經發生」，
    // 正是 TECH-009 要消滅的形狀，所以這一條由 1 收緊成 0。
    expect(seen).toHaveLength(0);
  });

  it("M01-Given preflight When OPTIONS Then 204 且不進 DO（省一次 DO 喚醒）", async () => {
    const { env, seen } = makeEnv();
    const response = await worker.fetch(
      new Request("https://w.test/m/abc/session/start", {
        method: "OPTIONS",
        headers: { origin: "tauri://localhost" },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(seen).toHaveLength(0);
  });

  it("M01-Given 設了 ALLOWED_ORIGINS When 用清單內來源 Then 放行、dev 來源則不再自動放行", async () => {
    const { env } = makeEnv("https://app.treefactory.dev");
    const allowed = await worker.fetch(
      new Request(
        "https://w.test/m/abc/session",
        authed({ headers: { origin: "https://app.treefactory.dev" } }),
      ),
      env,
    );
    const devOrigin = await worker.fetch(
      new Request("https://w.test/m/abc/session", authed({ headers: { origin: "http://localhost:1420" } })),
      env,
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.treefactory.dev");
    // 覆寫之後 dev 來源不在清單內 → TECH-009 D5 的 403（連轉發都沒有）。
    expect(devOrigin.status).toBe(403);
    expect(devOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });
});
