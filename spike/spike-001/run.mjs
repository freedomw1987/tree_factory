import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SPIKE-001 實驗腳本：把 16kHz mono PCM16 音檔餵給 Workers AI 的 `@cf/deepgram/nova-3`
 * （經由本地 `wrangler dev` 的 WebSocket 中繼），比較 `diarize` 開 / 關時的回傳訊息。
 *
 * 用法:
 *   node run.mjs plain      # 基準組：不加 diarize
 *   node run.mjs diarize    # 實驗組：diarize=true
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const WAV = resolve(ROOT, "spike/fixtures/two-speakers-16k.wav");
const OUT = resolve(ROOT, "spike/results");
const BASE = process.env.SPIKE_URL || "ws://127.0.0.1:8787";
const CHUNK = 3200; // 100ms @ 16kHz mono PCM16
const PACE_MS = 20; // 5 倍速送音（比實時快，但仍讓上游有處理時間）

const mode = process.argv[2] || "plain";
const diarize = mode === "diarize";
const t0 = Date.now();
const messages = [];
const sendTrace = [];

function wavPayload() {
  const buf = readFileSync(WAV);
  const i = buf.indexOf("data", 12, "latin1");
  const size = buf.readUInt32LE(i + 4);
  return buf.subarray(i + 8, i + 8 + size);
}

function summarize(messages) {
  const results = messages.filter((m) => m && m.type === "Results");
  const finals = results.filter((m) => m.is_final);
  const words = results.flatMap((m) => m.channel?.alternatives?.[0]?.words || []);
  const speakers = new Set();
  for (const w of words) {
    if (w.speaker !== undefined && w.speaker !== null) speakers.add(w.speaker);
    if (w.speaker_label) speakers.add(w.speaker_label);
  }
  const transcript = finals
    .map((m) => m.channel?.alternatives?.[0]?.transcript || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    totalMessages: messages.length,
    resultsMessages: results.length,
    finalMessages: finals.length,
    wordCount: words.length,
    wordSample: words.slice(0, 4).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      speaker: w.speaker,
      speaker_label: w.speaker_label,
      punctuated_word: w.punctuated_word,
    })),
    speakerValuesSeen: [...speakers],
    transcript,
    messageTypes: [...new Set(messages.map((m) => m?.type).filter(Boolean))],
    errors: messages.filter((m) => m?.__spike_error || m?.__upstream_error || m?.__upstream_close),
  };
}

const payload = wavPayload();
console.log(
  `[spike-001] mode=${mode} diarize=${diarize} 音檔 ${(payload.length / 32000).toFixed(2)} 秒 → ${BASE}/ws`,
);

const ws = new WebSocket(`${BASE}/ws?diarize=${diarize ? 1 : 0}`);

await new Promise((res, rej) => {
  const timeout = setTimeout(() => rej(new Error("連線逾時 10s")), 10000);
  ws.addEventListener("open", () => {
    clearTimeout(timeout);
    res();
  });
  ws.addEventListener("error", (e) => {
    clearTimeout(timeout);
    rej(new Error("WS error: " + (e.message || "unknown")));
  });
});
console.log("[spike-001] 已連上中繼 worker，開始送音…");

ws.addEventListener("message", (ev) => {
  if (typeof ev.data !== "string") return;
  try {
    messages.push(JSON.parse(ev.data));
  } catch {
    messages.push({ __raw: String(ev.data).slice(0, 200) });
  }
});
ws.addEventListener("close", (ev) => {
  console.log(`[spike-001] 上游關閉 code=${ev.code} reason=${ev.reason}`);
});

for (let off = 0; off < payload.length; off += CHUNK) {
  ws.send(payload.subarray(off, Math.min(off + CHUNK, payload.length)));
  if (sendTrace.length < 4) sendTrace.push({ atMs: Date.now() - t0, bytes: CHUNK });
  await new Promise((r) => setTimeout(r, PACE_MS));
}
console.log(`[spike-001] 音訊送完（${Date.now() - t0} ms），送 CloseStream`);
ws.send(JSON.stringify({ type: "CloseStream" }));

// 等上游把最終結果吐完（或 20 秒逾時）
await new Promise((res) => {
  const deadline = Date.now() + 20000;
  const tick = setInterval(() => {
    if (Date.now() > deadline || ws.readyState === WebSocket.CLOSED) {
      clearInterval(tick);
      res();
    }
  }, 250);
});
try {
  ws.close();
} catch {}

const summary = summarize(messages);
mkdirSync(OUT, { recursive: true });
const file = `${OUT}/spike-001-${mode}.json`;
writeFileSync(file, JSON.stringify({ mode, diarize, base: BASE, fixture: WAV, elapsedMs: Date.now() - t0, summary, messages }, null, 2));

console.log("\n===== 摘要 (" + mode + ") =====");
console.log(JSON.stringify(summary, null, 2).slice(0, 1800));
console.log("\n完整訊息 → " + file);
