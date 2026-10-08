/**
 * TECH-004：Durable Object 入口——每一場會議就是一個 DO。
 *
 * 這個類別刻意很薄：所有壽命邏輯都在 `HarnessLifecycle`（可純單元測試），
 * 所有 harness 建構細節都在 `openMeeting()`（可用 node:sqlite 整合測試）。
 * DO 只負責：把平台的 `ctx.storage` / alarm API 接上這兩者，並提供 HTTP 介面。
 *
 * 平台事實（SPIKE-003 實測）：
 * - DO constructor **不能 await** → 用 `HarnessLifecycle` 的懶初始化處理。
 * - DO 隨時可能被回收；下一次請求或 alarm 進來時必須能用同一份 storage 重開。
 * - `harness.close()` 會關掉 storage，所以重建走 `openMeeting()` 全鏈重建。
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { HarnessLifecycle, type LifecycleStats } from "./harness/lifecycle.js";
import {
  MissingCredentialError,
  ModelUnavailableError,
  UnknownProviderError,
  openMeeting,
  type MeetingBindings,
  type OpenMeetingResult,
} from "./harness/meeting-harness.js";
import { sha256Hex16 } from "./hash.js";
import {
  SESSION_ENDED_REASONS,
  acceptsTranscriptWrites,
  expireSession,
  sessionStatus,
  startSession,
  stopSession,
  type MeetingSession,
  type SessionEndedReason,
} from "./session.js";
import {
  AUDIO_RETENTION_DAYS,
  AudioChunkStore,
  ChunkConflictError,
  ChunkInvalidError,
  TranscriptChunkLedger,
  type ChunkSql,
} from "./storage/chunk-store.js";
import {
  GAP_SKEW_TOLERANCE_MS,
  GapConflictError,
  GapInvalidError,
  TranscriptGapLog,
} from "./storage/gap-store.js";
import {
  SessionCorruptError,
  SessionStore,
  type SessionSnapshot,
  type SessionSql,
} from "./storage/session-store.js";
import {
  SEGMENT_PAGE_LIMIT_MAX,
  TRANSCRIPT_SKEW_TOLERANCE_MS,
  TranscriptInvalidError,
  TranscriptLedger,
  validateSegment,
  type RecordSegmentInput,
  type RecordSegmentOutcome,
} from "./storage/transcript-store.js";
import { TranscriptStream, type IngestReport } from "./transcript-stream.js";

/** Worker 綁定（含 secret 與 vars）。 */
export type MeetingEnv = MeetingBindings;

/** 測試或離線執行時可注入的相容 storage（欄位同名即可）。 */
export interface DurableObjectStorageLike {
  sql: { exec(sql: string, ...bindings: never[]): unknown };
  setAlarm(atMs: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T>;
}

export interface MeetingDurableObjectContext {
  storage: DurableObjectStorageLike;
  /** DO id（測試與維運用；證明「一個會議 = 一個 DO 實例」）。 */
  id?: { toString(): string };
  /**
   * 現在時間（毫秒）。正式環境用 `Date.now()`；測試注入固定時鐘，
   * 這樣「兩小時後」是立刻可驗的，不必真的等兩小時、也不必動系統時鐘。
   */
  now?: () => number;
  /**
   * 逐字稿讀取一頁的上限（TECH-013）。正式環境＝`SEGMENT_PAGE_LIMIT_MAX`（500）；
   * 測試注入小值，這樣「不帶參數時真的在上限截斷」只要寫 51 列就能驗，
   * 不必在單元測試裡湊到 501 列才看得出差別。
   */
  pageLimitMax?: number;
}

/** 一次 alarm 醒來最多再往前排多久（避免無限接力）。 */
export const MAX_ALARM_DELAY_MS = 5 * 60 * 1000;

/** 讓 DO 類別在沒有 workerd 型別時也能被測試引用。 */
type DurableObjectState = MeetingDurableObjectContext;

/**
 * 讀一個分頁參數（TECH-013 D4）。
 *
 * 不合法就 `400 TRANSCRIPT_INVALID` 並指名欄位，**不靜默夾住**：
 * `?limit=0` 若默默變成上限 500，呼叫端以為「我只要 0 列」卻收到 500 列，
 * 而且永遠不會知道自己在說謊。同一個立場也用在這條路由的其他守門（US-103）。
 *
 * 重複帶同一參數＝錯誤：`?limit=1&limit=2` 沒有唯一合理的解讀方式，
 * 猜一個等於替呼叫端決定它沒說的事。
 */
function readPageParam(params: URLSearchParams, field: "since" | "limit", max: number): number | null {
  const values = params.getAll(field);
  if (values.length === 0) return null;
  if (values.length > 1) {
    throw new TranscriptInvalidError(`${field} 不得重複`);
  }
  const raw = values[0] as string;
  const message =
    field === "since" ? "since 必須是 ≥ 0 的整數" : `limit 必須是 1~${max} 的整數`;
  // 只收十進位整數字串：`/^\d+$/` 擋掉負號、小數、`1e3`、`0x1f` 與空字串。
  if (!/^\d+$/.test(raw)) throw new TranscriptInvalidError(message);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TranscriptInvalidError(message);
  if (field === "since") return value;
  if (value < 1 || value > max) throw new TranscriptInvalidError(message);
  return value;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export class MeetingDurableObject {
  readonly #ctx: DurableObjectState;
  readonly #env: MeetingEnv;
  readonly #lifecycle: HarnessLifecycle<OpenMeetingResult>;
  #alarmWakes = 0;

  constructor(ctx: DurableObjectState, env: MeetingEnv) {
    this.#ctx = ctx;
    this.#env = env;
    this.#lifecycle = new HarnessLifecycle<OpenMeetingResult>({
      // 重建整條鏈：adapter + storage + harness（close 會關掉 storage，見 SPIKE-003）。
      open: () => openMeeting(ctx.storage as never, { bindings: env }),
      close: (opened) => opened.harness.close(BACKGROUND_CONTEXT),
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      getAlarm: () => ctx.storage.getAlarm(),
    });
  }

