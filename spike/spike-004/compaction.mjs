/**
 * SPIKE-004：2 小時會議的成本形狀 —— 上下文會不會無限長大？壓縮什麼時候觸發？
 *
 * 用 faux provider（零 API 成本）餵 120 分鐘的逐字稿，量測：
 *   - entries / 累積字元數 / 是否觸發 compaction（結構性成本）
 *   - `view.value` 有哪些欄位、usage 從哪裡拿
 * 真實 token 與單價另外用可稽核的算式推估（見 docs/spike/SPIKE-004.md）。
 */
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DoSqliteDatabase } from "../spike-003/src/do-sqlite.js";

function doLikeStorage(db) {
  return {
    sql: {
      exec(sql, ...bindings) {
        if (/^\s*(select|with|pragma|explain)/i.test(sql)) {
          return { toArray: () => db.prepare(sql).all(...bindings) };
        }
        if (bindings.length > 0) db.prepare(sql).run(...bindings);
        else db.exec(sql);
        return { toArray: () => [] };
      },
    },
    async transaction(callback) {
      db.exec("BEGIN");
      let rolled = false;
      try {
        const out = await callback({ rollback: () => { db.exec("ROLLBACK"); rolled = true; } });
        if (!rolled) db.exec("COMMIT");
        return out;
      } catch (error) {
        if (!rolled) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** 造一段像真會議的逐字稿：一分鐘約 150 字英文（≈ 每分鐘 1 個 segment 群）。 */
function minuteOfTranscript(minute) {
  const lines = [
    `[${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}] 說話者1：我們接著看第三季的預算配置，` +
      "研發佔比要從百分之三十八提到百分之四十二，這需要產品線的排期一起調整，否則交期會擠到第四季。",
    `說話者2：同意方向，但人力缺口要先補，` +
      "我建議先把兩個後端缺額開出來，另外測試環境的穩定性問題上週已經修掉大部分，剩下兩個 case 在下週三前收斂。",
    `說話者1：那我把預算表更新後寄給大家，` + "週五前回覆意見，沒問題就進董事會。",
    `說話者2：我補一點，` + "客戶 A 的合約有排他條款，如果我們對外發布新模組要先確認法務，這件事我來追。",
  ];
  return lines.join("\n");
}

const db = new DatabaseSync(":memory:");
const storage = await SqliteStorage.open(new DoSqliteDatabase(doLikeStorage(db)));
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 128000 }] });
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(
  storage,
  {
    models,
    registry: createRegistry(),
    // 壓縮門檻刻意調小，好在 120 回合內觀察到觸發（真實預設見 SPIKE-004 文件）
    settings: { compaction: { enabled: true, reserveTokens: 12000, keepRecentTokens: 4000, backgroundTokens: 4000 } },
  },
  BACKGROUND_CONTEXT,
);
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

let chars = 0;
let compactions = 0;
let lastEntries = 0;
console.log("回合 | entries | 累積字元 | 回應狀態");
for (let minute = 0; minute < 120; minute += 1) {
  const text = minuteOfTranscript(minute);
  chars += text.length;
  faux.setResponses([fauxAssistantMessage("收到，已記下這一段。")]);
  const submission = await root.submit(
    { type: "input", content: text, requestId: `seg-${minute}` },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  const view = await root.viewState(BACKGROUND_CONTEXT);
  const entries = view.value.entries.length;
  if (entries < lastEntries + 1) {
    compactions += 1;
    console.log(`  ↳ 回合 ${minute}：entries ${lastEntries} → ${entries}（疑似 compaction）`);
  }
  lastEntries = entries;
  if (minute % 30 === 29 || minute === 0) {
    console.log(
      `${String(minute + 1).padStart(4)} | ${String(entries).padStart(7)} | ${String(chars).padStart(8)} | ${settled.status}`,
    );
  }
}
const view = await root.viewState(BACKGROUND_CONTEXT);
console.log("\n=== 收尾 ===");
console.log("view.value 欄位：", Object.keys(view.value).join(", "));
console.log("entries 總數：", view.value.entries.length);
console.log("型別分佈：", JSON.stringify(
  view.value.entries.reduce((acc, e) => ({ ...acc, [e.type ?? e.kind ?? "?"]: (acc[e.type ?? e.kind ?? "?"] ?? 0) + 1 }), {}),
));
console.log("疑似 compaction 次數：", compactions);
console.log("逐字稿總字元：", chars, "（≈", Math.round(chars / 2.5), "tokens 粗估）");
if (view.value.docs) {
  console.log("docs 鍵：", Object.keys(view.value.docs).join(", "));
  const usage = view.value.docs["pi.usage"];
  if (usage) console.log("pi.usage:", JSON.stringify(usage).slice(0, 400));
}
await harness.close(BACKGROUND_CONTEXT);
