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

// 每次跑用不同的會議 id：DO 的 storage 是持久的，固定 id 會讓第二次以後的執行
// 看到上一輪的殘留（「未開始 404」變成 200、逐字稿次數從 2 開始），
// 於是「全綠」只在乾淨 state 下成立。有了 run id，同一份 state 可以重複跑。
const RUN_ID = process.env.DO_SMOKE_RUN_ID ?? Date.now().toString(36);
const mid = (name) => `${name}-${RUN_ID}`;

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
const first = await get(`/m/${mid('meeting-a')}/health`);
check("第一次 /health 成功", first.status === 200 && first.body.ok === true, `conversationId=${first.body.conversationId}`);
check("第一次才開 harness（opens=1）", first.body.stats.opens === 1, `opens=${first.body.stats.opens}`);

const second = await get(`/m/${mid('meeting-a')}/health`);
check("第二次沒有重開（單例）", second.body.stats.opens === 1, `opens=${second.body.stats.opens}`);
check("同一場會議的 conversationId 不變", second.body.conversationId === first.body.conversationId);
check("模型與 D15 預設一致", second.body.model?.modelId === "faux-1", JSON.stringify(second.body.model));

console.log("--- 2. 一個會議 = 一個 DO 實例 ---");
const otherMeeting = await get(`/m/${mid('meeting-b')}/health`);
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
const scripted = await post(`/m/${mid('meeting-a')}/debug/faux`, { contents: ["記下了：週五前交預算明細。"] });
check("faux 腳本已設定（測試支援端點）", scripted.body.scripted === 1, JSON.stringify(scripted.body));
const submitted = await post(`/m/${mid('meeting-a')}/submit`, { content: "幫我記一件事" });
check("submit 回 done", submitted.body.status === "done", JSON.stringify(submitted.body));
const afterTurn = await get(`/m/${mid('meeting-a')}/health`);
check("entries 增加", afterTurn.body.entries > second.body.entries, `${second.body.entries} → ${afterTurn.body.entries}`);
const entriesAfterTurn = afterTurn.body.entries;

console.log("--- 4. alarm 接力 ---");
const missing = await get(`/m/${mid('meeting-a')}/wake`);
check("缺 ?ms 時明確報錯（不退化成 0）", missing.status === 400 && missing.body.error === "MS_REQUIRED");
const scheduled = await get(`/m/${mid('meeting-a')}/wake?ms=1500`);
check("wake 設定了 alarm", scheduled.body.scheduled === true, JSON.stringify(scheduled.body));
check(
  "alarm 時間 = 現在 + 1500ms（query 參數真的有送到 DO）",
  scheduled.body.at - Date.now() > 500,
  `at-now=${scheduled.body.at - Date.now()}ms`,
);
const rescheduled = await get(`/m/${mid('meeting-a')}/wake?ms=60000`);
check("更晚的 wake 不動既有 alarm（只往前）", rescheduled.body.scheduled === false, JSON.stringify(rescheduled.body));
await sleep(2500);

const afterAlarm = await get(`/m/${mid('meeting-a')}/health`);
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

