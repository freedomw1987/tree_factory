/**
 * TECH-004：Worker 入口（薄）。把 `/m/:meetingId/*` 轉給對應的會議 DO。
 *
 * 這支檔案存在的理由有兩個：
 * 1. 讓 DO 能被真的跑起來（`wrangler dev --local`）——比單元測試更強的證據。
 * 2. 明確 demo「一個會議 = 一個 DO 實例」的尋址方式（`idFromName`，會議 id 即名字）。
 */

import {
  allowedOrigins,
  corsDebugLine,
  corsDiagnosticHeaders,
  preflightResponse,
  withCors,
  withDiagnostics,
} from "./cors.js";
import { authDecision, bearerToken, DEVICE_TOKEN_HEADER } from "./edge-auth.js";
import { MeetingDurableObject, type MeetingEnv } from "./meeting-do.js";
import {
  clientKey,
  FixedWindowLimiter,
  rateLimitConfig,
  tokenFingerprint,
} from "./rate-limit.js";

export { MeetingDurableObject };

export interface Env extends MeetingEnv {
  MEETING: DurableObjectNamespace;
  /** 逗號分隔的允許來源；未設定時只允許本機開發來源（見 cors.ts）。 */
  ALLOWED_ORIGINS?: string;
  /**
   * TECH-006：設為 `"1"` 時，每個請求都印一行 `[cors] origin=… allowed=… path=…`。
   *
   * 為什麼需要這個開關：CORS 在 webview 裡被擋掉時，前端只看得到「Failed to fetch」，
   * 伺服器端卻完全安靜。要區分「沒送到」和「送到了但沒通過白名單」，就必須有 wire 層證據。
   * 預設關閉（每一請求都印 log 在正式環境是成本也是雜訊）。
   * 用法：`npx wrangler dev --var DEBUG_ORIGINS:1 --var HARNESS_PROVIDER:faux`。
   */
  DEBUG_ORIGINS?: string;
  /**
   * TECH-009：裝置憑證（`wrangler secret put DEVICE_TOKEN`）。
   *
   * **沒設定就不是「不檢查」，而是「全部拒絕」**（500 `AUTH_NOT_CONFIGURED`）：
   * 一個「忘了設 secret」的部署如果靜默放行，就等於門鎖故障還開著門。
   * 代價（要先設好才能用）寫在 `docs/env-setup.md`。
   */
  DEVICE_TOKEN?: string;
  /** TECH-009：速率限制的窗長（毫秒）與次數上限；不合法值一律回預設（沒有關掉的開關）。 */
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
}

/**
 * TECH-009：速率限制的狀態活在**這一顆 isolate 的記憶體**裡。
 *
 * 為什麼放模組層而不是每個請求新建：每個請求新建等於沒有限制（計數永遠從 0 開始）。
 * 為什麼不放 DO：會議 id 是對手可控的字串，每個新 id 都會拿到一個新桶＝沒有上限。
 * 誠實的界線：多顆 isolate 各自計數（design D10），這是「延緩」不是「全域配額」。
 */
const limiter = new FixedWindowLimiter();

