import { expect, test, type Page } from "@playwright/test";

/**
 * M01-US-101「一鍵開始 / 結束會議錄音」的 E2E。
 *
 * 誠實聲明（兩件事測不到，說明替代證據在哪）：
 * 1. **兩小時**：E2E 只把伺服端回傳的 `endsAtMs` 壓縮成 3 秒（其餘欄位原封不動），
 *    時間到的判定仍走同一段程式碼。真正的 2 小時邊界由注入時鐘的
 *    `worker/test/session-routes.test.ts` 與 `app/ui/src/lib/recorder/limit.test.ts` 證明。
 * 2. **iOS 鎖屏**：Chromium 無法真的鎖屏，所以中斷路徑由 `main.ts` 暴露的 dev 鉤子
 *    `__tf.notifyVisibility(true)` 驅動（與 `document.visibilitychange` 走同一條程式碼）。
 *    真機行為仍待 iOS 真機驗收（DoD 已列）。
 */

// 刻意「不」用 `mode: "serial"`：序列模式一旦有一條失敗，後面全部 skipped，
// 反而讓證據變少（稽核時只看得到第一條）。這裡靠 `workers: 1` + 每個測試清 localStorage
// 保持隔離，失敗時其餘測試照跑，一次看完全部問題。

/** 每個測試都從乾淨的本機列表開始（同一顆瀏覽器、同一個 origin）。 */
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => globalThis.localStorage.clear());
  await page.reload();
});

async function submitStart(page: Page, title: string): Promise<number> {
  await page.getByTestId("btn-start-meeting").click();
  await expect(page.getByTestId("start-sheet")).toBeVisible();
  await page.getByTestId("input-title").fill(title);
  const clickedAt = Date.now();
  await page.getByTestId("btn-start-confirm").click();
  return clickedAt;
}

/**
 * 按下確認 → 必須在 3 秒內真的看到「會議中」畫面。
 * `toBeVisible({ timeout: 3_000 })` 就是 AC-1 的斷言本體（超時即失敗）；
 * 回傳的 elapsed 是同一段時間的實際值，只是把它印出來讓人看得見。
 */
async function startMeeting(page: Page, title: string): Promise<number> {
  const clickedAt = await submitStart(page, title);
  await expect(page.getByTestId("meeting-screen")).toBeVisible({ timeout: 3_000 });
  return Date.now() - clickedAt;
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    const hook = (globalThis as unknown as { __tf?: { notifyVisibility: (h: boolean) => void } }).__tf;
    if (hook === undefined) throw new Error("dev 鉤子 __tf 不存在（是否以 dev 模式啟動？）");
    hook.notifyVisibility(value);
  }, hidden);
}

test("首頁：空狀態 + 兩分頁容器都存在（階段 A 就要有 tab bar）", async ({ page }) => {
  await expect(page.getByTestId("list-empty")).toBeVisible();
  await expect(page.getByTestId("tab-meetings")).toBeVisible();
  await page.getByTestId("tab-chat").click();
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await page.getByTestId("tab-meetings").click();
  await expect(page.getByTestId("list-empty")).toBeVisible();
});

test("AC-1：按開始後 3 秒內進入「錄音中」，紅燈亮、計時器在跑", async ({ page }) => {
  const elapsed = await startMeeting(page, "E2E 週會");
  expect(elapsed, `${elapsed}ms`).toBeLessThan(3_000);

  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");
  await expect(page.getByTestId("rec-light")).toHaveClass(/rec/);
  await expect(page.getByTestId("transcript-waiting")).toBeVisible();

  // 計時器必須會動。顯示是每秒量化一次（setInterval 1s，不是從 session 開始對齊），
  // 所以不能用「睡 1600ms 後期望不同」這種相位敏感的寫法——改用會自己重試的斷言。
  await expect(page.getByTestId("timer")).not.toHaveText("00:00", { timeout: 4_000 });
});

