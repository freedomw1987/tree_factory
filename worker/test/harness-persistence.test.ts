// TECH-004：真 pi-durable Harness + 真 SQLite 的持久化與憑證繫結測試。
//
// 這裡用 `node:sqlite`（Node 22 內建）當 DO SQLite 的替身，把 `fake DO storage`
// 接到真的 `SqliteStorage` / `Harness`。這是「DO 被回收後重開同一場會議」的最強
// 離線證據；現場版（真 workerd DO）由 `wrangler dev --local` 冒煙測試補上。

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { DoSqliteDatabase, type DoSqlStorageLike, type SqlBinding } from "../src/storage/do-sqlite.js";
import {
  MissingCredentialError,
  compactionPolicyFor,
  createBoundModels,
  openMeeting,
  resolveModel,
  type MeetingBindings,
} from "../src/harness/meeting-harness.js";

/** 把 `node:sqlite` 包成 DO 的 `storage` 形狀（與 SPIKE-003 smoke 相同做法）。 */
function doLikeStorage(db: DatabaseSync): DoSqlStorageLike {
  return {
    sql: {
      exec(sql: string, ...bindings: SqlBinding[]) {
        if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
          const rows = db.prepare(sql).all(...(bindings as never[]));
          return { toArray: () => rows };
        }
        if (bindings.length > 0) {
          db.prepare(sql).run(...(bindings as never[]));
        } else {
          db.exec(sql);
        }
        return { toArray: () => [] };
      },
    },
    async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
      db.exec("BEGIN");
      let rolledBack = false;
      try {
        const result = await callback({
          rollback: () => {
            db.exec("ROLLBACK");
            rolledBack = true;
          },
        });
        if (!rolledBack) {
          db.exec("COMMIT");
        }
        return result;
      } catch (error) {
        if (!rolledBack) {
          db.exec("ROLLBACK");
        }
        throw error;
      }
    },
  };
}

/** 離線測試用綁定：faux provider，不需要任何憑證。 */
const FAUX_BINDINGS: MeetingBindings = { HARNESS_PROVIDER: "faux" };

describe("openMeeting：憑證繫結（TECH-004）", () => {
  it("provider 是 cloudflare-workers-ai 時，缺憑證就丟 AUTH_INVALID（唯一可阻斷的錯誤）", () => {
    expect(() => resolveModel({}, "realtime")).toThrow(MissingCredentialError);
    try {
      resolveModel({ CLOUDFLARE_API_KEY: "k" }, "realtime");
      assert.fail("應該要丟錯");
    } catch (error) {
      const missing = error as MissingCredentialError;
      expect(missing.code).toBe("AUTH_INVALID");
      expect(missing.recoverable).toBe(false);
      expect(missing.message).toContain("CLOUDFLARE_ACCOUNT_ID");
    }
  });

  it("憑證齊全時解析出目錄裡的模型 id（含 @cf/ 前綴），且可用綁定覆寫", () => {
    const bindings: MeetingBindings = {
      CLOUDFLARE_API_KEY: "k",
      CLOUDFLARE_ACCOUNT_ID: "a",
    };
    expect(resolveModel(bindings, "realtime")).toEqual({
      provider: "cloudflare-workers-ai",
      modelId: "@cf/ibm-granite/granite-4.0-h-micro",
    });
    expect(resolveModel(bindings, "notes").modelId).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(
      resolveModel({ ...bindings, NOTES_MODEL_ID: "@cf/meta/llama-4-scout-17b-16e-instruct" }, "notes")
        .modelId,
    ).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
  });

  it("faux provider 不需要憑證（離線與測試用）", () => {
    expect(resolveModel({ HARNESS_PROVIDER: "faux" }, "realtime")).toEqual({
      provider: "faux",
      modelId: "faux-1",
    });
  });

  it("預設模型確實存在於 pi-ai 的 Workers AI 目錄（避免寫出解析不到的 id）", () => {
    const creds: MeetingBindings = { CLOUDFLARE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "a" };
    const { models } = createBoundModels(creds);
    const realtime = resolveModel(creds, "realtime");
    const notes = resolveModel(creds, "notes");
    expect(models.getModel(realtime.provider, realtime.modelId)?.id).toBe(realtime.modelId);
    expect(models.getModel(notes.provider, notes.modelId)?.id).toBe(notes.modelId);
    // D15 的核心前提：會後模型的窗口遠大於舊規劃的 24k。
    expect(models.getModel(notes.provider, notes.modelId)?.contextWindow).toBeGreaterThanOrEqual(128_000);
  });

  it("AuthContext 從綁定讀值（不是 process.env）：空字串視為未設定", async () => {
    const models = createBoundModels({
      CLOUDFLARE_API_KEY: "k",
      CLOUDFLARE_ACCOUNT_ID: "",
    }).models;
    const auth = await models.getAuth("cloudflare-workers-ai");
    // 帳號 id 為空 → 授權不完整 → 解析不到（不會誤用 process.env 的值）
    expect(auth).toBeUndefined();
    const ok = createBoundModels({ CLOUDFLARE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "acct" }).models;
    expect(await ok.getAuth("cloudflare-workers-ai")).toBeDefined();
  });

  it("壓縮政策依窗口大小推導，且在阻塞門檻之下才啟動背景壓縮", () => {
    const small = compactionPolicyFor(24_000);
    expect(small.enabled).toBe(true);
    expect(small.reserveTokens).toBe(6_000);
    expect(small.backgroundTokens).toBeLessThan(small.reserveTokens);

    const large = compactionPolicyFor(256_000);
    expect(large.reserveTokens).toBe(6_000);
    expect(large.keepRecentTokens).toBe(4_000);
    expect(256_000 - large.reserveTokens - large.backgroundTokens).toBeGreaterThan(200_000);
  });
});

