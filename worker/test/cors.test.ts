// M01-US-101：跨來源（app webview / 瀏覽器 → worker）的最小 CORS 支援。
//
// 為什麼是 M01 的範圍而不是「以後再說」：沒有這段，app 的 UI 根本打不到 worker，
// 使用者按「開始」只會拿到 undefined（瀏覽器擋掉），而畫面會顯示一個含糊的錯誤。
//
// 安全立場：**不用 `*`**。允許清單明列（dev 用 localhost/tauri 來源；正式用 ALLOWED_ORIGINS）。

import { describe, expect, it } from "vitest";

import {
  DEV_ORIGINS,
  allowedOrigins,
  corsDebugLine,
  corsHeaders,
  preflightResponse,
  withCors,
} from "../src/cors.js";

describe("M01-US-101 worker CORS", () => {
  it("M01-Given 未設定 ALLOWED_ORIGINS When 取清單 Then 只給 dev 來源（正式部署必須自己設定）", () => {
    expect(allowedOrigins(undefined)).toEqual(DEV_ORIGINS);
  });

  it("M01-Given 有設定 ALLOWED_ORIGINS When 取清單 Then 以設定為準（覆蓋 dev 預設，不聯集）", () => {
    expect(allowedOrigins("https://app.treefactory.dev, tauri://localhost ")).toEqual([
      "https://app.treefactory.dev",
      "tauri://localhost",
    ]);
  });

  it("M01-Given 在允許清單內的來源 When 取標頭 Then 回該來源且 GET/POST/OPTIONS 可用", () => {
    const headers = corsHeaders("http://localhost:1420", undefined);
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:1420");
    expect(headers["access-control-allow-methods"]).toContain("POST");
    expect(headers["vary"]?.toLowerCase()).toBe("origin");
  });

  it("M01-Given 清單外的來源 When 取標頭 Then 什麼都不給（不得退化成 `*`）", () => {
    expect(corsHeaders("https://evil.example", undefined)).toEqual({});
  });

  it("M01-Given 沒有 Origin（原生呼叫／同源）When 取標頭 Then 不加 CORS 標頭", () => {
    expect(corsHeaders(null, undefined)).toEqual({});
  });

  it("M01-Given preflight When 回應 Then 204 且帶允許標頭（不得回 404 讓瀏覽器放棄）", () => {
    const response = preflightResponse("http://localhost:1420", undefined);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-meeting-id");
  });

  it("M01-Given 清單外來源的 preflight When 回應 Then 仍然 204 但沒有允許標頭（瀏覽器自己會擋）", () => {
    const response = preflightResponse("https://evil.example", undefined);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("M01-Given 已有的回應 When 加上 CORS Then 保留 status/body 且標頭合併", async () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    const wrapped = withCors(original, "http://localhost:1420", undefined);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get("content-type")).toBe("application/json");
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    expect(await wrapped.text()).toBe('{"ok":true}');
  });
});

// TECH-006：把「webview 看到的 Origin 到底是什麼」變成可重複的觀測，
describe("TECH-006 worker CORS 觀測（DEBUG_ORIGINS）", () => {
  it("TECH006-Given 開了旗標 When 來源在清單內 Then 一行 allowed=true 且帶出實值", () => {
    const line = corsDebugLine(
      "tauri://localhost",
      undefined,
      "1",
      "POST",
      "/m/abc/session/start",
    );
    expect(line).toContain('origin="tauri://localhost"');
    expect(line).toContain("allowed=true");
    expect(line).toContain("method=POST");
    expect(line).toContain('path="/m/abc/session/start"');
  });

  it("TECH006-Given 開了旗標 When preflight When 觀測 Then 分得出是 OPTIONS（CORS 卡住時最常見的現場）", () => {
    const line = corsDebugLine(
      "tauri://localhost",
      undefined,
      "1",
      "OPTIONS",
      "/m/abc/session/start",
    );
    expect(line).toContain("method=OPTIONS");
  });

  it("TECH006-Given 開了旗標 When 來源在清單外 Then allowed=false（不得寫成「沒看到」）", () => {
    const line = corsDebugLine("https://evil.example", undefined, "1", "GET", "/m/abc/session");
    expect(line).toContain('origin="https://evil.example"');
    expect(line).toContain("allowed=false");
  });

  it("TECH006-Given 沒有 Origin 標頭 When 開了旗標 Then 仍然輸出一行且標為 (none)", () => {
    const line = corsDebugLine(null, undefined, "1", "GET", "/m/abc/health");
    expect(line).toContain('origin="(none)"');
    expect(line).toContain("allowed=false");
  });

  it("TECH006-Given 旗標未設或不是 '1' When 呼叫 Then 完全不輸出（正式環境不刷 log）", () => {
    for (const flag of [undefined, "", "0", "false", "TRUE", " 1", "yes"]) {
      expect(corsDebugLine("tauri://localhost", undefined, flag, "POST", "/m/abc/session")).toBeNull();
    }
  });

  it("TECH006-Given ALLOWED_ORIGINS 覆寫 When 觀測 Then 以覆寫後清單判斷（不是聯集）", () => {
    expect(
      corsDebugLine("tauri://localhost", "https://app.example", "1", "POST", "/x"),
    ).toContain("allowed=false");
    expect(
      corsDebugLine("https://app.example", "https://app.example", "1", "POST", "/x"),
    ).toContain("allowed=true");
  });
});

