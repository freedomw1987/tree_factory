/**
 * M01-US-101 前端 → 後端 session API。
 *
 * 契約（與 worker/src/meeting-do.ts 的 session 路由一致）：
 * - `POST /m/:meetingId/session/start` → 會議開始，回權威 `endsAtMs`
 * - `GET  /m/:meetingId/session`       → 目前狀態（回到前景時校正用）
 * - `POST /m/:meetingId/session/stop`  → 結束（`reason`: user / limit / aborted）
 *
 * `aborted` = 裝置端「開始」失敗（例：麥克風被拒）時把伺服端 session 收掉。
 * 少了它，session 會掛到 alarm 到點，事後被誤認為「這場會議錄到上限」。
 *
 * 重點：**`endsAtMs` 一律以回應為準**，前端不得自己算 2 小時（裝置時鐘不可信）。
 */

import type { SessionClient } from "../recorder/store";
import type { SegmentRow } from "../transcript/live-transcript";
import type { SegmentPage } from "../transcript/live-transcript-feed";

export type SessionPhase = "recording" | "ended" | "limit_reached";

export interface SessionPayload {
  meetingId: string;
  phase: SessionPhase;
  startedAtMs: number;
  endsAtMs: number;
  remainingMs: number;
  warn: boolean;
}

export interface HttpSessionClientOptions {
  baseUrl: string;
  meetingId: string;
  fetchImpl?: typeof fetch;
}

/**
 * M01-US-102：分段上傳/帳本的錯誤。
 *
 * `code` 的取值刻意對齊伺服端與設計 §6 的分類：
 * - `SEQ_CONFLICT`：同 seq 不同內容（409）——永久性問題，**不可覆蓋**，要留本機檔。
 * - `NETWORK`：連不上（fetch 丟錯）——暫時性，退避後重試。
 * - `SERVER`：其他 4xx/5xx。
 */
export class ChunkApiError extends Error {
  readonly code: "SEQ_CONFLICT" | "NETWORK" | "SERVER";
  readonly status: number;

