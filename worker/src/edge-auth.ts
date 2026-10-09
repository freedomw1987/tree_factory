/**
 * TECH-009：邊緣裝置憑證（device token）。
 *
 * 這一票的威脅模型（詳見 `docs/design/TECH-009-edge-auth-rate-limit.md` D1）：
 * 擋得住「別的網站用訪客的瀏覽器打進來」（S1）與「網路上有人掃到這個 worker」（S2）；
 * **擋不住**同機的另一個行程（S3）與把 App 逆向出來的人（S4）。
 * 一句話：這是門鎖，不是保險箱。
 *
 * 為什麼是自寫的常數時間比較，不用 `crypto.subtle.timingSafeEqual`：
 * workerd 沒有那個 API（且 JS 層本來就無法保證真正的常數時間）。
 * 這裡的目標是把「逐字元提早 return」這種**可自動化**的時間旁通道拿掉；
 * 更精細的側通道（JIT、快取、網路抖動）不在防禦範圍內，也不會假裝擋得住。
 */

/** 憑證的標頭名稱（小寫；`Headers` 一律以大小寫不敏感的方式查詢）。 */
export const DEVICE_TOKEN_HEADER = "authorization";

/** 從 `Authorization` 標頭取出 Bearer 憑證；格式不符一律 `null`（不得退化成空字串）。 */
export function bearerToken(raw: string | null): string | null {
  if (raw === null) return null;
  // 標頭整體的前後空白是 HTTP 層的正常現象（proxy／客戶端都可能加），容忍它；
  // 但**憑證本身不被 trim**——`Bearer  a` 與 `Bearer a` 是兩把不同的憑證。
  const trimmed = raw.trim();
  if (!/^bearer /i.test(trimmed)) return null;
  const token = trimmed.slice("bearer ".length);
  return token === "" ? null : token;
}

/**
 * 常數時間比較（best-effort）。
 *
 * 長度不同時仍然跑滿 `max(len)` 次迴圈，並把長度差 XOR 進結果，
 * 讓「長度不同」與「內容不同」在時間上不可區分。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export type AuthDecision = "ok" | "not_configured" | "invalid";

/**
 * 憑證判定。
 *
 * `not_configured` 與 `invalid` 是**不同**的事實，也回不同的狀態碼：
 * - `not_configured`（伺服器沒設 `DEVICE_TOKEN`）→ 500：這是**伺服器**壞了，不是使用者做錯事。
 *   刻意不用 401 —— 那會把「部署忘了設 secret」講成「你的憑證不對」，讓使用者查錯方向。
 * - `invalid`（有設定但不符）→ 401。
 *
 * 空字串設定視同沒設定：**不得**讓「空字串等於空憑證」變成一把人人都有的通行證。
 */
export function authDecision(
  raw: string | null,
  configured: string | null | undefined,
): AuthDecision {
  if (configured === undefined || configured === null || configured === "") return "not_configured";
  const presented = bearerToken(raw);
  if (presented === null) return "invalid";
  return constantTimeEquals(presented, configured) ? "ok" : "invalid";
}
