/**
 * M01-US-104 D9/D10：逐字稿輪詢。
 *
 * 為什麼是輪詢而不是 SSE / WebSocket：帳本已經有「只拿新的」（`since`）與分頁契約
 * （TECH-013 就是為這條路鋪的）；推播要 worker 支援 upgrade，成本不在這張票。
 * 每一次 tick 的節奏與生命週期（只在會議畫面且真的在錄音）由 app 狀態層決定。
 *
 * 兩個刻意的設計：
 * 1. **失敗不清空**：讀不到就留著上一次的內容並把狀態說出來（清空會被讀成「沒人在說話」）。
 * 2. **`hasMore` 立刻續抓**：同一 tick 內追到尾巴，不讓畫面落後好幾個 interval。
 */

import type { LiveTranscript, SegmentRow } from "./live-transcript";

export const TRANSCRIPT_PAGE_LIMIT = 500;
export const TRANSCRIPT_POLL_MS = 1_000;

/**
 * 一個 tick 最多追幾頁（防禦性上限，不是效能參數）。
 *
 * 為什麼需要：續抓的終止條件是「對方說 `hasMore: false`」。若上游回了 `hasMore: true` 又給一個
 * 不前進的 `nextSince`（同頁），這個 while 就是一個**不會讓出事件迴圈的無限迴圈**——畫面直接凍住，
 * 而錯誤是對方的（我方沒辦法用「改自己的程式」修正）。上限讓「對方犯錯」退化成「慢一點」：
 * 這一 tick 抓 20 頁就下班，下一 tick 從現在的水位繼續。
 */
export const MAX_PAGES_PER_TICK = 20;

export interface SegmentPage {
  segments: SegmentRow[];
  nextSince: number | null;
  hasMore: boolean;
}

/** 讀取端的最小介面（`HttpSessionClient` 結構上就符合）。 */
export interface TranscriptReadClient {
  listSegments(input: { since: number | null; limit: number }): Promise<SegmentPage>;
}

export interface FeedStatus {
  /** 最後一次讀取是否成功。 */
  ok: boolean;
  error: string | null;
  /** 最後一次成功的時間（牆鐘 ms；`null` ＝ 還沒成功過）。 */
  lastOkMs: number | null;
}

export interface LiveTranscriptFeedOptions {
  client: TranscriptReadClient;
  live: LiveTranscript;
  intervalMs?: number;
  pageLimit?: number;
  now?: () => number;
  /** 每次 tick 結束後的通知（畫面用它同步狀態）。 */
  onChange?: (status: FeedStatus) => void;
}

export class LiveTranscriptFeed {
  readonly #client: TranscriptReadClient;
  readonly #live: LiveTranscript;
  readonly #intervalMs: number;
  readonly #pageLimit: number;
  readonly #now: () => number;
  readonly #onChange: ((status: FeedStatus) => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 等待下一個 tick 的 resolver：`stop()` 要叫醒它，否則那個 promise 永遠懸著。 */
  #waiter: (() => void) | null = null;
  #running = false;
  #inFlight = false;
  #status: FeedStatus = { ok: true, error: null, lastOkMs: null };

  constructor(options: LiveTranscriptFeedOptions) {
    this.#client = options.client;
    this.#live = options.live;
    this.#intervalMs = options.intervalMs ?? TRANSCRIPT_POLL_MS;
    this.#pageLimit = options.pageLimit ?? TRANSCRIPT_PAGE_LIMIT;
    this.#now = options.now ?? (() => Date.now());
    this.#onChange = options.onChange;
  }

  get polling(): boolean {
    return this.#running;
  }

  get status(): FeedStatus {
    return this.#status;
  }

  /** 開始輪詢（重複呼叫安全）。 */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  /** 停止輪詢（離開會議畫面 / 錄音中斷 / 會議結束）。 */
  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#waiter?.();
    this.#waiter = null;
  }

  /**
   * 跑一輪（抓完所有 `hasMore` 的頁）。
   * 停止之後呼叫直接回傳：呼叫端不必自己判斷生命週期。
   */
  async pump(): Promise<void> {
    if (!this.#running || this.#inFlight) return;
    this.#inFlight = true;
    try {
      let more = true;
      let pages = 0;
      while (more && this.#running && pages < MAX_PAGES_PER_TICK) {
        const page: SegmentPage = await this.#client.listSegments({
          since: this.#live.pendingSince,
          limit: this.#pageLimit,
        });
        this.#live.applyPage(page);
        pages += 1;
        more = page.hasMore && page.segments.length > 0;
      }
      this.#status = { ok: true, error: null, lastOkMs: this.#now() };
    } catch (error) {
      this.#status = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        lastOkMs: this.#status.lastOkMs,
      };
    } finally {
      this.#inFlight = false;
      this.#onChange?.(this.#status);
    }
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      await this.pump();
      if (!this.#running) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#waiter = null;
          resolve();
        }, this.#intervalMs);
      });
    }
  }
}
