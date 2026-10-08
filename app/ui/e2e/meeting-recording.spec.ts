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

test.describe.configure({ mode: "serial" });

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
  return Date.now() - clickedAt;
}

async function startMeeting(page: Page, title: string): Promise<number> {
  const elapsed = await submitStart(page, title);
  await expect(page.getByTestId("meeting-screen")).toBeVisible();
  return elapsed;
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
  expect(elapsed).toBeLessThan(3_000);

  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");
  await expect(page.getByTestId("rec-light")).toHaveClass(/rec/);
  await expect(page.getByTestId("transcript-waiting")).toBeVisible();

  const first = await page.getByTestId("timer").textContent();
  await page.waitForTimeout(1_600);
  const second = await page.getByTestId("timer").textContent();
  expect(second).not.toBe(first);
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
