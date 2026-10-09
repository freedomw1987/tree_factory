import { describe, expect, it } from "vitest";

import { HttpSessionClient, TranscriptGapApiError } from "./api";

/**
 * M01-US-104 D10 / D11 / D18：逐字稿讀取（`GET /m/:id/transcript/segments`）的**網路邊界**測試。
 *
 * 為什麼要單獨釘這一層：畫面只看得懂 `SegmentPage`；伺服端回了什麼畸形資料是這一層的責任。
 * 這裡的每一條都在問「形狀不對時，畫面會看到什麼」——寧可少一列，也不要讓 `NaN` 或
 * `undefined` 流進 UI（那會變成一句沒有時間的鬼話，而且使用者不會知道它是假的）。
 */

const MEETING_ID = "m-1";

/** 假 fetch：回一份固定的 JSON，並把請求網址記下來（`since` 是不是排他契約要看它）。 */
function clientWith(payload: unknown, status = 200): { client: HttpSessionClient; urls: string[] } {
  const urls: string[] = [];
  const client = new HttpSessionClient({
    baseUrl: "http://worker.test",
    meetingId: MEETING_ID,
    fetchImpl: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { client, urls };
}

describe("M01-US-104 逐字稿讀取的網路邊界", () => {
  it("M01-D11 Given 合法的一頁 When 讀取 Then 逐欄轉成 SegmentPage（含 since 與 limit 都送出）", async () => {
    const { client, urls } = clientWith({
      meetingId: MEETING_ID,
      count: 1,
      total: 9,
      segments: [
        { seq: 7, idempotencyKey: "seg:seg:0:1000", speakerId: 1, text: "你好", startMs: 1_000, endMs: 2_000 },
      ],
      hasMore: true,
      nextSince: 7,
    });

    const page = await client.listSegments({ since: 6, limit: 500 });

    expect(page.segments).toEqual([
      { seq: 7, speakerId: 1, text: "你好", startMs: 1_000, endMs: 2_000, idempotencyKey: "seg:seg:0:1000" },
    ]);
    expect(page.nextSince).toBe(7);
    expect(page.hasMore).toBe(true);
    expect(urls[0]).toContain(`/m/${MEETING_ID}/transcript/segments?limit=500&since=6`);
  });

  it("M01-D11 Given since 為 null When 讀取 Then 網址不帶 since（＝從第一頁開始）", async () => {
    const { client, urls } = clientWith({ segments: [], hasMore: false, nextSince: null });

    const page = await client.listSegments({ since: null, limit: 500 });

    expect(urls[0]).toContain("limit=500");
    expect(urls[0]).not.toContain("since");
    expect(page).toEqual({ segments: [], nextSince: null, hasMore: false });
  });

  it("M01-D18 Given 水位不是安全整數 When 讀取 Then 當成「沒有水位」（不得把 NaN 送回去問伺服端）", async () => {
    const { client } = clientWith({ segments: [], hasMore: false, nextSince: "abc" });

    const page = await client.listSegments({ since: 3, limit: 500 });

    // 不是 400 或例外，而是回到「從第一頁重讀」——重讀靠冪等鍵去重，比送 `?since=NaN` 安全。
    expect(page.nextSince).toBeNull();
  });

  it("M01-D18 Given 水位是數字字串 When 讀取 Then 接受（與列內欄位同一套語意）；但 null 不得變成 0", async () => {
    const asString = clientWith({ segments: [], hasMore: false, nextSince: "3" });
    expect((await asString.client.listSegments({ since: null, limit: 500 })).nextSince).toBe(3);

    // TECH-013 的契約：沒有新資料時回 `null`。若被 `Number()` 變成 `0`，每一輪都會從頭重讀整份帳本。
    const asNull = clientWith({ segments: [], hasMore: false, nextSince: null });
    expect((await asNull.client.listSegments({ since: null, limit: 500 })).nextSince).toBeNull();
    const asBlank = clientWith({ segments: [], hasMore: false, nextSince: "" });
    expect((await asBlank.client.listSegments({ since: null, limit: 500 })).nextSince).toBeNull();

    // 有限但**不是安全整數**（小數）也不行：`?since=1.5` 沒有任何意義。
    const asFloat = clientWith({ segments: [], hasMore: false, nextSince: 1.5 });
    expect((await asFloat.client.listSegments({ since: null, limit: 500 })).nextSince).toBeNull();
  });

  it("M01-D18 Given 時間戳不是整數 When 讀取 Then 整列丟掉（畫面不得出現半句話）", async () => {
    const { client } = clientWith({
      segments: [
        { seq: 1, speakerId: 0, text: "好句", startMs: 1_000, endMs: 2_000 },
        { seq: 2, speakerId: 0, text: "小數時間", startMs: 1_500.5, endMs: 2_000 },
        { seq: 3, speakerId: 0, text: "", startMs: 3_000, endMs: 4_000 },
      ],
      hasMore: false,
      nextSince: 3,
    });

    const page = await client.listSegments({ since: null, limit: 500 });

    expect(page.segments.map((row) => row.seq)).toEqual([1]);
  });

  it("M01-D10 Given 伺服端回 500 When 讀取 Then 丟出可辨識的 SERVER 錯誤（畫面才能說「讀不到」）", async () => {
    const { client } = clientWith({ error: "boom" }, 500);

    const failed = client.listSegments({ since: null, limit: 500 });
    await expect(failed).rejects.toBeInstanceOf(TranscriptGapApiError);
    // 「可辨識」＝畫面分得出「伺服端壞了」與「網路斷了」——所以要驗 code，不只驗型別。
    await expect(failed).rejects.toMatchObject({ code: "SERVER" });
  });
});
