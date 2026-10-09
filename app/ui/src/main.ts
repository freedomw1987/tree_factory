import { mount } from "svelte";

import "./app.css";
import App from "./App.svelte";
import {
  discardUnfinished,
  flushChunks,
  initRecovery,
  loadMeetings,
  notifyVisibility,
  pushInterim,
  resumeUnfinished,
  tickMeeting,
  workerBaseUrl,
  workerToken,
  syncPendingGaps,
} from "./lib/app.svelte";
import { probeIfEnabled } from "./lib/dev/cors-probe";

const target = document.getElementById("app");
if (target === null) throw new Error("找不到 #app 掛載點");

mount(App, { target });

void loadMeetings();

// M01-US-102 AC-3：掃本機分段暫存；有未完成的會議會切到恢復畫面（不自動丟棄）。
// 刻意排在 `loadMeetings()` **之後**：恢復畫面會顯示會議標題（取自同一份清單），
// 先掃描會在標題還沒回來時就把使用者帶到恢復畫面（畫面閃一下、標題空白）。
// 順便（M01-US-107）把上次斷網沒送出去的缺口補送完。
void loadMeetings()
  .then(() => initRecovery())
  .then(() => syncPendingGaps());

// AC-2：網路恢復時把還沒送出的分段補送（ChunkQueue 內有 backoff，重複觸發安全）。
// M01-US-107（Gate 4 第 2 輪 P2）：缺口也是「離線就會積在本機」的東西，設計 §4 把 `online`
// 列為補送時機；只補分段會讓缺口停在「待同步」，直到使用者剛好回前景或續錄才被送出去。
window.addEventListener("online", () => {
  void flushChunks();
  void syncPendingGaps();
});

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
    __tf: {
      notifyVisibility,
      tickMeeting,
      loadMeetings,
      initRecovery,
      resumeUnfinished,
      discardUnfinished,
      flushChunks,
      syncPendingGaps,
      // M01-US-104：裝置端還沒有 STT 連線（沒有真的 interim 事件來源），
      // 所以顯示層的 interim 只能由這個鉤子驅動——這是**誠實**的測試縫，
      // 不是「假裝已經接上」：E2E 用它驗 AC-1/AC-2，真接線是後續票。
      pushInterim,
    },
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
    // TECH-009：探針也要帶憑證（否則它自己會拿到 401，把設定問題顯示成 CORS 問題）。
    const report = await probeIfEnabled("1", workerBaseUrl(), undefined, workerToken());
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