// M01-US-101：會議時間軸在**真 workerd** 上真的落地（DO SQLite + 路由）。
// 注意：這裡跑的是真實時間，所以「2:00 上限到點」不由這一支證明，
// 而是由可注入時鐘的 session-routes.test.ts 證明；這一支只證明「真的平台支援這些路徑」。
console.log("--- 6. M01-US-101 session 路由（真 workerd） ---");
const beforeStart = await get(`/m/${mid('meeting-sess')}/session`);
check(
  "未開始就查 session → 404 SESSION_NOT_STARTED",
  beforeStart.status === 404 && beforeStart.body.error === "SESSION_NOT_STARTED",
  JSON.stringify(beforeStart.body),
);
const started = await post(`/m/${mid('meeting-sess')}/session/start`, {});
check(
  "開始會議 → 201 recording，且 ends_at - started_at = 2 小時",
  started.status === 201 &&
    started.body.phase === "recording" &&
    started.body.endsAtMs - started.body.startedAtMs === 7_200_000,
  JSON.stringify(started.body),
);
check("會議 id 由 header 傳進 DO（回傳的 meetingId 就是路徑上的）", started.body.meetingId === mid('meeting-sess'));
const restarted = await post(`/m/${mid('meeting-sess')}/session/start`, {});
check(
  "重複開始不重置時間軸（冪等）",
  restarted.body.startedAtMs === started.body.startedAtMs,
  `${restarted.body.startedAtMs} vs ${started.body.startedAtMs}`,
);
const write1 = await post(`/m/${mid('meeting-sess')}/transcript`, { text: "第一句" });
const write2 = await post(`/m/${mid('meeting-sess')}/transcript`, { text: "第二句" });
check(
  "逐字稿寫入被接受並累計",
  write1.body.accepted === true && write2.body.transcriptWrites === 2,
  JSON.stringify(write2.body),
);
const statusBeforeStop = await get(`/m/${mid('meeting-sess')}/session`);
check(
  "查詢讀回同一份時間軸（transcriptWrites=2、warn=false）",
  statusBeforeStop.body.transcriptWrites === 2 && statusBeforeStop.body.warn === false,
  JSON.stringify(statusBeforeStop.body),
);
const isolated = await post(`/m/${mid('meeting-sess-2')}/session/start`, {});
const isolatedStatus = await get(`/m/${mid('meeting-sess-2')}/session`);
const firstStatus = await get(`/m/${mid('meeting-sess')}/session`);
check(
  "兩場會議的 session 互相隔離（新的 0 句、原本的 2 句）",
  isolated.body.phase === "recording" &&
    isolatedStatus.body.transcriptWrites === 0 &&
    firstStatus.body.transcriptWrites === 2,
  `other=${isolatedStatus.body.transcriptWrites}, first=${firstStatus.body.transcriptWrites}`,
);
const stopped = await post(`/m/${mid('meeting-sess')}/session/stop`, { reason: "user" });
check(
  "使用者結束 → phase=ended（reason=user）",
  stopped.body.phase === "ended" && stopped.body.endedReason === "user",
  JSON.stringify(stopped.body),
);
const afterStop = await post(`/m/${mid('meeting-sess')}/transcript`, { text: "結束後才補的句子" });
check(
  "結束後拒收逐字稿（409 SESSION_ENDED）",
  afterStop.status === 409 && afterStop.body.error === "SESSION_ENDED",
  JSON.stringify(afterStop.body),
);
const badReason = await post(`/m/${mid('meeting-sess')}/session/stop`, { reason: "because" });
check(
  "非法 reason → 400 REASON_INVALID（不默默當 user）",
  badReason.status === 400 && badReason.body.error === "REASON_INVALID",
  JSON.stringify(badReason.body),
);

// checker P0 的真 workerd 回歸探針：
// `aborted` 曾經寫得進去、讀不出來（讀取層白名單漏收），一次權限拒絕就讓該 meeting id 永久 500。
console.log("--- 7. aborted 收尾後仍讀得回來（真 workerd 回歸） ---");
const abortId = mid('meeting-abort');
await post(`/m/${abortId}/session/start`, {});
const aborted = await post(`/m/${abortId}/session/stop`, { reason: "aborted" });
check(
  "裝置端開始失敗 → stop aborted 回 200/ended",
  aborted.status === 200 && aborted.body.endedReason === "aborted",
  JSON.stringify(aborted.body),
);
const abortRead = await get(`/m/${abortId}/session`);
check(
  "aborted 之後 GET /session 仍 200（不得 SESSION_CORRUPT）",
  abortRead.status === 200 && abortRead.body.endedReason === "aborted",
  JSON.stringify(abortRead.body),
);

// M01-US-103：逐字稿帳本在**真 workerd** 上真的落地（DO SQLite + UNIQUE 索引 + 聚段管線）。
// 單元測試的 sqlite 是 node:sqlite 的替身；「CREATE TABLE / MAX(seq)+1 / 讀回同一份」這些
// 是**平台行為**，只有真的跑起來才算證據。
console.log("--- 8. M01-US-103 逐字稿帳本（真 workerd） ---");
const ledId = mid("meeting-ledger");
const w = (word, start, end, speaker) => ({ word, punctuated_word: word, start, end, speaker });
const resultsMsg = (words, isFinal = true) => ({
  type: "Results",
  channel_index: [0, 1],
  duration: words.at(-1)?.end ?? 0,
  start: words[0]?.start ?? 0,
  is_final: isFinal,
  speech_final: false,
  channel: { alternatives: [{ transcript: words.map((x) => x.punctuated_word).join(" "), confidence: 0.9, words }] },
});

