// TECH-009：入口層的邊緣授權（順序、狀態碼、有沒有進 DO）。
//
// 這一檔才是本票的**產品行為**：`index.ts` 是唯一決定「誰可以打進來」的地方。
// 假的 MEETING namespace 讓 `seen` 變成「請求有沒有真的碰到 DO」的證據——
// 這一票的重點正是「被擋的來源不只讀不到，連副作用都不該發生」。

import { describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/index.js";

interface Seen {
  path: string;
  method: string;
}

interface Harness {
  env: Env;
  seen: Seen[];
}

const TOKEN = "dev-token-123";

function makeEnv(vars: Partial<Record<"ALLOWED_ORIGINS" | "DEVICE_TOKEN" | "RATE_LIMIT_MAX" | "RATE_LIMIT_WINDOW_MS", string>> = {}): Harness {
  const seen: Seen[] = [];
  const env = {
    MEETING: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          seen.push({ path: url.pathname, method: request.method });
          return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
    ...vars,
  } as unknown as Env;
  return { env, seen };
}

/** 每一次呼叫都用**不同**的 IP，避免同一顆 limiter 的狀態在測試之間互相污染。 */
let ipSeq = 0;
function call(
  env: Env,
  path: string,
  init: { method?: string; token?: string | null; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": `10.0.0.${(ipSeq += 1)}` };
  if (init.token !== null && init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  if (init.origin !== null && init.origin !== undefined) headers.origin = init.origin;
  return worker.fetch(
    new Request(`https://w.test${path}`, { method: init.method ?? "GET", headers }),
    env,
  );
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("TECH-009 AC-1：未設定 DEVICE_TOKEN → 失效即關", () => {
  it("TECH-009 AC-1：任何 /m/ 底下的請求 → 500 AUTH_NOT_CONFIGURED（recoverable:false）且不進 DO", async () => {
    const { env, seen } = makeEnv();
    for (const path of ["/m/abc/health", "/m/abc/session", "/m/abc/transcript/segments"]) {
      const response = await call(env, path);
      expect(response.status, path).toBe(500);
      expect(await body(response)).toMatchObject({ error: "AUTH_NOT_CONFIGURED", recoverable: false });
    }
    expect(seen).toHaveLength(0);
  });

  it("TECH-009 AC-1：`GET /`（服務說明）與 `OPTIONS`（preflight）仍然公開——不帶憑證也看得到", async () => {
    const { env } = makeEnv();
    const help = await call(env, "/");
    expect(help.status).toBe(200);
    expect((await body(help)).service).toBe("tree-factory-worker");
    const preflight = await call(env, "/m/abc/session/start", { method: "OPTIONS", token: null });
    expect(preflight.status).toBe(204);
  });

  it("TECH-009 AC-1：就算對方送了憑證，沒設定的伺服器也不放行（不得把「沒設定」當成「不用檢查」）", async () => {
    const { env, seen } = makeEnv({ DEVICE_TOKEN: "" });
    expect((await call(env, "/m/abc/health", { token: TOKEN })).status).toBe(500);
    expect(seen).toHaveLength(0);
  });
});

describe("TECH-009 AC-2：憑證關", () => {
  it("TECH-009 AC-2：正確憑證 → 轉進 DO（方法與路徑原樣）", async () => {
    const { env, seen } = makeEnv({ DEVICE_TOKEN: TOKEN });
    const response = await call(env, "/m/abc/session/start", { method: "POST", token: TOKEN });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ path: "/session/start", method: "POST" }]);
  });

  it("TECH-009 AC-2：沒帶／錯值／非 Bearer → 401 AUTH_INVALID（recoverable:false）且不進 DO", async () => {
    const { env, seen } = makeEnv({ DEVICE_TOKEN: TOKEN });
    expect((await call(env, "/m/abc/health")).status).toBe(401);
    expect((await call(env, "/m/abc/health", { token: "wrong" })).status).toBe(401);
    expect((await call(env, "/m/abc/health", { token: "" })).status).toBe(401);
    const payload = await body(await call(env, "/m/abc/health", { token: "wrong" }));
    expect(payload).toMatchObject({ error: "AUTH_INVALID", recoverable: false });
    expect(String(payload.message)).toContain("裝置");
    expect(seen).toHaveLength(0);
  });

  it("TECH-009 AC-2：401 的回應不得洩漏「差幾個字元」（訊息裡沒有正確憑證的任何片段）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN });
    const payload = await body(await call(env, "/m/abc/health", { token: "dev-token-12" }));
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(JSON.stringify(payload)).not.toContain("dev-token");
  });
});

