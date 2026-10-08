import { expect, test, type Page } from "@playwright/test";

/**
 * M01-US-108「錄音續航（Screen Wake Lock）」的 E2E。
 *
 * 誠實聲明（測不到的部分與替代證據）：真機的「螢幕自動關閉」與「使用者按電源鍵」
 * 在 Chromium 裡做不到，這裡用注入的假 `navigator.wakeLock` 驅動與真機同一條程式碼路徑
 * （`app.svelte.ts` → `WakeLockManager`），並驗證畫面（`data-wakelock-state` + 提示文字）
 * 與 API 呼叫次數**兩邊**都對——只驗畫面會讓「畫得很誠實、但其實沒真的呼叫 API」假通過。
 * 真機行為（iOS 鎖屏後 webview 收不到音）屬 SPIKE-002 已證範疇，真機驗收另行安排。
 *
 * 假 API 的行為也刻意照規格：`request()` 在頁面不是前景時會被拒（NotAllowedError），
 * 所以「回前景才重取」不只是省事，而是規格要求的唯一可行時機（D3）。
 */

const MEETINGS_KEY = "tree_factory.meetings.v1";

type FakeWakeLockMode = "ok" | "unsupported" | "denied";

/**
 * 在任何頁面腳本之前注入假 API，並把觀察點掛在 `globalThis.__wl`。
 * `rejectNext` 讓測試模擬「系統收走後，重取也被拒」。
 */
async function installFakeWakeLock(page: Page, mode: FakeWakeLockMode = "ok"): Promise<void> {
  await page.addInitScript((selected: string) => {
    interface FakeSentinel {
      released: boolean;
      releaseCalls: number;
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
      release(): Promise<void>;
      /** 測試專用：模擬系統自己收走（電源鍵 / 瀏覽器省電釋放）。 */
      systemRelease(): void;
    }
    const state: { calls: number; sentinels: FakeSentinel[]; rejectNext: boolean; hidden: boolean } = {
      calls: 0,
      sentinels: [],
      rejectNext: false,
      hidden: false,
    };
    (globalThis as unknown as { __wl: typeof state }).__wl = state;

    if (selected === "unsupported") {
      Object.defineProperty(globalThis.navigator, "wakeLock", { configurable: true, value: undefined });
      return;
    }

    Object.defineProperty(globalThis.navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (): Promise<FakeSentinel> => {
          state.calls += 1;
          // 規格（Screen Wake Lock API）：頁面不是前景時 request() 會被拒（NotAllowedError）。
          // 這條讓「回前景才重取」不只是我們的選擇，而是規格上唯一可能的時機（D3）。
          if (state.hidden || selected === "denied" || state.rejectNext) {
            state.rejectNext = false;
            const error = new Error("wake lock not allowed");
            error.name = "NotAllowedError";
            throw error;
          }
          const listeners = new Set<() => void>();
          const sentinel: FakeSentinel = {
            released: false,
            releaseCalls: 0,
            addEventListener: (event: string, listener: () => void) => {
              if (event === "release") listeners.add(listener);
            },
            removeEventListener: (event: string, listener: () => void) => {
              if (event === "release") listeners.delete(listener);
            },
            release: async () => {
              sentinel.releaseCalls += 1;
              sentinel.released = true;
              for (const listener of [...listeners]) listener();
            },
            systemRelease: () => {
              sentinel.released = true;
              for (const listener of [...listeners]) listener();
            },
          };
          state.sentinels.push(sentinel);
          return sentinel;
        },
      },
    });
  }, mode);
}

interface WakeLockObservation {
  calls: number;
  sentinels: Array<{ released: boolean; releaseCalls: number }>;
}

async function observeWakeLock(page: Page): Promise<WakeLockObservation> {
  return page.evaluate(() => {
    const state = (globalThis as unknown as { __wl: WakeLockObservation }).__wl;
    return {
      calls: state.calls,
      sentinels: state.sentinels.map((sentinel) => ({
        released: sentinel.released,
        releaseCalls: sentinel.releaseCalls,
      })),
    };
  });
}

async function systemRelease(page: Page, index = 0): Promise<void> {
  await page.evaluate((target) => {
    const state = (globalThis as unknown as { __wl: { sentinels: Array<{ systemRelease(): void }> } }).__wl;
    const sentinel = state.sentinels[target];
    if (sentinel === undefined) throw new Error(`沒有第 ${target} 個 sentinel`);
    sentinel.systemRelease();
  }, index);
}

/**
 * 只切換「瀏覽器認為頁面在不在前景」，**不**通知 App。
 * 真機按電源鍵時這兩件事的先後沒有保證：系統可能先 `release` sentinel，
 * 而 App 還來不及知道已經不是前景（那時它會重取一個註定被拒的 request）。
 */
