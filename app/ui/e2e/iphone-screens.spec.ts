// TECH-007（續）— 其餘畫面的手機寬度：不溢出／點擊區 ≥44px／橫向安全區。
//
// 為什麼要這一支：2026-10-09 的真機驗收暴露了**一整家族**的「按不到」——狀態列蓋住
// 「開始會議」、Home Indicator 吃掉「長按結束會議」、逐字稿撐高把按鈕推出畫面。
// 第一輪只補了「會議中」畫面（`iphone-viewport.spec.ts` 3 條），其餘三個畫面
// （會議列表 / 開始 sheet / 權限阻斷頁）從來沒在手機寬度被檢查過，而且**橫向**
// 完全沒有處理：`index.html` 只宣告上下安全區，橫向時瀏海在左右。
//
// 這一支刻意**只驗幾何**（數字），不驗顏色／美感，也不做截圖比對：
// 產出這一票的 agent 看不到圖，截圖無法當斷言。三個不變式（設計 D1）：
//   1. 不得橫向溢出（會出現左右滑動＝手機上明顯壞掉）
//   2. 主要互動元素點擊高度 ≥ 44px（專案既有 `--tap`，DESIGN §2.3）
//   3. 主要 CTA 完整落在「扣掉安全區的可視矩形」內（先 scrollIntoViewIfNeeded：
//      可捲動的內容只要求「能被帶進安全矩形」，不要求免捲動就全部可見）
//
// 為什麼權限阻斷頁用「真的拒權」：在頁面腳本之前用 `addInitScript` 把 `getUserMedia()`
// 換成直接丟 `NotAllowedError`（見下方 `denyMicrophone`），讓 `getUserMedia()` 真的失敗，
// 於是 `confirmStart` 真的走 `PERMISSION_DENIED` 分支（設計 D5：不加測試縫）。
//
// 為什麼橫向要三組夾具：真機橫向的瀏海**只在一邊**（單邊 44pt），對稱夾具（44／44）驗不到
// 「左右顛倒」與「只讓開一邊」這兩類缺陷（Gate 4 oracle 實測兩者在 44／44 下都是 0 紅）。
//
// 為什麼**不**斷言會議列表每一列的點擊高度（`meeting-item`）：它目前是純顯示的 `<li>`
// （phase A 還沒有「開啟會議」），對不能點的元素斷言「點擊高度 ≥44px」是類別錯誤。
// 它仍受 AC-1（不溢出）與 AC-4 的容器幾何約束；等列真的可點再加回白名單（設計 D4）。
//
// ⚠️ 誠實揭露：安全區數值是**注入的常數**（與已交付的 3 條同一手法），真機的 env()
// 由 WebKit 計算、橫向的左右值還取決於握持方向。真機仍是最終驗收依據；本測試的價值
// 是「同一個錯誤不會再無聲溜過」。
import { expect, test, type Locator, type Page } from "@playwright/test";

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Size {
  width: number;
  height: number;
}

const PORTRAIT: Size = { width: 390, height: 844 };
const LANDSCAPE: Size = { width: 844, height: 390 };
/** iPhone 12 mini 實測（肖像）：狀態列 50pt、Home Indicator 34pt，左右為 0。 */
const PORTRAIT_INSETS: Insets = { top: 50, bottom: 34, left: 0, right: 0 };
/** 同一台轉橫：瀏海換到左右（各 44pt），底部 Home Indicator 縮為 21pt，頂端為 0。 */
const LANDSCAPE_INSETS: Insets = { top: 0, bottom: 21, left: 44, right: 44 };

/** 手機裝置參數（與已交付的 `iphone-viewport.spec.ts` 同一組值）。 */
const PHONE_USE = { deviceScaleFactor: 3, isMobile: true, hasTouch: true } as const;

/**
 * 拒權用：在**瀏覽器邊界**把 `getUserMedia()` 換成直接丟 `NotAllowedError`。
 *
 * 為什麼不是用 `test.use({ permissions: [], launchOptions })`：`launchOptions` 只要寫在
 * `test.describe` 裡，Playwright 就會**強制換一個 worker**並當場報錯
 * （實測訊息：`Cannot use({ launchOptions }) in a describe group, because it forces a new worker.`）。
 * 而 config 的 `--use-fake-ui-for-media-stream` 又會**自動按下允許**，光收回 `permissions` 不一定拒得成。
 * 所以改成跟正式程式碼同一條路徑：讓瀏覽器丟 `NotAllowedError` → `store.ts` 對映成
 * `permission_denied`（設計 D5：**不加測試縫**，改在邊界偽造）。呼叫時機必須在 `page.goto()` **之前**。
 */
