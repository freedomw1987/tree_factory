/**
 * SPIKE-003：`@earendil-works/pi-durable`（durable agent harness）能否跑在 Cloudflare Durable Object 裡。
 *
 * 這支 worker 只用來驗證，不部署到生產。所有檢查都在 DO 內執行，結果以 JSON 回傳：
 *   1. `SqliteStorage.open()` 能否在 DO SQLite 上跑完 schema migration（含 9 個 STRICT 表）
 *   2. `Harness.open()` + `root()` 能否在 DO 內開起來
 *   3. 一次完整 turn（submit → wait，faux provider，不打外部 API）
 *   4. 關掉 harness 後用同一份 DO SQLite 重開 → 是否還是同一場會議、訊息還在（durability）
 *   5. 跨請求是否持久（每次請求累加一次走訪紀錄）
 *
 * 用 faux provider 是刻意的：spike 要驗的是「DO 環境能不能跑」，不是模型品質，
 * 因此不碰任何外部 API、零成本、可重複。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DoSqliteDatabase } from "./do-sqlite.js";

const PROVIDER = "faux";
const MODEL_ID = "faux-1";

/** 每次「開機」都重建 adapter + storage + harness，模擬 DO 被回收後的下一次請求。 */
async function boot(storageLike) {
  const db = new DoSqliteDatabase(storageLike);
  const storage = await SqliteStorage.open(db);
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: PROVIDER, modelId: MODEL_ID } },
  });
  return { db, storage, faux, harness, root };
}

/** 每個檢查都包起來：單一檢查失敗不會讓整份報告消失。 */
async function step(checks, name, fn) {
  const started = Date.now();
  try {
    checks.push({ name, ok: true, ms: Date.now() - started, detail: (await fn()) ?? null });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    });
  }
}

export class HarnessDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const checks = [];
    const sql = this.ctx.storage.sql;

    let first;
    await step(checks, "boot：SqliteStorage.open（DO SQLite + migration）+ Harness.open + root()", async () => {
      first = await boot(this.ctx.storage);
      return { conversationId: first.root.id };
    });

    await step(checks, "schema：STRICT 表已建立", async () => {
      const rows = first.db.all
        ? await first.db.all(
            "select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
          )
        : [];
      return { tables: rows.length, strict: rows.filter((r) => /STRICT/.test(r.sql ?? "")).length };
    });

    if (first !== undefined) {
      await step(checks, "turn：submit → wait（faux provider，DO 內完成）", async () => {
        first.faux.setResponses([fauxAssistantMessage("記下了：週五前交預算明細。")]);
        const submission = await first.root.submit({ type: "input", content: "幫我記一件事" }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        return { status: settled.status, type: settled.type };
      });

      await step(checks, "durability：關掉再重開，同一場會議讀得回來", async () => {
        const conversationId = first.root.id;
        const entriesBefore = (await first.root.viewState(BACKGROUND_CONTEXT)).value.entries.length;
        await first.harness.close(BACKGROUND_CONTEXT); // 注意：close() 會一併關掉 storage
        const second = await boot(this.ctx.storage);
        const entriesAfter = (await second.root.viewState(BACKGROUND_CONTEXT)).value.entries.length;
        await second.harness.close(BACKGROUND_CONTEXT);
        return {
          sameConversation: second.root.id === conversationId,
          entries: `${entriesBefore} → ${entriesAfter}`,
        };
      });
    }

    await step(checks, "跨請求持久：DO SQLite 自己的一張表", async () => {
      sql.exec("create table if not exists spike_visit(id integer primary key autoincrement, at text)");
      sql.exec("insert into spike_visit(at) values (?)", new Date().toISOString());
      return { visits: sql.exec("select count(*) as n from spike_visit").one().n };
    });

    return Response.json({
      ok: checks.every((c) => c.ok),
      runtime: { userAgent: request.headers.get("user-agent"), databaseSize: sql.databaseSize },
      checks,
    });
  }
}

export default {
  async fetch(request, env) {
    const id = env.HARNESS.idFromName("spike-003");
    return env.HARNESS.get(id).fetch(request);
  },
};
