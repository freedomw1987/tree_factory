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
