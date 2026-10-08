// TECH-006：webview 端探針的純函式部分（TDD 先紅後綠）。
//
// 為什麼要拆出純函式：探針本身是「打一次真請求」，不可能在單元測試裡跑
// （那需要真 webview）；但「把結果說清楚」是純字串處理，可以完整測試。
// 而且排版錯了會讓唯一一次的實測證據讀不出來，所以它值得被測試。

import { describe, expect, it } from "vitest";

import { corsProbeEnabled, formatProbeReport, runCorsProbe, type CorsProbeResult } from "./cors-probe";

/** 一個只記事、不真的上網的 fetch：用來確定「什麼情況會多打一個請求」。 */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, impl };
}

const ok201 = () =>
  new Response("{\"phase\":\"recording\"}", {
    status: 201,
    headers: {
      "access-control-allow-origin": "tauri://localhost",
      "access-control-allow-headers": "content-type",
    },
  });

describe("TECH-006 webview 探針的純函式", () => {
  it("TECH006-Given 成功結果 When 格式化 Then 含 origin / status / ACAO 三件事", () => {
    const result: CorsProbeResult = {
      origin: "tauri://localhost",
      status: 201,
      allowOrigin: "tauri://localhost",
      allowHeaders: "content-type,x-meeting-id",
      error: null,
      stopped: true,
    };
    const text = formatProbeReport(result);
    expect(text).toContain("tauri://localhost");
    expect(text).toContain("201");
    expect(text).toContain("access-control-allow-origin");
  });

  it("TECH006-Given ACAO 缺席 When 格式化 Then 明說「沒有」而不是留空（這是被擋的關鍵線索）", () => {
    const text = formatProbeReport({
      origin: "tauri://localhost",
      status: 201,
      allowOrigin: null,
      allowHeaders: null,
      error: null,
      stopped: null,
    });
    expect(text).toContain("(無)");
  });

  it("TECH006-Given 請求被 CORS 擋住 When 格式化 Then 明說「webview 沒拿到回應」並附錯誤訊息", () => {
    const text = formatProbeReport({
      origin: "tauri://localhost",
      status: null,
      allowOrigin: null,
      allowHeaders: null,
      error: "TypeError: Failed to fetch",
      stopped: null,
    });
    expect(text).toContain("TypeError: Failed to fetch");
    expect(text).toContain("沒拿到回應");
  });

  it("TECH006-Given 旗標未設或不是 '1' When 檢查 Then 探針不啟用", () => {
    expect(corsProbeEnabled(undefined)).toBe(false);
    expect(corsProbeEnabled("0")).toBe(false);
    expect(corsProbeEnabled("true")).toBe(false);
    expect(corsProbeEnabled("")).toBe(false);
  });

  it("TECH006-Given 旗標為 '1' When 檢查 Then 啟用（**不看** DEV：打包後的 webview 才是要驗的那一個）", () => {
    // 為什麼拔掉 DEV 條款：實測發現 `tauri dev` 的 webview 來源是 devUrl 的 http 來源，
    // `tauri://localhost` 只會在**打包後**的 app 出現。若把探針限定在 DEV，
    // 就永遠驗不到真正上線的那個來源（等於這張票做不到）。
    expect(corsProbeEnabled("1")).toBe(true);
  });
});

// 「webview 真的讀到了回應」這件事，靠截圖不好自動化、也不可靠。
// 改成一個只有讀到 201 才會發生的**副作用**：回呼 stop 把探針建的會議收掉。
// 好處是證據與清理同一件事：log 上看到 stop，就證明前面那個 201 真的被讀到了。
describe("TECH-006 探針的「真的讀到」證明（回呼 stop）", () => {
  it("TECH006-Given start 回 201 When 探針結束 Then 回呼一次 stop（reason=aborted）", async () => {
    const { calls, impl } = fakeFetch(() => ok201());
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/session/start");
    expect(calls[1]).toContain("/session/stop");
    expect(result.stopped).toBe(true);
  });

  it("TECH006-Given start 被 CORS 擋住（fetch 丟例外）When 探針結束 Then **不**回呼 stop", async () => {
    const { calls, impl } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(calls).toHaveLength(1);
    expect(result.stopped).toBeNull();
    expect(result.error).toBe("TypeError: Failed to fetch");
  });

  it("TECH006-Given start 回非 201 When 探針結束 Then 不硬發 stop（沒開成的會議沒得收）", async () => {
    const { calls, impl } = fakeFetch(() => new Response("{}", { status: 403 }));
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(calls).toHaveLength(1);
    expect(result.stopped).toBeNull();
  });

  it("TECH006-Given 回呼 stop 自己失敗 When 探針結束 Then 不丟例外、如實記 stopped=false", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n += 1;
      if (n === 1) return ok201();
      throw new TypeError("Failed to fetch");
    });
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(result.status).toBe(201);
    expect(result.stopped).toBe(false);
  });

  it("TECH006-Given 有回呼結果 When 格式化 Then 把「讀到 / 沒讀到」寫清楚", () => {
    const base: CorsProbeResult = {
      origin: "tauri://localhost",
      status: 201,
      allowOrigin: "tauri://localhost",
      allowHeaders: "content-type",
      error: null,
      stopped: true,
    };
    expect(formatProbeReport(base)).toContain("是");
    expect(formatProbeReport({ ...base, stopped: false })).toContain("否");
    expect(formatProbeReport({ ...base, stopped: null })).toContain("n/a");
  });
});
