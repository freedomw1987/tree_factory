import { defineConfig, devices } from "@playwright/test";

/**
 * M01-US-101 的端到端測試（Gate 4）。
 *
 * 為什麼要在「瀏覽器 + 真的 worker」上跑，而不是只跑單元測試：
 * 這一條使用者故事最容易壞的地方是**接線**——麥克風權限、前景/背景事件、
 * 每秒 tick、CORS、以及「畫面顯示的狀態是否等於真的狀態」。單元測試驗不到這些。
 *
 * 兩個刻意的設定：
 * - `--use-fake-device-for-media-stream`：給 Chromium 一個假麥克風（有聲無聲不重要，
 *   重點是 `getUserMedia()` 真的會成功），因此不必在 CI 上接真裝置。
 * - `workers: 1`：worker 的 DO 狀態與 localStorage 是共用資源，序列跑才不會互相污染。
 *   （刻意**不**用 `mode: "serial"`：那會讓一條失敗就 skip 掉後面全部，反而少掉證據；
 *   序列靠 `workers: 1` + 每個測試清 localStorage 就夠了。）
 */
/**
 * TECH-009：E2E 用的裝置憑證。
 *
 * 為什麼可以寫死在這裡：這是**本機測試**用的值，不是祕密——測試要能自己把
 * worker 起起來並帶對的憑證，才驗得到「UI 真的會送 Authorization」。
 * 正式部署的 `DEVICE_TOKEN` 走 `wrangler secret`（見 `docs/env-setup.md`），
 * 不會是這個值。**刻意不**在 `use.extraHTTPHeaders` 裡塞同一顆 token：
 * 那會讓「UI 忘了帶憑證」的 bug 照樣全綠（連瀏覽器請求都會被測試設定補上）。
 */
declare const process: { env: Record<string, string | undefined> };

const E2E_DEVICE_TOKEN = process.env.E2E_DEVICE_TOKEN ?? "e2e-device-token";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 真的 Durable Object（faux provider，零成本）；session 路由就是打這裡。
      // TECH-009：worker 端的 DEVICE_TOKEN 必須與 `E2E_DEVICE_TOKEN` 相同，
      // 否則 UI 帶的憑證會被判 AUTH_INVALID（那就變成在驗錯的東西）。
      command: `npx --yes wrangler@4 dev --port 8787 --local --var HARNESS_PROVIDER:faux --var DEVICE_TOKEN:${E2E_DEVICE_TOKEN}`,
      cwd: "../../worker",
      url: "http://127.0.0.1:8787/",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      // TECH-009：vite 在**啟動時**內聯 `VITE_DEVICE_TOKEN`，所以這裡要用 env 傳進去
      // （測試檔本身讀不到 worker 的 `--var`）。
      env: { VITE_DEVICE_TOKEN: E2E_DEVICE_TOKEN },
      url: "http://localhost:1420/",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