const ledNotStarted = await post(`/m/${ledId}/transcript/stream`, { meetingOffsetMs: 0, messages: [] });
check(
  "未開始就寫逐字稿 → 409 SESSION_NOT_STARTED",
  ledNotStarted.status === 409 && ledNotStarted.body.error === "SESSION_NOT_STARTED",
  JSON.stringify(ledNotStarted.body),
);
await post(`/m/${ledId}/session/start`, {});

const firstRun = await post(`/m/${ledId}/transcript/stream`, {
  meetingOffsetMs: 0,
  finalize: true,
  messages: [resultsMsg([w("我們", 0, 0.6, 0), w("開始", 0.6, 1.2, 0)])],
});
check(
  "串流寫入一段（收尾）→ accepted=1、transcriptWrites=1",
  firstRun.status === 200 && firstRun.body.accepted === 1 && firstRun.body.transcriptWrites === 1,
  JSON.stringify(firstRun.body),
);
check(
  "回傳的段落本身（不是只有計數）",
  firstRun.body.appended?.[0]?.text === "我們 開始" && firstRun.body.appended?.[0]?.seq === 1,
  JSON.stringify(firstRun.body.appended),
);

const readBack = await get(`/m/${ledId}/transcript/segments`);
check(
  "讀回帳本：1 列、speaker 0、0~1200ms（毫秒原樣存回）",
  readBack.status === 200 &&
    readBack.body.count === 1 &&
    readBack.body.segments[0].speakerId === 0 &&
    readBack.body.segments[0].startMs === 0 &&
    readBack.body.segments[0].endMs === 1200,
  JSON.stringify(readBack.body),
);

const replay = await post(`/m/${ledId}/transcript/stream`, {
  meetingOffsetMs: 0,
  finalize: true,
  messages: [resultsMsg([w("我們", 0, 0.6, 0), w("開始", 0.6, 1.2, 0)])],
});
check(
  "同一份事件重播 → accepted=0、duplicates=1（冪等鍵在真 SQLite 上生效）",
  replay.status === 200 && replay.body.accepted === 0 && replay.body.duplicates === 1,
  JSON.stringify(replay.body),
);
const afterReplay = await get(`/m/${ledId}/transcript/segments`);
check("重播後列數不變、計數不變", afterReplay.body.count === 1 && afterReplay.body.segments.length === 1);

const conflict = await post(`/m/${ledId}/transcript/stream`, {
  meetingOffsetMs: 0,
  finalize: true,
  messages: [resultsMsg([w("我們", 0, 0.6, 0), w("要開始", 0.6, 1.2, 0)])],
});
check(
  "同鍵不同內容 → conflicts=1 且附兩份全文（不得靜默覆寫）",
  conflict.status === 200 &&
    conflict.body.conflicts?.length === 1 &&
    conflict.body.conflicts[0].existing.text === "我們 開始" &&
    conflict.body.conflicts[0].incoming.text === "我們 要開始",
  JSON.stringify(conflict.body.conflicts),
);
const afterConflict = await get(`/m/${ledId}/transcript/segments`);
check(
  "衝突後列數與內容都不變（append-only）",
  afterConflict.body.count === 1 && afterConflict.body.segments[0].text === "我們 開始",
  JSON.stringify(afterConflict.body.segments),
);

const cut = await post(`/m/${ledId}/transcript/stream`, {
  meetingOffsetMs: 0,
  finalize: true,
  messages: [
    resultsMsg([w("第一句", 2, 3, 0)]),
    { type: "UtteranceEnd", channel_index: [0, 1], last_word_end: 3 },
    // 第二句刻意**同一個人**（speaker 0）且只隔 1.0 秒（< 1200ms 門檻）：
    // 這樣「切開」只能由 UtteranceEnd 造成，少了它就會被併成一段（這一格才有鑑別力）。
    resultsMsg([w("第二句", 4, 5, 0)]),
  ],
});
const cutRows = (await get(`/m/${ledId}/transcript/segments`)).body.segments;
check(
  "UtteranceEnd 真的切段 → 共 3 列，第二列起點 2000ms、speaker 0，第三列 4000ms、speaker 0",
  cut.status === 200 &&
    cutRows.length === 3 &&
    cutRows[1].startMs === 2000 &&
    cutRows[1].speakerId === 0 &&
    cutRows[2].startMs === 4000 &&
    cutRows[2].speakerId === 0,
  JSON.stringify(cutRows.map((row) => [row.seq, row.speakerId, row.startMs, row.endMs, row.text])),
);
check(
  "seq 單調配發（1,2,3）且沒有跳號",
  cutRows.map((row) => row.seq).join(",") === "1,2,3",
  JSON.stringify(cutRows.map((row) => row.seq)),
);

