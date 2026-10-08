import { mount } from "svelte";

import "./app.css";
import App from "./App.svelte";
import { loadMeetings, notifyVisibility, tickMeeting, workerBaseUrl } from "./lib/app.svelte";
import { probeIfEnabled } from "./lib/dev/cors-probe";

const target = document.getElementById("app");
if (target === null) throw new Error("找不到 #app 掛載點");

mount(App, { target });

void loadMeetings();

// AC-4：切背景 / 鎖屏必須誠實顯示中斷（webview 在背景不會繼續收音，見 SPIKE-002）。
document.addEventListener("visibilitychange", () => {
  notifyVisibility(document.hidden);
});

// AC-5 / AC-6：剩餘時間與到點自動結束都以每秒一次的 tick 驅動；
// 權威時間在伺服端，這裡只是「把權威畫出來」。
setInterval(() => tickMeeting(), 1_000);

// 測試縫（只在 dev 生效）：Gate 4 的 playwright E2E 無法真的把頁面切到背景，
// 因此提供明確的鉤子來驅動「中斷 / 到點」這兩條路徑，而不是在測試裡等兩小時。
if (import.meta.env.DEV) {
  Object.assign(globalThis, {
    __tf: { notifyVisibility, tickMeeting, loadMeetings },
  });
}

// TECH-006：真實 webview 內的 CORS 實證（只有 `VITE_CORS_PROBE=1` 時才會跑）。
// 為什麼要在 app 裡做而不是用 curl：只有跑在 webview 裡的程式知道 webview 送出的 Origin。
void (async () => {
  const report = await probeIfEnabled(import.meta.env.VITE_CORS_PROBE, workerBaseUrl());
  if (report === null) return;
  const pre = document.createElement("pre");
  pre.dataset.testid = "cors-probe";
  pre.textContent = `[TECH-006 CORS 探針]\n${report}`;
  pre.style.cssText =
    "position:fixed;inset:auto 0 0 0;margin:0;padding:12px;font:12px/1.5 ui-monospace,monospace;" +
    "background:#131A22;color:#E8EEF5;border-top:1px solid #28323D;white-space:pre-wrap;z-index:99";
  document.body.append(pre);
})();