describe("TECH-009 AC-3：來源關（Origin）", () => {
  it("TECH-009 AC-3：白名單外的 Origin（帶正確憑證）→ 403 ORIGIN_FORBIDDEN 且不進 DO", async () => {
    const { env, seen } = makeEnv({ DEVICE_TOKEN: TOKEN });
    const response = await call(env, "/m/abc/session/start", {
      method: "POST",
      token: TOKEN,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ error: "ORIGIN_FORBIDDEN" });
    expect(seen).toHaveLength(0);
  });

  it("TECH-009 AC-3：順序是「先 Origin 後憑證」——憑證錯＋來源錯時仍然是 403（不用 401 當探測管道）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN });
    const response = await call(env, "/m/abc/health", { token: "wrong", origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("TECH-009 AC-3：沒有 Origin（curl／原生／腳本）→ 放行到憑證關，不是被 403 擋掉", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN });
    expect((await call(env, "/m/abc/health", { token: TOKEN, origin: null })).status).toBe(200);
  });

  it("TECH-009 AC-3：白名單內的 Origin → 放行（含 ALLOWED_ORIGINS 覆寫）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN, ALLOWED_ORIGINS: "https://app.example" });
    expect(
      (await call(env, "/m/abc/health", { token: TOKEN, origin: "https://app.example" })).status,
    ).toBe(200);
  });

  it("TECH-009 AC-3：被擋的 preflight 仍然 204（瀏覽器自己會擋；真正的那個請求根本不會送出去）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN });
    const response = await call(env, "/m/abc/session/start", {
      method: "OPTIONS",
      token: null,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("TECH-009 AC-4：速率限制關（入口層）", () => {
  it("TECH-009 AC-4：超過上限 → 429 RATE_LIMITED + Retry-After + recoverable:true 且不進 DO", async () => {
    const { env, seen } = makeEnv({ DEVICE_TOKEN: TOKEN, RATE_LIMIT_MAX: "2" });
    const headers = { authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": "10.9.9.9" };
    const send = (): Promise<Response> =>
      worker.fetch(new Request("https://w.test/m/abc/health", { headers }), env);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await body(blocked)).toMatchObject({
      error: "RATE_LIMITED",
      recoverable: true,
      limit: 2,
      windowMs: 60_000,
    });
    expect(seen).toHaveLength(2);
  });

  it("TECH-009 AC-4：Retry-After 是「這個窗還剩多久」，不是固定窗長（否則客戶端會等過頭）", async () => {
    // 為什麼要假時鐘：兩者只有在「窗已經走掉一部分」時才不同，
    // 而固定的窗長（60）與「剩 6 秒」在窗起點那一刻長得一模一樣——
    // 沒有假時鐘就驗不出這個差別（突變測試抓到的一條存活突變）。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      const { env } = makeEnv({
        DEVICE_TOKEN: TOKEN,
        RATE_LIMIT_MAX: "1",
        RATE_LIMIT_WINDOW_MS: "10000",
      });
      const headers = { authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": "10.8.8.8" };
      const send = (): Promise<Response> =>
        worker.fetch(new Request("https://w.test/m/abc/health", { headers }), env);
      expect((await send()).status).toBe(200);
      vi.setSystemTime(new Date(1_000_000 + 4_000));
      const blocked = await send();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("6");
      expect(await body(blocked)).toMatchObject({ retryAfterMs: 6_000, windowMs: 10_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("TECH-009 AC-4：不同 IP 各自一個桶（同一顆 token 從不同來源不會互相擠）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN, RATE_LIMIT_MAX: "1" });
    const send = (ip: string): Promise<Response> =>
      worker.fetch(
        new Request("https://w.test/m/abc/health", {
          headers: { authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": ip },
        }),
        env,
      );
    expect((await send("10.1.1.1")).status).toBe(200);
    expect((await send("10.1.1.1")).status).toBe(429);
    expect((await send("10.2.2.2")).status).toBe(200);
  });

  it("TECH-009 AC-4：被擋的憑證不消耗桶（未通過認證的洪水不得喝光合法裝置的額度）", async () => {
    const { env } = makeEnv({ DEVICE_TOKEN: TOKEN, RATE_LIMIT_MAX: "1" });
    const headers = { authorization: "Bearer wrong", "cf-connecting-ip": "10.5.5.5" };
    for (let i = 0; i < 5; i += 1) {
      const r = await worker.fetch(new Request("https://w.test/m/abc/health", { headers }), env);
      expect(r.status).toBe(401);
    }
    const ok = await worker.fetch(
      new Request("https://w.test/m/abc/health", {
        headers: { authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": "10.5.5.5" },
      }),
      env,
    );
    expect(ok.status).toBe(200);
  });
});
