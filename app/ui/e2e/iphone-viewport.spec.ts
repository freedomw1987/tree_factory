// M01 真機驗收修復（2026-10-09）：iPhone 尺寸下的兩個「安全區」bug。
//
// 為什麼要專門用「手機視窗 + 假安全區」再跑一條：E2E 專案用 Desktop Chrome（視窗高、
// 安全區恆為 0），下面兩件事在桌機永遠不會發生，所以先前 6 條 E2E 全綠卻擋不住真機：
//
//   1. 最上面的「開始會議」落在狀態列（約 50pt）底下 → 使用者「按不到開始會議 button」
//   2. 最下面的「長按結束會議」落進 Home Indicator 手勢區（34pt）→ 「結束會議按不到」
//
// 做法：`app.css` 把安全區抽成 `--safe-top` / `--safe-bottom`，這裡注入 iPhone 12 mini
// 的實測值（390×844pt、top 50、bottom 34），把真機版面搬進 CI。
//
// ⚠️ 誠實揭露：這是**近似**（真機的 env() 由 WebKit 算，這裡是注入常數），
// 真機仍是唯一最終驗收依據；本測試的價值是「同一個錯誤不會再無聲溜過」。
import { expect, test, type Page } from "@playwright/test";

const VIEWPORT = { width: 390, height: 844 };
const SAFE_TOP = 50; // iPhone 12 mini 狀態列
const SAFE_BOTTOM = 34; // iPhone 12 mini Home Indicator 手勢區

test.use({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

async function simulateIphoneSafeArea(page: Page) {
  await page.addStyleTag({
    content: `:root { --safe-top: ${SAFE_TOP}px; --safe-bottom: ${SAFE_BOTTOM}px; }`,
  });
}

test("iPhone 390×844：最上面的「開始會議」不得被狀態列蓋住", async ({ page }) => {
  await page.goto("/");
  await simulateIphoneSafeArea(page);

  const start = page.getByTestId("btn-start-meeting");
  await expect(start).toBeVisible();
  const box = await start.boundingBox();
  expect(box, "量不到「開始會議」按鈕的位置").not.toBeNull();
  expect(
    box!.y,
    `「開始會議」頂端 y=${box!.y.toFixed(1)} 落在 ${SAFE_TOP}pt 的狀態列裡，點擊會被 iOS 吃掉`,
  ).toBeGreaterThanOrEqual(SAFE_TOP);
});

test("iPhone 390×844：最下面的「長按結束會議」不得落進 Home Indicator 手勢區", async ({ page }) => {
  await page.goto("/");
  await simulateIphoneSafeArea(page);

  await page.getByTestId("btn-start-meeting").click();
  await page.getByTestId("btn-start-confirm").click();

  const end = page.getByTestId("btn-end-hold");
  await expect(end).toBeVisible();
  const box = await end.boundingBox();
  expect(box, "量不到「長按結束會議」按鈕的位置").not.toBeNull();
  const clearance = VIEWPORT.height - (box!.y + box!.height);
  expect(
    clearance,
    `按鈕底緣距畫面底只剩 ${clearance.toFixed(1)}px；${SAFE_BOTTOM}pt 的手勢區會把按住事件吃掉`,
  ).toBeGreaterThanOrEqual(SAFE_BOTTOM);
});

// 同一個「按不到」家族的第三個寫法：逐字稿長起來把結束按鈕往下擠，使用者得先用手滑到
// 最底下（真機第一次驗收時，使用者就是這樣「原來是可以 scroll down」才按到的）。
// 要求：逐字稿區自己捲，結束按鈕永遠停在看得見、按得下的位置。
test("iPhone 390×844：逐字稿變長時，「長按結束會議」仍留在底部手勢區之上", async ({ page }) => {
  await page.goto("/");
  await simulateIphoneSafeArea(page);
  await page.getByTestId("btn-start-meeting").click();
  await page.getByTestId("btn-start-confirm").click();

  const end = page.getByTestId("btn-end-hold");
  await expect(end).toBeVisible();
  await page.getByTestId("transcript").evaluate((el) => {
    for (let i = 1; i <= 60; i += 1) {
      const line = document.createElement("p");
      line.textContent = `逐字稿第 ${i} 句：這是一行用來把容器灌滿的假文字。`;
      el.append(line);
    }
  });

  const box = await end.boundingBox();
  expect(box, "量不到「長按結束會議」按鈕的位置").not.toBeNull();
  const clearance = VIEWPORT.height - (box!.y + box!.height);
  expect(
    clearance,
    `逐字稿被灌滿之後，按鈕底緣距畫面底剩 ${clearance.toFixed(1)}px（會被擠出畫面／掉進手勢區）`,
  ).toBeGreaterThanOrEqual(SAFE_BOTTOM);
});