/** 統一的錯誤 payload：`recoverable` 明示「使用者重試有沒有意義」。 */
function errorResponse(
  status: number,
  error: string,
  message: string,
  recoverable: boolean,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error, message, recoverable, ...extra }) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = env.ALLOWED_ORIGINS;
    // TECH-006：觀測必須**最先**做，preflight 也要看得到（被擋的往往是 preflight）。
    const debug = corsDebugLine(
      origin,
      allowed,
      env.DEBUG_ORIGINS,
      request.method,
      url.pathname,
    );
    if (debug !== null) console.log(debug);
    // CORS 在**入口**處理：DO 不該需要知道「誰在瀏覽器裡呼叫它」。
    // TECH-010：診斷標頭（只在 DEBUG_ORIGINS=1 時非空）。被 CORS 擋掉時 body 讀不到，
    // 只有回應標頭能讓開發者分辨「沒送到」與「送到了但白名單沒中」。
    const diagnostic = corsDiagnosticHeaders(origin, allowed, env.DEBUG_ORIGINS);
    if (request.method === "OPTIONS") {
      return withDiagnostics(preflightResponse(origin, allowed), diagnostic);
    }
    const match = /^\/m\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) {
      return withDiagnostics(withCors(
        new Response(
          JSON.stringify({
            ok: true,
            service: "tree-factory-worker",
            routes: [
              "GET /m/:meetingId/health",
              "POST /m/:meetingId/session/start",
              "GET /m/:meetingId/session",
              "POST /m/:meetingId/session/stop",
              "POST /m/:meetingId/transcript",
              "POST /m/:meetingId/transcript/gap",
              "GET /m/:meetingId/transcript/gaps",
              "POST /m/:meetingId/audio/chunk?seq=",
              "GET /m/:meetingId/audio/chunks",
              "POST /m/:meetingId/submit",
              "POST /m/:meetingId/wake?ms=",
              "POST /m/:meetingId/release",
            ],
          }) + "\n",
          { headers: { "content-type": "application/json; charset=utf-8" } },
        ),
        origin,
        allowed,
      ), diagnostic);
    }
    // ── TECH-009：邊緣三關，順序是刻意的 ────────────────────────────────────
    //
    // 1) Origin（來源關）：**先判**來源。憑證錯的時候也回 403 而非 401，
    //    這樣 401/403 的差別不會變成「有沒有猜對憑證」的探測管道。
    //    `origin === null`（curl／原生／腳本）沒有來源可判 → 放行到下一關由憑證把關。
    // 2) 憑證（device token）：沒設定＝全部拒絕（fail-closed）。
    // 3) 速率（固定窗）：**只對已通過認證的請求計數**——
    //    否則任何一個亂猜憑證的人都能把合法裝置的額度喝光。
    //
    // 三關都在**轉發之前**：被擋的請求不會碰到 DO，也就不會有任何副作用
    // （舊行為是「不給 CORS 標頭但照常轉發」，那等於擋了讀取卻讓寫入發生）。
    const gated = (response: Response): Response =>
      withDiagnostics(withCors(response, origin, allowed), diagnostic);

    if (origin !== null && !allowedOrigins(allowed).includes(origin)) {
      return gated(
        errorResponse(403, "ORIGIN_FORBIDDEN", "這個來源不在允許清單內。", false),
      );
    }

    const rawCredential = request.headers.get(DEVICE_TOKEN_HEADER);
    const decision = authDecision(rawCredential, env.DEVICE_TOKEN);
    if (decision === "not_configured") {
      // 500 而不是 401：這是伺服器沒設定好，不是使用者的憑證有問題。
      return gated(
        errorResponse(
          500,
          "AUTH_NOT_CONFIGURED",
          "伺服端尚未完成設定（DEVICE_TOKEN 未設定），請見 docs/env-setup.md。",
          false,
        ),
      );
    }
    if (decision === "invalid") {
      // 訊息刻意不含任何憑證片段（連「差了幾個字元」都不說）。
      return gated(
        errorResponse(401, "AUTH_INVALID", "裝置授權已失效，請重新配對。", false),
      );
    }

    const config = rateLimitConfig(env);
    const token = bearerToken(rawCredential) as string;
    const rate = limiter.check(
      clientKey(await tokenFingerprint(token), request.headers.get("cf-connecting-ip")),
      Date.now(),
      config,
    );
    if (!rate.allowed) {
      const retryAfterSeconds = Math.ceil(rate.retryAfterMs / 1000);
      return gated(
        new Response(
          JSON.stringify({
            error: "RATE_LIMITED",
            message: `請求太頻繁，請等 ${retryAfterSeconds} 秒後再試。`,
            // 可重試：這不是資料錯誤，等等再送就會成功（UI 走既有退避）。
            recoverable: true,
            limit: rate.limit,
            windowMs: rate.windowMs,
            retryAfterMs: rate.retryAfterMs,
          }) + "\n",
          {
            status: 429,
            // `Retry-After` 是秒（RFC 9110）；這裡揭露的是**窗剩下的時間**，不是亂槍打鳥的常數。
            headers: {
              "content-type": "application/json; charset=utf-8",
              "retry-after": String(retryAfterSeconds),
            },
          },
        ),
      );
    }

    const meetingId = match[1] as string;
    // ⚠️ `url.pathname` **不含 query**：只取 pathname 會把 `?ms=` 這類參數吃掉
    // （真 workerd 冒煙測試抓到的 bug：參數消失 → 延遲變 0 → alarm 立刻觸發）。
    const rest = (match[2] ?? "/health") + url.search;
    const stub = env.MEETING.get(env.MEETING.idFromName(meetingId));
    // 會議 id 走 header 進 DO：DO 只看得到被改寫後的路徑，而會議 id 是它存進
    // session 資料列的必要欄位（比用 DO id 的十六進位雜湊可讀得多）。
    const forwarded = new Request(new URL(rest, url.origin), request);
    forwarded.headers.set("x-meeting-id", meetingId);
    return gated(await stub.fetch(forwarded));
  },
} satisfies ExportedHandler<Env>;