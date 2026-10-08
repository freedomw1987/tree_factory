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
