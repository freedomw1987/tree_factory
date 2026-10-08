/**
 * M01-US-101 前端 → 後端 session API。
 *
 * 契約（與 worker/src/meeting-do.ts 的 session 路由一致）：
 * - `POST /m/:meetingId/session/start` → 會議開始，回權威 `endsAtMs`
 * - `GET  /m/:meetingId/session`       → 目前狀態（回到前景時校正用）
 * - `POST /m/:meetingId/session/stop`  → 結束（`reason`: user / limit）
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
