// TECH-006：webview 端探針的純函式部分（TDD 先紅後綠）。
//
// 為什麼要拆出純函式：探針本身是「打一次真請求」，不可能在單元測試裡跑
// （那需要真 webview）；但「把結果說清楚」與「什麼情況多打一個請求」是純邏輯。
//
// ⚠️ Gate 4 第 1 輪 P1 的教訓：**不要**在測試裡用合成的 `Response` 假裝讀得到
// `access-control-allow-origin`——那正是第一版自我感覺良好的來源。
// 瀏覽器不會 expose CORS 內部標頭，所以真的 webview 一定讀不到；測試要對齊這件事。

import { describe, expect, it } from "vitest";

import { corsProbeEnabled, formatProbeReport, probeIfEnabled, runCorsProbe, type CorsProbeResult } from "./cors-probe";

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

/** 刻意**不帶** CORS 標頭：真 webview 看到的 Response 就是這樣。 */
const ok201 = () => new Response('{"phase":"recording"}', { status: 201 });

describe("TECH-006 webview 探針的純函式", () => {
  it("TECH006-Given 成功結果 When 格式化 Then 含 origin / status / 讀到與否三件事", () => {
    const result: CorsProbeResult = { origin: "tauri://localhost", status: 201, error: null, stopped: true };
    const text = formatProbeReport(result);
    expect(text).toContain("tauri://localhost");
    expect(text).toContain("201");
    expect(text).toContain("能回呼 stop");
  });

  it("TECH006-Given 成功結果 When 格式化 Then 明說「ACAO 讀不到，去看 worker log」（不得留白讓人誤讀）", () => {
    const text = formatProbeReport({ origin: "tauri://localhost", status: 201, error: null, stopped: true });
    expect(text).toContain("JS 讀不到");
    expect(text).toContain("worker log");
    expect(text).toContain("拿得到 status 就代表 CORS 已通過");
  });

  it("TECH006-Given 請求被 CORS 擋住 When 格式化 Then 明說「webview 沒拿到回應」並附錯誤訊息", () => {
    const text = formatProbeReport({
      origin: "tauri://localhost",
      status: null,
      error: "TypeError: Failed to fetch",
      stopped: null,
    });
    expect(text).toContain("TypeError: Failed to fetch");
    expect(text).toContain("沒拿到回應");
    expect(text).not.toContain("拿得到 status");
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
  it("TECH006-Given start 回 201 When 探針結束 Then 回呼一次 stop（reason=aborted、2xx）", async () => {
    const { calls, impl } = fakeFetch(() => ok201());
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/session/start");
    expect(calls[1]).toContain("/session/stop");
    expect(result.stopped).toBe(true);
    expect(result.status).toBe(201);
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

  it("TECH006-Given stop 回 500 When 探針結束 Then **不得**報成成功（Gate 4 P2 修正）", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n += 1;
      return n === 1 ? ok201() : new Response("{}", { status: 500 });
    });
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(result.status).toBe(201);
    expect(result.stopped).toBe(false);
  });

  it("TECH006-Given stop 自己丟例外 When 探針結束 Then 不丟例外、如實記 stopped=false", async () => {
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

  it("TECH006-Given 環境沒有 crypto.randomUUID When 探針執行 Then 不丟例外、仍完成（AC-2：不得影響 UI）", async () => {
    const original = globalThis.crypto;
    // 模擬舊 WKWebView：randomUUID 不存在
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: undefined },
      configurable: true,
    });
    try {
      const { calls, impl } = fakeFetch(() => ok201());
      const result = await runCorsProbe("http://127.0.0.1:8787", impl);
      expect(result.status).toBe(201);
      expect(calls[0]).toMatch(/\/m\/probe-[a-z0-9-]+\/session\/start/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });

  it("TECH006-Given 探針內部壞掉 When 走 probeIfEnabled Then 不 reject，回一份可讀字串", async () => {
    // 唯一要求是「不得把例外往上丟」（AC-2）；錯誤本身要寫進報告。
    const exploded = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const report = await probeIfEnabled("1", "http://127.0.0.1:8787", exploded);
    expect(report).toContain("boom");
  });

  it("TECH-009：帶 token → start 與 stop 都帶 Authorization（探針不能被自己的認證擋掉）", async () => {
    const seen: (string | null)[] = [];
    const { calls, impl } = fakeFetch((_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return ok201();
    });
    const result = await runCorsProbe("http://127.0.0.1:8787", impl, "tok-9");
    expect(calls).toHaveLength(2);
    expect(seen).toEqual(["Bearer tok-9", "Bearer tok-9"]);
    expect(result.credential).toBe(true);
    expect(formatProbeReport(result)).toContain("有帶");
  });

  it("TECH-009：沒 token → 不帶 Authorization，且報告明說「401 是預期結果，不是 CORS 問題」", async () => {
    const seen: (string | null)[] = [];
    const { impl } = fakeFetch((_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return ok201();
    });
    const result = await runCorsProbe("http://127.0.0.1:8787", impl);
    expect(seen[0]).toBeNull();
    expect(result.credential).toBe(false);
    expect(formatProbeReport(result)).toContain("不是 CORS 問題");
  });

  it("TECH006-Given 旗標未設 When 走 probeIfEnabled Then 完全不動作（連 fetch 都不呼叫）", async () => {
    const { calls, impl } = fakeFetch(() => ok201());
    expect(await probeIfEnabled(undefined, "http://127.0.0.1:8787", impl)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("TECH006-Given 有回呼結果 When 格式化 Then 把「讀到 / 沒讀到」寫清楚", () => {
    const base: CorsProbeResult = {
      origin: "tauri://localhost",
      status: 201,
      error: null,
      stopped: true,
    };
    expect(formatProbeReport(base)).toContain("是");
    expect(formatProbeReport({ ...base, stopped: false })).toContain("否");
    expect(formatProbeReport({ ...base, stopped: null })).toContain("n/a");
  });
});
