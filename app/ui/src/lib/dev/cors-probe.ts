/**
 * TECH-006：在**真實 webview 內**對 worker 打一次核心會話請求，並把結果說清楚。
 *
 * 為什麼需要在 app 裡放探針，而不是用 curl：curl 不可能「假裝自己是 Tauri webview」。
 * 這張票要驗的正是「webview 送出的 Origin 到底是什麼、我們的白名單有沒有命中」——
 * 只有真的跑在 webview 裡的程式能回答。
 *
 * ⚠️ **一個被實測推翻的直覺**（Gate 4 第 1 輪 P1）：`access-control-allow-origin`
 * 是 CORS 內部標頭，**瀏覽器不會把它 expose 給 JS**。所以 `response.headers.get(...)`
 * 在真 webview 一定回 `null`——就算伺服器明明送了。第一次實測時探針畫面就顯示
 * 「（無）」，極易被誤讀成「CORS 失敗」。
 * 因此本探針**不再讀那兩個標頭**；真正可靠的判準是：
 * ① `response.status` 讀得到 ⇒ CORS 已經通過（**限 `mode:"cors"`**；
 *    被擋時 `fetch` 會直接丟例外。`no-cors` 的 opaque response 不在此列，所以本探針顯式指定 mode）
 * ② worker log 的 `[cors] allowed=true` ⇒ 伺服器端的白名單判定。
 *
 * 為什麼是 build-time 旗標：探針會在 worker 上真的開一場會議（真資料），
 * 且它顯示的是診斷訊息，不該出現在使用者面前。旗標是 `VITE_CORS_PROBE=1`
 * （vite 會內聯，未設時 `main.ts` 的整段分支會被 tree-shake 掉；見 AC-4）。
 */

export interface CorsProbeResult {
  /** webview 自己看到的來源（`location.origin`）。 */
  origin: string;
  /** HTTP 狀態碼；請求根本沒回來（含被 CORS 擋）時為 null。 */
  status: number | null;
  /** 請求在 webview 層就失敗時的訊息（例：CORS 被擋的 `TypeError: Failed to fetch`）。 */
  error: string | null;
  /**
   * 探針讀到 `201` 之後，有没有**成功**回呼 `stop`（HTTP 2xx）。
   *
   * 為什麼這個欄位就是「webview 真的讀到回應」的證明：回呼只會在 `status === 201`
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
 * 安全上仍然收得住：旗標是 **build-time** 變數（vite 內聯），未設時
 * `main.ts` 的呼叫端分支會被 tree-shake（實測 production build 的 JS 不含探針字串）；
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
    // 這一行是 Gate 4 P1 的修正：把「讀不到」講清楚，不要留白讓人以為是空值。
    "ACAO / CORS 標頭：JS 讀不到（瀏覽器不 expose）→ 請看 worker log 的 [cors] allowed=…",
  ];
  if (result.status !== null) {
    lines.push("（拿得到 status 就代表 CORS 已通過：被擋時 fetch 會直接丟例外）");
  }
  if (result.error !== null) {
    lines.push(`webview 沒拿到回應：${result.error}`);
  }
  const readFine =
    result.stopped === true ? "是" : result.stopped === false ? "否（stop 自己也失敗）" : "n/a";
  lines.push(`webview 真的讀到回應（能回呼 stop）：${readFine}`);
  return lines.join("\n");
}

/** 不依賴 `crypto.randomUUID` 的後備 id（少數 WKWebView 舊版沒有這個 API）。 */
function fallbackMeetingId(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 探針使用的裸請求：刻意**不**經過 `HttpSessionClient`，
 * 因為我們要看到原始的 `status`，而不是被 client 先包成錯誤物件。 */
export async function runCorsProbe(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<CorsProbeResult> {
  const origin = globalThis.location?.origin ?? "(unknown)";
  const base = baseUrl.replace(/\/$/, "");
  const meetingId = globalThis.crypto?.randomUUID?.() ?? fallbackMeetingId();
  const url = (path: string) => `${base}/m/${encodeURIComponent(meetingId)}/${path}`;
  let status: number | null = null;
  try {
    // ⚠️ `mode: "cors"` 刻意寫出來（不要只靠預設值）：
    // 「拿得到 status ⇒ CORS 已通過」這個立論**只在 cors 模式成立**——
    // `mode: "no-cors"` 的 opaque response 不丟例外、status 永遠 0，拿得到也驗不到 CORS。
    const response = await fetchImpl(url("session/start"), {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
    });
    status = response.status;
  } catch (error) {
    return {
      origin,
      status: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stopped: null,
    };
  }
  // 只有「真的讀到 201」才會走到這裡 → 這筆 stop 就是讀取成功的機械證據。
  let stopped: boolean | null = null;
  if (status === 201) {
    try {
      const stoppedResponse = await fetchImpl(url("session/stop"), {
        method: "POST",
        mode: "cors",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "aborted" }),
      });
      // Gate 4 第 1 輪 P2：只說「沒丟例外」會把 4xx/5xx 誤報成成功，要看狀態碼。
      stopped = stoppedResponse.ok;
    } catch {
      // 探針自己的收尾失敗不得影響 app（也不得把 start 的成功蓋掉）。
      stopped = false;
    }
  }
  return { origin, status, error: null, stopped };
}

/** 給 `main.ts` 用的最小入口：啟用時打一次並回傳要顯示的文字。 */
export async function probeIfEnabled(
  flag: string | undefined,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (!corsProbeEnabled(flag)) return null;
  try {
    const result = await (fetchImpl === undefined
      ? runCorsProbe(baseUrl)
      : runCorsProbe(baseUrl, fetchImpl));
    return formatProbeReport(result);
  } catch (error) {
    // 探針**任何**失敗都不准往上冒（AC-2：不得影響正常 UI）。
    return `探針自己壞了：${error instanceof Error ? error.message : String(error)}`;
  }
}
