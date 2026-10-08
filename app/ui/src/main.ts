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

// TECH-006：真實 webview 內的 CORS 實證。
//
// 為什麼要在 app 裡做而不是用 curl：只有跑在 webview 裡的程式知道 webview 送出的 Origin。
// 為什麼用 top-level 的**常數**判斷（而不是傳旗標進函式）：vite 可以把整段
// 移除（tree-shake），未設旗標的 production build 就不會帶探針程式碼（Gate 4 第 1 輪 P2 的修正；
// 舊寫法雖然不執行，但程式碼與 `session/start` 字串仍留在 bundle 裡）。
if (import.meta.env.VITE_CORS_PROBE === "1") {
  void (async () => {
    const report = await probeIfEnabled("1", workerBaseUrl());
    if (report === null) return;
    const pre = document.createElement("pre");
    pre.dataset.testid = "cors-probe";
    pre.textContent = `[TECH-006 CORS 探針]\n${report}`;
    pre.style.cssText =
      "position:fixed;inset:0 0 auto 0;margin:0;padding:8px 12px;max-height:45%;overflow:auto;pointer-events:none;" +
      "font:11px/1.4 ui-monospace,monospace;background:#131A22F2;color:#E8EEF5;" +
      "border-bottom:1px solid #28323D;white-space:pre-wrap;z-index:99";
    document.body.append(pre);
  })();
}
