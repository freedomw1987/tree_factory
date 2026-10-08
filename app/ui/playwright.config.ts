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
 * - `workers: 1` + serial：worker 的 DO 狀態與 localStorage 是共用資源，序列跑才不會互相污染。
 */
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
      command: "npx --yes wrangler@4 dev --port 8787 --local --var HARNESS_PROVIDER:faux",
      cwd: "../../worker",
      url: "http://127.0.0.1:8787/",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:1420/",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
