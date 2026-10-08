/**
 * TECH-006：在**真實 webview 內**對 worker 打一次核心會話請求，並把結果說清楚。
 *
 * 為什麼需要在 app 裡放探針，而不是用 curl：curl 不可能「假裝自己是 Tauri webview」。
 * 這張票要驗的正是「webview 送出的 Origin 到底是什麼、我們的白名單有沒有命中」——
 * 只有真的跑在 webview 裡的程式能回答。
 *
 * 為什麼是 dev-only：探針會在 worker 上真的開一場會議（真資料），
 * 且它顯示的是診斷訊息，不該出現在使用者面前。所以 gate 條件要求
 * `VITE_CORS_PROBE=1`，**而它刻意不看 `import.meta.env.DEV`**：
 * `tauri dev` 的 webview 來源是 devUrl（http），真正上線的 `tauri://localhost`
 * 只在打包後出現（見 `corsProbeEnabled` 註解）。
 */

export interface CorsProbeResult {
  /** webview 自己看到的來源（`location.origin`）。 */
  origin: string;
  /** HTTP 狀態碼；請求根本沒回來時為 null。 */
  status: number | null;
  /** 回應上的 `access-control-allow-origin`；缺席時 null（＝被瀏覽器擋的關鍵線索）。 */
  allowOrigin: string | null;
  /** 回應上的 `access-control-allow-headers`（preflight 有沒有放行自訂標頭）。 */
  allowHeaders: string | null;
  /** 請求在 webview 層就失敗時的訊息（例：CORS 被擋的 `TypeError: Failed to fetch`）。 */
  error: string | null;
  /**
   * 探針讀到 201 之後有没有成功回呼 `stop`。
   *
   * 為什麼這個欄位就是「webview 真的讀到回應」的證明：回呼只會在 `status === 201`）
   * 的分支裡發生，而 CORS 被擋時 `fetch` 直接丟例外——所以 log 上出現 stop，
   * 就代表那個 201 **真的被 webview 讀到了**（不只是伺服器有回）。
   * `null` ＝ 根本沒走到這一步（start 失敗或非 201）。
   */
  stopped: boolean | null;
}

/**
 * 探針是否啟用。
 *
 * @param flag `import.meta.env.VITE_CORS_PROBE`
 *
 * ⚠️ **刻意不看** `import.meta.env.DEV`（TECH-006 實測後修正）：
 * `tauri dev` 的 webview 載入的是 `devUrl`（http），來源是 `http://localhost:<vite 埠>`；
 * 而正式上線的那一個來源（`tauri://localhost`）**只會在打包後的 app 出現**。
 * 若把探針限定在 DEV，就永遠驗不到真正要驗的對象。
 *
 * 安全上仍然安全：旗標是 **build-time** 變數（vite 會內聯），未設就整段是死碼；
 * 而且它只影響「顯示一訊息」與「打一次真的 /session/start」，不開放任何新入口。
 */
export function corsProbeEnabled(flag: string | undefined): boolean {
  return flag === "1";
}

/** 把探針結果排成人看得懂的一段文字（這是一次性證據，必須好讀）。 */
export function formatProbeReport(result: CorsProbeResult): string {
  const lines = [
    `webview origin：${result.origin}`,
    `HTTP status：${result.status === null ? "(無回應)" : String(result.status)}`,
    `access-control-allow-origin：${result.allowOrigin ?? "(無)"}`,
    `access-control-allow-headers：${result.allowHeaders ?? "(無)"}`,
  ];
  if (result.error !== null) {
    lines.push(`webview 沒拿到回應：${result.error}`);
  }
  const readFine =
    result.stopped === true ? "是" : result.stopped === false ? "否（stop 自己也失敗）" : "n/a";
  lines.push(`webview 真的讀到回應（能回呼 stop）：${readFine}`);
  return lines.join("\n");
}

/** 探針使用的裸請求：刻意**不**經過 `HttpSessionClient`，
 * 因為我們要看到原始的 status 與 ACAO 標頭，而不是被 client 先包成錯誤物件。 */
export async function runCorsProbe(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<CorsProbeResult> {
  const origin = globalThis.location?.origin ?? "(unknown)";
  const base = baseUrl.replace(/\/$/, "");
  const meetingId = globalThis.crypto.randomUUID();
  const url = (path: string) => `${base}/m/${encodeURIComponent(meetingId)}/${path}`;
  let status: number | null = null;
  let allowOrigin: string | null = null;
  let allowHeaders: string | null = null;
  try {
    const response = await fetchImpl(url("session/start"), {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    status = response.status;
    allowOrigin = response.headers.get("access-control-allow-origin");
    allowHeaders = response.headers.get("access-control-allow-headers");
  } catch (error) {
    return {
      origin,
      status: null,
      allowOrigin: null,
      allowHeaders: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stopped: null,
    };
  }
  // 只有「真的讀到 201」才會走到這裡 → 這筆 stop 就是讀取成功的機械證據。
  let stopped: boolean | null = null;
  if (status === 201) {
    try {
      await fetchImpl(url("session/stop"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "aborted" }),
      });
      stopped = true;
    } catch {
      // 探針自己的收尾失敗不得影響 app（也不得把 start 的成功蓋掉）。
      stopped = false;
    }
  }
  return { origin, status, allowOrigin, allowHeaders, error: null, stopped };
}

/** 給 `main.ts` 用的最小入口：啟用時打一次並回傳要顯示的文字。 */
export async function probeIfEnabled(
  flag: string | undefined,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (!corsProbeEnabled(flag)) return null;
  const result = await (fetchImpl === undefined
    ? runCorsProbe(baseUrl)
    : runCorsProbe(baseUrl, fetchImpl));
  return formatProbeReport(result);
}
