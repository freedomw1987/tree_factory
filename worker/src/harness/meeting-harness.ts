/**
 * TECH-004：在 Durable Object 內開一場會議的 `Harness`——包含憑證繫結與模型策略。
 *
 * 三個關鍵決定（都有實測或目錄證據支撐）：
 *
 * 1. **憑證走 Worker secret 繫結，不讀 `process.env`**：pi-ai 的 provider 授權會呼叫
 *    `AuthContext.env(name)`（見 `pi-ai/dist/auth/types.d.ts`）。Workers 沒有 `process.env`，
 *    所以建立 `createModels({ authContext })` 時注入一個**由 `env` 綁定物件讀值**的實作。
 *    缺少憑證時丟 `AUTH_INVALID`（system-design §5.2 裡**唯一允許阻斷錄音**的錯誤碼）。
 *
 * 2. **模型 id 必須用 pi-ai 目錄裡的完整 id**（含 `@cf/` 前綴）。目錄的權威來源是**程式碼**
 *    `pi-ai/dist/providers/cloudflare-workers-ai.models.js`（`CLOUDFLARE_WORKERS_AI_MODELS`）；
 *    `pi-ai/dist/providers/data/cloudflare-workers-ai.json` 只有 **api** 定義、沒有模型清單。
 *    自行縮寫的名稱（例如把 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 寫成
 *    `llama-3.3-70b-fp8-fast`）解析不到——**解析不到就丟錯**，不靜默退回保守政策。
 *
 * 3. **分階段模型 + 顯式壓縮政策（D15）**：即時階段用便宜的小模型，會後產出用較強的模型；
 *    壓縮政策顯式設定，不依賴預設值（預設值是為長對話設計的，跟我們的 2 小時會議不同）。
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import { DoSqliteDatabase, type DoSqlStorageLike } from "../storage/do-sqlite.js";

/**
 * `AuthContext` 型別：pi-ai 沒有對外匯出這個型別（只在 `auth/types.ts` 內部），
 * 所以從公開 API (`createModels`) 的參數推導，避免深連結到內部檔案。
 */
export type AuthContext = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["authContext"]>;

/** Worker 綁定（wrangler.toml 的 vars 與 secret）。 */
export interface MeetingBindings {
  /** secret：Workers AI API key（與 CLOUDFLARE_ACCOUNT_ID 成對）。 */
  CLOUDFLARE_API_KEY?: string;
  /** secret/var：Cloudflare 帳號 id。 */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** 覆寫 provider（`faux` 供測試／離線用）。 */
  HARNESS_PROVIDER?: string;
  /** 即時階段模型 id。 */
  REALTIME_MODEL_ID?: string;
  /** 會後產出階段模型 id。 */
  NOTES_MODEL_ID?: string;
  [name: string]: unknown;
}

/** 預設 provider。 */
export const DEFAULT_PROVIDER = "cloudflare-workers-ai";

/**
 * 預設模型（值取自 pi-ai 的 Workers AI 目錄，2026-10-08）。
 *
 * ⚠️ 這裡刻意**不**沿用 planning 階段的「即時 8b llama / 會後 70b llama」：
 * 目錄裡沒有 8b llama，而 70b（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`）是
 * **24k 上下文 / $2.253 每百萬輸出 token**——是目錄裡「窗口最小、輸出最貴」的組合。
 * 改選：即時 = granite-micro（131k / $0.017 進 / $0.112 出，最便宜）；
 * 會後 = gemma-4-26b（256k / $0.1 進 / $0.3 出）。
 * 最終拍板屬 M02-US-219（分階段模型），此處只提供安全預設。
 */
export const DEFAULT_REALTIME_MODEL_ID = "@cf/ibm-granite/granite-4.0-h-micro";
export const DEFAULT_NOTES_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

/** 會議階段：決定用哪個模型（D15）。 */
export type MeetingPhase = "realtime" | "notes";

export type MeetingPhaseErrorCode = "AUTH_INVALID" | "MODEL_UNAVAILABLE" | "PROVIDER_UNKNOWN";

/** 缺少憑證：對應 system-design §5.2 的 `AUTH_INVALID`（可阻斷）。 */
export class MissingCredentialError extends Error {
  readonly code = "AUTH_INVALID";
  readonly recoverable = false;

