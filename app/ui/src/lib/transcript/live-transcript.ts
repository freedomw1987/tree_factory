/**
 * M01-US-104 即時逐字稿：把「已定稿的句子」與「正在說的那一句」變成畫面上的一條時間軸。
 *
 * 為什麼是純模組（不碰 DOM）：
 * - 跟隨 / 未讀 / 去重 / 渲染預算是**規則**，規則要能被突變測試殺；
 * - 捲動本身（真的改 `scrollTop`、真的上滑）由 MeetingScreen 的 adapter 做，
 *   純模組只收「使用者離底部多遠」這一個數字。
 *
 * 資料來源分工（見 docs/design/M01-US-104-live-transcript-display.md §2）：
 * committed 來自伺服端帳本（`GET /transcript/segments?since=`，TECH-013 契約）；
 * interim 由 `applyInterim()` 注入（裝置端還沒有 STT 連線，來源屬後續票）。
 */

export type LineState = "interim" | "committed";

/** DoD：可視範圍 ＋ 最近 30 句。 */
export const RENDER_BUDGET = 30;

/**
 * 離底部幾 px 以內算「還在最新處」（D4）。
 * 24px：手指微微抖動不該讓「回到最新」跳出來，但真的往上看一句就會離開。
 */
export const FOLLOW_THRESHOLD_PX = 24;

/** 伺服端帳本的一列（`GET /transcript/segments` 的 `segments[i]`；多餘欄位忽略）。 */
export interface SegmentRow {
  seq: number;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
  idempotencyKey?: string;
}

/** 畫面上一句話（`seq` 為 `null` ＝ 還沒定稿）。 */
export interface TranscriptLine {
  key: string;
  seq: number | null;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
  state: LineState;
}

/** 逐字稿缺口（M01-US-107 的紀錄；這裡只需要時間欄位）。 */
export interface GapRow {
  seq: number;
  fromMs: number;
  toMs: number | null;
}

export type TimelineEntry<G = GapRow> =
  | { kind: "line"; line: TranscriptLine }
  | { kind: "gap"; gap: G };

export interface MergeTimelineInput<G extends GapRow = GapRow> {
  lines: readonly TranscriptLine[];
  gaps: readonly G[];
  budget?: number;
}

function lineTimeOf(entry: TimelineEntry<GapRow>): number {
  return entry.kind === "line" ? entry.line.startMs : entry.gap.fromMs;
}

/** 同一時間：句子先（有內容的比空白重要）。 */
function rankOf(entry: TimelineEntry<GapRow>): number {
  return entry.kind === "line" ? 0 : 1;
}

/**
 * 去重鍵（D11）。
 *
 * 兩個**不同命名空間**是刻意的：`seg:` 開頭的是伺服端冪等鍵（可能自己就長得像
 * `seg:seg:0:1000`，見 `worker/src/transcript-stream.ts:178` 的合成鍵），
 * `seq:` 開頭的是「這一列沒有冪等鍵、只能靠帳本序號認」。
 * 若兩者共用 `seg:` 前綴，一列 `idempotencyKey: "0"` 與一列沒有鍵的 `seq: 0` 會撞成同一個鍵 →
 * 後到的那一列會被**無聲丟掉**（畫面少一句，而使用者不會知道）。
 */
export function segmentKey(row: SegmentRow): string {
  return row.idempotencyKey === undefined ? `seq:${row.seq}` : `seg:${row.idempotencyKey}`;
}

/**
 * 兩個時間區間是否**真正**相交（端點相接**不算**）。
 *
 * 為什麼要嚴格：連續的 STT 句子通常就是前一句 `endMs` 等於後一句 `startMs`。
 * 若把「端點相接」也算相交，前一秒的定稿（`{1000,2000}`）晚到時會把下一句正在說的
 * interim（`{2000,3000}`）一起收掉 —— 畫面會憑空少掉「正在說…」，直到下一個 interim 才回來。
 * 真正要吸收的是「同一句被回填了更早起點」的定稿（`{4500,5900}` 對 interim `{5000,6000}`）。
 */
