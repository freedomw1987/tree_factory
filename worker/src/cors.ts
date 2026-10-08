/**
 * 跨來源支援（app webview / 瀏覽器 → worker）。
 *
 * 為什麼需要：Tauri（含 iOS）的 webview 會用 `tauri://localhost` 這類自訂來源發請求，
 * 瀏覽器開發時則是 `http://localhost:1420`。兩者對 worker 都是跨來源，
 * 沒有 CORS 標頭就**在瀏覽器層**被擋掉——這類失敗最難查（網路面板看起來「根本沒送出去」）。
 *
 * 為什麼不用 `*`：這一區是會議資料的入口，任何網站都能打就等於把使用者的會議開放出去。
 * 允許清單明列，且正式部署必須自己設 `ALLOWED_ORIGINS`（未設定時只給 dev 來源）。
 */

/** 本機開發／Tauri webview 的來源（`ALLOWED_ORIGINS` 未設定時的預設值）。 */
export const DEV_ORIGINS = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "tauri://localhost",
  "http://tauri.localhost",
];

export function allowedOrigins(configured: string | undefined): string[] {
  if (configured === undefined) return DEV_ORIGINS;
  const parsed = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return parsed.length === 0 ? DEV_ORIGINS : parsed;
}

export function corsHeaders(
  origin: string | null,
  configured: string | undefined,
): Record<string, string> {
  if (origin === null) return {};
  if (!allowedOrigins(configured).includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-meeting-id",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** preflight：一律 204；清單外的來源不給允許標頭（由瀏覽器擋，不在這裡假裝成功）。 */
export function preflightResponse(origin: string | null, configured: string | undefined): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin, configured) });
}

/** 把 CORS 標頭併到既有回應上（不改 status/body）。 */
export function withCors(
  response: Response,
  origin: string | null,
  configured: string | undefined,
): Response {
  const extra = corsHeaders(origin, configured);
  if (Object.keys(extra).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * TECH-006：把「webview 實際送來的來源」變成可重複的觀測。
 *
 * 為什麼需要：CORS 被擋的症狀是「請求看起來根本沒送出去」，除非知道
 * worker 真的收到哪個 `Origin`，否則只能猜。Tauri（macOS / iOS）是自訂 scheme，
 * 各平台寫法不完全一樣，猜测風險很高。
 *
 * 為什麼必須先開旗標：這行會出現在**每一**個請求上；在正式環境刷 log 是成本也是雜訊。
 * 因此只有 `DEBUG_ORIGINS` 正好等於 `"1"`（不 trim、不看大小寫）時才輸出。
 *
 * @param method HTTP 方法（`OPTIONS` ＝ preflight；CORS 卡住時最常見的現場）
 * @returns 要印出的那一行；未開旗標時 `null`（呼叫端自行決定要不要印）。
 */
export function corsDebugLine(
  origin: string | null,
  configured: string | undefined,
  debugFlag: string | undefined,
  method: string,
  path: string,
): string | null {
  if (debugFlag !== "1") return null;
  const allowed = origin !== null && allowedOrigins(configured).includes(origin);
  return `[cors] origin="${origin ?? "(none)"}" allowed=${allowed} method=${method} path="${path}"`;
}
