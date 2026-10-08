import { expect, test, type Page } from "@playwright/test";

/**
 * M01-US-107「背景／鎖屏缺口標記」的 E2E。
 *
 * 誠實聲明（測不到的部分與替代證據）：
 * 1. **iOS 真的鎖屏**：Chromium 無法鎖屏，中斷路徑一律由 `main.ts` 的 dev 鉤子
 *    `__tf.notifyVisibility(true)` 驅動（與 `document.visibilitychange` 同一條程式碼）。
 *    真機行為仍待 iOS 真機驗收（DoD 已列）。
 * 2. **系統把 webview 直接殺掉**：E2E 不能真的殺進程；「被殺掉後重開」由
 *    `app/ui/src/lib/transcript/gap-tracker.test.ts`（記憶體 + 假儲存）與
 *    `worker/test/transcript-gap-routes.test.ts`（未閉合缺口可續補）分別證明。
 *
 * 這一組刻意**同時**驗畫面與伺服端：只驗畫面會讓「畫得很誠實、但伺服端什麼都沒收到」
 * 這種假通過漏掉。
 */

const WORKER_BASE = "http://localhost:8787";
const MEETINGS_KEY = "tree_factory.meetings.v1";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => globalThis.localStorage.clear());
  await page.reload();
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
    const hook = (globalThis as unknown as { __tf?: { notifyVisibility: (h: boolean) => void } }).__tf;
    if (hook === undefined) throw new Error("dev 鉤子 __tf 不存在（是否以 dev 模式啟動？）");
    hook.notifyVisibility(value);
  }, hidden);
}

/** 讀伺服端的缺口清單（會議 id 每次執行都不同，DO 狀態不會互相污染）。 */
async function serverGaps(
  page: Page,
  meetingId: string,
): Promise<Array<{ seq: number; fromMs: number; toMs: number | null }>> {
  const response = await page.request.get(`${WORKER_BASE}/m/${meetingId}/transcript/gaps`);
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { gaps?: Array<{ seq: number; fromMs: number; toMs: number | null }> };
  return payload.gaps ?? [];
}

/** 等伺服端真的收到 N 筆（送出是 async；用重試代替睡固定秒數）。 */
async function expectServerGapCount(page: Page, meetingId: string, count: number): Promise<void> {
  await expect
    .poll(async () => (await serverGaps(page, meetingId)).length, { timeout: 5_000 })
    .toBe(count);
}

test("AC-1：切到背景的當下逐字稿就出現缺口，且明說結束時間未知", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 缺口測試");
  await page.waitForTimeout(1_200);

  await setHidden(page, true);

  const row = page.getByTestId("transcript-gap");
  await expect(row).toHaveCount(1, { timeout: 2_000 });
  await expect(row).toHaveAttribute("data-gap-open", "true");
  await expect(row).toContainText("未錄到");
  await expect(row).toContainText("結束時間未知");
  // 有缺口就不能再說「等待第一句…」——那會讓人以為這段沒人說話。
  await expect(page.getByTestId("transcript-waiting")).toHaveCount(0);

  await expectServerGapCount(page, meetingId, 1);
  const [gap] = await serverGaps(page, meetingId);
  expect(gap?.toMs).toBeNull();
  expect(gap?.fromMs).toBeGreaterThan(500);
});

test("AC-2：回到前景續錄後，同一列補上時間範圍（起訖 + 長度）", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 缺口補完測試");
  await page.waitForTimeout(1_000);
  await setHidden(page, true);
  await expect(page.getByTestId("transcript-gap")).toHaveAttribute("data-gap-open", "true");

  await page.waitForTimeout(1_500); // 中斷期間計時器凍結，這 1.5 秒不會算進長度
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");

  const row = page.getByTestId("transcript-gap");
  await expect(row).toHaveAttribute("data-gap-open", "false");
  await expect(row).toContainText("–"); // 「起 – 訖，共 N 秒」
  await expect(row).toContainText("共");

  await expect.poll(async () => (await serverGaps(page, meetingId))[0]?.toMs ?? null, { timeout: 5_000 }).not.toBeNull();
  const [gap] = await serverGaps(page, meetingId);
  // 這一段的長度就是「真的中斷了多久」（量到 1.5 秒）：
  // US-101 的選擇是「畫面上的計時器在中斷時凍結，但會議的時間軸照走」。
  // 所以缺口 = [中斷時刻, 回到前景時刻]，音檔在那段時間真的沒收到。
  expect(gap?.toMs! - gap!.fromMs).toBeGreaterThanOrEqual(1_000);
  expect(gap?.toMs! - gap!.fromMs).toBeLessThan(4_000);
  await expect(row).toContainText("共");
});

test("AC-3：中斷期間重複的 hidden 不得標出第二筆（畫面與伺服端都只有一筆）", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 重複中斷測試");
  await page.waitForTimeout(800);

  await setHidden(page, true);
  await setHidden(page, true);
  await setHidden(page, true);

  await expect(page.getByTestId("transcript-gap")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("transcript-gap")).toHaveCount(1);
  await expectServerGapCount(page, meetingId, 1);
});

test("Edge：兩次不同的中斷各自一列，seq 遞增（逐字稿順序可以排）", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 兩次中斷測試");
  await setHidden(page, true);
  await expect(page.getByTestId("transcript-gap")).toHaveCount(1);
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");

  await setHidden(page, true);
  await expect(page.getByTestId("transcript-gap")).toHaveCount(2);
  await page.getByTestId("btn-resume").click();

  await expectServerGapCount(page, meetingId, 2);
  const gaps = await serverGaps(page, meetingId);
  expect(gaps.map((gap) => gap.seq)).toEqual([1, 2]);
  expect(gaps[1]!.fromMs).toBeGreaterThanOrEqual(gaps[0]!.toMs ?? 0);
});