async function markFakeHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    const state = (globalThis as unknown as { __wl?: { hidden: boolean } }).__wl;
    if (state === undefined) throw new Error("假 wakeLock 不存在（是否忘了 installFakeWakeLock？）");
    state.hidden = value;
  }, hidden);
}

async function rejectNextRequest(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __wl: { rejectNext: boolean } }).__wl.rejectNext = true;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => globalThis.localStorage.clear());
});

async function startMeeting(page: Page, title: string): Promise<string> {
  await page.getByTestId("btn-start-meeting").click();
  await expect(page.getByTestId("start-sheet")).toBeVisible();
  await page.getByTestId("input-title").fill(title);
  await page.getByTestId("btn-start-confirm").click();
  await expect(page.getByTestId("meeting-screen")).toBeVisible({ timeout: 3_000 });
  const id = await page.evaluate((key) => {
    const raw = globalThis.localStorage.getItem(key);
    const parsed = raw === null ? [] : (JSON.parse(raw) as Array<{ id: string }>);
    return parsed[0]?.id ?? "";
  }, MEETINGS_KEY);
  expect(id).not.toBe("");
  return id;
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    // 兩件事都要做：①瀏覽器層的前景狀態（假 API 據此決定 request() 准不准）
    // ②通知 App（等同 visibilitychange），順序也照真機——先離開前景，App 才知道。
    const wl = (globalThis as unknown as { __wl?: { hidden: boolean } }).__wl;
    if (wl !== undefined) wl.hidden = value;
    const hook = (globalThis as unknown as { __tf?: { notifyVisibility: (h: boolean) => void } }).__tf;
    if (hook === undefined) throw new Error("dev 鉤子 __tf 不存在（是否以 dev 模式啟動？）");
    hook.notifyVisibility(value);
  }, hidden);
}

async function holdToEnd(page: Page): Promise<void> {
  const button = page.getByTestId("btn-end-hold");
  const box = await button.boundingBox();
  if (box === null) throw new Error("找不到長按按鈕的位置");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_300);
  await page.mouse.up();
  await expect(page.getByTestId("meeting-screen")).toHaveCount(0);
}

test("AC-1：開始錄音就壓住螢幕一次，而且不囉嗦（沒有提示）", async ({ page }) => {
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 開始");

  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
  // 真的呼叫過 API（不是只有畫面好看）
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(1);
  // 有保護就不該出現「請保持畫面開啟」——那會讓使用者以為要一直盯著手機
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
});

test("AC-2 / D3：切背景被系統收走，回前景但沒續錄不重取；真的續錄才重取", async ({ page }) => {
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 中斷");

  await setHidden(page, true);
  // 進背景：系統必然釋放，所以我們主動收乾淨，且狀態降為 suspended（不假裝還在保護）
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "suspended");
  await expect.poll(async () => (await observeWakeLock(page)).sentinels[0]?.releaseCalls).toBe(1);

  // Gate 4 抓到：每秒的 tickMeeting() 原本會無條件 stop()，把 suspended 壓成 idle
  // → 斷言會 flake、狀態也在 tick 之間跳動。這裡刻意跨過一次 tick 再確認它是穩定的。
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "suspended");

  await setHidden(page, false);
  // 回到前景但錄音還是中斷的（visible 不自動續錄）→ 不得重取（D1）
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音已中斷");
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(1);

  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音中");
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(2);
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
});

test("AC-2：系統自己收走（電源鍵）→ 自動重取一次就回到 active", async ({ page }) => {
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 系統釋放");

  await systemRelease(page);
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(2);
});

test("AC-2 / D4：重取也被拒 → 停在 lost 並明說請保持畫面開啟（不再空轉）", async ({ page }) => {
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 失去保護");

  await rejectNextRequest(page);
  await systemRelease(page);

  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "lost");
  await expect(page.getByTestId("wakelock-hint")).toContainText("請保持畫面開啟");
  // 只多打一次（初始 1 + 重試 1），之後不再無意義重試
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(2);
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音中");
});

test("AC-2：裝置不支援 → 誠實說「請保持畫面開啟」，錄音照常（best-effort）", async ({ page }) => {
  await installFakeWakeLock(page, "unsupported");
  await page.reload();
  await startMeeting(page, "E2E WakeLock 不支援");

  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "unsupported");
  await expect(page.getByTestId("wakelock-hint")).toContainText("不支援防止螢幕關閉");
  // 不支援不代表錄不了：紅燈與狀態都要照舊
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音中");
  expect((await observeWakeLock(page)).calls).toBe(0);
});

test("AC-2：系統拒絕（省電模式）→ 明說原因，錄音照常", async ({ page }) => {
  await installFakeWakeLock(page, "denied");
  await page.reload();
  await startMeeting(page, "E2E WakeLock 被拒");

  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "denied");
  await expect(page.getByTestId("wakelock-hint")).toContainText("省電");
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音中");
});

