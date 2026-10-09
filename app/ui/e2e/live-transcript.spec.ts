import { expect, test, type Page } from "@playwright/test";
// TECH-009：直接打 worker 的請求要帶憑證（否則 401）。刻意不用 `use.extraHTTPHeaders`，
// 那會連「UI 自己有沒有帶憑證」一起掩蓋掉。
import { AUTH } from "./device-token";

/**
 * M01-US-104「會議中即時顯示逐字稿」的 E2E。
 *
 * 誠實聲明（**測不到**的部分，不要把它們讀成已驗證）：
 * 1. **真的語音 → interim 事件**：裝置端還沒有 nova / STT 連線（沒有票），所以 interim 由
 *    dev 鉤子 `__tf.pushInterim(...)` 驅動。它走的是未來真接線**同一條** `applyInterim()` 路徑，
 *    但「這些字真的來自麥克風」不在本票的舉證範圍（見 `docs/ac/M01-US-104.md`）。
 * 2. **iOS 真機的手勢捲動**：Chromium 的 wheel 事件不等於手指拖拽；真機手感待 iOS 真機驗收。
 * 3. **fps**：這裡量的是「512 句伺服端資料下，DOM 只有渲染預算內的節點」+ 一次捲動／回流的操作延遲，
 *    不是 frame 時間，也不是真機 iPhone 的手感。
 *
 * 這一組刻意**同時**驗畫面與伺服端：只驗畫面會讓「畫得很誠實、但伺服端什麼都沒收到」漏掉。
 */

const WORKER_BASE = "http://localhost:8787";


const MEETINGS_KEY = "tree_factory.meetings.v1";

interface SegmentInput {
  idempotencyKey: string;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
}

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

/** 直接打伺服端寫入逐字稿（＝未來 STT 落地走的那條路徑），不經過畫面。 */
async function postSegments(page: Page, meetingId: string, segments: SegmentInput[]): Promise<void> {
  const response = await page.request.post(`${WORKER_BASE}/m/${meetingId}/transcript/segments`, {
    headers: AUTH,
    data: { segments },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * 伺服端真的存了幾句（用來證明「畫面上有」不是憑空畫出來的）。
 * 讀 `total` 而不是 `count`：`count` 是**這一頁**的列數（會被 `limit` 截掉），`total` 才是帳本總數。
 */
async function serverSegmentCount(page: Page, meetingId: string): Promise<number> {
  const response = await page.request.get(
    `${WORKER_BASE}/m/${meetingId}/transcript/segments?limit=500`,
    { headers: AUTH },
  );
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { total?: number };
  return payload.total ?? 0;
}

async function pushInterim(page: Page, input: SegmentInput): Promise<void> {
  await page.evaluate((value) => {
    const hook = (globalThis as unknown as { __tf?: { pushInterim?: (i: unknown) => void } }).__tf;
    if (hook?.pushInterim === undefined) throw new Error("dev 鉤子 __tf.pushInterim 不存在（是否以 dev 模式啟動？）");
    hook.pushInterim(value);
  }, input);
}

/** 逐字稿容器離底部還有多遠（跟隨的判準就是這個距離，不是布林旗標）。 */
async function distanceFromBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.querySelector('[data-testid="transcript"]');
    if (node === null) throw new Error("找不到逐字稿容器");
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  });
}

/** 一句夠長的文字：讓 28 句一定超過容器高度（否則「上滑」測不到東西）。 */
function longText(index: number): string {
  return `第 ${index} 句：` + "這是一段用來撐高逐字稿容器、確認自動跟隨與手動上滑行為的長句。".repeat(4);
}

test("M01-US-104 AC-1／AC-2：定稿句子依時間軸出現，講者以 1 起算，同句不重複", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 逐字稿顯示");

  await postSegments(page, meetingId, [
    { idempotencyKey: "e2e:1", speakerId: 0, text: "大家好我是小明", startMs: 0, endMs: 1_200 },
    { idempotencyKey: "e2e:2", speakerId: 1, text: "我是小華請多指教", startMs: 1_500, endMs: 2_800 },
    { idempotencyKey: "e2e:3", speakerId: 0, text: "今天要討論三件事", startMs: 3_000, endMs: 4_200 },
  ]);
  // 伺服端真的收到（畫面與伺服端兩邊都要成立）
  await expect.poll(async () => serverSegmentCount(page, meetingId), { timeout: 5_000 }).toBe(3);

  const rows = page.getByTestId("transcript-line");
  await expect(rows).toHaveCount(3, { timeout: 5_000 });
  // 順序＝時間軸順序（不是插入順序）
  await expect(rows).toHaveText([
    /大家好我是小明/,
    /我是小華請多指教/,
    /今天要討論三件事/,
  ]);
  for (const index of [0, 1, 2]) {
    await expect(rows.nth(index)).toHaveAttribute("data-line-state", "committed");
  }
  await expect(rows.nth(0).getByTestId("line-speaker")).toHaveText("講者 1");
  await expect(rows.nth(1).getByTestId("line-speaker")).toHaveText("講者 2");
  // AC-2：同一句只出現一次
  await expect(page.getByText("大家好我是小明")).toHaveCount(1);
  await expect(page.getByTestId("transcript-waiting")).toHaveCount(0);
});

