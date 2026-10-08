/**
 * M01-US-103：串流落地管線（原始訊息 → 聚段 → 帳本）。
 *
 * 這是把 US-109（聚段器）、本票的解析層（`nova-events.ts`）與帳本（`transcript-store.ts`）
 * 接成一條線的地方。四個決策在這裡被落實：
 *
 * - **D3／D4：只有 `is_final` 的字進帳本**。interim 留在記憶體（`pending()`，給 US-104 顯示），
 *   所以「interim 與 final 混餵同一段」在**結構上**不可能產生兩句（AC-6）。
 * - **冪等鍵＝`seg:<speakerId>:<startMs>`**：同一個人、同一個起點＝同一句 → 重送收斂成 `duplicate`。
 * - **D6：重疊留痕**：段落起點早於帳本裡**前一段**的終點時記下 `overlapMs`（AC-4）。
 * - **D10：`finalize()` 收尾**（SPIKE-001：只送 `CloseStream` 會掉最後一句）。
 *
 * 時間軸（AC-2）：字詞的秒 → 毫秒由聚段器做；「音訊第一幀 ≠ 會議開始」的差額由
 * `meetingOffsetMs` 補上。**它沒有預設值**——默默當 0 等於宣稱「按下開始的瞬間 STT 已經連上」，
 * 那是假的，所以呼叫端一定要明講。
 */

import { parseNovaMessage } from "./nova-events.js";
import { TranscriptSegmenter, type DiarizedWord, type TranscriptSegment } from "./segmentation.js";
import {
  TranscriptInvalidError,
  validateSegment,
  type RecordSegmentInput,
  type RecordSegmentOutcome,
  type TranscriptSegmentRecord,
} from "./storage/transcript-store.js";

/** 帳本出口（結構上就是 `TranscriptLedger`；用介面是為了讓測試能注入假帳本）。 */
export interface TranscriptSink {
  record(input: RecordSegmentInput): RecordSegmentOutcome;
  /** 時間軸上前一段（起點更早、最接近的那一段）的結束時間；沒有則 `null`。 */
  previousEndMs(startMs: number): number | null;
}

export interface TranscriptStreamOptions {
  sink: TranscriptSink;
  /** 音訊第一幀相對會議開始的毫秒（必填，見檔頭）。 */
  meetingOffsetMs: number;
  /** 停頓門檻；預設與聚段器一致（1200ms）。 */
  pauseThresholdMs?: number;
}

/** 每次落地都要帶的伺服端時間（由 DO 依 session 權威時間算出）。 */
export interface IngestContext {
  nowMs: number;
  maxMs: number;
}

export interface IngestReport {
  /** 這次真的新增的列。 */
  appended: TranscriptSegmentRecord[];
  /** 這把鑰匙本來就在（重送），內容相同。 */
  duplicates: TranscriptSegmentRecord[];
  /** 這把鑰匙本來就在，但內容不同（不覆寫、不靜默）。 */
  conflicts: { existing: TranscriptSegmentRecord; incoming: TranscriptSegmentRecord }[];
  /** 緩衝中還沒完成的那一段（給顯示用；不落地）。 */
  pending: TranscriptSegment | null;
}

/** 冪等鍵前綴：之後若出現別的來源（例如人工補登），不會撞到這個命名空間。 */
export const SEGMENT_KEY_PREFIX = "seg";

export class TranscriptStream {
  readonly #sink: TranscriptSink;
  readonly #meetingOffsetMs: number;
  /** 落地用（只有 final 的字進來）。 */
  readonly #segmenter: TranscriptSegmenter;
  /** 顯示用（interim + final 都進來）；不落地。 */
  readonly #display: TranscriptSegmenter;
  /** 收到 `UtteranceEnd` 但緩衝還是空的（訊號早於那句的 final）→ 記著，等緩衝有字再切。 */
  #pendingUtteranceEnd = false;