async function denyMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = (): Promise<MediaStream> =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
}

const TAP = 44;
/** 次像素捨入：1px 內的差異不算溢出。 */
const SLACK = 1;

/** 把假安全區塞進 `:root`——正式程式碼一律用 var(--safe-*)，所以這樣就等於真機版面。 */
function safeAreaCss(insets: Insets): string {
  return `:root{--safe-top:${insets.top}px;--safe-bottom:${insets.bottom}px;--safe-left:${insets.left}px;--safe-right:${insets.right}px;}`;
}

/** 每個測試都從乾淨的本機列表開始（worker 的 DO 與 localStorage 是共用資源）。 */
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => globalThis.localStorage.clear());
});

async function openList(page: Page, insets: Insets): Promise<void> {
  await page.goto("/");
  await page.addStyleTag({ content: safeAreaCss(insets) });
  await expect(page.getByTestId("btn-start-meeting")).toBeVisible();
}

async function openSheet(page: Page, insets: Insets): Promise<void> {
  await openList(page, insets);
  await page.getByTestId("btn-start-meeting").click();
  await expect(page.getByTestId("start-sheet")).toBeVisible();
}

/** 真的走一次「開始 → 長按 1.4 秒結束」，讓列表有一列**真實資料**（設計 D6）。 */
async function openListWithMeeting(page: Page, insets: Insets, title: string): Promise<void> {
  await openList(page, insets);
  await page.getByTestId("btn-start-meeting").click();
  await page.getByTestId("input-title").fill(title);
  await page.getByTestId("btn-start-confirm").click();
  await expect(page.getByTestId("meeting-screen")).toBeVisible({ timeout: 10_000 });

  const end = page.getByTestId("btn-end-hold");
  const box = await end.boundingBox();
  if (box === null) throw new Error("找不到長按結束按鈕的位置");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_400);
  await page.mouse.up();
  await expect(page.getByTestId("meeting-item")).toHaveAttribute("data-status", "ended");
}

/** 走真的拒權路徑：`confirmStart` 拿到 `PERMISSION_DENIED` → 阻斷頁。 */
async function openBlocked(page: Page, insets: Insets): Promise<void> {
  await openSheet(page, insets);
  await page.getByTestId("btn-start-confirm").click();
  await expect(page.getByTestId("perm-blocked")).toBeVisible({ timeout: 10_000 });
}

/** 量「文件層 + 指定容器」的橫向溢出量（px）。 */
async function overflowPx(page: Page, selector: string | null): Promise<number> {
  return page.evaluate((sel) => {
    const el = sel === null ? document.documentElement : document.querySelector(sel);
    if (el === null) throw new Error(`找不到容器 ${sel}`);
    return el.scrollWidth - el.clientWidth;
  }, selector);
}

/** AC-1：文件層與主要容器都不得橫向溢出。 */
async function expectNoHorizontalOverflow(page: Page, name: string): Promise<void> {
  const selectors: Array<string | null> = [null, ".content", ".shell", ".tabbar"];
  for (const selector of selectors) {
    const overflow = await overflowPx(page, selector);
    expect(
      overflow,
      `${name}：${selector ?? "document"} 橫向溢出 ${overflow}px（使用者得左右滑才看得到內容）`,
    ).toBeLessThanOrEqual(SLACK);
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rectOf(locator: Locator, name: string): Promise<Rect> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `量不到 ${name} 的位置（可能被隱藏或不存在）`).not.toBeNull();
  return box!;
}

/** AC-2：主要互動元素的點擊高度 ≥ 44px。 */
async function expectTapTarget(locator: Locator, name: string): Promise<void> {
  const box = await rectOf(locator, name);
  expect(box.height, `${name} 的點擊高度只有 ${box.height.toFixed(1)}px（< ${TAP}px，手指按不準）`)
    .toBeGreaterThanOrEqual(TAP);
}

