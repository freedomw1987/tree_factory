import { mount } from "svelte";

import "./app.css";
import App from "./App.svelte";
import { loadMeetings, notifyVisibility, tickMeeting } from "./lib/app.svelte";

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
