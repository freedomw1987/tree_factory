import { expect, test, type Page } from "@playwright/test";
// TECH-009：下面第 3 條要用同一顆憑證值來比對瀏覽器實際送出的 header。
import { AUTH, E2E_DEVICE_TOKEN } from "./device-token";

/**
 * TECH-009「邊緣授權與速率限制」的 E2E（畫面側）。
 *
 * 為什麼需要這一組（單元測試已經綠了還不夠）：
 * 1. `auth-token.test.ts` 驗的是「`HttpSessionClient` 把憑證塞進 `Headers`」——那是
 *    純函式層。真正會壞的地方是**接線**：`app.svelte.ts` 有沒有把 `VITE_DEVICE_TOKEN`
 *    讀進來、有沒有傳給 client。這個只有真的跑在瀏覽器裡才算數。
 * 2. 401／429 的文案是使用者唯一看得到的東西。單元測試驗函式回什麼字串，
 *    這裡驗**畫面上真的出現那句話**，而且**不得**出現「請確認網路」。
 *
 * 刻意的做法：用 `page.route` 攔下 `session/start` 並回一份**真的 401／429 形狀**
 * 的 body，而不是去弄一顆沒設憑證的 worker。理由：
 * - 同一顆 worker 要是沒憑證，上面每一條既有 E2E 都會 401，反而少掉覆蓋；
 * - 攔截讓我們能同時**讀到瀏覽器送出的 header**（拿掉實作就會紅），
 *   這是「UI 真的有帶憑證」在真實瀏覽器上的直接證據。
 *
 * 誠實聲明（這一組驗不到的事）：
 * - 真機（Tauri／iOS WKWebView）行為不在此列；`Origin` 白名單由 worker 端測試與
 *   `worker/scripts/cors-probe.mjs` 負責。
 * - 429 的**退避**（`chunk-queue` 的 backoff）不在此驗：那是上傳路徑，
 *   由 `app/ui/src/lib/recorder/chunk-queue.test.ts` 覆蓋。這裡只驗文案。
 */

const AUTH_ERROR_BODY = { error: "AUTH_INVALID", message: "裝置授權已失效，請重新配對。", recoverable: false };
const RATE_LIMIT_BODY = { error: "RATE_LIMITED", message: "請求太頻繁，請稍後再試。", recoverable: true };

/** 開到「開始」確認前的畫面（不含真的打伺服端）。 */
async function openStartSheet(page: Page, title: string): Promise<void> {
  await page.getByTestId("btn-start-meeting").click();
  await expect(page.getByTestId("start-sheet")).toBeVisible();
  await page.getByTestId("input-title").fill(title);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => globalThis.localStorage.clear());
  await page.reload();
});

test("TECH-009 AC-1/AC-4：開始會議時瀏覽器真的送出 Authorization，401 時說「裝置授權已失效」（不是「請確認網路」）", async ({
  page,
}) => {
  const seen: Array<string | undefined> = [];
  await page.route("**/session/start", async (route) => {
    seen.push(route.request().headers()["authorization"]);
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify(AUTH_ERROR_BODY),
    });
  });

  await openStartSheet(page, "授權失效的會議");
  await page.getByTestId("btn-start-confirm").click();

  // ① 真的帶了憑證（值來自 playwright.config.ts 注入給 worker／vite 的同一顆）。
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]).toBe("Bearer e2e-device-token");

  // ② 文案要對。舊版把 401 講成網路問題，會把使用者送去查一條沒壞的線。
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("裝置授權已失效，請重新配對");
  await expect(toast).not.toContainText("請確認網路");
  // ③ 不進會議畫面（不得只回一句 toast 卻照樣開始錄音）。
  await expect(page.getByTestId("meeting-screen")).toHaveCount(0);
});

test("TECH-009 AC-6：429 時說「稍後再試」，且不得誤報成網路問題", async ({ page }) => {
  await page.route("**/session/start", async (route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "retry-after": "1" },
      body: JSON.stringify(RATE_LIMIT_BODY),
    });
  });

  await openStartSheet(page, "忙線中的會議");
  await page.getByTestId("btn-start-confirm").click();

  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("稍後再試");
  await expect(toast).not.toContainText("請確認網路");
  await expect(page.getByTestId("meeting-screen")).toHaveCount(0);
});

