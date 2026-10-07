/**
 * SPIKE-003 本機smoke：用 `node:sqlite` 當 DO SQLite 的替身，跑同一支 `DoSqliteDatabase`
 * 與同一條 Harness 使用路徑（faux provider，不打外部 API）。
 *
 * 用途：把「adapter 邏輯 + Harness 呼叫方式」對的快，再去 workerd 跑同一份程式碼。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DoSqliteDatabase } from "../src/do-sqlite.js";

/** 把 node:sqlite 包成 DO 的 `storage` 形狀：`.sql.exec(sql, ...bindings)` + `.transaction(cb)`。 */
function doLikeStorage(db) {
  return {
    sql: {
      exec(sql, ...bindings) {
        if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
          const rows = db.prepare(sql).all(...bindings);
          return { toArray: () => rows };
        }
        if (bindings.length > 0) db.prepare(sql).run(...bindings);
        else db.exec(sql);
        return { toArray: () => [] };
      },
    },
    async transaction(callback) {
      db.exec("BEGIN");
      let rolledBack = false;
      try {
        const result = await callback({
          rollback: () => {
            db.exec("ROLLBACK");
            rolledBack = true;
          },
        });
        if (!rolledBack) db.exec("COMMIT");
        return result;
      } catch (error) {
        if (!rolledBack) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function newModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

const db = new DatabaseSync(":memory:");
const adapter = new DoSqliteDatabase(doLikeStorage(db));
const storage = await SqliteStorage.open(adapter);
console.log("✓ SqliteStorage.open 成功（schema migration 跑完）");

const tables = await adapter.all("select name, sql from sqlite_master where type='table' order by name");
console.log(`  表數=${tables.length}，其中 STRICT=${tables.filter((t) => /STRICT/.test(t.sql ?? "")).length}`);
console.log(`  sqlite_version=${(await adapter.get("select sqlite_version() as v")).v}`);
assert.ok(tables.length > 5, "應建立多張表");

const { models, faux } = newModels();
const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
console.log("✓ Harness.open + root() 成功，conversationId=" + root.id);

faux.setResponses([fauxAssistantMessage("記下了：週五前交預算明細。")]);
const submission = await root.submit({ type: "input", content: "幫我記一件事" }, BACKGROUND_CONTEXT);
const settled = await submission.wait(BACKGROUND_CONTEXT);
console.log(`✓ 一次完整 turn 完成：status=${settled.status} type=${settled.type}`);
assert.equal(settled.status, "done");

const before = (await root.viewState(BACKGROUND_CONTEXT)).value.entries.length;
await harness.close(BACKGROUND_CONTEXT);   // 注意：close() 會一併關掉 storage
console.log("✓ harness.close() 完成（storage 亦隨之關閉）");

// 第二階段：同一份 SQLite，重新開一組 adapter + storage + harness（等價於 DO 被回收後的下一次請求）
const adapter2 = new DoSqliteDatabase(doLikeStorage(db));
const storage2 = await SqliteStorage.open(adapter2);
const { models: models2 } = newModels();
const reopened = await Harness.open(storage2, { models: models2, registry: createRegistry() }, BACKGROUND_CONTEXT);
const sameRoot = await reopened.root(BACKGROUND_CONTEXT);
const after = (await sameRoot.viewState(BACKGROUND_CONTEXT)).value.entries.length;
console.log(`✓ 重開後：conversation 相同=${sameRoot.id === root.id}，entries=${before} → ${after}`);
assert.equal(sameRoot.id, root.id);
assert.ok(after >= before, "重開後不應少於原本的 entries");

await reopened.close(BACKGROUND_CONTEXT);
console.log("\nSPIKE-003 smoke：全部通過 ✅");
