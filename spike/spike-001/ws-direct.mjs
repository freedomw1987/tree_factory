/**
 * SPIKE-001 第二段：直接對 Workers AI 的 streaming WebSocket 端點送音，
 * 驗證 `diarize=true` 在「串流模式」是否同樣有效（產品正式路徑是串流）。
 *
 * 為什麼不用 wrangler dev：本機 dev 的 AI binding 需要 workers.dev 子網域才能走遠端，
 * 那會動到帳號設定；直接對 REST/WS API 下請求可避開帳號變更。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ACCT = process.env.CF_ACCOUNT_ID || "989bd6bed8ac2b33221a5fbc76798be1";
const token = process.env.CF_TOKEN || execSync(
  "python3 -c \"import io,os,re;s=io.open(os.path.expanduser('~/Library/Preferences/.wrangler/config/default.toml'),encoding='utf-8').read();print(re.search(r'^oauth_token\\s*=\\s*\\\"([^\\\"]+)\\\"',s,re.M).group(1))\"",
).toString().trim();

const diarize = process.argv[2] !== "0";
const params = new URLSearchParams({
  encoding: "linear16",
  sample_rate: "16000",
  language: "en",
  interim_results: "true",
  vad_events: "true",
  endpointing: "300",
  utterance_end_ms: "1000",
  smart_format: "true",
  punctuate: "true",
  ...(diarize ? { diarize: "true" } : {}),
  // 產品需要「一句話一個段落」的結構：paragraphs / utterances 讓上游直接給出 speaker 分段
  paragraphs: "true",
  utterances: "true",
});
const url = `wss://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run/@cf/deepgram/nova-3?${params}`;

const FIXTURE = process.argv[3] || "spike/fixtures/two-speakers-16k.wav";
const wav = readFileSync(resolve(ROOT, FIXTURE));
const i = wav.indexOf("data", 12, "latin1");
const pcm = wav.subarray(i + 8, i + 8 + wav.readUInt32LE(i + 4));
const CHUNK = 3200;
const messages = [];
const t0 = Date.now();

let ws;
try {
  ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
} catch (e) {
  ws = new WebSocket(url); // 若 undici 不支援 headers，改用子協定以外的退路（會拿到 401 並記錄）
  ws.addEventListener("open", () => ws.send(JSON.stringify({ __note: "headers 未生效" })));
}

await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("WS 連線逾時 15s（可能被 401 擋下）")), 15000);
  ws.addEventListener("open", () => { clearTimeout(to); res(); });
  ws.addEventListener("error", (e) => { clearTimeout(to); rej(new Error("WS error: " + (e.message || e.type))); });
});
console.log(`[ws-direct] 已連上（diarize=${diarize}），開始送 ${(pcm.length / 32000).toFixed(2)} 秒音訊`);

ws.addEventListener("message", (ev) => {
  const s = typeof ev.data === "string" ? ev.data : "[binary]";
  try { messages.push(JSON.parse(s)); } catch { messages.push({ __raw: String(s).slice(0, 300) }); }
});

for (let off = 0; off < pcm.length; off += CHUNK) {
  ws.send(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  await new Promise((r) => setTimeout(r, 15));
}
ws.send(JSON.stringify({ type: "CloseStream" }));
console.log(`[ws-direct] 音訊送完 ${Date.now() - t0}ms，等結果…`);

await new Promise((res) => {
  const deadline = Date.now() + 25000;
  const tick = setInterval(() => {
    if (Date.now() > deadline || ws.readyState === 2 /* CLOSING */ || ws.readyState === 3) { clearInterval(tick); res(); }
  }, 200);
});
try { ws.close(); } catch {}

const results = messages.filter((m) => m && m.type === "Results");
const allWords = results.flatMap((m) => m.channel?.alternatives?.[0]?.words || []);
const speakers = [...new Set(allWords.map((w) => w.speaker).filter((v) => v !== undefined && v !== null))];
const finals = results.filter((m) => m.is_final);
const transcript = finals.map((m) => m.channel?.alternatives?.[0]?.transcript || "").join(" ").replace(/\s+/g, " ").trim();
const paras = results.flatMap((m) => m.channel?.alternatives?.[0]?.paragraphs?.paragraphs || []).map((p) => ({
  speaker: p.speaker, start: p.start, end: p.end, text: (p.sentences || []).map((s) => s.text).join(" "),
}));

const summary = {
  endpoint: "wss://api.cloudflare.com/client/v4/accounts/<acct>/ai/run/@cf/deepgram/nova-3",
  fixture: FIXTURE,
  diarizeRequested: diarize,
  totalMessages: messages.length,
  resultsMessages: results.length,
  finalMessages: finals.length,
  wordCount: allWords.length,
  speakerValuesSeen: speakers,
  wordSample: allWords.slice(0, 5).map((w) => ({ w: w.punctuated_word || w.word, speaker: w.speaker, start: w.start })),
  paragraphs: paras.slice(0, 6),
  transcript,
  nonResultsTypes: [...new Set(messages.map((m) => m?.type).filter((t) => t && t !== "Results"))],
  errors: messages.filter((m) => m?.__spike_error || m?.err_code || m?.error || m?.__raw),
};
mkdirSync(resolve(ROOT, "spike/results"), { recursive: true });
const tag = (process.argv[3] ? "stress-" : "") + (diarize ? "diarize" : "plain");
const out = resolve(ROOT, `spike/results/spike-001-ws-${tag}.json`);
writeFileSync(out, JSON.stringify({ summary, messages }, null, 2));
console.log("\n===== 串流摘要 =====");
console.log(JSON.stringify(summary, null, 2).slice(0, 2000));
console.log("\n完整訊息 → " + out);