  constructor(missing: readonly string[], provider: string) {
    super(
      `provider「${provider}」需要 ${missing.join(" 與 ")}；` +
        "請以 `wrangler secret put` 設定，或用 HARNESS_PROVIDER=faux 跑離線測試。",
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * 不支援的 provider：**不用別的 provider 頂替**，也不用它去跳過憑證檢查。
 *
 * ⚠️ 這是 **DO 診斷面**（`/health`、operator smoke）的碼，不在 `system-design.md` §5.2
 * 的裝置錯誤碼表裡（那張表是裝置端協定、窮舉 10 碼）。若未來要把這個情形送到裝置，
 * **必須先補表**（否則違反該節「新增碼必須同步更新此表」的規定）。
 */
export class UnknownProviderError extends Error {
  readonly code = "PROVIDER_UNKNOWN";
  /** 依 §5.2 的定義＝「裝置可繼續」，不是「維運可自癒」：設定錯了不該中止錄音。 */
  readonly recoverable = true;

  constructor(provider: string) {
    super(
      `不支援的 provider「${provider}」：本階段只有 ${SUPPORTED_PROVIDERS.join(" / ")}；` +
        "若只是想在本機跑，請設 HARNESS_PROVIDER=faux。",
    );
    this.name = "UnknownProviderError";
  }
}

/**
 * 目錄裡查不到的模型 id：**不靜默退回保守的 24k 窗口**。
 *
 * 為什麼要丟錯而不是 fallback：`compactionPolicyFor()` 的輸出**取決於窗口大小**
 * （24k 與 128k 算出來的保留量不同），一個打錯的 id 會讓壓縮政策默默變成錯的
 * ——那是「靜默失敗族」，比一個明確的錯誤危險得多。
 *
 * 沿用 §5.2 既有的 `MODEL_UNAVAILABLE`（`recoverable: ✅`：錄音不中斷，只降級）。
 */
export class ModelUnavailableError extends Error {
  readonly code = "MODEL_UNAVAILABLE";
  readonly recoverable = true;

  constructor(provider: string, modelId: string) {
    super(
      `provider「${provider}」的目錄裡找不到模型「${modelId}」：` +
        "請確認 REALTIME_MODEL_ID / NOTES_MODEL_ID 用的是完整 id（含 `@cf/` 前綴）。",
    );
    this.name = "ModelUnavailableError";
  }
}

/** 本階段支援的 provider：預設的 Workers AI 與離線／測試用的 faux。 */
export const SUPPORTED_PROVIDERS = [DEFAULT_PROVIDER, "faux"] as const;

/** 由 Worker 綁定讀值的 `AuthContext`（取代預設的 `process.env` 版本）。 */
export function createBindingAuthContext(bindings: MeetingBindings): AuthContext {
  return {
    async env(name: string): Promise<string | undefined> {
      const value = bindings[name];
      return typeof value === "string" && value !== "" ? value : undefined;
    },
    // Worker 沒有檔案系統；憑證只能來自綁定。
    async fileExists(): Promise<boolean> {
      return false;
    },
  };
}

export interface ResolvedModel {
  provider: string;
  modelId: string;
}

/**
 * 解析某個階段要用哪個模型，並檢查憑證。
 * @throws UnknownProviderError 當 `HARNESS_PROVIDER` 不是支援的值時（不用別的 provider 頂替）
 * @throws MissingCredentialError 當 provider 需要憑證而綁定裡沒有時
 */
export function resolveModel(bindings: MeetingBindings, phase: MeetingPhase): ResolvedModel {
  const provider = bindings.HARNESS_PROVIDER ?? DEFAULT_PROVIDER;
  if (provider !== DEFAULT_PROVIDER && provider !== "faux") {
    throw new UnknownProviderError(provider);
  }
  if (provider === "faux") {
    return { provider, modelId: phase === "notes" ? "faux-notes" : "faux-1" };
  }
  const missing = (["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"] as const).filter(
    (name) => typeof bindings[name] !== "string" || bindings[name] === "",
  );
  if (missing.length > 0) {
    throw new MissingCredentialError(missing, provider);
  }
  const configured = phase === "realtime" ? bindings.REALTIME_MODEL_ID : bindings.NOTES_MODEL_ID;
  const fallback = phase === "realtime" ? DEFAULT_REALTIME_MODEL_ID : DEFAULT_NOTES_MODEL_ID;
  return { provider, modelId: configured ?? fallback };
}

/** D15 的顯式壓縮政策（避免吃 pi-durable 的預設值）。 */
export interface CompactionPolicy {
  enabled: boolean;
  /** 保留給系統／回覆的 token 數。 */
  reserveTokens: number;
  /** 最近的對話保留多少 token 不壓縮。 */
  keepRecentTokens: number;
  /** 達到此 token 數就背景壓縮。 */
  backgroundTokens: number;
}

/**
 * 依窗口大小算壓縮政策（D15）：預設留 6k 給系統、4k 給最近對話、超過窗口一半就背景壓縮。
 * 有明確理由才調，且每個數字都要能講出為什麼。
 */
export function compactionPolicyFor(contextWindowTokens: number): CompactionPolicy {
  const reserveTokens = Math.min(6000, Math.floor(contextWindowTokens / 4));
  return {
    enabled: true,
    // 擋在「窗口 - reserve」；背景壓縮再提早 2k 開始（pi-durable 的語意：
    // 背景壓縮在阻塞門檻「之下 backgroundTokens」啟動）。
    reserveTokens,
    keepRecentTokens: Math.min(4000, Math.floor(contextWindowTokens / 8)),
    backgroundTokens: Math.min(2000, Math.floor(contextWindowTokens / 12)),
  };
}

/**
 * 目錄「有這個模型、但沒標窗口」時的保守窗口（最小可用：llama-3.3-70b 的 24k）。
 *
 * ⚠️ 只有這一種情形會用到它；**打錯的模型 id 一律丟 `ModelUnavailableError`**，
 * 不再靠這個保守值把錯誤吞掉。
 */
export const FALLBACK_CONTEXT_WINDOW = 24_000;

/** 建立（或重建）一場會議的 harness 及其根對話。 */
export interface OpenMeetingOptions {
  bindings: MeetingBindings;
  phase?: MeetingPhase;
  /** 覆寫壓縮政策（預設依模型窗口計算）。 */
  compaction?: CompactionPolicy;
  /** 覆寫模型（測試或未來由使用者指定時用）。 */
  model?: ResolvedModel;
}

export interface OpenMeetingResult {
  harness: Harness;
  database: DoSqliteDatabase;
  models: MutableModels;
  model: ResolvedModel;
  /** 根對話：重開後仍會拿到同一個（durability，SPIKE-003 已驗）。 */
  conversationId: number;
  /** 取得根對話 handle（每次呼叫都回同一場會議）。 */
  root: () => Promise<Awaited<ReturnType<Harness["root"]>>>;
  /** 只有 faux provider 才有：測試／離線用。 */
  faux?: FauxProviderHandle;
}

/** 建立 models（含 authContext 繫結）。faux provider 時一併回傳 handle，供測試設定回覆。 */
export function createBoundModels(bindings: MeetingBindings): {
  models: MutableModels;
  faux?: FauxProviderHandle;
} {
  const models = createModels({ authContext: createBindingAuthContext(bindings) });
  const provider = bindings.HARNESS_PROVIDER ?? DEFAULT_PROVIDER;
  if (provider !== DEFAULT_PROVIDER && provider !== "faux") {
    // 這裡也擋一次：任何呼叫端都不該因為打錯 provider 而默默建成 Cloudflare。
    throw new UnknownProviderError(provider);
  }
  if (provider === "faux") {
    const ids = [
      "faux-1",
      "faux-notes",
      bindings.REALTIME_MODEL_ID,
      bindings.NOTES_MODEL_ID,
    ].filter((id): id is string => typeof id === "string" && id !== "");
    const faux = fauxProvider({
      provider: "faux",
      models: [...new Set(ids)].map((id) => ({ id })),
    });
    models.setProvider(faux.provider);
    return { models, faux };
  }
  models.setProvider(cloudflareWorkersAIProvider());
  return { models };
}

/**
 * 開一場會議的 harness。
 *
 * 注意（SPIKE-003 的踩坑）：`harness.close()` **會一併關掉 storage**，
 * 所以「重建」時必須重新建立 adapter → storage → harness 這一整條鏈，
 * 不能只重開 harness。呼叫端（`HarnessLifecycle`）就是靠這個函式重建整條鏈。
 */
export async function openMeeting(
  storage: DoSqlStorageLike,
  options: OpenMeetingOptions,
): Promise<OpenMeetingResult> {
  const model = options.model ?? resolveModel(options.bindings, options.phase ?? "realtime");
  // 先驗「模型真的存在」再碰 storage（fail fast）：
  // 打錯 id 要立刻講出來，不可以先開好 storage 再靜默退回保守的壓縮政策。
  const { models, faux } = createBoundModels(options.bindings);
  const definition = models.getModel(model.provider, model.modelId);
  if (definition === undefined) {
    throw new ModelUnavailableError(model.provider, model.modelId);
  }
  const database = new DoSqliteDatabase(storage);
  const sqlite = await SqliteStorage.open(database);
  // D15：壓縮政策依「該模型實際的上下文窗口」推導，不用一個寫死的數字。
  const policy =
    options.compaction ?? compactionPolicyFor(definition.contextWindow ?? FALLBACK_CONTEXT_WINDOW);
  const harness = await Harness.open(
    sqlite,
    { models, registry: createRegistry(), settings: { compaction: policy } },
    BACKGROUND_CONTEXT,
  );
  const root = () =>
    harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.modelId } },
    });
  const conversation = await root();
  return {
    harness,
    database,
    models,
    model,
    conversationId: conversation.id,
    root,
    ...(faux === undefined ? {} : { faux }),
  };
}