const WORKER_BASE = "http://localhost:8787";
const MEETINGS_KEY = "tree_factory.meetings.v1";

/** 真的開一場會議（不攔截請求）：只有真的打伺服端才看得出「哪一條路忘了帶憑證」。 */
async function meetingIdFromStorage(page: Page): Promise<string> {
  const id = await page.evaluate((key) => {
    const raw = globalThis.localStorage.getItem(key);
    const parsed = raw === null ? [] : (JSON.parse(raw) as Array<{ id: string }>);
    return parsed[0]?.id ?? "";
  }, MEETINGS_KEY);
  expect(id).not.toBe("");
  return id;
}

/**
 * 真的開一場會議（不攔截請求）：只有真的打伺服端才看得出「哪一條路忘了帶憑證」。
 *
 * **開場失敗回 `null` 而不拋**（Gate 4 oracle F4）：這一條測試的價值是「哪一條路漏了憑證」
 * 的斷言。若先 `await` 畫面出現，憑證真的漏掉時（伺服端 401）測試會在「找不到
 * `meeting-screen`」逾時紅掉，**永遠走不到漏憑證那條斷言**——紅在錯的地方，
 * 未來有人刪掉第 1 條測試就會變成假守門。
 */
async function tryStartMeeting(page: Page, title: string): Promise<string | null> {
  await openStartSheet(page, title);
  await page.getByTestId("btn-start-confirm").click();
  try {
    await expect(page.getByTestId("meeting-screen")).toBeVisible({ timeout: 3_000 });
  } catch {
    return null;
  }
  return meetingIdFromStorage(page);
}

/** 切背景／回前景（與 `document.visibilitychange` 同一條程式碼）。 */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    const hook = (globalThis as unknown as { __tf?: { notifyVisibility: (h: boolean) => void } }).__tf;
    if (hook === undefined) throw new Error("dev 鉤子 __tf 不存在（是否以 dev 模式啟動？）");
    hook.notifyVisibility(value);
  }, hidden);
}

test("TECH-009 AC-2：UI 自己發出的每一個 /m/ 請求都帶了裝置憑證（不是只有 session/start 那一條路）", async ({
  page,
}) => {
  // 為什麼要有這一條：`app.svelte.ts` 裡有**四處**各自 `new HttpSessionClient(...)`。
  // 只把憑證傳給「開始會議」那一處，畫面上完全看不出來——會議照開，只是缺口／音檔
  // 上傳全部 401 被默默丟掉（使用者看到的是「缺口待同步」永遠掛著）。
  const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("/m/") || request.method() === "OPTIONS") return;
    seen.push({ method: request.method(), url, auth: request.headers()["authorization"] });
  });

  const meetingId = await tryStartMeeting(page, "憑證全面覆蓋");
  if (meetingId === null) {
    // 開場沒成功（最常見的原因就是憑證漏了）：先把請求收齊，讓下面的斷言去紅——
    // 這樣失敗訊息會是「這些請求漏了裝置憑證」，而不是「找不到 meeting-screen」。
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBeGreaterThan(0);
  } else {
    // 逼出一條「不是 session/start」的請求：切背景會把缺口 POST 到 /transcript/gaps。
    await setHidden(page, true);
    await setHidden(page, false);

    await expect
      .poll(() => seen.filter((request) => !request.url.includes("/session/start")).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
  }

  const missing = seen.filter((request) => request.auth !== `Bearer ${E2E_DEVICE_TOKEN}`);
  expect(missing, `這些請求漏了裝置憑證：${JSON.stringify(missing)}`).toEqual([]);

  // 憑證這條綠了之後，才要求開場本身也成功（兩件事分開報，紅的時候才看得出是哪一件）。
  expect(meetingId, "憑證都帶對了，開場卻沒成功——那不是這條測試在管的東西，請看 worker 日誌").not.toBeNull();
  if (meetingId === null) return;

  // 另外確認「畫面說的和伺服端收到的一致」：缺口真的進了伺服端的帳本。
  const gaps = await page.request.get(`${WORKER_BASE}/m/${meetingId}/transcript/gaps`, { headers: AUTH });
  expect(gaps.status()).toBe(200);
  const payload = (await gaps.json()) as { gaps?: unknown[] };
  expect(payload.gaps?.length ?? 0).toBeGreaterThan(0);
});