// TECH-010：dev 模式「來源埠漂移」的診斷。
//
// 症狀：前端換了埠（例如 dev server 從 1420 漂到 1421）→ 白名單沒中 → 瀏覽器把回應
// 整包擋掉，前端只看到 `Failed to fetch`，**與「正式環境被擋」完全同症狀**，
// 開發者分不出「請求根本沒送到」與「送到了但白名單沒中」。
// 因此把「這次的 Origin 是什麼、白名單有沒有中」放到**回應標頭**上：
// 被 CORS 擋掉時 body 讀不到，但 DevTools 的 response headers 看得到。
//
// 安全立場：只在 `DEBUG_ORIGINS=1` 時出現，且**不含任何白名單內容**（不洩漏設定）。

import worker, { type Env } from "../src/index.js";
import { corsDiagnosticHeaders, safeHeaderOrigin, withDiagnostics } from "../src/cors.js";

function entryEnv(allowed?: string, debug?: string): Env {
  const env = {
    MEETING: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      }),
    },
    ...(allowed === undefined ? {} : { ALLOWED_ORIGINS: allowed }),
    ...(debug === undefined ? {} : { DEBUG_ORIGINS: debug }),
  } as unknown as Env;
  return env;
}

describe("M01-TECH-010 埠漂移的診斷標頭", () => {
  it("M01-TECH-010-Given 未開旗標 When 取診斷標頭 Then 一個都不加（正式環境零足跡）", () => {
    expect(corsDiagnosticHeaders("tauri://localhost", undefined, undefined)).toEqual({});
    expect(corsDiagnosticHeaders("https://evil.example", undefined, "0")).toEqual({});
  });

  it("M01-TECH-010-Given 開了旗標且白名單命中 When 取診斷標頭 Then 回報 true 並回顯來源", () => {
    expect(corsDiagnosticHeaders("tauri://localhost", undefined, "1")).toEqual({
      "x-cors-origin": "tauri://localhost",
      "x-cors-allowed": "true",
    });
  });

  it("M01-TECH-010-Given 開了旗標但白名單沒中 When 取診斷標頭 Then 回報 false 並回顯來源（這就是漂移的現場）", () => {
    expect(corsDiagnosticHeaders("http://localhost:1421", undefined, "1")).toEqual({
      "x-cors-origin": "http://localhost:1421",
      "x-cors-allowed": "false",
    });
  });

  it("M01-TECH-010-Given Origin 夾帶垂直 tab When 取診斷標頭 Then 回 (invalid)（不讓對手控制字元進回應標頭）", () => {
    // Gate 4 oracle 用 raw socket 證實：workerd 會擋 CR/LF 與 NUL，但 VT（0x0B）會原樣寫進標頭。
    expect(safeHeaderOrigin("http://evil.test\u000bEVIL")).toBe("(invalid)");
    expect(corsDiagnosticHeaders("http://evil.test\u000bEVIL", undefined, "1")).toEqual({
      "x-cors-origin": "(invalid)",
      "x-cors-allowed": "false",
    });
    // 白名單比對用的是**原始** Origin，不是淨化後的字串（否則會因為淨化而意外放行）。
    expect(corsDiagnosticHeaders("http://evil.test\u000bEVIL", "http://evil.test", "1")["x-cors-allowed"]).toBe("false");
  });

  it("M01-TECH-010-Given 正常 Origin When 淨化 Then 原樣通過（白名單機制不能被淨化影響）", () => {
    expect(safeHeaderOrigin("http://localhost:1421")).toBe("http://localhost:1421");
    expect(safeHeaderOrigin(null)).toBe("(none)");
  });

  it("M01-TECH-010-Given 旗標是別的字串 When 取診斷標頭 Then 仍然回空（判斷不寬鬆：只有 \"1\" 才算開）", () => {
    expect(corsDiagnosticHeaders("tauri://localhost", undefined, "true")).toEqual({});
    expect(corsDiagnosticHeaders("tauri://localhost", undefined, "1 ")).toEqual({});
  });

  it("M01-TECH-010-Given 診斷標頭非空 When 併入回應 Then 帶上 Vary: origin（避免共享快取把 A 的來源回給 B）", async () => {
    const base = new Response(null, { status: 204 });
    const merged = withDiagnostics(base, { "x-cors-allowed": "false" });
    expect(merged.headers.get("vary")).toBe("origin");
  });

  it("M01-TECH-010-Given 回應本來就有 Vary When 併入診斷標頭 Then 不重複加 origin", async () => {
    const base = new Response(null, { status: 204, headers: { vary: "origin" } });
    expect(withDiagnostics(base, { "x-cors-allowed": "false" }).headers.get("vary")).toBe("origin");
    const other = new Response(null, { status: 204, headers: { vary: "accept-encoding" } });
    expect(withDiagnostics(other, { "x-cors-allowed": "false" }).headers.get("vary")).toBe(
      "accept-encoding, origin",
    );
  });

  it("M01-TECH-010-Given 開了旗標但沒有 Origin When 取診斷標頭 Then 標明 (none)（非瀏覽器來的請求）", () => {
    expect(corsDiagnosticHeaders(null, undefined, "1")).toEqual({
      "x-cors-origin": "(none)",
      "x-cors-allowed": "false",
    });
  });

  it("M01-TECH-010-Given 診斷標頭 When 併入回應 Then 不改 status/body、既有標頭保留", async () => {
    const base = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    const merged = withDiagnostics(base, { "x-cors-allowed": "false" });
    expect(merged.status).toBe(201);
    expect(merged.headers.get("content-type")).toBe("application/json");
    expect(merged.headers.get("x-cors-allowed")).toBe("false");
    expect(await merged.json()).toEqual({ ok: true });
  });

  it("M01-TECH-010-Given 沒有診斷標頭 When 併入回應 Then 原樣回傳", () => {
    const base = new Response(null, { status: 204 });
    expect(withDiagnostics(base, {})).toBe(base);
  });

  it("M01-TECH-010-Given 漂移來源的 preflight When 開旗標 Then 204 沒有允許標頭但有 allowed=false", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:1421" },
      }),
      entryEnv(undefined, "1"),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-cors-origin")).toBe("http://localhost:1421");
    expect(response.headers.get("x-cors-allowed")).toBe("false");
  });

  it("M01-TECH-010-Given 漂移來源的 POST When 開旗標 Then 診斷標頭與回應一起回來（body 看不到，標頭看得到）", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session/start", {
        method: "POST",
        headers: { origin: "http://localhost:1421", "x-meeting-id": "m1" },
      }),
      entryEnv(undefined, "1"),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-cors-allowed")).toBe("false");
  });

  it("M01-TECH-010-Given 名單內的來源 When 開旗標 Then 允許標頭與 allowed=true 同時在（正向對照）", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session/start", {
        method: "POST",
        headers: { origin: "tauri://localhost", "x-meeting-id": "m1" },
      }),
      entryEnv(undefined, "1"),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(response.headers.get("x-cors-allowed")).toBe("true");
  });

  it("M01-TECH-010-Given 未開旗標 When 打漂移來源 Then 完全沒有診斷標頭（預設零足跡）", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:1421" },
      }),
      entryEnv(),
    );
    expect(response.headers.get("x-cors-origin")).toBeNull();
    expect(response.headers.get("x-cors-allowed")).toBeNull();
  });

  it("M01-TECH-010-Given 白名單命中的 preflight When 開旗標 Then allowed=true 與 allow-origin 並存（正向對照的 OPTIONS 版）", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:1420" },
      }),
      entryEnv(undefined, "1"),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    expect(response.headers.get("x-cors-allowed")).toBe("true");
  });

  it("M01-TECH-010-Given 未開旗標的 DO 轉發路徑 When 打白名單來源 Then 連 x-cors-origin 都沒有", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/m/m1/session/start", {
        method: "POST",
        headers: { origin: "tauri://localhost", "x-meeting-id": "m1" },
      }),
      entryEnv(),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(response.headers.get("x-cors-origin")).toBeNull();
    expect(response.headers.get("x-cors-allowed")).toBeNull();
  });

  it("M01-TECH-010-Given 未帶路徑的首頁 When 開旗標 Then 診斷標頭也在（連路由清單都看得到現場）", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/", { headers: { origin: "http://localhost:1421" } }),
      entryEnv(undefined, "1"),
    );
    expect(response.headers.get("x-cors-allowed")).toBe("false");
    expect(response.status).toBe(200);
  });
});