const badText = await post(`/m/${ledId}/transcript/segments`, {
  segments: [{ idempotencyKey: "seg:0:9000", speakerId: 0, text: "   ", startMs: 9000, endMs: 9500 }],
});
check(
  "空白內文 → 400 TRANSCRIPT_INVALID（真 workerd 也照擋）",
  badText.status === 400 && badText.body.error === "TRANSCRIPT_INVALID",
  JSON.stringify(badText.body),
);
const noOffset = await post(`/m/${ledId}/transcript/stream`, { messages: [] });
check(
  "缺 meetingOffsetMs → 400（不得默默當 0）",
  noOffset.status === 400 && noOffset.body.error === "TRANSCRIPT_INVALID",
  JSON.stringify(noOffset.body),
);
const afterBad = await get(`/m/${ledId}/transcript/segments`);
check("被擋下的請求不得寫入任何一列", afterBad.body.count === 3, `count=${afterBad.body.count}`);

const manual = await post(`/m/${ledId}/transcript/segments`, {
  idempotencyKey: "seg:2:9000",
  speakerId: 2,
  text: "人工補登的一句",
  startMs: 9000,
  endMs: 9500,
});
check(
  "另一條路徑（已分好段的句子）直接進同一本帳，seq 接續 = 4",
  manual.status === 200 && manual.body.accepted === 1 && manual.body.transcriptWrites === 4,
  JSON.stringify(manual.body),
);
const finalRead = await get(`/m/${ledId}/transcript/segments`);
check(
  "最後讀回：4 列、seq 1..4、speaker 依序 0,0,0,2",
  finalRead.body.count === 4 &&
    finalRead.body.segments.map((row) => row.seq).join(",") === "1,2,3,4" &&
    finalRead.body.segments.map((row) => row.speakerId).join(",") === "0,0,0,2",
  JSON.stringify(finalRead.body.segments.map((row) => [row.seq, row.speakerId, row.startMs, row.text])),
);
const ledSession = await get(`/m/${ledId}/session`);
check(
  "session 的 transcriptWrites 與帳本列數一致（4）",
  ledSession.body.transcriptWrites === 4,
  `transcriptWrites=${ledSession.body.transcriptWrites}`,
);

