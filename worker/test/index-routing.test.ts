// M01-US-101：worker 入口（轉發 + CORS）。
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
  } as unknown as Env;
  return { env, seen };
}

describe("M01-US-101 worker 入口（轉發與 CORS）", () => {
  it("M01-Given 未帶路徑 When GET / Then 回服務說明與路由清單", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://w.test/"), env);
    const body = (await response.json()) as { service: string; routes: string[] };
    expect(response.status).toBe(200);
    expect(body.service).toBe("tree-factory-worker");
    expect(body.routes).toContain("POST /m/:meetingId/session/start");
  });

  it("M01-Given 裝置端打 session 路徑 When 轉進 DO Then 路徑與會議 id 都正確", async () => {
    const { env, seen } = makeEnv();
    await worker.fetch(
      new Request("https://w.test/m/abc/session/start", { method: "POST", body: "{}" }),
      env,
    );
    expect(seen).toEqual([{ path: "/session/start", search: "", meetingId: "abc" }]);
  });

  it("M01-Given 沒帶子路徑 When 轉進 DO Then 預設走 /health（與 TECH-004 一致）", async () => {
    const { env, seen } = makeEnv();
    await worker.fetch(new Request("https://w.test/m/abc"), env);
    expect(seen[0]?.path).toBe("/health");
  });

  it("M01-Given 有 query When 轉進 DO Then query 不得被吃掉（?ms= 的舊坑）", async () => {
    const { env, seen } = makeEnv();
    await worker.fetch(new Request("https://w.test/m/abc/wake?ms=1500"), env);
    expect(seen[0]).toEqual({ path: "/wake", search: "?ms=1500", meetingId: "abc" });
  });

  it("M01-Given 允許來源 When 回應 Then 帶 CORS 標頭（app 才打得動）", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://w.test/m/abc/session", {
        headers: { origin: "http://localhost:1420" },
      }),
      env,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  it("M01-Given 清單外來源 When 回應 Then 不帶 CORS 標頭（但請求本身照常處理）", async () => {
    const { env, seen } = makeEnv();
    const response = await worker.fetch(
      new Request("https://w.test/m/abc/session", { headers: { origin: "https://evil.example" } }),
      env,
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toHaveLength(1);
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
      new Request("https://w.test/m/abc/session", {
        headers: { origin: "https://app.treefactory.dev" },
      }),
      env,
    );
    const devOrigin = await worker.fetch(
      new Request("https://w.test/m/abc/session", { headers: { origin: "http://localhost:1420" } }),
      env,
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.treefactory.dev");
    expect(devOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });
});
