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
  MAX_TEXT_CHARS,
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
  /**
   * 跨請求接續（TECH-012 D1）：上一次 `snapshot()` 的內容。
   * 有值時緩衝從這裡長回來，所以「同一個會議拆成多個請求」不會掉字。
   */
  resume?: { words?: readonly DiarizedWord[]; pendingUtteranceEnd?: boolean };
  /** 緩衝字數上限（TECH-012 D5）；預設 `MAX_BUFFER_WORDS`。 */
  maxBufferWords?: number;
  /**
   * 緩衝的**字元預算**（TECH-012 D5 修訂）；預設 `MAX_TEXT_CHARS`。
   *
   * 為什麼不能只看字數：帳本拒收 text 超過 `MAX_TEXT_CHARS` 的段落，而「強制收段」的職責
   * 正是「先落地、不丟字」——如果緩衝可以長到落地不了，那道守衛就等於不存在
   * （Gate 4 oracle 實測：一次 2001 字的請求會變成一顆 10889 字元的段落，每個請求都 400）。
   * 所以字元預算必須與帳本上限**同一個數量級**，且預設值直接綁定它。
   */
  maxTextChars?: number;
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
  /**
   * 這次為了守住緩衝上限而**強制收段**的次數（TECH-012 D5）。
   * 非 0 代表「有一句被提早落地」，裝置端看得出來切法與平常不同。
   */
  forcedFlushes: number;
  /**
   * 這次被判定成「早就落地的重播字」而**沒有餵進聚段器**的字數（TECH-012 D10 修訂）。
   *
   * 與 `duplicates` 分開：`duplicates` 是**段落級**（帳本冪等鍵命中），這裡是**字級**
   * （重播的整批事件裡、時間軸早已被帳本蓋到的那幾顆字）。兩者單位不同，不混算。
   * 為什麼要報：這些字是被**丟掉**的——丟得對（帳本已蓋到、丟了不掉字），但裝置端
   * 必須看得出來「這一批有東西被忽略」，不能再靠會議結束的 `droppedBufferedWords` 才知道。
   */
  replayedWords: number;
}

/**
 * 緩衝字數上限（TECH-012 D5）。
 *
 * 為什麼要有上限：聚段緩衝現在**每個字都落在 DO SQLite 裡**。若來源忘了送 `finalize`、
 * 或整場會議都沒有停頓，那一列會一直長大，最後變成單一列塞進整個會議的逐字稿。
 * 上限到了就「把已緩衝的那段先落地」（不是丟掉）——寧可多切一刀，不可以少字。
 * 2000 字 ≈ 連續講 13 分鐘以上（真人語速約 150 字／分），正常會議早已被停頓切過好幾段。
 *
 * **它只是兩個上限之一**：另一個是「字元預算」（`maxTextChars`，預設＝帳本的 `MAX_TEXT_CHARS`）。
 * 字數上限擋的是「那一列 SQLite 無限長大」，字元預算擋的是「收下來的段落落不了地」。
 * 兩者都在 `#feedLanding()` 裡以**逐字**的方式檢查（一批一次是不夠的：一批本身就可能超預算）。
 */
export const MAX_BUFFER_WORDS = 2000;

/** 空報告（兩處（路由與本檔內部）共用，避免欄位漏抄）。 */
export function emptyIngestReport(): IngestReport {
  return { appended: [], duplicates: [], conflicts: [], pending: null, forcedFlushes: 0, replayedWords: 0 };
}

/**
 * `meetingOffsetMs` 的唯一驗證點（TECH-012 D2）。
 *
 * 建構子用它，路由在「寫任何東西之前」也用它：不合法要在**還沒碰緩衝**前就 400，
 * 否則一次壞請求就會把好緩衝汙染成「以 0 為基準」的半句。
 */
export function requireMeetingOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TranscriptInvalidError(
      `meetingOffsetMs=${JSON.stringify(value)}（必須是非負整數毫秒；不得默默當 0）`,
    );
  }
  return value;
}

/** 冪等鍵前綴：之後若出現別的來源（例如人工補登），不會撞到這個命名空間。 */
export const SEGMENT_KEY_PREFIX = "seg";

export class TranscriptStream {
  readonly #sink: TranscriptSink;
  readonly #meetingOffsetMs: number;
  readonly #maxBufferWords: number;
  /** 落地的字元預算（TECH-012 D5 修訂）；預設與帳本的 `MAX_TEXT_CHARS` 相同。 */
  readonly #maxTextChars: number;
  /** 落地用（只有 final 的字進來）。 */
  readonly #segmenter: TranscriptSegmenter;
  /** 顯示用（interim + final 都進來）；不落地。 */
  readonly #display: TranscriptSegmenter;
  /** 收到 `UtteranceEnd` 但緩衝還是空的（訊號早於那句的 final）→ 記著，等緩衝有字再切。 */
  #pendingUtteranceEnd = false;
  /**
   * 從快照接回來的字（D10 的重播去重表）：鍵是「身分」（講者＋起訖＋字），值是還沒被配掉的顆數。
   * `null` = 這個請求不是接續來的（沒有東西要防重）。
   */
  #replayable: Map<string, number> | null = null;

