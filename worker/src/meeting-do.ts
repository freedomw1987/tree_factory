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
  openMeeting,
  type MeetingBindings,
  type OpenMeetingResult,
} from "./harness/meeting-harness.js";

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
          if (raw === null) {
            // 「沒帶參數」絕不能退化成 0（會變成忙迴圈式的立即 alarm）。
            return json({ error: "MS_REQUIRED", message: "請帶 ?ms=<毫秒>", example: "/wake?ms=60000" }, 400);
          }
          const delayMs = Number(raw);
          if (!Number.isFinite(delayMs) || delayMs < 0) {
            return json({ error: "MS_INVALID", value: raw }, 400);
          }
          return json(await this.#lifecycle.wakeIn(delayMs));
        }
        case "/release":
          await this.#lifecycle.release();
          return json({ released: true, ...this.stats });
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
    const opened = await this.#lifecycle.onAlarm();
    await opened.root(); // 觸發一次讀取，確認重建後同一場會議讀得回來
    await this.#lifecycle.release();
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