function rangesOverlap(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * M01-D7：句子與缺口合成一條時間軸。
 *
 * 渲染預算只裁**已定稿**的句子（interim 一定留著——不然「正在說的話」會消失）。
 * 被裁掉的前綴代表畫面從某個時間點才開始，所以更早的缺口也一起收掉；
 * 但**跨過**裁切點的缺口要留（它有一部分還在畫面上，藏起來會少報中斷）。
 * 「早」與「跨」只差一行過濾器，兩種錯都不會讓測試紅——所以有兩條測試分別釘住它們
 * （`M01-D7` 的兩題）。
 */
export function mergeTimeline<G extends GapRow>(input: MergeTimelineInput<G>): TimelineEntry<G>[] {
  const budget = input.budget ?? RENDER_BUDGET;
  const committed = input.lines.filter((line) => line.state === "committed");
  const interims = input.lines.filter((line) => line.state === "interim");
  const omitted = Math.max(0, committed.length - budget);
  const kept = omitted > 0 ? committed.slice(committed.length - budget) : committed;
  const floorMs = kept.length === 0 ? Number.NEGATIVE_INFINITY : kept[0]!.startMs;

  const entries: TimelineEntry<G>[] = [
    ...kept.map((line): TimelineEntry<G> => ({ kind: "line", line })),
    ...interims.map((line): TimelineEntry<G> => ({ kind: "line", line })),
    ...input.gaps
      .filter((gap) => gap.toMs === null || gap.toMs >= floorMs)
      .map((gap): TimelineEntry<G> => ({ kind: "gap", gap })),
  ];
  entries.sort(
    (a, b) => lineTimeOf(a as TimelineEntry<GapRow>) - lineTimeOf(b as TimelineEntry<GapRow>) || rankOf(a) - rankOf(b),
  );
  return entries;
}

export interface TranscriptCounts {
  committed: number;
  interim: number;
  /** 被渲染預算裁掉、畫面必須明說的句數（不得假裝全都在畫面上）。 */
  omitted: number;
}

/**
 * 即時逐字稿狀態機。
 *
 * 單調性保證（D11）：帳本只會往前長，所以 `pendingSince` 只前進不後退；
 * 同一頁重複讀到不會變成兩列（以帳本冪等鍵去重）。
 */
export class LiveTranscript<G extends GapRow = GapRow> {
  #committed: TranscriptLine[] = [];
  #seen = new Set<string>();
  #interim: TranscriptLine | null = null;
  #gaps: G[] = [];
  #following = true;
  #unread = 0;
  #since: number | null = null;
  /**
   * 最近一次 `timeline(budget)` 用的預算。
   * 為什麼要記：`counts.omitted` 與實際裁切若各算各的（一個用 `RENDER_BUDGET`、一個用傳入的
   * `budget`），就會出現「畫面只畫 2 句、卻說省略 0 句」的兩套真相。
   */
  #budget = RENDER_BUDGET;

  /** 目前所有句子（已定稿依 `startMs` 遞增，interim 放最後）。 */
  get lines(): TranscriptLine[] {
    return this.#interim === null ? [...this.#committed] : [...this.#committed, this.#interim];
  }

  get counts(): TranscriptCounts {
    return {
      committed: this.#committed.length,
      interim: this.#interim === null ? 0 : 1,
      omitted: Math.max(0, this.#committed.length - this.#budget),
    };
  }

  /** 還在自動跟隨最新一句（AC-3）。 */
  get following(): boolean {
    return this.#following;
  }

  /** 停止跟隨之後進來的句數（AC-4 的「N 句新」）。 */
  get unread(): number {
    return this.#unread;
  }

  /** 下一次要跟伺服端要的 `since`（`null` ＝ 從第一頁開始）。 */
  get pendingSince(): number | null {
    return this.#since;
  }

  /**
   * AC-1：收到一段未定稿的文字。
   * 只保留**一個** interim 槽：同一時間只會有一句「正在說」。
   */
  applyInterim(input: { speakerId: number; text: string; startMs: number; endMs: number }): void {
    this.#interim = {
      key: `interim:${input.speakerId}`,
      seq: null,
      speakerId: input.speakerId,
      text: input.text,
      startMs: input.startMs,
      endMs: input.endMs,
      state: "interim",
    };
  }

  /**
   * 不會再有 interim：會議結束 / 離開會議畫面 / 進背景（`app.svelte.ts` 的三個出口都呼叫它）。
   * 為什麼「進背景」也算：`visibility_hidden` 會停輪詢且裝置端不再收音，畫面上再留著
   * 「正在說…」就是說謊（那句話永遠不會被定稿）。
   */
  clearInterim(): void {
    this.#interim = null;
  }

  /**
   * AC-2：套用伺服端的一頁帳本。
   *
   * 兩個不可退讓的點：
   * 1. 同一個冪等鍵只會有一列（重讀同一頁不得變成兩份）；
   * 2. 定稿到達時，**對應的 interim 必須被收掉**——時間戳對不上也要收，
   *    否則畫面上會同時出現「我正在測試這」與「我正在測試這句」兩份（使用者會以為記了兩次）。
   *    兩個條件合起來看：**真正**的區間相交（真實 STT 的 final 常會回填句子起點，`startMs` 比 interim 早）
   *    或 定稿已推進到 interim 之後。只看後者的話，前者會留一份鬼影；
   *    只看相交的話，較早的落後補齊會誤殺正在說的那句 —— 所以相交必須嚴格（端點相接不算），
   *    而且只看**這一頁新增**的列（頁裡帶回的重複列不該有副作用）。三者各有一條測試釘住。
   */
  applyPage(page: { segments: readonly SegmentRow[]; nextSince: number | null }): void {
    let added = 0;
    let newestStartMs = Number.NEGATIVE_INFINITY;
    const fresh: SegmentRow[] = [];
    for (const row of page.segments) {
      const key = segmentKey(row);
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      fresh.push(row);
      this.#committed.push({
        key,
        seq: row.seq,
        speakerId: row.speakerId,
        text: row.text,
        startMs: row.startMs,
        endMs: row.endMs,
        state: "committed",
      });
      added += 1;
      newestStartMs = Math.max(newestStartMs, row.startMs);
    }
    if (added > 0) {
      this.#committed.sort((a, b) => a.startMs - b.startMs || (a.seq ?? 0) - (b.seq ?? 0));
      // 定稿涵蓋到 interim 所在的時間之後才算「收掉了那句」；更早的定稿只是落後補齊，
      // 這時候收掉 interim 會讓正在說的那句憑空消失。
      const interim = this.#interim;
      const absorbedByOverlap = interim !== null && fresh.some((row) => rangesOverlap(row, interim));
      if (interim !== null && (newestStartMs >= interim.startMs || absorbedByOverlap)) {
        this.#interim = null;
      }
      if (!this.#following) this.#unread += added;
    }
    if (page.nextSince !== null && (this.#since === null || page.nextSince > this.#since)) {
      this.#since = page.nextSince;
    }
  }

  /** M01-US-107 的缺口（整份取代：缺口數量少，且來源本身是權威清單）。 */
  applyGaps(gaps: readonly G[]): void {
    this.#gaps = [...gaps].sort((a, b) => a.fromMs - b.fromMs || a.seq - b.seq);
  }

  /**
   * AC-3：畫面回報「捲軸離底部多遠」——距離是唯一判準。
   * 不區分「使用者滑」與「程式自己捲」：scroll 事件的 `isTrusted` 對兩者都是 true
   * （程式設 `scrollTop` 也由瀏覽器派事件），但程式自己捲一定落在底部（距離 ≈ 0），
   * 所以距離本身就把兩種情況分開了。
   */
  notifyUserScroll(distancePx: number): void {
    if (distancePx <= FOLLOW_THRESHOLD_PX) {
      this.#following = true;
      this.#unread = 0;
      return;
    }
    this.#following = false;
  }

  /** AC-4：按下「回到最新 · N 句新」。 */
  backToLatest(): void {
    this.#following = true;
    this.#unread = 0;
  }

  /** 畫面要渲染的列（已排序、已裁切；被裁的句數在 `counts.omitted`）。 */
  timeline(budget: number = RENDER_BUDGET): TimelineEntry<G>[] {
    this.#budget = budget;
    return mergeTimeline({ lines: this.lines, gaps: this.#gaps, budget });
  }
}
