/**
 * TECH-009：E2E 用的裝置憑證（單一來源，勿在測試裡各寫一份）。
 *
 * 為什麼要獨立一個檔案：`playwright.config.ts` 要把同一顆值分別注入 worker
 * （`--var DEVICE_TOKEN`）與 vite（`VITE_DEVICE_TOKEN`），而 E2E 裡「直接打 worker」
 * 的請求也要帶它。三處若各寫一份字串，改一處就會出現一半 401 的假紅。
 *
 * 為什麼是寫死的：這是**本機測試**值，不是祕密；正式部署走 `wrangler secret`
 * （見 `docs/env-setup.md`）。可用 `E2E_DEVICE_TOKEN` 環境變數覆寫。
 *
 * 為什麼要自己 `declare process`：`app/ui` 的 tsconfig 沒有 node 型別
 * （刻意不引入 `@types/node`），所以 `process.env` 在 `npm run typecheck` 會紅。
 * 這行只是把 Playwright 執行時**本來就有**的全域 `process` 補上型別。
 */
declare const process: { env: Record<string, string | undefined> };

export const E2E_DEVICE_TOKEN = process.env.E2E_DEVICE_TOKEN ?? "e2e-device-token";

/** 直接打 worker 的請求（`page.request.*`）要帶的標頭。 */
export const AUTH: Record<string, string> = { authorization: `Bearer ${E2E_DEVICE_TOKEN}` };