console.log("--- 9. TECH-013：分頁／增量 + 部分寫入的計數 ---");
const pageId = mid("meeting-page");
await post(`/m/${pageId}/session/start`, {});
for (let i = 0; i < 5; i += 1) {
  const written = await post(`/m/${pageId}/transcript/segments`, {
    idempotencyKey: `seg:0:${i * 1000}`,
    speakerId: 0,
    text: `第 ${i + 1} 句`,
    startMs: i * 1000,
    endMs: i * 1000 + 500,
  });
  check(
    `人工補登第 ${i + 1} 句：計數跟上（transcriptWrites=${i + 1}）`,
    written.status === 200 && written.body.transcriptWrites === i + 1,
    JSON.stringify(written.body),
  );
}
const firstPage = await get(`/m/${pageId}/transcript/segments?limit=2`);
check(
  "?limit=2 → 2 列、hasMore=true、nextSince=2、total=5",
  firstPage.body.count === 2 && firstPage.body.hasMore === true && firstPage.body.nextSince === 2 && firstPage.body.total === 5,
  JSON.stringify({
    count: firstPage.body.count,
    hasMore: firstPage.body.hasMore,
    nextSince: firstPage.body.nextSince,
    total: firstPage.body.total,
  }),
);
const secondPage = await get(`/m/${pageId}/transcript/segments?since=2&limit=2`);
check(
  "?since=2 是排他下界 → 續抓 seq 3,4（不漏不重）",
  secondPage.body.segments.map((row) => row.seq).join(",") === "3,4",
  JSON.stringify(secondPage.body.segments.map((row) => row.seq)),
);
const thirdPage = await get(`/m/${pageId}/transcript/segments?since=4`);
check(
  "續抓到最後一頁：1 列、hasMore=false、nextSince=5",
  thirdPage.body.count === 1 && thirdPage.body.hasMore === false && thirdPage.body.nextSince === 5,
  JSON.stringify(thirdPage.body),
);
const emptyPage = await get(`/m/${pageId}/transcript/segments?since=5`);
check(
  "since 超過最後一列 → 空頁（200、nextSince=null），不是 404",
  emptyPage.status === 200 && emptyPage.body.count === 0 && emptyPage.body.nextSince === null,
  JSON.stringify(emptyPage.body),
);
const badParams = [
  ["limit=0", "limit"],
  ["limit=501", "limit"],
  ["limit=1.5", "limit"],
  ["since=-1", "since"],
  ["since=abc", "since"],
  ["limit=1&limit=2", "limit"],
];
for (const [query, field] of badParams) {
  const bad = await get(`/m/${pageId}/transcript/segments?${query}`);
  check(
    `?${query} → 400 且訊息指名 ${field}`,
    bad.status === 400 && String(bad.body.message).includes(field),
    JSON.stringify(bad.body),
  );
}
const pageRows = await get(`/m/${pageId}/transcript/segments`);
const pageSession = await get(`/m/${pageId}/session`);
check(
  "讀取（含六次壞參數）不動帳本也不動計數：5 列、transcriptWrites=5",
  pageRows.body.total === 5 && pageSession.body.transcriptWrites === 5,
  `total=${pageRows.body.total} writes=${pageSession.body.transcriptWrites}`,
);
// 部分寫入：第 1 則只是餵緩衝、第 2 則切段讓第 1 段落 0~1 秒、第 3 則切段時落地的是 70 秒那段 → 落在未來時間窗。
const partialId = mid("meeting-partial");
await post(`/m/${partialId}/session/start`, {});
const partial = await post(`/m/${partialId}/transcript/stream`, {
  meetingOffsetMs: 0,
  messages: [
    resultsMsg([w("第一句", 0, 1, 0)]),
    resultsMsg([w("第二句", 70, 71, 1)]),
    resultsMsg([w("第三句", 80, 81, 0)]),
  ],
});
check("串流中途 400（第 3 則切段時落地的那段落在未來時間窗）", partial.status === 400, JSON.stringify(partial.body));
const partialRows = await get(`/m/${partialId}/transcript/segments`);
const partialSession = await get(`/m/${partialId}/session`);
check(
  "部分寫入：已落地的 1 列留著（不回滾），且 transcriptWrites 追到 1",
  partialRows.body.total === 1 && partialSession.body.transcriptWrites === 1,
  `rows=${partialRows.body.total} writes=${partialSession.body.transcriptWrites}`,
);
// 併發：兩個請求同時打。真 workerd 不保證一定交錯（單元測試才是保證），這裡是壓力測試。
const raceId = mid("meeting-race");
await post(`/m/${raceId}/session/start`, {});
const [raceA, raceB] = await Promise.all([
  post(`/m/${raceId}/transcript/segments`, {
    idempotencyKey: "seg:0:0",
    speakerId: 0,
    text: "同時 A",
    startMs: 0,
    endMs: 1000,
  }),
  post(`/m/${raceId}/transcript/segments`, {
    idempotencyKey: "seg:0:1",
    speakerId: 0,
    text: "同時 B",
    startMs: 0,
    endMs: 1000,
  }),
]);
const raceRows = await get(`/m/${raceId}/transcript/segments`);
const raceSession = await get(`/m/${raceId}/session`);
check(
  "同時兩筆：兩列都在（帳本 2）且計數＝2，不得少算",
  raceA.status === 200 &&
    raceB.status === 200 &&
    raceRows.body.total === 2 &&
    raceRows.body.segments.map((row) => row.seq).join(",") === "1,2" &&
    raceSession.body.transcriptWrites === 2,
  JSON.stringify({
    a: raceA.body.transcriptWrites,
    b: raceB.body.transcriptWrites,
    total: raceRows.body.total,
    writes: raceSession.body.transcriptWrites,
  }),
);

console.log(`\nDO smoke：${failures === 0 ? "全部通過 ✅" : `${failures} 項失敗 ❌`}`);
process.exit(failures === 0 ? 0 : 1);