/** AC-3 / AC-4：主要 CTA 必須完整落在「扣掉安全區的可視矩形」內。 */
async function expectInsideSafeArea(
  page: Page,
  locator: Locator,
  name: string,
  size: Size,
  insets: Insets,
): Promise<void> {
  const box = await rectOf(locator, name);
  const rightEdge = size.width - insets.right;
  const bottomEdge = size.height - insets.bottom;
  expect(box.x, `${name} 左緣 x=${box.x.toFixed(1)} 落在 ${insets.left}pt 的左安全區裡`)
    .toBeGreaterThanOrEqual(insets.left - SLACK);
  expect(box.y, `${name} 頂端 y=${box.y.toFixed(1)} 落在 ${insets.top}pt 的頂安全區裡`)
    .toBeGreaterThanOrEqual(insets.top - SLACK);
  expect(
    box.x + box.width,
    `${name} 右緣 x=${(box.x + box.width).toFixed(1)} 超過 ${rightEdge}pt（右安全區 ${insets.right}pt）`,
  ).toBeLessThanOrEqual(rightEdge + SLACK);
  expect(
    box.y + box.height,
    `${name} 底緣 y=${(box.y + box.height).toFixed(1)} 超過 ${bottomEdge}pt（底安全區 ${insets.bottom}pt）`,
  ).toBeLessThanOrEqual(bottomEdge + SLACK);
}

/** 分頁列（三個畫面都有）：手機上永遠在底部，也必須讓開左右／底部安全區。 */
async function expectTabbarReachable(page: Page, size: Size, insets: Insets): Promise<void> {
  for (const id of ["tab-meetings", "tab-chat"]) {
    await expectInsideSafeArea(page, page.getByTestId(id), id, size, insets);
  }
}

/** 容器本身也要讓開左右安全區：`.shell` 的 padding 少一邊或左右顛倒時，這裡會紅。 */
async function expectContentInsideSafeArea(
  page: Page,
  name: string,
  size: Size,
  insets: Insets,
): Promise<void> {
  const box = await rectOf(page.locator(".content"), `${name} 的 .content`);
  expect(box.x, `${name}：.content 左緣 x=${box.x.toFixed(1)} 沒有讓開 ${insets.left}pt 的左安全區`)
    .toBeGreaterThanOrEqual(insets.left - SLACK);
  expect(
    box.x + box.width,
    `${name}：.content 右緣 x=${(box.x + box.width).toFixed(1)} 沒有讓開 ${insets.right}pt 的右安全區`,
  ).toBeLessThanOrEqual(size.width - insets.right + SLACK);
}

// ── 肖像：列表與開始 sheet（需要麥克風，沿用 config 的假麥克風） ──────────────
test.describe("肖像 390×844：會議列表與開始 sheet", () => {
  test.use({ viewport: PORTRAIT, ...PHONE_USE });

  test("TECH-007 AC-1／AC-2／AC-3：會議列表（空狀態）不溢出、「開始會議」點得到", async ({ page }) => {
    await openList(page, PORTRAIT_INSETS);
    await expect(page.getByTestId("list-empty")).toBeVisible();

    await expectNoHorizontalOverflow(page, "會議列表（空）");
    await expectTapTarget(page.getByTestId("btn-start-meeting"), "開始會議");
    await expectInsideSafeArea(page, page.getByTestId("btn-start-meeting"), "開始會議", PORTRAIT, PORTRAIT_INSETS);
    await expectTabbarReachable(page, PORTRAIT, PORTRAIT_INSETS);
  });

  test("TECH-007 AC-1／AC-3：長標題會議列不得把列表撐爆，「開始會議」仍在安全區內", async ({ page }) => {
    // 標題長度才是溢出的成因，所以刻意寫到接近元件 `maxlength=80` 的長標題。
    await openListWithMeeting(
      page,
      PORTRAIT_INSETS,
      "這是一場標題刻意寫得非常長的會議用來檢查窄螢幕不會被標題撐爆而需要左右滑動才看得到",
    );
    await expect(page.getByTestId("meeting-list")).toBeVisible();

    await expectNoHorizontalOverflow(page, "會議列表（有長標題）");
    await expectInsideSafeArea(page, page.getByTestId("btn-start-meeting"), "開始會議", PORTRAIT, PORTRAIT_INSETS);
    await expectTabbarReachable(page, PORTRAIT, PORTRAIT_INSETS);
  });

  test("TECH-007 AC-1／AC-2／AC-3：開始 sheet 不溢出、輸入框與「開始」都按得到", async ({ page }) => {
    await openSheet(page, PORTRAIT_INSETS);

    await expectNoHorizontalOverflow(page, "開始 sheet");
    await expectTapTarget(page.getByTestId("input-title"), "會議標題輸入框");
    await expectTapTarget(page.getByTestId("btn-start-confirm"), "開始（確認）");
    await expectInsideSafeArea(page, page.getByTestId("btn-start-confirm"), "開始（確認）", PORTRAIT, PORTRAIT_INSETS);
    await expectTabbarReachable(page, PORTRAIT, PORTRAIT_INSETS);
  });
});