  constructor(options: TranscriptStreamOptions) {
    this.#meetingOffsetMs = options.meetingOffsetMs;
    if (
      typeof this.#meetingOffsetMs !== "number" ||
      !Number.isSafeInteger(this.#meetingOffsetMs) ||
      this.#meetingOffsetMs < 0
    ) {
      throw new TranscriptInvalidError(
        `meetingOffsetMs=${JSON.stringify(options.meetingOffsetMs)}（必須是非負整數毫秒；不得默默當 0）`,
      );
    }
    this.#sink = options.sink;
    const segmenterOptions =
      options.pauseThresholdMs === undefined ? {} : { pauseThresholdMs: options.pauseThresholdMs };
    this.#segmenter = new TranscriptSegmenter(segmenterOptions);
    this.#display = new TranscriptSegmenter(segmenterOptions);
  }

  /** 餵入原始訊息（`messages` 可以是任意 JSON；壞訊息會被忽略）。 */
  ingest(messages: readonly unknown[], context: IngestContext): IngestReport {
    const report = emptyReport();
    for (const message of messages) {
      for (const event of parseNovaMessage(message)) {
        if (event.type === "utterance_end") {
          // AC-7／D5：endpointing 訊號＝「上一句到這裡結束」，一到就該收段（即使停頓還沒超過門檻）。
          // 但訊號可能**早於那句的 final**（AC-6 的 Given 正是這個順序）：此時落地用的緩衝還是空的，
          // 當下收段等於什麼都沒切（實測：整段會併成一句）。所以先記旗標，
          // 等緩衝真的有字、下一個 words 事件到來時才真的切。
          this.#pendingUtteranceEnd = true;
          this.#display.feed(event);
          continue;
        }
        if (event.type === "speech_started") {
          // 目前只解析、不使用（保留給未來的即時「開始說話」提示）。
          continue;
        }
        // D4：interim 只更新顯示緩衝，不進聚段器 → 不可能產生重複句。
        this.#feedDisplay(event.words);
        if (!event.final) continue;
        if (this.#pendingUtteranceEnd && this.#segmenter.pending() !== null) {
          this.#pendingUtteranceEnd = false;
          this.#commit(this.#segmenter.feed({ type: "utterance_end" }), context, report);
        }
        this.#commit(this.#segmenter.feed({ type: "words", words: event.words }), context, report);
      }
    }
    report.pending = this.pending();
    return report;
  }

  /**
   * 串流收尾：把緩衝中的最後一段落地（D10）。
   * 具冪等性——聚段器的 `flush()` 第二次回 `null`，所以重複呼叫不會多出一句。
   */
  finalize(context: IngestContext): IngestReport {
    const report = emptyReport();
    const tail = this.#segmenter.flush();
    if (tail !== null) this.#commit([tail], context, report);
    this.#display.flush();
    report.pending = this.pending();
    return report;
  }

  /**
   * 把字詞餵進「顯示用」緩衝（interim + final 都進；落地與它無關）。
   *
   * Deepgram 的 interim 是**累積重送**：每一則都從該句的第一個字重述整個前綴（真跡可證）。
   * 照單全收會讓 `pending()` 出現同一句重複 2~4 次（實測），US-104 直接接上去就會看到那串。
   * 判準：這批字的第一個字起點**不晚於**目前緩衝的結尾 → 它與緩衝重疊，是「重述」而不是「續講」，
   * 先丟掉舊緩衝再餵。**這個判準假設來源是累積重送**（真跡就是這樣）：若來源改成「零間隙的增量
   * 片段」（上批 `end == 下批 start`），判準恆真 → 每批都 flush，而 `flush()` 回傳的段落目前被丟棄
   * （本票只做落地，顯示是 US-104）→ `pending()` 只剩本批。US-104 接手時要保留 flush 的內容
   * （Gate 4 第二輪 P2-2）。
   *
   * 為什麼不是比「緩衝起點」：真跡的 interim 講者標記不可靠（前 13 則一律標 `speaker 0`，
   * 連 `speaker 1` 的句子也被標成 0），所以緩衝起點可能停在好幾句之前，
   * 比起點會漏掉第 2 句之後的每一次重述（實測：`pending()` 疊到 4 次）。
   */
  #feedDisplay(words: DiarizedWord[]): void {
    const first = words[0];
    const buffered = this.#display.pending();
    if (first !== undefined && buffered !== null && first.start * 1000 <= buffered.endMs) {
      this.#display.flush();
    }
    this.#display.feed({ type: "words", words });
  }

  /** 緩衝中尚未完成的段落（interim 也在裡面）；沒有內容時為 `null`。 */
  pending(): TranscriptSegment | null {
    return this.#display.pending();
  }

  /** 把聚段器吐出的段落寫進帳本，並依結果分類（新增 / 重送 / 衝突）。 */
  #commit(segments: readonly TranscriptSegment[], context: IngestContext, report: IngestReport): void {
    for (const segment of segments) {
      const startMs = segment.startMs + this.#meetingOffsetMs;
      const endMs = segment.endMs + this.#meetingOffsetMs;
      // 重疊＝前一段還沒結束、這一段就開始了。問**帳本**（權威時間軸）而不是問這個物件的記憶體：
      // 記憶體版本在「重播同一份事件串流」時會拿上一輪的結尾當前一段，算出假重疊，
      // 讓同一句話在重播時變成內容不同的衝突（實測踩到，這正是 AC-1 要防的漂移）。
      // 上限夾在本段長度內：極端交錯下重疊不可能比句子本身長。
      const previousEndMs = this.#sink.previousEndMs(startMs);
      const overlapMs =
        previousEndMs === null ? 0 : Math.min(Math.max(0, previousEndMs - startMs), endMs - startMs);
      const fields = {
        idempotencyKey: `${SEGMENT_KEY_PREFIX}:${segment.speakerId}:${startMs}`,
        speakerId: segment.speakerId,
        text: segment.text,
        startMs,
        endMs,
        overlapMs,
      };
      // 先用同一套驗證擋一次：不合法的段落不該讓整批 500，而是明確 400（由路由轉譯）。
      validateSegment({ ...fields, maxMs: context.maxMs, nowMs: context.nowMs });
      const outcome = this.#sink.record({ ...fields, maxMs: context.maxMs, nowMs: context.nowMs });
      if (outcome.accepted) {
        report.appended.push(outcome.segment);
      } else if (outcome.duplicate) {
        report.duplicates.push(outcome.segment);
      } else {
        report.conflicts.push({ existing: outcome.existing, incoming: outcome.incoming });
      }
    }
  }
}

function emptyReport(): IngestReport {
  return { appended: [], duplicates: [], conflicts: [], pending: null };
}
