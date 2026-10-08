import { svelte } from "@sveltejs/vite-plugin-svelte";
// vitest 的 defineConfig 是 vite 的擴充版本（多了 `test` 區塊），設定檔用這一個。
import { defineConfig } from "vitest/config";

// Tauri 的 iOS dev 流程需要固定 port（tauri.conf.json 的 devUrl 指到這裡）。
export default defineConfig({
  plugins: [svelte()],
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  test: {
    // 核心邏輯（上限數學 / 狀態機 / store）刻意不碰 DOM，跑 node 環境最快也最穩；
    // 需要 DOM 的行為由 Gate 4 的 playwright E2E 覆蓋（見 docs/ac/M01-US-101.md）。
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
