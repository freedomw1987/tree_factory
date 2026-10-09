/**
 * M01-US-109：Deepgram nova-3 串流逐字稿聚段器。
 *
 * 背景（SPIKE-001）：nova-3 的 `diarize` 只在**單字層級**回 `speaker` 編號，
 * 串流**不會**回 `paragraphs` / `utterances`（批次 API 才有），所以聚段規則要自己寫。
 *
 * 聚段規則（三條，任何一條成立就切段）：
 *   ① `speaker` 變更
 *   ② 與前一個字的停頓**嚴格大於** `pauseThresholdMs`（預設 1200ms）
 *   ③ 收到 `UtteranceEnd`（endpointing 訊號）
 *
 * 設計約束：
 *   - **純邏輯**：無 I/O、無網路、**無時鐘**（只看輸入的 `start` / `end`）→ 同輸入必得同輸出。
 *   - **單位**：輸入 `start` / `end` 沿用 Deepgram 原生**秒**；輸出 `startMs` / `endMs` 為**毫秒**
 *     （本產品正準單位），避免在網路邊界做轉換。
 *   - **`speakerId` 保持 0 起算**（顯示層才 +1，見 DESIGN §2.4）。
 *   - **不修改輸入**（不得就地排序或改動物件）。
 *   - `flush()` 對應 SPIKE-001 的發現：`CloseStream` 會掉最後一句，必須明確收尾。
 */

/** Deepgram 回傳的單字（秒為單位，`speaker` 為 0 起算的講者編號）。 */
export interface DiarizedWord {
  readonly word: string;
  readonly punctuated_word?: string;
  readonly speaker: number;
  readonly start: number;
  readonly end: number;
}

/** 聚段結果（本產品正準單位：毫秒）。 */
export interface TranscriptSegment {
  readonly speakerId: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly words: DiarizedWord[];
}

/** 從 STT 串流進來的兩種事件。 */
export type StreamEvent =
  | { type: "words"; words: DiarizedWord[] }
  | { type: "utterance_end" };

export interface SegmenterOptions {
  /** 停頓門檻（毫秒）。嚴格大於才切段。預設 1200ms（SPIKE-001 的實測值）。 */
  pauseThresholdMs?: number;
  /**
   * 跨請求接續：把上一次 `bufferedWords()` 的內容放回緩衝（TECH-012 D1）。
   * 沒有這條路，切在句子中間的那半句就會隨物件消失（US-103 P0-1）。
   */
  resume?: readonly DiarizedWord[];
}

/** SPIKE-001 決定的預設停頓門檻：1.2 秒。 */
export const DEFAULT_PAUSE_THRESHOLD_MS = 1200;

export class TranscriptSegmenter {
  readonly #pauseThresholdMs: number;
  #buffer: DiarizedWord[] = [];

  constructor(options: SegmenterOptions = {}) {
    this.#pauseThresholdMs = options.pauseThresholdMs ?? DEFAULT_PAUSE_THRESHOLD_MS;
    // 只複製一層陣列：`DiarizedWord` 的欄位都是 readonly，逐字共用是安全的（不修改輸入）。
    this.#buffer = options.resume === undefined ? [] : [...options.resume];
  }

  /** 緩衝中的字（複本）——跨請求快照用；呼叫端不得藉此改到聚段器的狀態。 */
  bufferedWords(): DiarizedWord[] {
    return [...this.#buffer];
  }

  /**
   * 餵入一個串流事件。
   * @returns 本次事件**造成完成**的段落（0 到多段）；尚未完成的內容留在緩衝。
   */
  feed(event: StreamEvent): TranscriptSegment[] {
    if (event.type === "utterance_end") {
      const completed = this.#take();
      return completed === null ? [] : [completed];
    }

    const completed: TranscriptSegment[] = [];
    for (const word of event.words) {
      const previous = this.#buffer.at(-1);
      if (previous !== undefined && !this.#continues(previous, word)) {
        const segment = this.#take();
        if (segment !== null) {
          completed.push(segment);
        }
      }
      this.#buffer.push(word);
    }
    return completed;
  }

  /** 目前緩衝中（尚未完成）的段落，供即時顯示用；沒有內容時為 `null`。 */
  pending(): TranscriptSegment | null {
    return this.#buffer.length === 0 ? null : buildSegment(this.#buffer);
  }

  /**
   * 取出緩衝中最後一段（串流結束時呼叫）。
   * 具冪等性：第二次呼叫回 `null`，不會重複吐出。
   */
  flush(): TranscriptSegment | null {
    return this.#take();
  }

  /** 這兩個字是否屬於同一段。 */
  #continues(previous: DiarizedWord, next: DiarizedWord): boolean {
    if (previous.speaker !== next.speaker) {
      return false;
    }
    // 先四捨五入到毫秒再比：浮點誤差不可影響「等於門檻不切」的語意
    // （例如 2.2 - 1.0 = 1.2000000000000002 秒，代表的是恰好 1200ms）。
    const gapMs = Math.round((next.start - previous.end) * 1000);
    if (!Number.isFinite(gapMs)) {
      // 防禦：NaN / Infinity 的時間戳（上游資料壞掉時）不該把每個字都切成獨立段落，
      // 那會產生大量垃圾句子；視為續段，讓它成為一段（若後續正常資料到來仍可正確切段）。
      return true;
    }
    return gapMs <= this.#pauseThresholdMs;
  }

  #take(): TranscriptSegment | null {
    if (this.#buffer.length === 0) {
      return null;
    }
    const words = this.#buffer;
    this.#buffer = [];
    return buildSegment(words);
  }
}

function buildSegment(words: readonly DiarizedWord[]): TranscriptSegment {
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("buildSegment 不應收到空陣列");
  }
  return {
    speakerId: first.speaker,
    text: words.map((word) => word.punctuated_word ?? word.word).join(" ").trim(),
    startMs: Math.round(first.start * 1000),
    endMs: Math.round(last.end * 1000),
    words: [...words],
  };
}