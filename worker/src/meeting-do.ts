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
import { SessionStore, type SessionSnapshot, type SessionSql } from "./storage/session-store.js";

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
}

/** 一次 alarm 醒來最多再往前排多久（避免無限接力）。 */
export const MAX_ALARM_DELAY_MS = 5 * 60 * 1000;

/** 讓 DO 類別在沒有 workerd 型別時也能被測試引用。 */
type DurableObjectState = MeetingDurableObjectContext;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
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

  #transcriptLedger(): TranscriptChunkLedger {
    return new TranscriptChunkLedger(this.#chunkSql());
  }

  /**
   * 讀 session，並在「已經到點」時順手落地。
   * 為什麼讀也要落地：alarm 可能沒醒、可能被延後；但上限是**時間**決定的，
   * 所以任何一次請求都必須先把過期的 recording 收成 ended（否則狀態會被讀成還在錄）。
   */
  #readSession(store: SessionStore): SessionSnapshot | null {
    const snapshot = store.read();
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
    const next: SessionSnapshot = {
      session: current.session,
      transcriptWrites: current.transcriptWrites + 1,
    };
    store.write(next);
    return json({
      accepted: true,
      duplicate: false,
      chunkSeq: chunkSeq ?? null,
      transcriptWrites: next.transcriptWrites,
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