test("M01-US-104 AC-1／AC-2：interim 先以「未定稿」出現，定稿後就地取代且不重複", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 逐字稿 interim");

  await pushInterim(page, {
    idempotencyKey: "interim:e2e:1",
    speakerId: 0,
    text: "我正在測試這一句還沒定稿",
    startMs: 500,
    endMs: 1_600,
  });

  const rows = page.getByTestId("transcript-line");
  await expect(rows).toHaveCount(1, { timeout: 2_000 });
  await expect(rows).toHaveAttribute("data-line-state", "interim");
  await expect(page.getByText("我正在測試這一句還沒定稿")).toHaveCount(1);
  // interim 不該假裝是定稿：還沒有講者標籤
  await expect(rows.getByTestId("line-speaker")).toHaveCount(0);

  // 定稿（同一段文字、時間重疊）→ 就地取代
  await postSegments(page, meetingId, [
    { idempotencyKey: "e2e:final:1", speakerId: 0, text: "我正在測試這一句還沒定稿", startMs: 500, endMs: 1_700 },
  ]);
  await expect(rows).toHaveCount(1, { timeout: 5_000 });
  await expect(rows).toHaveAttribute("data-line-state", "committed");
  await expect(rows.getByTestId("line-speaker")).toHaveText("講者 1");
  await expect(page.locator('[data-line-state="interim"]')).toHaveCount(0);
  // 只留一句：沒有「interim 一句 + 定稿一句」的鬼影
  await expect(page.getByText("我正在測試這一句還沒定稿")).toHaveCount(1);

  // AC-1：進背景（裝置端不再收音）時，「正在說…」的那句必須消失。
  // 留著它等於向使用者承諾一句永遠不會被定稿的話（Gate 4 P2-3 的修正）。
  await pushInterim(page, {
    idempotencyKey: "interim:e2e:2",
    speakerId: 0,
    text: "進背景前的半句話",
    startMs: 8_000,
    endMs: 8_500,
  });
  await expect(page.locator('[data-line-state="interim"]')).toHaveCount(1);
  await page.evaluate(() => {
    const hook = (globalThis as unknown as { __tf?: { notifyVisibility?: (hidden: boolean) => void } }).__tf;
    if (hook?.notifyVisibility === undefined) throw new Error("dev 鉤子 __tf.notifyVisibility 不存在");
    hook.notifyVisibility(true);
  });
  await expect(page.locator('[data-line-state="interim"]')).toHaveCount(0, { timeout: 2_000 });
  // 已定稿的那句不受影響（清 interim 不是清全部）。
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-line-state", "committed");
});

test("M01-US-104 AC-3／AC-4：自動跟隨、手動上滑停跟並累計，回到最新後恢復", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 逐字稿跟隨");
  await page.setViewportSize({ width: 1024, height: 700 });

  const segments: SegmentInput[] = [];
  for (let index = 0; index < 28; index += 1) {
    segments.push({
      idempotencyKey: `e2e:follow:${index}`,
      speakerId: index % 2,
      text: longText(index),
      // 時間戳必須落在「已過時間 + 容忍（60 秒）」內（transcript-store 的 validateSegment），
      // 所以整場用 1 秒一句的密度，不要拉到分鐘級。
      startMs: index * 1_000,
      endMs: index * 1_000 + 800,
    });
  }
  await postSegments(page, meetingId, segments);

  const wrap = page.getByTestId("transcript-wrap");
  await expect(page.getByTestId("transcript-line")).toHaveCount(28, { timeout: 8_000 });
  // AC-3：新句一直進來時畫面跟著最新一句（距離底部 ≈ 0）
  await expect(wrap).toHaveAttribute("data-following", "true");
  await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(24);

  // 使用者自己往上滑 → 停止跟隨
  const transcript = page.getByTestId("transcript");
  const box = await transcript.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(wrap).toHaveAttribute("data-following", "false", { timeout: 2_000 });

  // AC-4：停止跟隨後新句進來 → 累計 N 句，且**畫面不跳動**
  const before = await transcript.evaluate((node) => node.scrollTop);
  await postSegments(page, meetingId, [
    { idempotencyKey: "e2e:follow:new", speakerId: 0, text: longText(99), startMs: 30_000, endMs: 30_800 },
  ]);
  await expect(page.getByTestId("transcript-line")).toHaveCount(29, { timeout: 8_000 });
  await expect(wrap).toHaveAttribute("data-unread", "1");
  const button = page.getByTestId("btn-back-to-latest");
  await expect(button).toBeVisible();
  await expect(button).toContainText("回到最新 · 1 句新");
  expect(await transcript.evaluate((node) => node.scrollTop)).toBe(before);

  // 點「回到最新」→ 回到底部、跟隨恢復、按鈕消失
  await button.click();
  await expect(wrap).toHaveAttribute("data-following", "true");
  await expect(button).toHaveCount(0);
  await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(24);
});