  constructor(code: "SEQ_CONFLICT" | "NETWORK" | "SERVER", message: string, status = 0) {
    super(message);
    this.name = "ChunkApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * M01-US-107：逐字稿缺口的錯誤。
 *
 * `GAP_CONFLICT`（409）＝同 seq 卻是**不同**的中斷起點（正常不該發生，
 * 一旦發生就是本機 seq 被重算或換了會議）。它是永久性錯誤，重送一百次也不會好，
 * 所以呼叫端要停止重試、並誠實標示（見 gap-tracker 的 `conflict`）。
 *
 * `PERMANENT`（409 SESSION_ENDED / LIMIT_REACHED / SESSION_NOT_STARTED）＝伺服端這一場
 * 已經不會再收逐字稿了。同樣永久，但帳本上沒有這筆，所以標記不同（見 `terminal`）。
 */
export class TranscriptGapApiError extends Error {
  readonly code: "GAP_CONFLICT" | "PERMANENT" | "NETWORK" | "SERVER";
  readonly status: number;

  constructor(code: "GAP_CONFLICT" | "PERMANENT" | "NETWORK" | "SERVER", message: string, status = 0) {
    super(message);
    this.name = "TranscriptGapApiError";
    this.code = code;
    this.status = status;
  }
}

/** 伺服端會永久拒絕這筆缺口的錯誤碼（會議狀態已定，不會再回到可寫狀態）。 */
export const PERMANENT_GAP_ERRORS: ReadonlySet<string> = new Set([
  "SESSION_ENDED",
  "LIMIT_REACHED",
  "SESSION_NOT_STARTED",
]);


/**
 * 逐字稿帳本的一列（網路邊界：形狀不對就整列丟掉，不要讓 `NaN` 流進畫面）。
 * 時間戳必須是安全整數（含 `endMs`），`text` 必須是非空字串——否則寧可少一列也不要顯示「undefined」。
 */
function parseSegmentRow(item: unknown): SegmentRow | null {
  if (item === null || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const seq = Number(raw.seq);
  const speakerId = Number(raw.speakerId);
  const startMs = Number(raw.startMs);
  const endMs = Number(raw.endMs);
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(speakerId) || text === "") return null;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) return null;
  const idempotencyKey = typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : undefined;
  return {
    seq,
    speakerId,
    text,
    startMs,
    endMs,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

export class SessionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SessionApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ChunkLedger {
  /** 伺服端已收下的分段 seq（升序）。 */
  acked: number[];
  /** 下一個還缺的 seq（有洞就指洞，AC-4 時間軸連續）。 */
  expectedNextSeq: number;
  /** seq → 伺服端那份分段的內容指紋；對帳時用來發現「同 seq 不同內容」（不覆蓋）。 */
  hashes: Record<number, string>;
}

export class HttpSessionClient implements SessionClient {
  readonly #baseUrl: string;
  readonly #meetingId: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpSessionClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#meetingId = options.meetingId;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async start(): Promise<{ startedAtMs: number; endsAtMs: number }> {
    const payload = await this.#post("start");
    return { startedAtMs: payload.startedAtMs, endsAtMs: payload.endsAtMs };
  }

  async stop(reason: "user" | "limit" | "aborted"): Promise<void> {
    await this.#post("stop", { reason });
  }

  async status(): Promise<SessionPayload> {
    return this.#request("GET", "session");
  }

  /**
   * 上傳一段音訊（M01-US-102）。
   *
   * `seq` 走 query、內容走 body 原始位元組（worker 端同一條契約）。
   * `duplicate:true`（伺服端說「這段我收過了」）**不是錯誤**：對恢復流程而言那就是成功。
   */
  async uploadChunk(chunk: { seq: number; blob: Blob }): Promise<"accepted" | "duplicate"> {
    const url = `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/audio/chunk?seq=${chunk.seq}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: chunk.blob,
      });
    } catch (error) {
      throw new ChunkApiError("NETWORK", error instanceof Error ? error.message : String(error));
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 409) {
      // 只有伺服端說「同 seq 不同內容」才當成永久衝突；其他 409（例如會議狀態）是可重試的 server 錯。
      const code = payload.error === "SEQ_CONFLICT" ? "SEQ_CONFLICT" : "SERVER";
      throw new ChunkApiError(code, String(payload.message ?? "上傳被拒（HTTP 409）"), 409);
    }
    if (!response.ok) {
      throw new ChunkApiError("SERVER", `上傳失敗（HTTP ${response.status}）`, response.status);
    }
    return payload.duplicate === true ? "duplicate" : "accepted";
  }

  /** 讀伺服端帳本（恢復對帳的權威來源）。 */
  async chunkLedger(): Promise<ChunkLedger> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/audio/chunks`,
      );
    } catch (error) {
      throw new ChunkApiError("NETWORK", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new ChunkApiError("SERVER", `讀帳本失敗（HTTP ${response.status}）`, response.status);
    }
    const payload = (await response.json()) as { chunks?: unknown; expectedNextSeq?: unknown };
    const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
    const hashes: Record<number, string> = {};
    for (const item of chunks) {
      const seq = Number((item as { seq?: unknown }).seq);
      const hash = (item as { hash?: unknown }).hash;
      if (Number.isSafeInteger(seq) && typeof hash === "string") hashes[seq] = hash;
    }
    return {
      acked: chunks
        .map((item) => Number((item as { seq?: unknown }).seq))
        .filter((seq) => Number.isSafeInteger(seq))
        .sort((a, b) => a - b),
      expectedNextSeq: Number(payload.expectedNextSeq ?? 1),
      hashes,
    };
  }

  /**
   * 寫入一筆逐字稿缺口（M01-US-107）。`toMs:null` = 這段還開著（先開後閉）。
   * 重送同一筆（同 seq 同 fromMs）伺服端回 `duplicate:true`，**不是錯誤**。
   */
  async writeGap(input: { seq: number; fromMs: number; toMs: number | null }): Promise<void> {
    const url = `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/transcript/gap`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          input.toMs === null
            ? { seq: input.seq, fromMs: input.fromMs }
            : { seq: input.seq, fromMs: input.fromMs, toMs: input.toMs },
        ),
      });
    } catch (error) {
      throw new TranscriptGapApiError("NETWORK", error instanceof Error ? error.message : String(error));
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 409 && payload.error === "GAP_CONFLICT") {
      throw new TranscriptGapApiError("GAP_CONFLICT", "同 seq 但中斷起點不同", 409);
    }
    if (response.status === 409 && PERMANENT_GAP_ERRORS.has(String(payload.error))) {
      // 這一場已經結束 / 到了上限 / 根本還沒開始：永久狀態，重試再多次也不會成功。
      // 不能當成「暫時性」——那會讓 UI 永遠掛著「待同步」承諾一件不會發生的事（Gate 4 F5）。
      throw new TranscriptGapApiError(
        "PERMANENT",
        `伺服端不再接受這筆缺口（${String(payload.error)}）`,
        409,
      );
    }
    if (!response.ok) {
      // 其他 4xx/5xx：暫時性，留著下次再試。
      throw new TranscriptGapApiError("SERVER", `寫入缺口失敗（HTTP ${response.status}）`, response.status);
    }
  }

  /** 讀伺服端的缺口清單（換裝置 / 本機被清掉時的權威來源）。 */
  async listGaps(): Promise<Array<{ seq: number; fromMs: number; toMs: number | null }>> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/transcript/gaps`,
      );
    } catch (error) {
      throw new TranscriptGapApiError("NETWORK", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new TranscriptGapApiError("SERVER", `讀缺口清單失敗（HTTP ${response.status}）`, response.status);
    }
    const payload = (await response.json()) as { gaps?: unknown };
    const gaps = Array.isArray(payload.gaps) ? payload.gaps : [];
    return gaps
      .map((item) => ({
        seq: Number((item as { seq?: unknown }).seq),
        fromMs: Number((item as { fromMs?: unknown }).fromMs),
        toMs: (item as { toMs?: unknown }).toMs === null ? null : Number((item as { toMs?: unknown }).toMs),
      }))
      .filter(
        (gap) =>
          Number.isSafeInteger(gap.seq) &&
          Number.isSafeInteger(gap.fromMs) &&
          (gap.toMs === null || Number.isSafeInteger(gap.toMs)),
      );
  }

  /**
   * M01-US-104：讀逐字稿帳本（TECH-013 的分頁 / 增量契約）。
   *
   * `since` 傳上一次回應的 `nextSince`（空頁回 `null` ＝ 用同一個值再問仍是空頁，不會有前進的假象）；
   * `hasMore` 為真時呼叫端要續抓，否則畫面會停在某一頁。
   */
  async listSegments(input: { since: number | null; limit: number }): Promise<SegmentPage> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.since !== null) query.set("since", String(input.since));
    const url = `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/transcript/segments?${query.toString()}`;
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      throw new TranscriptGapApiError("NETWORK", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new TranscriptGapApiError("SERVER", `讀逐字稿失敗（HTTP ${response.status}）`, response.status);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const raw = Array.isArray(payload.segments) ? payload.segments : [];
    // 水位（`nextSince`）只能是安全整數：不是的話等於**沒有**水位，寧可下一次重讀同一頁
    // （重讀靠冪等鍵去重），也不要拿一個 `NaN` 去問伺服端（`?since=NaN` 會被回 400）。
    // 與列內欄位同一套語意：數字字串 `"3"` 接受（列的 `seq: "3"` 也是這樣）。
    // 但 `null`／`undefined`／空字串**不得**被 `Number()` 變成 `0` —— TECH-013 的契約是
    // 「沒有新資料時回 `null`」，變成 `0` 會讓每一輪都從頭重讀整份帳本。
    const asSince =
      typeof payload.nextSince === "number" ||
      (typeof payload.nextSince === "string" && payload.nextSince.trim() !== "" && /^[0-9]+$/.test(payload.nextSince.trim()))
        ? Number(payload.nextSince)
        : Number.NaN;
    const nextSince = Number.isSafeInteger(asSince) ? asSince : null;
    return {
      segments: raw
        .map((item) => parseSegmentRow(item))
        .filter((row): row is SegmentRow => row !== null),
      nextSince,
      hasMore: payload.hasMore === true,
    };
  }

  #post(action: "start" | "stop", body?: unknown): Promise<SessionPayload> {
    return this.#request("POST", `session/${action}`, body);
  }

  async #request(method: string, path: string, body?: unknown): Promise<SessionPayload> {
    const response = await this.#fetch(
      `${this.#baseUrl}/m/${encodeURIComponent(this.#meetingId)}/${path}`,
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new SessionApiError(
        response.status,
        String(payload.error ?? "SESSION_ERROR"),
        String(payload.message ?? `session ${path} 失敗（HTTP ${response.status}）`),
      );
    }
    return payload as unknown as SessionPayload;
  }
}
