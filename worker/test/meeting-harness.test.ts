// TECH-004：模型 / provider 解析的「不許靜默」測試。
//
// 背景（reviewer 稽核 + jev 校驗後驗證共同的結論）：這一族的三個缺陷都是
// **靜默失敗**——打錯的 provider 或模型 id 不會報錯，而是悄悄換一個 provider，
// 或悄悄用 24k 的保守窗口去算壓縮政策。對本專案（壓縮政策算錯 = 可能爆上下文）
// 這比一個明確的錯誤危險得多，所以一律改成明確丟錯。

import { describe, expect, it } from "vitest";

import type { DoSqlStorageLike, SqlBinding } from "../src/storage/do-sqlite.js";
import {
  FALLBACK_CONTEXT_WINDOW,
  ModelUnavailableError,
  UnknownProviderError,
  compactionPolicyFor,
  createBoundModels,
  openMeeting,
  resolveModel,
  type MeetingBindings,
} from "../src/harness/meeting-harness.js";

const CREDENTIALS: MeetingBindings = { CLOUDFLARE_API_KEY: "key", CLOUDFLARE_ACCOUNT_ID: "account" };

/** 假 storage：記錄被呼叫的 SQL；用於證明「錯誤發生在碰 storage 之前」。 */
function trackingStorage(): { storage: DoSqlStorageLike; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    storage: {
      sql: {
        exec(statement: string, ..._bindings: SqlBinding[]) {
          sql.push(statement);
          return { toArray: () => [] };
        },
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    },
  };
}

describe("模型與 provider 解析（TECH-004）", () => {
  it("未知 provider 直接丟 PROVIDER_UNKNOWN，不用別的 provider 頂替、也不跳過憑證檢查", () => {
    for (const provider of ["not-a-provider", "openai"]) {
      try {
        resolveModel({ HARNESS_PROVIDER: provider }, "realtime");
        expect.unreachable(`未知 provider「${provider}」一定要丟錯`);
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownProviderError);
        expect((error as UnknownProviderError).code).toBe("PROVIDER_UNKNOWN");
      }
    }
  });

  it("支援的 provider：faux（離線）與 cloudflare-workers-ai（預設，需憑證）", () => {
    expect(resolveModel({ HARNESS_PROVIDER: "faux" }, "realtime")).toEqual({
      provider: "faux",
      modelId: "faux-1",
    });
    expect(resolveModel({ HARNESS_PROVIDER: "faux" }, "notes").modelId).toBe("faux-notes");
    expect(resolveModel(CREDENTIALS, "notes")).toEqual({
      provider: "cloudflare-workers-ai",
      modelId: "@cf/google/gemma-4-26b-a4b-it",
    });
    expect(resolveModel(CREDENTIALS, "realtime").modelId).toBe("@cf/ibm-granite/granite-4.0-h-micro");
  });

  it("打錯的模型 id 丟 MODEL_UNAVAILABLE（不可靜默用 24k 保守窗口）", async () => {
    const tracked = trackingStorage();
    await expect(
      openMeeting(tracked.storage, {
        bindings: { ...CREDENTIALS, REALTIME_MODEL_ID: "@cf/typo/does-not-exist" },
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(tracked.sql).toEqual([]); // 先驗模型，再碰 storage
  });

  it("未知 provider 在碰 storage 之前就丟錯（fail fast，不要先開一半）", async () => {
    const tracked = trackingStorage();
    await expect(
      openMeeting(tracked.storage, { bindings: { HARNESS_PROVIDER: "not-a-provider" } }),
    ).rejects.toBeInstanceOf(UnknownProviderError);
    expect(tracked.sql).toEqual([]);
  });

  it("模型在目錄裡時才拿得到真實窗口；靜默退化會算出完全不同的壓縮政策", () => {
    const { models } = createBoundModels({ HARNESS_PROVIDER: "faux" });
    expect(models.getModel("faux", "faux-1")?.contextWindow).toBe(128_000);

    // 這是「為什麼靜默退化危險」的證據：24k 保守值算出來的政策和真實窗口差很多。
    expect(compactionPolicyFor(128_000)).toEqual({
      enabled: true,
      reserveTokens: 6_000,
      keepRecentTokens: 4_000,
      backgroundTokens: 2_000,
    });
    expect(compactionPolicyFor(FALLBACK_CONTEXT_WINDOW)).toEqual({
      enabled: true,
      reserveTokens: 6_000,
      keepRecentTokens: 3_000,
      backgroundTokens: 2_000,
    });

    // 預設的 Cloudflare 模型 id 是真的存在於目錄裡（不是靠 fallback 撐著）。
    const cloudflare = createBoundModels(CREDENTIALS).models;
    expect(cloudflare.getModel("cloudflare-workers-ai", "@cf/ibm-granite/granite-4.0-h-micro")?.contextWindow).toBe(131_000);
    expect(cloudflare.getModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it")?.contextWindow).toBe(256_000);
  });
});
