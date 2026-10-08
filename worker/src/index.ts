/**
 * TECH-004：Worker 入口（薄）。把 `/m/:meetingId/*` 轉給對應的會議 DO。
 *
 * 這支檔案存在的理由有兩個：
 * 1. 讓 DO 能被真的跑起來（`wrangler dev --local`）——比單元測試更強的證據。
 * 2. 明確 demo「一個會議 = 一個 DO 實例」的尋址方式（`idFromName`，會議 id 即名字）。
 */

import {
  corsDebugLine,
  corsDiagnosticHeaders,
  preflightResponse,
  withCors,
  withDiagnostics,
} from "./cors.js";
import { MeetingDurableObject, type MeetingEnv } from "./meeting-do.js";

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
              "GET /m/:meetingId/wake?ms=",
              "GET /m/:meetingId/release",
            ],
          }) + "\n",
          { headers: { "content-type": "application/json; charset=utf-8" } },
        ),
        origin,
        allowed,
      ), diagnostic);
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
    return withDiagnostics(withCors(await stub.fetch(forwarded), origin, allowed), diagnostic);
  },
} satisfies ExportedHandler<Env>;