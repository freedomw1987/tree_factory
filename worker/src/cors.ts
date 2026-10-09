/**
 * 跨來源支援（app webview / 瀏覽器 → worker）。
 *
 * 為什麼需要：Tauri（含 iOS）的 webview 會用 `tauri://localhost` 這類自訂來源發請求，
 * 瀏覽器開發時則是 `http://localhost:1420`。兩者對 worker 都是跨來源，
 * 沒有 CORS 標頭就**在瀏覽器層**被擋掉——這類失敗最難查（網路面板看起來「根本沒送出去」）。
 *
 * 為什麼不用 `*`：這一區是會議資料的入口，任何網站都能打就等於把使用者的會議開放出去。
 * 允許清單明列，且正式部署必須自己設 `ALLOWED_ORIGINS`（未設定時只給 dev 來源）。
 *
 * TECH-009 起，這裡同時是**拒絕關**的依據：清單外的來源不再只是「不給標頭但照常轉發」，
 * 而是在入口就 403（`ORIGIN_FORBIDDEN`）——不給標頭只擋得住讀取，寫入的副作用已經發生了。
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
    // TECH-009：裝置憑證走 `Authorization`；少了這一行，帶憑證的請求連 preflight 都過不了。
    "access-control-allow-headers": "content-type,x-meeting-id,authorization",
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
 * TECH-010：把「這次的 Origin 有沒有中白名單」放上**回應標頭**。
 *
 * 為什麼事件記錄不夠：`corsDebugLine` 只在 server log 看得到，而 CORS 被擋時
 * 開發者盯著的是 DevTools 的 Network 面板——被擋掉的回應讀不到 body，
 * **標頭是唯一還看得見的通道**。沒有這個，埠漂移（dev server 從 1420 變 1421）
 * 與「正式環境真的被擋」症狀完全一樣（都只看到 `Failed to fetch`）。
 *
 * 為什麼只在 `DEBUG_ORIGINS=1` 時給：正式環境多送這兩個標頭等於多一個指紋欄位，
 * 且對使用者毫無用處；預設不給，行為與 TECH-006 之前完全相同。
 *
 * 安全立場：只回**對方自己送的 Origin** 與 true/false，**不回白名單內容**——
 * 否則等於免費送攻擊者一份允許清單。
 */
export function corsDiagnosticHeaders(
  origin: string | null,
  configured: string | undefined,
  debugFlag: string | undefined,
): Record<string, string> {
  if (debugFlag !== "1") return {};
  const allowed = origin !== null && allowedOrigins(configured).includes(origin);
  return {
    // HTTP 標頭值只能是 ASCII；Origin 本來就是 ASCII，沒帶時用 `(none)` 標明。
    "x-cors-origin": safeHeaderOrigin(origin),
    "x-cors-allowed": allowed ? "true" : "false",
  };
}

/**
 * 淨化要回顯的 Origin。
 *
 * 為什麼需要：`Origin` 是**對手可控**的字串，而這一票新增的行為正是「把它寫進回應標頭」。
 * Gate 4 oracle 用 raw socket 實測：workerd 會擋掉含 CR/LF（obs-fold）與 NUL 的請求（`400`），
 * 但**垂直 tab `0x0B` 會被原樣寫進回應標頭**——不構成 response splitting，
 * 卻違反 RFC 9110 的 field-value 文法，且若下游有寬鬆的 parser/proxy 把 VT 當行終止，理論上可被拆行。
 * 這裡採白名單：只放行可見 ASCII（`\x20`–`\x7e`）且長度合理者，其餘一律 `(invalid)`。
 */
export function safeHeaderOrigin(origin: string | null): string {
  if (origin === null) return "(none)";
  return /^[\x20-\x7e]{1,255}$/.test(origin) ? origin : "(invalid)";
}

/** 把診斷標頭併到回應上；空 map 時**原樣回傳**（不製造新的 Response 物件）。 */
export function withDiagnostics(
  response: Response,
  headers: Record<string, string>,
): Response {
  if (Object.keys(headers).length === 0) return response;
  const merged = new Headers(response.headers);
  // oracle P2-2：診斷標頭的值隨 `Origin` 變動，回應就必須帶 `Vary: origin`——
  // 否則共享快取（CDN / 反向代理）可能把 A 來源的 `x-cors-origin` 回給 B。
  if (!(merged.get("vary") ?? "").toLowerCase().split(/\s*,\s*/).includes("origin")) {
    merged.set("vary", merged.get("vary") ? `${merged.get("vary")}, origin` : "origin");
  }
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
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
