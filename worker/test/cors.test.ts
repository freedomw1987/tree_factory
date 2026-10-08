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
