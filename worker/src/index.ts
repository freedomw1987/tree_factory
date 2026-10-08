/**
 * TECH-004：Worker 入口（薄）。把 `/m/:meetingId/*` 轉給對應的會議 DO。
 *
 * 這支檔案存在的理由有兩個：
 * 1. 讓 DO 能被真的跑起來（`wrangler dev --local`）——比單元測試更強的證據。
 * 2. 明確 demo「一個會議 = 一個 DO 實例」的尋址方式（`idFromName`，會議 id 即名字）。
 */

import { MeetingDurableObject, type MeetingEnv } from "./meeting-do.js";

export { MeetingDurableObject };

export interface Env extends MeetingEnv {
  MEETING: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/m\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "tree-factory-worker",
          routes: ["GET /m/:meetingId/health", "POST /m/:meetingId/submit", "GET /m/:meetingId/wake?ms=", "GET /m/:meetingId/release"],
        }) + "\n",
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    const meetingId = match[1] as string;
    // ⚠️ `url.pathname` **不含 query**：只取 pathname 會把 `?ms=` 這類參數吃掉
    // （真 workerd 冒煙測試抓到的 bug：參數消失 → 延遲變 0 → alarm 立刻觸發）。
    const rest = (match[2] ?? "/health") + url.search;
    const stub = env.MEETING.get(env.MEETING.idFromName(meetingId));
    return stub.fetch(new Request(new URL(rest, url.origin), request));
  },
} satisfies ExportedHandler<Env>;