  constructor(options: TranscriptStreamOptions) {
    this.#meetingOffsetMs = requireMeetingOffset(options.meetingOffsetMs);
    if (options.maxBufferWords !== undefined) {
      if (
        typeof options.maxBufferWords !== "number" ||
        !Number.isSafeInteger(options.maxBufferWords) ||
        options.maxBufferWords < 1
      ) {
        throw new TranscriptInvalidError(
          `maxBufferWords=${JSON.stringify(options.maxBufferWords)}（必須是 ≥ 1 的整數）`,
        );
      }
    }
    this.#maxBufferWords = options.maxBufferWords ?? MAX_BUFFER_WORDS;
    if (options.maxTextChars !== undefined) {
      if (
        typeof options.maxTextChars !== "number" ||
        !Number.isSafeInteger(options.maxTextChars) ||
        options.maxTextChars < 1
      ) {
        throw new TranscriptInvalidError(
          `maxTextChars=${JSON.stringify(options.maxTextChars)}（必須是 ≥ 1 的整數）`,
        );
      }
    }
    this.#maxTextChars = options.maxTextChars ?? MAX_TEXT_CHARS;
    this.#sink = options.sink;
    const segmenterOptions =
      options.pauseThresholdMs === undefined ? {} : { pauseThresholdMs: options.pauseThresholdMs };
    const resumed = options.resume?.words;
    this.#pendingUtteranceEnd = options.resume?.pendingUtteranceEnd === true;
    if (resumed !== undefined) this.#replayable = countWords(resumed);
    this.#segmenter = new TranscriptSegmenter(
      resumed === undefined ? segmenterOptions : { ...segmenterOptions, resume: resumed },
    );
    // 顯示緩衝用「落地緩衝」當種子（TECH-012 D6）：final 的半句是已知的，不說給顯示層聽
    // 等於每次換請求畫面就跳一下。interim 的內容不落地、也不進快照（下次累積重送會自己補上）。
    this.#display = new TranscriptSegmenter(
      resumed === undefined ? segmenterOptions : { ...segmenterOptions, resume: resumed },
    );
  }

  /** 音訊第一幀相對會議開始的毫秒（寫快照時要一起存，見 `snapshot()`）。 */
  get meetingOffsetMs(): number {
    return this.#meetingOffsetMs;
  }

  /**
   * 現在該持久化的狀態（TECH-012 D1／D5／D7）。
   *
   * 呼叫時機是**整批成功之後**：中途拋錯就不寫快照，呼叫端可以原封不動重送同一批
   * （已落地的句子靠冪等鍵收斂成 duplicate）。
   */
  snapshot(): {
    meetingOffsetMs: number;
    words: DiarizedWord[];
    pendingUtteranceEnd: boolean;
  } {
    return {
      meetingOffsetMs: this.#meetingOffsetMs,
      words: this.#segmenter.bufferedWords(),
      pendingUtteranceEnd: this.#pendingUtteranceEnd,
    };
  }

  /** 餵入原始訊息（`messages` 可以是任意 JSON；壞訊息會被忽略）。 */
  ingest(messages: readonly unknown[], context: IngestContext): IngestReport {
    const report = emptyIngestReport();
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
        // D10：先扣掉「上一批已經收下、這次只是重播」的字。整批都是重播時**什麼都不做**——
        // 連 `UtteranceEnd` 的收段都要延後，否則重播一次就會把緩衝提前清空（狀態不冪等）。
        const fresh = this.#takeFresh(event.words, report);
        if (fresh.length === 0) continue;
        if (this.#pendingUtteranceEnd && this.#segmenter.pending() !== null) {
          this.#pendingUtteranceEnd = false;
          this.#commit(this.#segmenter.feed({ type: "utterance_end" }), context, report);
        }
        this.#feedLanding(fresh, context, report);
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
    const report = emptyIngestReport();
    // 收尾＝這條串流結束，延後中的 endpointing 訊號也一併消費掉：
    // 否則它會跟著快照活到下一條串流，讓下一句開頭白白多切一刀。
    this.#pendingUtteranceEnd = false;
    const tail = this.#segmenter.flush();
    if (tail !== null) this.#commit([tail], context, report);
    this.#display.flush();
    report.pending = this.pending();
    return report;
  }

  /**
   * 重播去重（TECH-012 D10）。
   *
   * 為什麼需要：裝置端是 at-least-once——回應在路上掉了就會重送同一批事件。落地的那一段有冪等鍵
   * 擋著（同鍵同內容 → `duplicate`），但**還在緩衝裡的那半句**沒有鍵可用，照單全收就會變成
   * 「甲 甲」這種疊字，之後落地時內容與已落地的列不同 → 變成 `conflict`（那句話就沒了）。
   *
   * 判準是「身分完全相同」：講者＋起訖秒＋字面。真跡裡的時間戳是浮點秒，
   * 同一個字不可能用同一組時間戳出現兩次，所以配掉的一定是重播。
   * 另外，**已經落地**的字不在這張表裡，但也不該被當成新音訊——那是 `#isStaleReplay()`
   * 的工作（問緩衝的順序＋帳本的時間軸），兩道判準合起來才是完整的「重播」定義。
   *
   * 已知限制：裝置端若把同一批字**改過**（例如重新標點／換時間戳）再送，這裡認不出來，
   * 就會走衝突路徑——大聲（`conflicts` 非 0），不是靜默。
   */
  #takeFresh(words: readonly DiarizedWord[], report: IngestReport): DiarizedWord[] {
    const replayable = this.#replayable;
    if (replayable === null) return [...words];
    // 緩衝現有內容的時間終點（毫秒）；空緩衝＝沒有「排在後面卻時間更早」的風險。
    // 這一輪的字會在迴圈跑完之後才餵進去，所以這份快照在整輪判準裡都成立。
    const buffered = this.#segmenter.bufferedWords();
    const lastBuffered = buffered.length === 0 ? null : (buffered[buffered.length - 1] ?? null);
    const bufferTailEndMs = lastBuffered === null ? null : this.#toMs(lastBuffered.end);
    const fresh: DiarizedWord[] = [];
    for (const word of words) {
      const key = wordIdentity(word);
      const left = replayable.get(key) ?? 0;
      if (left > 0) {
        if (left === 1) replayable.delete(key);
        else replayable.set(key, left - 1);
        continue;
      }
      // 已經落地、而且餵了會打亂緩衝順序的重播字 → 丟（見 #isStaleReplay）。
      if (bufferTailEndMs !== null && this.#isStaleReplay(word, bufferTailEndMs)) {
        // 丟掉的重播字要報出來（D9 加法欄位）：丟得對，但不能靜默。
        report.replayedWords += 1;
        continue;
      }
      fresh.push(word);
    }
    return fresh;
  }

  /** 秒 → 毫秒（聚段器用的是秒，帳本用的是毫秒）。 */
  #toMs(seconds: number): number {
    return Math.round(seconds * 1000) + this.#meetingOffsetMs;
  }

  /**
   * 這顆字是不是「早就落地、而且餵了會打亂緩衝順序」的重播字（TECH-012 D10 修訂；
   * Gate 4 第二輪 oracle 的 P1）。
   *
   * 為什麼只看緩衝不夠：裝置端重送的是**整批事件**，裡面同時有「已經落地那半句之後的字」
   * 與「還在緩衝裡的字」。後者靠 `#replayable` 認得（同一份快照帶回來的），前者不在那張表裡
   * ——照單全收就會把它接在「時間較晚的緩衝字」後面：緩衝時間軸反向（第一顆字的 `start`
   * 比最後一顆字的 `end` 還大），下一次落地被 `validateSegment` 擋成 400；而且壞掉的順序
   * **已經寫回 SQLite**（每個請求都重新 `buffers.read()`）→ 之後每個請求都 400、
   * 字只在會議結束以 `droppedBufferedWords` 出現（實測重現見交付文）。
   *
   * 兩個條件都成立才丟（缺一不可）：
   * 1. **會打亂順序**：這顆字的終點 ≤ 緩衝現有內容的終點 → 餵進去是「排在後面、時間更早」
   *    （緩衝空、或字本來就接在緩衝後面 → 條件不成立 → 照舊餵）。
   * 2. **帳本已經蓋到它的終點**：`previousEndMs(字終點) >= 字終點` → 這顆字的時間軸早就在
   *    帳本裡了，丟掉不會掉字（只是不重複落地）。真實的重播形狀就是這樣。
   *
   * 條件 2 是「不掉字」的保證：**沒被帳本蓋到**的字（例如 US-102 回補送來的舊音訊字）
   * 一律不收進判準，即使它會排在緩衝前面——那些字還沒落地，丟了就是真的掉字。
   * 條件 1 少用「起點」當基準：起點剛好等於已落地那列終點的新字（合法接續）終點更大，
   * 蓋不到 → 不會被誤殺。
   *
   * 已知取捨（刻意的，不是承諾）：**沒被帳本蓋到**又排在緩衝前面的字（來源時序外送）仍會
   * 照原樣餵進聚段器——那條路的時間軸本來就可能反向（本票不處理，見交付文的未開票遺留）。
   * 另外，帳本只有段級的時間覆蓋、沒有逐字身分，所以「被蓋到」是以時間軸判定的：
   * 兩位講者的字在同一段時間內交錯、且較晚的那批已先落地時，較早的那批會被判成重播丟掉。
   */
  #isStaleReplay(word: DiarizedWord, bufferTailEndMs: number): boolean {
    const wordEndMs = this.#toMs(word.end);
    if (wordEndMs > bufferTailEndMs) return false;
    const coveredEnd = this.#sink.previousEndMs(wordEndMs);
    return coveredEnd !== null && wordEndMs <= coveredEnd;
  }

  /**
   * 把「落地用」的字**一個一個**餵進聚段器，並在任何時候守住緩衝的兩個上限（TECH-012 D5）。
   *
   * 為什麼是逐字而不是逐批：上限的判準是「緩衝 + 這一顆字會不會超過」。若逐批檢查，
   * 一批本身就超過預算時（實測：一批 2001 顆字）守衛只能放行，緩衝收下來的那段就落地不了
   * ——守衛反而製造了它要防的那個結果（Gate 4 oracle 的 P1）。逐字檢查之後，
   * 任何一次請求都不可能讓緩衝超出上限，強制收段的段落也一定落得了地。
   *
   * 逐字餵與逐批餵在聚段語意上等價：聚段器本來就是逐字在判斷切點
   * （`feed()` 內是 `for (const word of event.words)`）。
   */
  #feedLanding(words: readonly DiarizedWord[], context: IngestContext, report: IngestReport): void {
    for (const word of words) {
      // 單一 token 自己就超過帳本上限 → 它放進任何段落都落不了地（沒有任何合法切點）。
      // 這種 token 實務上不存在（STT 的一顆字不會有 2000 字元），但**不能讓它進緩衝**：
      // Gate 4 第二輪 oracle 實測，放行之後那顆字會先被收下，之後同一場會議的**每一次請求
      // 都 400**（連正常字也落不了地），直到會議結束以 `droppedBufferedWords` 收場。
      // 當批就大聲擋（路由轉 400），緩衝維持乾淨，後續正常字照常可用。
      const wordChars = wordTextLength(word);
      if (wordChars > this.#maxTextChars) {
        throw new TranscriptInvalidError(
          `text 長度 ${wordChars} 超過上限 ${this.#maxTextChars}（單一 token 落不了地，不進緩衝）`,
        );
      }
      const buffered = this.#segmenter.bufferedWords();
      if (buffered.length > 0 && this.#overflows(buffered, word)) {
        this.#forceFlush(context, report);
      }
      this.#commit(this.#segmenter.feed({ type: "words", words: [word] }), context, report);
    }
  }

  /**
   * 收下這顆字之後，緩衝會不會超過任一個上限？
   *
   * 兩個判準都**不是**「≥」而是「超過就切」：恰好等於上限時不切（切了會多出沒有人要的碎句）。
   * 字元那一條用的是「join 之後的長度」——它是 `buildSegment()` 真正產出的 `text.length` 的
   * **上界**（同樣的字、同樣的空白分隔，只差最後的 `trim()` 會把兩端削短），
   * 所以「join 長度 ≤ 上限」保證「text.length ≤ 上限」→ 段落一定落得了地。
   */
  #overflows(buffered: readonly DiarizedWord[], next: DiarizedWord): boolean {
    if (buffered.length >= this.#maxBufferWords) return true;
    return joinedTextLength(buffered) + 1 + wordTextLength(next) > this.#maxTextChars;
  }

  /** 把緩衝裡的那一段先落地（不是丟掉），並記一次「提早收段」。 */
  #forceFlush(context: IngestContext, report: IngestReport): void {
    const forced = this.#segmenter.flush();
    if (forced === null) return;
    this.#commit([forced], context, report);
    report.forcedFlushes += 1;
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
  return emptyIngestReport();
}

/** 一顆字在 `text` 裡的長度（`buildSegment()` 用 `punctuated_word ?? word`）。 */
function wordTextLength(word: DiarizedWord): number {
  return (word.punctuated_word ?? word.word).length;
}

/** 這串字 join 起來之後的長度（＝`buildSegment()` 產出的 `text.length` 的上界，見 `#overflows`）。 */
function joinedTextLength(words: readonly DiarizedWord[]): number {
  if (words.length === 0) return 0;
  let length = words.length - 1;
  for (const word of words) {
    length += wordTextLength(word);
  }
  return length;
}

/** 一個字的「身分」（重播去重用；不含標點，因為標點不改變它是不是同一顆字）。 */
function wordIdentity(word: DiarizedWord): string {
  return `${word.speaker}|${word.start}|${word.end}|${word.word}`;
}

function countWords(words: readonly DiarizedWord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) {
    const key = wordIdentity(word);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
