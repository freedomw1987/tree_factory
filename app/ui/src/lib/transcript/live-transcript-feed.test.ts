import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LiveTranscriptFeed,
  MAX_PAGES_PER_TICK,
  type SegmentPage,
  type TranscriptReadClient,
} from "./live-transcript-feed";
import { LiveTranscript, type SegmentRow } from "./live-transcript";

/** M01-US-104 D9/D10：輪詢節奏、續抓、失敗不清空。 */

function row(seq: number): SegmentRow {
  return { seq, speakerId: 0, text: `第 ${seq} 句`, startMs: seq * 1_000, endMs: seq * 1_000 + 900 };
}

/** 假的讀取端：記錄每次被問的 `since`，回傳預先排好的頁面。 */
class FakeClient implements TranscriptReadClient {
  readonly asked: (number | null)[] = [];
  readonly pages: SegmentPage[] = [];
  failTimes = 0;

  async listSegments(input: { since: number | null; limit: number }): Promise<SegmentPage> {
    this.asked.push(input.since);
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("讀取失敗（假）");
    }
    const page = this.pages.shift();
    if (page === undefined) return { segments: [], nextSince: null, hasMore: false };
    return page;
  }
}

describe("M01-US-104 逐字稿輪詢", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("M01-D9 Given 開始輪詢 When 時間前進 Then 立刻抓一次、之後每個 interval 抓一次", async () => {
    const client = new FakeClient();
    const live = new LiveTranscript();
    const feed = new LiveTranscriptFeed({ client, live, intervalMs: 1_000 });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.asked).toEqual([null]);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.asked).toHaveLength(3);

    feed.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.asked).toHaveLength(3);
    expect(feed.polling).toBe(false);
  });

  it("M01-D11 Given 還有很多頁 When hasMore 為真 Then 同一個 tick 內續抓，並用伺服端水位當 since", async () => {
    const client = new FakeClient();
    client.pages.push(
      { segments: [row(1), row(2)], nextSince: 2, hasMore: true },
      { segments: [row(3)], nextSince: 3, hasMore: false },
    );
    const live = new LiveTranscript();
    const feed = new LiveTranscriptFeed({ client, live, intervalMs: 1_000 });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.asked).toEqual([null, 2]);
    expect(live.counts.committed).toBe(3);
  });

  it("M01-D10 Given 讀取失敗 When 失敗 Then 舊句留著、狀態說出失敗；下一輪成功就恢復", async () => {
    const client = new FakeClient();
    client.pages.push({ segments: [row(1)], nextSince: 1, hasMore: false });
    const live = new LiveTranscript();
    const feed = new LiveTranscriptFeed({ client, live, intervalMs: 1_000 });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status.ok).toBe(true);

    client.failTimes = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.status.ok).toBe(false);
    expect(feed.status.error).toContain("讀取失敗（假）");
    expect(live.counts.committed).toBe(1); // 不得清空
    expect(live.pendingSince).toBe(1); // 不得因為失敗而倒退

    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.status.ok).toBe(true);
    expect(feed.status.error).toBeNull();
    expect(live.counts.committed).toBe(1);
  });

  it("M01-D17 Given 上游一直說還有下一頁 When 同一個 tick Then 頁數必須有上限（不能把事件迴圈鎖住）", async () => {
    const client = new FakeClient();
    // 上游若壞掉（`hasMore` 一直為真），續抓就是一個不會讓出事件迴圈的迴圈 → 畫面直接凍住。
    // 這裡刻意讓每頁都前進水位（不是同一頁），才不會把測試本身寫成無限迴圈。
    for (let index = 1; index <= MAX_PAGES_PER_TICK + 5; index += 1) {
      client.pages.push({ segments: [row(index)], nextSince: index, hasMore: true });
    }
    const live = new LiveTranscript();
    const feed = new LiveTranscriptFeed({ client, live, intervalMs: 1_000 });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.asked).toHaveLength(MAX_PAGES_PER_TICK);
    expect(live.counts.committed).toBe(MAX_PAGES_PER_TICK);

    // 下一輪從現在的水位繼續（上限只是「慢一點」，不是「漏掉」）。
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.counts.committed).toBe(MAX_PAGES_PER_TICK + 5);
  });

  it("M01-D9 Given 已經停止 When 再呼叫 pump 直接回傳 Then 不會偷抓", async () => {
    const client = new FakeClient();
    const live = new LiveTranscript();
    const feed = new LiveTranscriptFeed({ client, live, intervalMs: 1_000 });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    feed.stop();
    const asked = client.asked.length;

    await feed.pump();
    expect(client.asked).toHaveLength(asked);
  });
});
