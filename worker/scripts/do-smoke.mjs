#!/usr/bin/env node
/**
 * TECH-004 冒煙測試：在**真的 workerd** 裡跑真 Durable Object（faux provider，零成本）。
 *
 * 為什麼需要這一支：單元測試驗的是壽命邏輯，但「DO 被回收後同一場會議讀得回來」、
 * 「alarm 真的會醒來」、「一個會議真的對到一個 DO 實例」這些是**平台行為**，
 * 只有真的跑起來才算證據（SPIKE-003 的方法是錯的就會在這裡爆）。
 *
 * 用法：
 *   cd worker && npx wrangler dev --port 8787 --local --var HARNESS_PROVIDER:faux &
 *   node scripts/do-smoke.mjs
 */

const BASE = process.env.DO_SMOKE_BASE ?? "http://127.0.0.1:8787";

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "✅" : "❌";
  if (!condition) {
    failures += 1;
  }
  console.log(`${mark} ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

async function get(path) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function post(path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`DO smoke：base=${BASE}`);
console.log("--- 0. Worker 活著 ---");
const root = await get("/");
check("GET / 回服務說明", root.status === 200 && root.body.service === "tree-factory-worker");

console.log("--- 1. 懶初始化 + 單例 ---");
const first = await get("/m/meeting-a/health");
check("第一次 /health 成功", first.status === 200 && first.body.ok === true, `conversationId=${first.body.conversationId}`);
check("第一次才開 harness（opens=1）", first.body.stats.opens === 1, `opens=${first.body.stats.opens}`);

const second = await get("/m/meeting-a/health");
check("第二次沒有重開（單例）", second.body.stats.opens === 1, `opens=${second.body.stats.opens}`);
check("同一場會議的 conversationId 不變", second.body.conversationId === first.body.conversationId);
check("模型與 D15 預設一致", second.body.model?.modelId === "faux-1", JSON.stringify(second.body.model));

console.log("--- 2. 一個會議 = 一個 DO 實例 ---");
const otherMeeting = await get("/m/meeting-b/health");
// conversationId 只在該場會議內唯一（根對話 id 是固定的），所以要比的是 DO 身分。
check(
  "另一場會議對到不同的 DO 實例",
  otherMeeting.body.doId !== first.body.doId,
  `${first.body.doId} vs ${otherMeeting.body.doId}`,
);
check(
  "另一場會議各自獨立開 harness（兩邊 opens 都是 1）",
  otherMeeting.body.stats.opens === 1,
  `opens=${otherMeeting.body.stats.opens}`,
);

console.log("--- 3. 真的跑一個 turn（faux 模型） ---");
const scripted = await post("/m/meeting-a/debug/faux", { contents: ["記下了：週五前交預算明細。"] });
check("faux 腳本已設定（測試支援端點）", scripted.body.scripted === 1, JSON.stringify(scripted.body));
const submitted = await post("/m/meeting-a/submit", { content: "幫我記一件事" });
check("submit 回 done", submitted.body.status === "done", JSON.stringify(submitted.body));
const afterTurn = await get("/m/meeting-a/health");
check("entries 增加", afterTurn.body.entries > second.body.entries, `${second.body.entries} → ${afterTurn.body.entries}`);
const entriesAfterTurn = afterTurn.body.entries;

console.log("--- 4. alarm 接力 ---");
const missing = await get("/m/meeting-a/wake");
check("缺 ?ms 時明確報錯（不退化成 0）", missing.status === 400 && missing.body.error === "MS_REQUIRED");
const scheduled = await get("/m/meeting-a/wake?ms=1500");
check("wake 設定了 alarm", scheduled.body.scheduled === true, JSON.stringify(scheduled.body));
check(
  "alarm 時間 = 現在 + 1500ms（query 參數真的有送到 DO）",
  scheduled.body.at - Date.now() > 500,
  `at-now=${scheduled.body.at - Date.now()}ms`,
);
const rescheduled = await get("/m/meeting-a/wake?ms=60000");
check("更晚的 wake 不動既有 alarm（只往前）", rescheduled.body.scheduled === false, JSON.stringify(rescheduled.body));
await sleep(2500);

const afterAlarm = await get("/m/meeting-a/health");
check("alarm 真的醒來（alarmWakes ≥ 1）", afterAlarm.body.stats.alarmWakes >= 1, `alarmWakes=${afterAlarm.body.stats.alarmWakes}`);
check(
  "alarm 醒來後 harness 重建（opens ≥ 2）",
  afterAlarm.body.stats.opens >= 2,
  `opens=${afterAlarm.body.stats.opens}`,
);
check("重建後 conversationId 不變", afterAlarm.body.conversationId === first.body.conversationId);
check("重建後 entries 不變少（同一份 storage 讀回）", afterAlarm.body.entries >= entriesAfterTurn, `${entriesAfterTurn} → ${afterAlarm.body.entries}`);

console.log("--- 5. 缺憑證時回 AUTH_INVALID（唯一可阻斷） ---");
console.log("（跳過：本輪以 HARNESS_PROVIDER=faux 啟動；AUTH_INVALID 由單元測試覆蓋）");

console.log(`\nDO smoke：${failures === 0 ? "全部通過 ✅" : `${failures} 項失敗 ❌`}`);
process.exit(failures === 0 ? 0 : 1);