test("AC-4：切到背景後計時器凍結、紅燈熄、明說中斷時間；回來後可續錄", async ({ page }) => {
  await startMeeting(page, "E2E 背景測試");
  await page.waitForTimeout(1_200);

  await setHidden(page, true);
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音已中斷");
  await expect(page.getByTestId("banner-interrupt")).toContainText("錄音已中斷");
  await expect(page.getByTestId("rec-light")).not.toHaveClass(/rec/);

  // 計時器必須凍結：等 2 秒之後讀值不得變。
  const frozen = await page.getByTestId("timer").textContent();
  await page.waitForTimeout(2_000);
  expect(await page.getByTestId("timer").textContent()).toBe(frozen);

  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");
  await expect(page.getByTestId("rec-light")).toHaveClass(/rec/);
  await page.waitForTimeout(1_200);
  expect(await page.getByTestId("timer").textContent()).not.toBe(frozen);
});

test("AC-2：長按填滿 1 秒結束會議，列表顯示已結束", async ({ page }) => {
  await startMeeting(page, "E2E 結束測試");
  const button = page.getByTestId("btn-end-hold");
  const box = await button.boundingBox();
  if (box === null) throw new Error("找不到長按按鈕的位置");

  // 先驗「誤觸不會結束」：按下後立刻放開，畫面必須留在會議中。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(page.getByTestId("meeting-screen")).toBeVisible();

  await page.mouse.down();
  await page.waitForTimeout(1_400);
  await page.mouse.up();

  await expect(page.getByTestId("meeting-screen")).not.toBeVisible();
  await expect(page.getByTestId("meeting-item")).toHaveAttribute("data-status", "ended");
  await expect(page.getByTestId("meeting-item")).toContainText("E2E 結束測試");
});

test("AC-5 + AC-6：剩 5 分鐘內黃橫幅（紅燈仍亮）→ 到點自動結束並給兩個出口", async ({ page }) => {
  // 時間壓縮：只把伺服端回的 ends_at 提前成 3 秒，其餘欄位不動。
  await page.route("**/session/start", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    if (body.phase === "recording") body.endsAtMs = Date.now() + 3_000;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });

  await startMeeting(page, "E2E 上限測試");
  await expect(page.getByTestId("banner-warn")).toContainText("2 小時上限");
  await expect(page.getByTestId("rec-light")).toHaveClass(/rec/); // 紅燈不得提前熄

  await expect(page.getByTestId("panel-limit")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("panel-limit")).toContainText("2:00 之後的內容不會被記錄");
  await expect(page.getByTestId("rec-light")).not.toHaveClass(/rec/);

  await page.getByTestId("btn-generate-note").click();
  await expect(page.getByTestId("toast")).toContainText("M02-US-203");
  await expect(page.getByTestId("meeting-item")).toHaveAttribute("data-status", "ended");
});

test("AC-3：麥克風被拒時進阻斷頁、明說原因並給設定指引（不得靜默失敗）", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  });
  await page.reload();

  await submitStart(page, "E2E 權限測試");
  await expect(page.getByTestId("perm-blocked")).toBeVisible();
  await expect(page.getByTestId("perm-blocked")).toContainText("麥克風");
  await expect(page.getByTestId("perm-blocked")).toContainText("設定");
  await expect(page.getByTestId("btn-perm-retry")).toBeVisible();
});

test("圖示一律 inline SVG，不是 emoji（DESIGN.md §5 規則 8 / TECH-011）", async ({ page }) => {
  // 會議列表空狀態：圖示必須是 <svg>，且文字節點裡不得夾帶 emoji
  await expect(page.getByTestId("list-empty")).toBeVisible();
  await expect(page.getByTestId("list-empty").locator("svg")).toBeVisible();
  const emptyText = await page.getByTestId("list-empty").innerText();
  expect(emptyText).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);

  // 底部 tab bar：兩個分頁都要有 svg 圖示，文字只留標籤
  await expect(page.getByTestId("tab-meetings").locator("svg")).toBeVisible();
  await expect(page.getByTestId("tab-chat").locator("svg")).toBeVisible();
  await expect(page.getByTestId("tab-meetings")).toHaveText("會議");

  // 對話首頁空狀態（38pt 大圖示）
  await page.getByTestId("tab-chat").click();
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.getByTestId("chat-empty").getByTestId("icon-chat")).toBeVisible();
});

test("權限被拒頁的圖示也是 SVG（原型同源：ban）", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  });
  await page.reload();

  await submitStart(page, "E2E 圖示測試");
  await expect(page.getByTestId("perm-blocked")).toBeVisible();
  await expect(page.getByTestId("icon-ban")).toBeVisible();
});