  /** 壽命統計（給維運與測試看單例與接力是否真的發生）。 */
  get stats(): LifecycleStats & { alarmWakes: number } {
    return { ...this.#lifecycle.stats, alarmWakes: this.#alarmWakes };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/health":
          return json(await this.#health());
        case "/wake": {
          const raw = url.searchParams.get("ms");
          // 只收十進位整數字串（第二輪 checker 實測 NEW-P2-2）：`Number("0x1f")` 是 31、
          // `Number("0.5")` 會被平台存成小數時間戳、`Number("1e3")` 是 1000，
          // 都不是呼叫端想表達的「毫秒」；而「沒帶參數」與「帶了空字串」更不能
          // 退化成 0（獨立 reviewer 實測的忙迴圈）。
          // 另外：**格式檢查不得先 trim**（第三輪 NEW-3-1）——query 裡的 `+` 是空白
          // （`?ms=+5` → `" 5"`），trim 下去就等於放行 5ms 的近似立即 alarm；
          // 只有「空／只有空白」這種「等於沒給」的情況才走 `MS_REQUIRED`。
          if (raw === null || raw.trim() === "") {
            return json(
              {
                error: "MS_REQUIRED",
                message: "請帶 ?ms=<毫秒>",
                example: `/wake?ms=${DEFAULT_ALARM_DELAY_MS}`,
              },
              400,
            );
          }
          if (!/^\d+$/.test(raw)) {
            return json({ error: "MS_INVALID", value: raw }, 400);
          }
          const delayMs = Number(raw);
          if (!Number.isSafeInteger(delayMs)) {
            return json({ error: "MS_INVALID", value: raw }, 400);
          }
          // `ms=0` 是**明確**的「立刻接力」（刻意放行，與沒帶 ms 的退化不同）；
          // 上限則是「一次 alarm 最多再往前排這麼久」。
          if (delayMs > MAX_ALARM_DELAY_MS) {
            // 一次 alarm 最多只能再往前排 5 分鐘，醒來後再接力；否則單一 alarm 可能被推到
            // 「會議已結束很久」才響，中間的收尾就斷了。
            return json(
              { error: "MS_TOO_LARGE", value: raw, max: MAX_ALARM_DELAY_MS },
              400,
            );
          }
          return json(await this.#lifecycle.wakeIn(delayMs));
        }
        case "/session":
          return this.#sessionStatusRoute();
        case "/session/start":
          return await this.#sessionStartRoute(request);
        case "/session/stop":
          return await this.#sessionStopRoute(request);
        case "/transcript":
          return await this.#transcriptRoute(request);
        case "/transcript/segments":
          return await this.#transcriptSegmentsRoute(request);
        case "/transcript/stream":
          return await this.#transcriptStreamRoute(request);
        case "/transcript/gap":
          return await this.#transcriptGapRoute(request);
        case "/transcript/gaps":
          return this.#transcriptGapListRoute();
        case "/audio/chunk":
          return await this.#audioChunkRoute(request, url);
        case "/audio/chunks":
          return this.#audioChunkListRoute();
        case "/release": {
          // 照實回報：有 open 正在飛時 release() 會延後（不把即將交出去的 harness 關掉）。
          const decision = await this.#lifecycle.release();
          return json({ ...decision, ...this.stats });
        }
        case "/debug/faux": {
          // 測試支援：只有 faux provider 才有作用（正式 provider 下一定回 404）。
          const opened = await this.#lifecycle.current();
          if (opened.faux === undefined || !("setResponses" in opened.faux)) {
            return json({ error: "NOT_FAUX" }, 404);
          }
          const payload = (await request.json()) as { contents?: string[] };
          const contents = payload.contents ?? [];
          opened.faux.setResponses(contents.map((content) => fauxAssistantMessage(content)));
          return json({ scripted: contents.length });
        }
        case "/submit": {
          const payload = (await request.json()) as { content?: string };
          return json(await this.#submit(payload.content ?? ""));
        }
        default:
          return json({ error: "NOT_FOUND", path: url.pathname }, 404);
      }
    } catch (error) {
      if (error instanceof SessionCorruptError) {
        // TECH-008：DB 被竊改（欄位不合法／時間軸被平移）與「程式 bug」在維運上是兩件事，
        // 所以給它自己的 code。`recoverable:false`：DO 每次讀都會失敗，裝置端只能停錄。
        return json({ error: error.code, message: error.message, recoverable: false }, 500);
      }
      if (error instanceof MissingCredentialError) {
        // AUTH_INVALID 是唯一允許阻斷的錯誤（system-design §5.2）。
        return json({ error: error.code, message: error.message, recoverable: false }, 401);
      }
      if (error instanceof ChunkConflictError) {
        // 同 seq 不同內容：**不覆蓋**（覆蓋會讓已落地的逐字稿與音檔對不上）。
        return json({ error: error.code, message: error.message, recoverable: false }, 409);
      }
      if (error instanceof ChunkInvalidError) {
        return json({ error: error.code, message: error.message }, 400);
      }
      if (error instanceof GapInvalidError) {
        return json({ error: error.code, message: error.message }, 400);
      }
      if (error instanceof TranscriptInvalidError) {
        // 逐字稿段落不合法：明確 400 並指出欄位（整批不寫，見 #transcriptSegmentsRoute）。
        return json({ error: error.code, message: error.message, recoverable: true }, 400);
      }
      if (error instanceof GapConflictError) {
        // 同 seq 不同起點 = 裝置端序號重用：不覆蓋，因為覆蓋會讓兩次中斷變成同一筆。
        return json({ error: error.code, message: error.message, recoverable: false }, 409);
      }
      if (error instanceof UnknownProviderError || error instanceof ModelUnavailableError) {
        // 設定錯誤（provider / 模型 id）：明確講出來，不讓它變成一個含糊的 INTERNAL。
        // `recoverable` 依 §5.2 的定義＝「裝置可繼續」（不是「維運可自癒」）。
        return json(
          { error: error.code, message: error.message, recoverable: error.recoverable },
          500,
        );
      }
      return json(
        { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  }

  /**
   * alarm 醒來：確保 harness 可用（被回收過就重建），然後把下一次醒來往前排。
   *
   * 為什麼要在這裡 `release()`：alarm 執行完之後，DO 可能很久沒有新請求，
   * 主動放掉 harness 可以讓「下一次請求一定讀得回同一份資料」這件事在每次醒來都被驗證
   * （而不是等到記憶體被平台回收才第一次走重建路徑）。
   */
  async alarm(): Promise<void> {
    this.#alarmWakes += 1;
    // 先收 session 再處理 harness：到點收尾不該被 harness 的失敗拖累
    // （若 harness 拋錯，錄音上限仍然已經落地，裝置端問到的會是正確答案）。
    this.#expireSessionIfReached();
    // 接力：session 的到點 alarm 可能「一開始就沒排到」——若 start 當下已有一個更早的
    // alarm（TECH-004 的 harness 接力 demo 就是），earliest-wins 不會覆蓋它，
    // 而那個早 alarm 醒來後 slot 就被清空了。沒有這一行，session 到點這個 wake 永遠不會發生，
    // 上限只能靠「下一次請求剛好進來」時惰性判定（資料最終還是對的，但少了一條防線）。
    await this.#rearmSessionAlarm();
    const opened = await this.#lifecycle.onAlarm();
    await opened.root(); // 觸發一次讀取，確認重建後同一場會議讀得回來
    // 正常情況下 `onAlarm()` 已經開完，這裡會真的關掉；萬一延後（有別的 open 在飛），
    // 也會計進 `stats.deferredReleases` 並在 /health 看得到，不是靜默丟掉。
    await this.#lifecycle.release();
  }

  // ─────────────────────────────── M01-US-101：session ───────────────────────────────

  #now(): number {
    return (this.#ctx.now ?? Date.now)();
  }

  #sessionStore(): SessionStore {
    return new SessionStore(this.#ctx.storage.sql as unknown as SessionSql);
  }

  /**
   * DO SQL 的最小介面：`rowsWritten` 是用來判斷 `INSERT OR IGNORE` 到底有沒有寫進去
   * （＝是否為重送）的唯讀計數；拿不到時 store 會退化成「寫入前是否存在」的判斷。
   */
  #chunkSql(): ChunkSql {
    const sql = this.#ctx.storage.sql as unknown as {
      exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten?: number };
    };
    return {
      exec: (query, ...bindings) => {
        const cursor = sql.exec(query, ...bindings);
        return {
          toArray: () => cursor.toArray(),
          changes: typeof cursor.rowsWritten === "number" ? cursor.rowsWritten : undefined,
        };
      },
    };
  }

  #chunkStore(): AudioChunkStore {
    return new AudioChunkStore(this.#chunkSql());
  }

  /** US-101 的 chunkSeq 認領表（只記「哪個 seq 來過」，不含內文）。 */
  #transcriptLedger(): TranscriptChunkLedger {
    return new TranscriptChunkLedger(this.#chunkSql());
  }

  /** 逐字稿一頁的上限：正式＝`SEGMENT_PAGE_LIMIT_MAX`，可由測試注入縮小（TECH-013）。 */
  #pageLimitMax(): number {
    return this.#ctx.pageLimitMax ?? SEGMENT_PAGE_LIMIT_MAX;
  }

  /** M01-US-103 的逐字稿帳本（唯一存放逐字稿文字的地方）。 */
  #segmentLedger(): TranscriptLedger {
    return new TranscriptLedger(this.#chunkSql());
  }

  #gapLog(): TranscriptGapLog {
    return new TranscriptGapLog(this.#chunkSql());
  }

  /**
   * 讀 session，並在「已經到點」時順手落地。
   * 為什麼讀也要落地：alarm 可能沒醒、可能被延後；但上限是**時間**決定的，
   * 所以任何一次請求都必須先把過期的 recording 收成 ended（否則狀態會被讀成還在錄）。
   */
  #readSession(store: SessionStore): SessionSnapshot | null {
    // TECH-008：讀取必須帶入「現在時間」，否則「兩欄一起往後推」的竊改看不出來
    // （差值仍是 2 小時）。時間來源與其他路徑同一個 `#now()`，測試注入固定時鐘即可重現。
    const snapshot = store.read(this.#now());
    if (snapshot === null) return null;
    const expired = expireSession(snapshot.session, this.#now());
    if (expired === snapshot.session) return snapshot;
    const next = { ...snapshot, session: expired };
    store.write(next);
    return next;
  }

  #expireSessionIfReached(): void {
    const store = this.#sessionStore();
    this.#readSession(store);
  }

  #payload(snapshot: SessionSnapshot): Record<string, unknown> {
    const status = sessionStatus(snapshot.session, this.#now());
    return {
      meetingId: snapshot.session.meetingId,
      phase: status.phase,
      startedAtMs: snapshot.session.startedAtMs,
      endsAtMs: snapshot.session.endsAtMs,
      remainingMs: status.remainingMs,
      warn: status.warn,
      endedAtMs: snapshot.session.endedAtMs,
      endedReason: snapshot.session.endedReason,
      transcriptWrites: snapshot.transcriptWrites,
    };
  }

  #sessionStatusRoute(): Response {
    const snapshot = this.#readSession(this.#sessionStore());
    if (snapshot === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "這場會議還沒開始" }, 404);
    }
    return json(this.#payload(snapshot));
  }

  /**
   * 開始會議：第一次寫定權威時間軸；重複呼叫**不重開**（否則裝置端重試就能無限延長會議）。
   *
   * 若同一個 meeting id 已經結束（含 `aborted`），這裡回的是**已結束的那筆**（phase=ended），
   * 不會復活、不會改 `ends_at`；裝置端必須看 `phase` 而不是只看 HTTP 狀態碼。
   * 真正「再錄一場」是由裝置端換一個新的 meeting id（= 新的 DO）達成的。
   */
  async #sessionStartRoute(request: Request): Promise<Response> {
    const store = this.#sessionStore();
    const existing = this.#readSession(store);
    if (existing !== null) return json(this.#payload(existing), 201);
    const snapshot: SessionSnapshot = {
      session: startSession(this.#meetingId(request), this.#now()),
      transcriptWrites: 0,
    };
    store.write(snapshot);
    await this.#armSessionAlarm(snapshot.session.endsAtMs);
    return json(this.#payload(snapshot), 201);
  }

  async #sessionStopRoute(request: Request): Promise<Response> {
    const store = this.#sessionStore();
    const current = this.#readSession(store);
    if (current === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "這場會議還沒開始" }, 404);
    }
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = body.reason;
    // 合法原因由 `SESSION_ENDED_REASONS` 單一來源決定（型別 / SQL CHECK / 這裡不得各自維護）。
    if (!(SESSION_ENDED_REASONS as readonly unknown[]).includes(reason)) {
      return json(
        { error: "REASON_INVALID", value: reason, allowed: [...SESSION_ENDED_REASONS] },
        400,
      );
    }
    const next: SessionSnapshot = {
      session: stopSession(current.session, this.#now(), reason as SessionEndedReason),
      transcriptWrites: current.transcriptWrites,
    };
    store.write(next);
    return json(this.#payload(next));
  }

  /**
   * M01-US-102：上傳一段音訊（冪等）。
   *
   * `seq` 走 query、內容走 body 原始位元組。為什麼不用 JSON + base64：base64 會膨脹 33%，
   * 而音訊分段是熱路徑（每 30 秒一次）；原始位元組直送最省。
   *
   * 重送（同 seq 同內容）回 `accepted:true, duplicate:true`：對裝置端而言這仍是成功，
   * 所以不該用 4xx 讓重試邏輯糾結；真正的錯誤（同 seq 不同內容）是 409 SEQ_CONFLICT。
   */
  async #audioChunkRoute(request: Request, url: URL): Promise<Response> {
    const current = this.#readSession(this.#sessionStore());
    if (current === null) {
      // 沒開始過的會議就不該有分段（也不該比 session 早到：那代表裝置端順序錯了）。
      return json({ error: "SESSION_NOT_STARTED", message: "這場會議還沒開始" }, 404);
    }
    const rawSeq = url.searchParams.get("seq");
    if (rawSeq === null || !/^\d+$/.test(rawSeq)) {
      throw new ChunkInvalidError(`seq 必須是正整數字串，收到 ${JSON.stringify(rawSeq)}`);
    }
    const seq = Number(rawSeq);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) {
      throw new ChunkInvalidError("分段內容是空的（byteLength=0）");
    }
    const contentHash = await sha256Hex16(bytes);
    const result = this.#chunkStore().record({ seq, byteLen: bytes.byteLength, contentHash, nowMs: this.#now() });
    return json(result, 201);
  }

  /**
   * 恢復對帳用：回報伺服端已收下的分段，以及「下一個還缺的 seq」。
   * 裝置端用 `expectedNextSeq` 判斷缺段（AC-4 時間軸連續），不必自己推。
   */
  #audioChunkListRoute(): Response {
    const current = this.#readSession(this.#sessionStore());
    if (current === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "這場會議還沒開始" }, 404);
    }
    const store = this.#chunkStore();
    return json({
      meetingId: current.session.meetingId,
      chunks: store.list(),
      count: store.count(),
      lastSeq: store.lastSeq(),
      expectedNextSeq: store.expectedNextSeq(),
      retentionDays: AUDIO_RETENTION_DAYS,
    });
  }

  /**
   * M01-US-103：逐字稿帳本（POST 寫入多句 / GET 讀回整場）。
   *
   * 為什麼另開一條路，而不是把 `/transcript` 改成落地：`/transcript` 是 US-101 的
   * 「守門 + 計數」契約（現行裝置端在用，example 的純文字沒有講者也沒有時間戳）。
   * 把純文字塞進帳本會污染時間軸；所以舊路徑原樣保留，有結構的內容走這條。
   *
   * 兩個刻意的順序：
   * 1. **守門先於驗證**：已達 2:00 或會議結束時回 409，不讓裝置端以為「內容有問題」。
   * 2. **整批先驗證再寫**：批次裡有一個壞的，就一批都不寫——
   *    寫一半會讓時間軸出現「有頭沒尾」的段落，比整批被擋更難救。
   */
  async #transcriptSegmentsRoute(request: Request): Promise<Response> {
    const snapshot = this.#readSession(this.#sessionStore());
    if (snapshot === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "沒有進行中的會議" }, 409);
    }
    if (request.method === "GET" || request.method === "HEAD") {
      // TECH-013：讀取改成可以「只拿新的」與「分頁」。
      // 不帶參數＝第一頁（最多 `SEGMENT_PAGE_LIMIT_MAX` 列）——這是有意的行為改變：
      // 整場一次回傳在 2 小時會議約 2000 列（真跡段長換算約 0.4 MB），而截斷在此是**看得見**的（`hasMore` / `total`）。
      const params = new URL(request.url).searchParams;
      const max = this.#pageLimitMax();
      const since = readPageParam(params, "since", max);
      const limit = readPageParam(params, "limit", max) ?? max;
      const ledger = this.#segmentLedger();
      const page = ledger.listPage(since, limit);
      const last = page.rows[page.rows.length - 1];
      return json({
        meetingId: snapshot.session.meetingId,
        count: page.rows.length,
        // `count` 是「這一頁幾列」（原本的語意不變）；`total` 是整場幾列。
        total: ledger.count(),
        segments: page.rows,
        hasMore: page.hasMore,
        // 空頁回 `null`：呼叫端用同一個 `since` 再問一次仍會是空頁，不會有前進的假象。
        nextSince: last === undefined ? null : last.seq,
      });
    }
    if (request.method !== "POST") {
      // 帳本是 append-only，連 HTTP 動詞都不給「改」與「刪」：
      // 沒擋動詞時 `DELETE` 會被當成 POST 走完，反而**寫進一列**（獨立審查抓到）。
      return json({ error: "METHOD_NOT_ALLOWED", message: "只支援 GET / POST" }, 405, {
        allow: "GET, POST, HEAD",
      });
    }
    const rejected = this.#transcriptWriteRejection(snapshot);
    if (rejected !== null) return rejected;
    const body = await this.#jsonObjectBody(request);
    if (body.segments !== undefined && !Array.isArray(body.segments)) {
      throw new TranscriptInvalidError("segments 必須是陣列（或整包省略＝單一句）");
    }
    // 單一物件與陣列都收：裝置端補單句時不必為了 API 對稱再包一層。
    const inputs = Array.isArray(body.segments) ? body.segments : [body];
    // 元素也要先驗型別，否則訊息會長成 `idempotencyKey=undefined`，看不出是第幾個壞掉。
    inputs.forEach((input, index) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TranscriptInvalidError(`segments[${index}] 必須是物件`);
      }
    });
    const context = this.#transcriptWriteContext(snapshot);
    const fields = inputs.map((input) =>
      validateSegment({ ...(input as Record<string, unknown>), ...context }),
    );
    const ledger = this.#segmentLedger();
    const accepted: RecordSegmentOutcome[] = [];
    const duplicates: RecordSegmentOutcome[] = [];
    const conflicts: { existing: unknown; incoming: unknown }[] = [];
    // 「壞一個就整批不寫」不是靠 try，是靠**先驗完再寫**（`fields` 整批 `validateSegment` 過才進迴圈，
    // US-103 的既有測試釘著）——所以這裡的 try 擋的不是**邏輯性**壞資料，
    // 而是**儲存層**錯誤（`record()` 內 INSERT / 讀回失敗；第二輪獨立審查用探針證明這條路真的存在：
    // 讓第 2 個 INSERT 拋 → 帳本 1 列、計數 0）。同一個差額補記也包在 `#writeWithCatchUp` 裡。
    this.#writeWithCatchUp(ledger, () => {
      for (const field of fields) {
        const outcome = ledger.record({ ...field, ...context });
        if (outcome.accepted) accepted.push(outcome);
        else if (outcome.duplicate) duplicates.push(outcome);
        else conflicts.push({ existing: outcome.existing, incoming: outcome.incoming });
      }
    });
    return json(this.#transcriptWriteResult(accepted.length, duplicates.length, conflicts));
  }

  /**
   * M01-US-103：串流落地（原始 nova 訊息 → 聚段 → 帳本）。
   *
   * 與 `/transcript/segments` 的差別：這裡收的是**上游原始事件**，逐字稿內文由伺服端自己聚出來。
   * 這條路的存在理由是 SPIKE-001 的發現：聚段規則（講者切換 / 停頓 / `UtteranceEnd`）
   * 若留在裝置端，兩台裝置會對「同一段音訊該切成幾句」有不同答案；
   * 放在伺服端，重播同一份事件串流得到的段落**逐字相同**（AC-1 的重播等價）。
   */
  async #transcriptStreamRoute(request: Request): Promise<Response> {
    const snapshot = this.#readSession(this.#sessionStore());
    if (snapshot === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "沒有進行中的會議" }, 409);
    }
    if (request.method !== "POST") {
      // 與 `/transcript/segments` 同一個道理，而且這條是**正式路徑**：
      // 沒擋動詞時 `DELETE /transcript/stream` 帶合法 body 會被當 POST 走完並**寫進一列**
      // （第二輪獨立審查實測：200 + `accepted:1`）。append-only 不能只做一半。
      return json({ error: "METHOD_NOT_ALLOWED", message: "只支援 POST" }, 405, { allow: "POST" });
    }
    const rejected = this.#transcriptWriteRejection(snapshot);
    if (rejected !== null) return rejected;
    const body = await this.#jsonObjectBody(request);
    if (!Array.isArray(body.messages)) {
      throw new TranscriptInvalidError("messages 必須是陣列（原始 STT 事件）");
    }
    // `finalize` 只認 `true`；若送來 `"yes"` / `1` 而我們照樣收下，最後一段會留在緩衝裡
    // **默默不落地**（與 P0-1 同一類陷阱），所以型別錯誤要當成 400，不能沉默。
    if (body.finalize !== undefined && typeof body.finalize !== "boolean") {
      throw new TranscriptInvalidError("finalize 必須是布林（true 才會收尾）");
    }
    const context = this.#transcriptWriteContext(snapshot);
    // 這裡先建 stream：`meetingOffsetMs` 不合法會在建構時就拋（不得默默當 0）。
    const ledger = this.#segmentLedger();
    const stream = new TranscriptStream({
      sink: ledger,
      meetingOffsetMs: body.meetingOffsetMs as number,
    });
    // 兩條帳本寫入路徑都走 `#writeWithCatchUp` 的差額補記（TECH-013 D5）：
    // 串流是**邊收邊落地**，中途一句落在未來時間窗就 400，但前面的句子已經在帳本裡；
    // 批次路徑的邏輯性壞資料靠「先驗完再寫」擋住，儲存層錯誤（INSERT／讀回失敗）則同樣靠補記。
    // `finalize()` 也可能拋（收尾那一句才是壞的），所以補記要包住兩者。
    const report: IngestReport = { appended: [], duplicates: [], conflicts: [], pending: null };
    const messages = body.messages as unknown[];
    this.#writeWithCatchUp(ledger, () => {
      this.#mergeIngestReport(report, stream.ingest(messages, context));
      if (body.finalize === true) {
        this.#mergeIngestReport(report, stream.finalize(context));
      }
    });
    return json({
      ...this.#transcriptWriteResult(report.appended.length, report.duplicates.length, report.conflicts),
      appended: report.appended,
      pending: report.pending,
    });
  }

  /**
   * 解析 JSON 物件 body。
   *
   * `request.json()` 對空 body 會 reject、對字面 `null` / 陣列 / 純量則會成功——
   * 兩種都不該變成 500（審查抓到：`POST /transcript/stream` 帶 `null` 會 500）。
   */
  async #jsonObjectBody(request: Request): Promise<Record<string, unknown>> {
    const parsed: unknown = await request.json().catch(() => null);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TranscriptInvalidError("body 必須是 JSON 物件");
    }
    return parsed as Record<string, unknown>;
  }

  /** 兩條寫入路徑共用的守門（US-101 的 `acceptsTranscriptWrites` 是唯一判準）。 */
  #transcriptWriteRejection(snapshot: SessionSnapshot): Response | null {
    if (acceptsTranscriptWrites(snapshot.session, this.#now())) return null;
    const status = sessionStatus(snapshot.session, this.#now());
    return json(
      {
        error: status.reached ? "LIMIT_REACHED" : "SESSION_ENDED",
        message: status.reached
          ? "已達 2 小時上限，2:00 之後的內容不會被記錄。"
          : "這場會議已經結束，不再接受逐字稿。",
        accepted: 0,
        transcriptWrites: snapshot.transcriptWrites,
      },
      409,
    );
  }

  /**
   * 寫入用的權威時間窗：裝置回報的毫秒只能落在「已過時間 + 容差」內。
   * 容差自成一常數（`TRANSCRIPT_SKEW_TOLERANCE_MS`，值與 US-107 缺口相同、但不 import 它的常數）：
   * 兩個功能的容差日後可能各自調整，耦合會讓改一邊時誤傷另一邊。
   */
  #transcriptWriteContext(snapshot: SessionSnapshot): { nowMs: number; maxMs: number } {
    const nowMs = this.#now();
    return { nowMs, maxMs: Math.max(0, nowMs - snapshot.session.startedAtMs) + TRANSCRIPT_SKEW_TOLERANCE_MS };
  }

  /** 只有**新增**的句子才算一次寫入（重送與衝突不得讓計數膨脹）。 */
  #transcriptWriteResult(accepted: number, duplicates: number, conflicts: unknown[]): Record<string, unknown> {
    return { accepted, duplicates, conflicts, transcriptWrites: this.#addTranscriptWrites(accepted) };
  }

  /**
   * 把「這次真的新增的句數」加到 session 的計數上（TECH-013 D5），回傳加完後的值。
   *
   * 關鍵是**寫入當下重新讀**，而不是用請求開頭的快照當基底：
   * `await request.json()` 會讓出執行權，別的請求可能已經落地並更新過計數；
   * 拿舊快照覆蓋就是少算（AC-4 的競爭）。
   *
   * 為什麼這樣就夠：DO 是單執行緒，`#readSession` 與 `write` 之間**沒有 await**，
   * 所以「讀-加-寫」在物件內是不可分割的——不需要鎖，也不需要稅。
   *
   * `delta === 0` 時仍要回傳**現在**的值（不是舊值）：呼叫端可能會把它寫進回應。
   */
  #addTranscriptWrites(delta: number): number {
    const fresh = this.#readSession(this.#sessionStore());
    if (fresh === null) {
      // 到不了這裡：三條寫入路徑都在入口驗過 session 了。
      // 大聲一點比編一個數字好——若真的發生，帳本已經有列而計數會永遠落後。
      throw new Error("session 不存在，無法更新 transcriptWrites");
    }
    const transcriptWrites = fresh.transcriptWrites + delta;
    if (delta !== 0) {
      // `{ ...fresh, ... }` 而非只挑兩個欄位：`SessionSnapshot` 以後若長出第三個欄位，
      // 只挑欄位的寫法會**靜默**把它丟掉（第二輪審查 P2 nit）。
      this.#sessionStore().write({ ...fresh, transcriptWrites });
    }
    return transcriptWrites;
  }

  /**
   * TECH-013 D5 的另一半：**部分寫入**的差額補記（兩條帳本寫入路徑共用，避免下次又漂移）。
   *
   * 邊落地邊失敗時，前面已經寫進帳本的列不會回滾——計數不能停在舊值。
   * 做法是進入前量一次帳本列數，`catch` 裡把「實際多了幾列」補記上去，然後**原樣 rethrow**
   * （錯誤碼與訊息不得被這次補記改變）。
   *
   * 兩個已知的殘餘風險（設計 §6 有寫）：
   *   * 這裡的 `count()` 若本身失敗，補記就失敗（機率極低，但發生時計數會落後）；
   *   * 補記用的 `#addTranscriptWrites` 若失敗會蓋掉原始錯誤。兩者都是「大聲壞掉」而非靜默，故可接受。
   */
  #writeWithCatchUp(ledger: TranscriptLedger, run: () => void): void {
    const before = ledger.count();
    try {
      run();
    } catch (error) {
      this.#addTranscriptWrites(ledger.count() - before);
      throw error;
    }
  }

  #mergeIngestReport(report: IngestReport, tail: IngestReport): void {
    report.appended.push(...tail.appended);
    report.duplicates.push(...tail.duplicates);
    report.conflicts.push(...tail.conflicts);
    report.pending = tail.pending;
  }

  /**
   * M01-US-107：逐字稿缺口標記（AC-1 / AC-3）。
   *
   * 為什麼允許「只開不閉」：`hidden` 當下就必須寫入（app 可能再也沒回來），
   * 但那一刻根本還不知道中斷會多久。回前台時用**同一個 seq** 補 `toMs`，
   * 靠 `INSERT OR IGNORE`（PK = seq）保證同一段不會變成兩筆。
   */
  async #transcriptGapRoute(request: Request): Promise<Response> {
    const current = this.#readSession(this.#sessionStore());
    if (current === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "沒有進行中的會議" }, 409);
    }
    // 合法 JSON 的 `null` 會讓 `request.json()` **成功**回 `null`（`catch` 不觸發），
    // 接著讀 `body.seq` 就 TypeError → 500。與 US-103 修掉的同型缺陷一致（Gate 4 第二輪 P2-3）。
    const body = (await request.json().catch(() => ({}))) as {
      seq?: unknown;
      fromMs?: unknown;
      toMs?: unknown;
    } | null;
    if (!acceptsTranscriptWrites(current.session, this.#now())) {
      const status = sessionStatus(current.session, this.#now());
      return json(
        {
          error: status.reached ? "LIMIT_REACHED" : "SESSION_ENDED",
          message: status.reached
            ? "已達 2 小時上限，2:00 之後的內容不會被記錄。"
            : "這場會議已經結束，不再接受逐字稿。",
        },
        409,
      );
    }
    // 型別守門放在 session 守門**之後**：會議已結束時，409 比「body 不合法」更貼近事實
    // （與兩條逐字稿路由同一個順序原則）。
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new TranscriptInvalidError("body 必須是 JSON 物件");
    }
    // 上限用**伺服端**的已過時間算：裝置回報的 ms 只能在這個範圍內，否則時間軸沒參考價值。
    const elapsedMs = Math.max(0, this.#now() - current.session.startedAtMs);
    const result = this.#gapLog().record({
      seq: body.seq,
      fromMs: body.fromMs,
      toMs: body.toMs,
      maxMs: elapsedMs + GAP_SKEW_TOLERANCE_MS,
      nowMs: this.#now(),
    });
    return json(result);
  }

  /** M01-US-107：讀回缺口清單（裝置端重開後要靠它把逐字稿的缺口列長回來）。 */
  #transcriptGapListRoute(): Response {
    const current = this.#readSession(this.#sessionStore());
    if (current === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "沒有進行中的會議" }, 409);
    }
    const gaps = this.#gapLog().list();
    return json({ gaps, count: gaps.length });
  }
  /**
   * 逐字稿寫入守門員（M01-US-101）＋ 分段冪等（M01-US-102 AC-4：重送不得產生重複句）。
   *
   * 順序刻意是「先守門 → 再認領 seq」：被 2:00 上限或空內文擋下的請求，
   * 不應該先把 seq 燒掉（否則使用者補上內容後反而被當成重送）。
   */

  async #transcriptRoute(request: Request): Promise<Response> {
    const store = this.#sessionStore();
    const current = this.#readSession(store);
    if (current === null) {
      return json({ error: "SESSION_NOT_STARTED", message: "沒有進行中的會議" }, 409);
    }
    const body = (await request.json().catch(() => ({}))) as { text?: unknown; chunkSeq?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      return json({ error: "EMPTY_CONTENT", message: "逐字稿不得為空" }, 400);
    }
    const chunkSeq =
      typeof body.chunkSeq === "number" && Number.isSafeInteger(body.chunkSeq) ? body.chunkSeq : undefined;
    if (chunkSeq !== undefined && this.#transcriptLedger().has(chunkSeq)) {
      // 重送：不是錯誤，但也不得增加計數（＝不會產生第二句）。
      return json({
        accepted: false,
        duplicate: true,
        chunkSeq,
        transcriptWrites: current.transcriptWrites,
      });
    }
    if (!acceptsTranscriptWrites(current.session, this.#now())) {
      const status = sessionStatus(current.session, this.#now());
      return json(
        {
          error: status.reached ? "LIMIT_REACHED" : "SESSION_ENDED",
          message: status.reached
            ? "已達 2 小時上限，2:00 之後的內容不會被記錄。"
            : "這場會議已經結束，不再接受逐字稿。",
          accepted: false,
          transcriptWrites: current.transcriptWrites,
        },
        409,
      );
    }
    if (chunkSeq !== undefined && !this.#transcriptLedger().claim(chunkSeq, this.#now())) {
      // 競態：另一個並行請求先認領了同一個 seq。
      return json({
        accepted: false,
        duplicate: true,
        chunkSeq,
        transcriptWrites: current.transcriptWrites,
      });
    }
    // 這條路徑（US-101 的文字逐字稿）也是**寫入**，所以計數要走同一個「寫入當下重讀」。
    // 第二輪獨立審查用探針證明：用進場快照 `current.transcriptWrites + 1` 時，
    // 只要在 `await request.json()` 期間有 `/transcript/segments` 落地（2 列），
    // 就會寫回 1 → 帳本 2 列、計數 1（D6-1 的全稱句不成立）。
    // 循序呼叫的回值不變（`#addTranscriptWrites` 加完回傳現在的值）。
    return json({
      accepted: true,
      duplicate: false,
      chunkSeq: chunkSeq ?? null,
      transcriptWrites: this.#addTranscriptWrites(1),
      note: "逐字稿內容的落地由 M01-US-103 接上；這裡只驗證寫入守門員與分段冪等。",
    });
  }

  /**
   * session 還在錄且它的到點 alarm 沒有排上（或已被別的 alarm 清掉）→ 補排。
   * 已結束就不排（避免 alarm 無限接力）。
   */
  async #rearmSessionAlarm(): Promise<void> {
    const snapshot = this.#readSession(this.#sessionStore());
    if (snapshot === null || snapshot.session.state !== "recording") return;
    await this.#armSessionAlarm(snapshot.session.endsAtMs);
  }

  /**
   * 排到點 alarm：**只往前不往後**（earliest-wins）。
   * TECH-004 的接力 demo 也用同一個 alarm slot，所以這裡不能覆蓋已存在且更早的 alarm。
   */
  async #armSessionAlarm(atMs: number): Promise<void> {
    const existing = await this.#ctx.storage.getAlarm();
    if (existing === null || atMs < existing) {
      await this.#ctx.storage.setAlarm(atMs);
    }
  }

  #meetingId(request: Request): string {
    return request.headers.get("x-meeting-id") ?? this.#ctx.id?.toString() ?? "unknown";
  }

  async #health(): Promise<Record<string, unknown>> {
    const opened = await this.#lifecycle.current();
    const conversation = await opened.root();
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    return {
      ok: true,
      doId: this.#ctx.id?.toString() ?? "unknown",
      model: opened.model,
      conversationId: opened.conversationId,
      rootId: conversation.id,
      entries: view.value.entries.length,
      stats: this.stats,
    };
  }

  async #submit(content: string): Promise<Record<string, unknown>> {
    if (content.trim() === "") {
      return { error: "EMPTY_CONTENT" };
    }
    const opened = await this.#lifecycle.current();
    const conversation = await opened.root();
    const submission = await conversation.submit(
      { type: "input", content },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    return {
      status: settled.status,
      conversationId: conversation.id,
      entries: view.value.entries.length,
    };
  }
}

/** 匯出給測試用的常數（避免 magic number 散落）。 */
export const DEFAULT_ALARM_DELAY_MS = 60_000;