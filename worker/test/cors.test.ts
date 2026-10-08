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