describe("openMeeting：真的開一場會議並讀回（TECH-004）", () => {
  it("同一份 storage 重開後拿到同一個 conversation，且 entries 不變少", async () => {
    const db = new DatabaseSync(":memory:");
    const storage = doLikeStorage(db);

    const first = await openMeeting(storage, { bindings: FAUX_BINDINGS });
    expect(first.model.provider).toBe("faux");
    // 先真的跑一輪，讓會議裡有內容；否則「讀得回來」會退化成「什麼都沒存」
    first.faux?.setResponses([fauxAssistantMessage("記下了：週五前交預算明細。")]);
    const rootBefore = await first.root();
    const submission = await rootBefore.submit({ type: "input", content: "幫我記一件事" }, BACKGROUND_CONTEXT);
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const before = (await rootBefore.viewState(BACKGROUND_CONTEXT)).value.entries.length;
    expect(before).toBeGreaterThan(1);

    await first.harness.close(BACKGROUND_CONTEXT); // close 會一併關掉 storage

    // 模擬 DO 被回收後的下一次請求：整條鏈重建
    const second = await openMeeting(storage, { bindings: FAUX_BINDINGS });
    const rootAfter = await second.root();
    expect(rootAfter.id).toBe(first.conversationId);
    const after = (await rootAfter.viewState(BACKGROUND_CONTEXT)).value.entries.length;
    expect(after).toBe(before);
    // 重開後仍可繼續同一場會議
    second.faux?.setResponses([fauxAssistantMessage("第二輪也記下了。")]);
    const second_turn = await rootAfter.submit({ type: "input", content: "還有一件事" }, BACKGROUND_CONTEXT);
    expect((await second_turn.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect((await rootAfter.viewState(BACKGROUND_CONTEXT)).value.entries.length).toBeGreaterThan(before);
    await second.harness.close(BACKGROUND_CONTEXT);
  });

  it("彈性：自訂壓縮政策可覆寫（供 M02-US-219 分階段模型使用）", async () => {
    const db = new DatabaseSync(":memory:");
    const opened = await openMeeting(doLikeStorage(db), {
      bindings: FAUX_BINDINGS,
      compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1, backgroundTokens: 0 },
    });
    const settings = await opened.root();
    expect(settings.id).toBe(opened.conversationId);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it("faux 設定回覆後可以完成一個 turn（證明 harness 真的可用，不只是開得起來）", async () => {
    const db = new DatabaseSync(":memory:");
    const opened = await openMeeting(doLikeStorage(db), { bindings: FAUX_BINDINGS });
    expect(opened.faux).toBeDefined();
    opened.faux?.setResponses([fauxAssistantMessage("記下了：週五前交預算明細。")]);
    const root = await opened.root();
    const submission = await root.submit({ type: "input", content: "幫我記一件事" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    const view = await root.viewState(BACKGROUND_CONTEXT);
    expect(view.value.entries.length).toBeGreaterThan(1);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it("DoSqliteDatabase 真的寫進 SQLite（表已建立，且 STRICT 生效）", async () => {
    const db = new DatabaseSync(":memory:");
    const adapter = new DoSqliteDatabase(doLikeStorage(db));
    const opened = await openMeeting(doLikeStorage(db), { bindings: FAUX_BINDINGS });
    const tables = await adapter.all("select name, sql from sqlite_master where type='table'");
    expect(tables.length).toBeGreaterThan(5);
    const strictCount = tables.filter(
      (table) => typeof (table as { sql?: string }).sql === "string" && /STRICT/.test((table as { sql: string }).sql),
    ).length;
    expect(strictCount).toBeGreaterThan(0);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });
});