test("離線時缺口仍在畫面上，但誠實標「待同步」；恢復後才變成已同步", async ({ page }) => {
  await startMeeting(page, "E2E 離線缺口測試");
  await page.route("**/transcript/gap", (route) => route.abort("failed"));

  await setHidden(page, true);
  const row = page.getByTestId("transcript-gap");
  await expect(row).toHaveCount(1, { timeout: 2_000 });
  await expect(page.getByTestId("gap-pending")).toBeVisible();
  await expect(row).toContainText("結束時間未知");

  await page.unroute("**/transcript/gap");
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");
  await expect(page.getByTestId("gap-pending")).toHaveCount(0, { timeout: 5_000 });
});

test("Edge（Gate 4 第 2 輪）：離線時寫入的缺口，網路恢復（online）就會自動補送", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 缺口 online 補送測試");
  await page.waitForTimeout(800);
  await page.route("**/transcript/gap", (route) => route.abort("failed"));

  await setHidden(page, true);
  await expect(page.getByTestId("transcript-gap")).toHaveCount(1, { timeout: 2_000 });
  await expect(page.getByTestId("gap-pending")).toBeVisible();

  // 只做「網路恢復」：使用者**不**回前景、**不**續錄、**不**重新整理。
  // 這種情況下缺口也必須自己送出去（設計 §4 把 online 列為補送時機）。
  await page.unroute("**/transcript/gap");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page.getByTestId("gap-pending")).toHaveCount(0, { timeout: 5_000 });
  await expectServerGapCount(page, meetingId, 1);
});

test("Edge：回到前景但還沒按「繼續」時，缺口不得被提前關掉（不然會少報中斷長度）", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 前景未續錄測試");
  await page.waitForTimeout(1_000);
  await setHidden(page, true);
  const row = page.getByTestId("transcript-gap");
  await expect(row).toHaveAttribute("data-gap-open", "true");

  // 回到前景（visibilitychange → visible），但使用者**還沒**按「繼續這場會議？」。
  // 依 state.ts：`visibility_visible` 不自動續錄，所以這一刻錄音還是停的——
  // 缺口必須持續開著，不然畫面會說「只缺 1 秒」而使用者真實缺了 2.5 秒。
  await page.waitForTimeout(1_500);
  await setHidden(page, false);
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音已中斷");
  await expect(row).toHaveAttribute("data-gap-open", "true");
  await expect(row).toContainText("結束時間未知");
  await expect.poll(async () => (await serverGaps(page, meetingId))[0]?.toMs ?? null).toBeNull();

  // 真的續錄之後才補結束時間，而且長度要涵蓋整段中斷——包含「回到前景後等到真的按下繼續」
  // 的那 1.5 秒（提前關掉缺口的版本會得到 ~0，因為它把凍結值當成結束時間）。
  await page.getByTestId("btn-resume").click();
  await expect(page.getByTestId("rec-state-label")).toHaveText("錄音中");
  await expect(row).toHaveAttribute("data-gap-open", "false");
  await expect
    .poll(async () => (await serverGaps(page, meetingId))[0]?.toMs ?? null, { timeout: 5_000 })
    .not.toBeNull();
  const [gap] = await serverGaps(page, meetingId);
  expect(gap!.toMs! - gap!.fromMs).toBeGreaterThanOrEqual(1_500);
});

test("Edge：會議結束後 app 再進背景，不得冒出幽靈缺口", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 結束後背景測試");
  const button = page.getByTestId("btn-end-hold");
  const box = await button.boundingBox();
  if (box === null) throw new Error("找不到長按按鈕的位置");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_300);
  await page.mouse.up();
  await expect(page.getByTestId("meeting-screen")).toHaveCount(0);

  // 會議已結束，進背景不應該再產生「此段未錄到」——那會讓逐字稿多出一段從不存在的缺口。
  await setHidden(page, true);
  await page.waitForTimeout(500);
  const stored = await page.evaluate(
    (id) => globalThis.localStorage.getItem(`tree_factory.transcript-gaps.v1:${id}`),
    meetingId,
  );
  expect(stored).toBeNull();
  expect(await serverGaps(page, meetingId)).toHaveLength(0);
});

test("結束會議前會把還開著的缺口收尾，不留「結束時間未知」的尾巴", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 中斷後結束測試");
  await setHidden(page, true);
  await expect(page.getByTestId("transcript-gap")).toHaveAttribute("data-gap-open", "true");
  // 真的中斷一下才結束：不然「收尾成 0 長度」也會過關（Gate 4 F4 說的就是這種假綠）。
  await page.waitForTimeout(1_200);

  // 中斷狀態下長按結束會議（中斷不是「使用者不想結束」的理由）。
  const button = page.getByTestId("btn-end-hold");
  const box = await button.boundingBox();
  if (box === null) throw new Error("找不到長按按鈕的位置");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_300);
  await page.mouse.up();
  await expect(page.getByTestId("meeting-screen")).toHaveCount(0);

  await expect.poll(async () => (await serverGaps(page, meetingId))[0]?.toMs ?? null, { timeout: 5_000 }).not.toBeNull();
  const [gap] = await serverGaps(page, meetingId);
  expect(gap!.toMs! - gap!.fromMs).toBeGreaterThanOrEqual(1_000);
});