test("M01-US-104 DoD：512 句時畫面只留渲染預算內的節點，且捲動操作延遲可量", async ({ page }) => {
  const meetingId = await startMeeting(page, "E2E 逐字稿 512 句");
  await page.setViewportSize({ width: 1024, height: 700 });

  const total = 512;
  const segments: SegmentInput[] = [];
  for (let index = 0; index < total; index += 1) {
    segments.push({
      idempotencyKey: `e2e:bulk:${index}`,
      speakerId: index % 2,
      text: longText(index),
      // 1 毫秒一句：512 句全部落在 validateSegment 的容忍窗（已過時間 + 60 秒）內。
      // 拉到 1 秒一句會讓第 100 句就落在「未來」而被伺服端拒絕。
      startMs: 1_000 + index,
      endMs: 1_500 + index,
    });
  }
  await postSegments(page, meetingId, segments);
  await expect.poll(() => serverSegmentCount(page, meetingId), { timeout: 20_000 }).toBe(total);

  const rows = page.getByTestId("transcript-line");
  // 伺服端 512 句、畫面只渲染 RENDER_BUDGET(30) 句 —— 長會議不是 512 個 DOM 節點。
  await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBe(30);
  await expect(page.getByTestId("transcript-omitted")).toHaveText("上方已省略 482 句（只保留最近 30 句）");
  // 留下的必須是**最近**的 30 句（索引 482~511，句子的編號從 0 起算）：界線兩邊都要對。
  await expect(rows.nth(0)).toContainText("第 482 句");
  await expect(rows.nth(29)).toContainText("第 511 句");
  await expect(page.getByText("第 481 句：", { exact: false })).toHaveCount(0);
  await expect(page.getByText("第 0 句：", { exact: false })).toHaveCount(0);

  // 操作延遲：捲到頂 → 捲到底 → 強制回流 → 等兩個 frame（讓排版真的發生）。
  const latencyMs = await page.evaluate(async () => {
    const node = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    if (node === null) throw new Error("找不到逐字稿容器");
    const started = performance.now();
    node.scrollTop = 0;
    node.scrollTop = node.scrollHeight;
    void node.offsetHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
    return performance.now() - started;
  });
  console.log(`[M01-US-104 DoD] 512 句（DOM 30 列）：捲到頂→捲到底+回流 = ${latencyMs.toFixed(1)}ms`);
  expect(latencyMs).toBeLessThan(300);

  // 捲動本身也要留下痕跡：手動往上滑之後跟隨要停（512 句時的行為與 28 句一致）。
  const wrap = page.getByTestId("transcript-wrap");
  await expect(wrap).toHaveAttribute("data-following", "true");
  const box = await page.getByTestId("transcript").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(wrap).toHaveAttribute("data-following", "false", { timeout: 2_000 });

  // 不跟隨時**上面被裁掉**（512 → 514 句會把最上面兩列擠出預算）：
  // 畫面不得自己跳回最新（那是「假裝使用者還在跟隨」），也不得把捲軸位置重置。
  const transcriptNode = page.getByTestId("transcript");
  const scrollBefore = await transcriptNode.evaluate((node) => node.scrollTop);
  await postSegments(page, meetingId, [
    { idempotencyKey: `e2e:bulk:${total}`, speakerId: 0, text: longText(total), startMs: 1_000 + total, endMs: 1_500 + total },
    {
      idempotencyKey: `e2e:bulk:${total + 1}`,
      speakerId: 1,
      text: longText(total + 1),
      startMs: 1_001 + total,
      endMs: 1_501 + total,
    },
  ]);
  // 砍掉前綴發生了嗎：第 0 列從「第 482 句」變成「第 484 句」（每次只留最近 30 句）。
  await expect(rows.nth(0)).toContainText(`第 ${total - 28} 句`, { timeout: 8_000 });
  await expect(rows).toHaveCount(30);
  await expect(wrap).toHaveAttribute("data-following", "false");
  await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeGreaterThan(24);
  expect(await transcriptNode.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(scrollBefore);
});
