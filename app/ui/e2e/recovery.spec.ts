import { expect, test, type Page } from "@playwright/test";

/**
 * M01-US-102 AC-3 的 E2E：**app 被殺 / 斷電重開**之後，若本機還有沒送出的分段，
 * 必須先問使用者，而且未經明確同意不得丟棄。
 *
 * 誠實聲明（測不到的部分與替代證據）：
 * - 「真的把程序殺掉」在 Playwright 裡做不到；但 IndexedDB 是**跨頁面載入**的持久層，
 *   所以「先寫入 IndexedDB → reload」在資料面等價於「程序重啟」——新的 ChunkRecovery
 *   面對的是同一份磁碟狀態（單元測試 `chunk-pipeline.test.ts` 另外證了邏輯面）。
 * - 「上傳失敗但本機保留」的網路細節由 `chunk-pipeline.test.ts` 覆蓋；這裡只驗 UI 契約。
 */

const AUDIO_DB = "tree_factory.audio.v1";
const MEETINGS_KEY = "tree_factory.meetings.v1";

/** 與產品/worker 同一條指紋契約（SHA-256 前 16 hex），讓種進去的分段在內容上「真的」對得上。 */
async function hashOf(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 把一段音檔直接種進本機分段儲存（模擬「上一次生命週期留下的暫存」）。 */
async function seedPendingChunk(
  page: Page,
  meetingId: string,
  title: string,
  seq: number,
  content = "seeded-audio",
): Promise<void> {
  await page.evaluate(
    async ({ dbName, meetingsKey, id, label, seqNo, hash, body }) => {
      globalThis.localStorage.clear();
      globalThis.localStorage.setItem(
        meetingsKey,
        JSON.stringify([
          {
            id,
            title: label,
            startedAtMs: Date.now() - 60_000,
            endsAtMs: Date.now() + 60_000,
            status: "recording",
          },
        ]),
      );
      await new Promise<void>((resolve, reject) => {
        const request = globalThis.indexedDB.open(dbName, 1);
        request.addEventListener("upgradeneeded", () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
        });
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const db = request.result;
          const tx = db.transaction("chunks", "readwrite");
          tx.objectStore("chunks").put({
            key: `${id}:${seqNo}`,
            meetingId: id,
            seq: seqNo,
            hash,
            blob: new Blob([body], { type: "audio/webm" }),
          });
          tx.addEventListener("complete", () => resolve());
          tx.addEventListener("error", () => reject(tx.error));
        });
      });
    },
    {
      dbName: AUDIO_DB,
      meetingsKey: MEETINGS_KEY,
      id: meetingId,
      label: title,
      seqNo: seq,
      hash: await hashOf(content),
      body: content,
    },
  );
}

test("AC-3：重開後偵測到未完成會議 → 先詢問；丟棄需二次確認；未同意不得自動丟棄", async ({ page }) => {
  await page.goto("/");
  await seedPendingChunk(page, "rec-1", "斷電的週會", 1);

  // reload = 程序重啟：新的 app 生命週期面對同一份 IndexedDB。
  await page.reload();

  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await expect(page.getByTestId("recover-item")).toContainText("斷電的週會");
  await expect(page.getByTestId("recover-item")).toContainText("還有 1 段未送出");

  // 丟棄必須二次確認：按了「丟棄」不會馬上刪，仍看得到該筆。
  await page.getByTestId("btn-recover-discard").click();
  await expect(page.getByTestId("recover-confirm-text")).toBeVisible();
  await page.getByTestId("btn-recover-discard-cancel").click();
  await expect(page.getByTestId("recover-item")).toBeVisible();

  // 「稍後再說」只離開畫面，不清資料；再重開仍然會被問到。
  await page.getByTestId("btn-recover-later").click();
  await expect(page.getByTestId("recover-screen")).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await expect(page.getByTestId("recover-item")).toContainText("斷電的週會");
});

test("AC-3：使用者明確按下「確定丟棄」才真的刪掉本機暫存", async ({ page }) => {
  await page.goto("/");
  await seedPendingChunk(page, "rec-2", "要被丟棄的會議", 1);
  await page.reload();

  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await page.getByTestId("btn-recover-discard").click();
  await page.getByTestId("btn-recover-discard-confirm").click();

  await expect(page.getByTestId("recover-screen")).not.toBeVisible({ timeout: 5_000 });
  // 重開不應再被問到（IndexedDB 已經真的清掉）。
  await page.reload();
  await expect(page.getByTestId("recover-screen")).not.toBeVisible();
});