// ── 肖像：權限阻斷頁（這一組刻意收回麥克風權限） ─────────────────────────────
test.describe("肖像 390×844：權限阻斷頁（真的拒權）", () => {
  test.use({ viewport: PORTRAIT, ...PHONE_USE });

  test("TECH-007 AC-1／AC-2／AC-3：權限阻斷頁不溢出、「再試一次」點得到又在安全區內", async ({ page }) => {
    await denyMicrophone(page);
    await openBlocked(page, PORTRAIT_INSETS);

    await expectNoHorizontalOverflow(page, "權限阻斷頁");
    await expectTapTarget(page.getByTestId("btn-perm-retry"), "再試一次");
    await expectInsideSafeArea(page, page.getByTestId("btn-perm-retry"), "再試一次", PORTRAIT, PORTRAIT_INSETS);
    await expectTabbarReachable(page, PORTRAIT, PORTRAIT_INSETS);
  });
});

// ── 橫向（844×390）：三個畫面 × 三組安全區夾具 ───────────────────────────────
// 真機橫向只有一邊有瀏海，所以橫向三條各跑三組夾具：對稱、只有左邊、只有右邊。
const LANDSCAPE_FIXTURES: Array<{ name: string; insets: Insets }> = [
  { name: "左右各 44", insets: LANDSCAPE_INSETS },
  { name: "只有左邊 44", insets: { ...LANDSCAPE_INSETS, right: 0 } },
  { name: "只有右邊 44", insets: { ...LANDSCAPE_INSETS, left: 0 } },
];

test.describe("橫向 844×390：會議列表與開始 sheet", () => {
  test.use({ viewport: LANDSCAPE, ...PHONE_USE });

  for (const fixture of LANDSCAPE_FIXTURES) {
    const label = `橫向（${fixture.name}）`;

    test(`TECH-007 AC-4：${label}會議列表不溢出、「開始會議」讓開左右安全區`, async ({ page }) => {
      await openList(page, fixture.insets);

      await expectNoHorizontalOverflow(page, `${label}會議列表`);
      await expectContentInsideSafeArea(page, `${label}會議列表`, LANDSCAPE, fixture.insets);
      await expectTapTarget(page.getByTestId("btn-start-meeting"), `開始會議（${label}）`);
      await expectInsideSafeArea(
        page,
        page.getByTestId("btn-start-meeting"),
        `開始會議（${label}）`,
        LANDSCAPE,
        fixture.insets,
      );
      await expectTabbarReachable(page, LANDSCAPE, fixture.insets);
    });

    test(`TECH-007 AC-4：${label}開始 sheet 不溢出、「開始」讓開左右安全區`, async ({ page }) => {
      await openSheet(page, fixture.insets);

      await expectNoHorizontalOverflow(page, `${label}開始 sheet`);
      await expectContentInsideSafeArea(page, `${label}開始 sheet`, LANDSCAPE, fixture.insets);
      await expectTapTarget(page.getByTestId("btn-start-confirm"), `開始（確認，${label}）`);
      await expectInsideSafeArea(
        page,
        page.getByTestId("btn-start-confirm"),
        `開始（確認，${label}）`,
        LANDSCAPE,
        fixture.insets,
      );
      await expectTabbarReachable(page, LANDSCAPE, fixture.insets);
    });
  }
});

test.describe("橫向 844×390：權限阻斷頁（真的拒權）", () => {
  test.use({ viewport: LANDSCAPE, ...PHONE_USE });

  for (const fixture of LANDSCAPE_FIXTURES) {
    const label = `橫向（${fixture.name}）`;

    test(`TECH-007 AC-4：${label}權限阻斷頁不溢出、按鈕讓開左右安全區`, async ({ page }) => {
      await denyMicrophone(page);
      await openBlocked(page, fixture.insets);

      await expectNoHorizontalOverflow(page, `${label}權限阻斷頁`);
      await expectContentInsideSafeArea(page, `${label}權限阻斷頁`, LANDSCAPE, fixture.insets);
      await expectTapTarget(page.getByTestId("btn-perm-retry"), `再試一次（${label}）`);
      await expectInsideSafeArea(
        page,
        page.getByTestId("btn-perm-retry"),
        `再試一次（${label}）`,
        LANDSCAPE,
        fixture.insets,
      );
      await expectTabbarReachable(page, LANDSCAPE, fixture.insets);
    });
  }
});