test("AC-2 / D4：真機「按電源鍵」的順序（release 與 hidden 幾乎同時到）→ 不得留下幽靈保護，也不得噴假提示", async ({ page }) => {
  // 真機的同一個動作有兩面：系統先 `release` sentinel，緊接著頁面變 hidden（這一條測這個順序）。
  // 這一條把 Gate 4 Finding 1 的推論釘住：不得讓畫面宣稱 `active`，也不得噴「請保持畫面開啟」
  // （那一刻錄音已中斷，誠實的訊息由 US-107 缺口列負責）。
  // 反序（系統已非前景、release 才到）由上一條與下一條覆蓋——兩種落點不同，見 AC v1.3。
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 電源鍵");

  await systemRelease(page);
  await setHidden(page, true);

  await expect(page.getByTestId("rec-state-label")).toContainText("錄音已中斷");
  await expect(page.getByTestId("meeting-screen")).not.toHaveAttribute("data-wakelock-state", "active");
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
  await expect(page.getByTestId("transcript-gap")).toBeVisible();
  // 最多重試 1 次（初始 1 + 重試 1），不得無限空轉
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBeLessThanOrEqual(2);

  // 回前景仍然中斷 → 不得重取；真的續錄才重新取得
  await setHidden(page, false);
  await expect(page.getByTestId("meeting-screen")).not.toHaveAttribute("data-wakelock-state", "active");
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
});

test("AC-2 / D4：真機電源鍵的另一種到場順序（頁面先 hidden、release 才到）→ 不得漏掉、也不得變成 lost", async ({ page }) => {
  // 同一件事的另一半：SPIKE-002 說電源鍵會讓 webview 變 hidden，瀏覽器行事的先後無保證。
  // 若 `hidden` 先到（我方主動收乾淨、listener 已移除），稍後才到的系統 release 事件必須是 no-op：
  // 不得噴「螢幕保護已失效」的假提示，也不得在背景多打一次註定被拒的 `request()`。
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 電源鍵反序");

  await setHidden(page, true);
  await expect(page.getByTestId("rec-state-label")).toContainText("錄音已中斷");
  await systemRelease(page); // 系統的 release 遲到：此刻 listener 已被我方移除

  await expect(page.getByTestId("meeting-screen")).not.toHaveAttribute("data-wakelock-state", "active");
  await expect(page.getByTestId("meeting-screen")).not.toHaveAttribute("data-wakelock-state", "lost");
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(1);

  await setHidden(page, false);
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
});

test("AC-2 / D4（Gate 4 第二輪）：release 先到、但系統已非前景（重取必被拒）→ 誠實說沒有保護，且不得回頭宣稱 active", async ({ page }) => {
  // Gate 4 第二輪獨立審查抓到：真機電源鍵的另一種到場順序是「系統已非前景，release 才到」。
  // 這時我方的重取註定被拒 → 依 D4 會降為 `lost` 並噴提示。這裡把那個落點釘住（AC v1.3）：
  // 寧可誠實說「現在沒有保護」，也不要停留在 `suspended`（無提示＝靜默無保護）。
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 先釋放後轉背景");

  await markFakeHidden(page, true); // 系統層已經不是前景，但 App 還不知道
  await systemRelease(page); // 觸發重取；此刻 request() 必被拒

  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "lost");
  await expect(page.getByTestId("wakelock-hint")).toContainText("離開會中斷錄音");
  // 只多打一次（初始 1 + 重試 1），不得無限空轉
  await expect.poll(async () => (await observeWakeLock(page)).calls).toBe(2);

  // App 終於知道已離開前景：`suspend()` 此時對 `lost` 是 no-op，狀態與提示都不得被改寫
  await setHidden(page, true);
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "lost");
  await expect(page.getByTestId("wakelock-hint")).toContainText("離開會中斷錄音");

  // 回前景並真的續錄 → 重新取得，提示才消失（不得殘留假訊息）
  await setHidden(page, false);
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
});

test("D9：結束會議就放掉 sentinel，不再宣稱螢幕受保護，也不殘留提示", async ({ page }) => {
  await installFakeWakeLock(page);
  await page.reload();
  await startMeeting(page, "E2E WakeLock 結束");
  await expect(page.getByTestId("meeting-screen")).toHaveAttribute("data-wakelock-state", "active");

  await holdToEnd(page);

  const observation = await observeWakeLock(page);
  expect(observation.sentinels[0]?.released).toBe(true);
  expect(observation.sentinels[0]?.releaseCalls).toBe(1);
  expect(observation.calls).toBe(1); // 我方釋放不得觸發「失去保護 → 重取」
  await expect(page.getByTestId("wakelock-hint")).toHaveCount(0);
});