// ↓ 以下兩條對應 Gate 4 審查的 F2（「續傳」按鈕以前**完全沒有**測試）：
//   光驗「丟棄」不算驗完 AC-3——續傳是預設動作，也是唯一會把資料送回伺服端的一條路。
const WORKER_BASE = "http://localhost:8787";

/** 讓伺服端真的有一場進行中的會議（正常流程是按「開始」，這裡直接備好伺服端狀態）。 */
async function startServerSession(page: Page, meetingId: string): Promise<void> {
  const response = await page.request.post(`${WORKER_BASE}/m/${meetingId}/session/start`);
  expect(response.ok()).toBeTruthy();
}

test("AC-2：重開後按「續傳」→ 依伺服端帳本回補分段（真的送到伺服端）並從畫面移除", async ({
  page,
}) => {
  // 會議 id 每次跑都不同：wrangler dev 的 DO 狀態會留在 .wrangler/state，
  // 固定 id 會讓第二次跑撞到上一次已落地的分段（變成「內容衝突」而不再是「回補」）。
  const meetingId = `rec-resume-${Date.now()}`;
  await page.goto("/");
  await startServerSession(page, meetingId);
  await seedPendingChunk(page, meetingId, "要回補的會議", 1);
  await page.reload();

  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await page.getByTestId("btn-recover-resume").click();

  await expect(page.getByTestId("toast")).toContainText("已回補 1 段未送出的音檔");
  await expect(page.getByTestId("recover-screen")).not.toBeVisible({ timeout: 10_000 });

  // 權威證據：問伺服端帳本，而不是相信畫面說「好了」。
  const ledger = await page.request.get(`${WORKER_BASE}/m/${meetingId}/audio/chunks`);
  const body = (await ledger.json()) as { chunks?: Array<{ seq: number }>; count?: number };
  expect(body.chunks?.map((chunk) => chunk.seq)).toEqual([1]);
  expect(body.count).toBe(1);
});

test("AC-1/AC-2：伺服端已有同 seq 的其他內容 → 不覆蓋、不刪本機檔，並明說衝突（Gate 4 F4）", async ({
  page,
}) => {
  const meetingId = `rec-conflict-${Date.now()}`;
  await page.goto("/");
  await startServerSession(page, meetingId);
  await seedPendingChunk(page, meetingId, "內容衝突的會議", 1, "first-audio");
  await page.reload();
  await page.getByTestId("btn-recover-resume").click();
  await expect(page.getByTestId("toast")).toContainText("已回補 1 段未送出的音檔");

  // 同一個 seq 換成**不同內容**再送一次：伺服端已經有 first-audio 的版本，不可被覆蓋。
  await seedPendingChunk(page, meetingId, "內容衝突的會議", 1, "second-audio");
  await page.reload();
  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await page.getByTestId("btn-recover-resume").click();

  await expect(page.getByTestId("toast")).toContainText("內容衝突");
  await expect(page.getByTestId("recover-item")).toContainText("還有 1 段未送出"); // 本機檔保留

  // 伺服端仍是原本那一段（hash 未變、count 仍為 1）：不覆蓋是這張票的紅線。
  const ledger = await page.request.get(`${WORKER_BASE}/m/${meetingId}/audio/chunks`);
  const body = (await ledger.json()) as { chunks?: Array<{ seq: number; hash: string }>; count?: number };
  expect(body.count).toBe(1);
  expect(body.chunks?.[0]?.hash).toBe(await hashOf("first-audio"));
});

test("AC-2/AC-3：續傳失敗時不得說「已處理完」——保留本機檔並留在恢復畫面", async ({ page }) => {
  await page.goto("/");
  // 刻意不呼叫 startServerSession：伺服端沒有這場會議，讀帳本會失敗（類比斷網）。
  await seedPendingChunk(page, "rec-4", "伺服器沒開的會議", 1);
  await page.reload();

  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await page.getByTestId("btn-recover-resume").click();

  await expect(page.getByTestId("toast")).toContainText("仍有 1 段待送");
  await expect(page.getByTestId("recover-screen")).toBeVisible();
  await expect(page.getByTestId("recover-item")).toContainText("還有 1 段未送出");

  // 資料還在：重開仍然會被問到（沒被當成「處理完了」而清掉）。
  await page.reload();
  await expect(page.getByTestId("recover-item")).toContainText("伺服器沒開的會議");
});
