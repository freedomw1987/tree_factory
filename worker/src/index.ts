/**
 * TECH-004：Worker 入口（薄）。把 `/m/:meetingId/*` 轉給對應的會議 DO。
 *
 * 這支檔案存在的理由有兩個：
 * 1. 讓 DO 能被真的跑起來（`wrangler dev --local`）——比單元測試更強的證據。
 * 2. 明確 demo「一個會議 = 一個 DO 實例」的尋址方式（`idFromName`，會議 id 即名字）。
 */

import { preflightResponse, withCors } from "./cors.js";
import { MeetingDurableObject, type MeetingEnv } from "./meeting-do.js";

export { MeetingDurableObject };

export interface Env extends MeetingEnv {
  MEETING: DurableObjectNamespace;
  /** 逗號分隔的允許來源；未設定時只允許本機開發來源（見 cors.ts）。 */
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const allowed = env.ALLOWED_ORIGINS;
    // CORS 在**入口**處理：DO 不該需要知道「誰在瀏覽器裡呼叫它」。
    if (request.method === "OPTIONS") {
      return preflightResponse(origin, allowed);
    }
    const url = new URL(request.url);
    const match = /^\/m\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) {
      return withCors(
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
              "POST /m/:meetingId/submit",
              "GET /m/:meetingId/wake?ms=",
              "GET /m/:meetingId/release",
            ],
          }) + "\n",
          { headers: { "content-type": "application/json; charset=utf-8" } },
        ),
        origin,
        allowed,
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
    return withCors(await stub.fetch(forwarded), origin, allowed);
  },
} satisfies ExportedHandler<Env>;