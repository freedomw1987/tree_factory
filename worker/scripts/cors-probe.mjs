#!/usr/bin/env node
// TECH-010：把「webview 實測 CORS」的手動流程腳本化。
//
// 為什麼需要：TECH-006 把「webview 實際送來的 Origin」變成可觀測（`DEBUG_ORIGINS=1`
// + `[cors] origin=… allowed=…` log），但驗證流程還是「開 wrangler → 開 app/webview →
// 看 log → 手抄」。同一個 worker、同一個 Origin，只要換一個埠（dev server 漂移）
// 結果就不同，而這件事前端只表現成 `Failed to fetch`。
//
// 這支腳本做的是**wire 層**的重播：對同一個 worker 依序送 OPTIONS（preflight）
// 與 POST（真的請求），把 status、`access-control-allow-origin`、
// 以及 TECH-010 的 `x-cors-allowed` 一起印出來。
//
// 誠實範圍：腳本取代的是「用 curl 重播請求」這段；**真的 webview（Tauri / iOS WKWebView）
// 仍然要人跑**——腳本無法代替 webview 的 scheme 差異（那種差異正是 TECH-006 的產物）。
//
// 用法：
//   node scripts/cors-probe.mjs --base http://127.0.0.1:8787
//   node scripts/cors-probe.mjs --base http://127.0.0.1:8787 --origin tauri://localhost --origin http://localhost:1421
//   node scripts/cors-probe.mjs --json
//
// 離開碼：0 = 所有來源都「allowed=true」（可安心進 webview 實測）；
//         1 = 至少一個來源被擋（＝埠漂移現場，先修 ALLOWED_ORIGINS）；
//         2 = 打不到 worker（先確認 wrangler 有起來、埠對不對）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE,
  devOrigins,
  exitCodeFor,
  hint,
  parseArgs,
  resolveOrigins,
  verdict,
} from "./cors-probe-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.error !== null) {
  console.error(args.error);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const parsed = devOrigins(readFileSync(join(here, "..", "src", "cors.ts"), "utf8"));
const { origins, error: listError } = resolveOrigins(args.origins, parsed);
if (listError !== null) {
  console.error(listError);
  process.exit(2);
}
const { base, meeting, token, json } = args;

/**
 * TECH-009：`/m/**` 之後一律要裝置憑證，沒帶就是 401。
 * 這裡只有在給了 `--token` 時才加標頭——探測的目標是 CORS 政策，
 * 不該因為「剛好有憑證」而讓 preflight 的判讀改變（`verdict()` 只看 preflight）。
 */
function authHeaders(token) {
  return token === "" ? {} : { authorization: `Bearer ${token}` };
}

async function probe(base, meeting, origin) {
  const url = `${base}/m/${meeting}/session/start`;
  const row = { origin, preflight: null, post: null, error: null };
  try {
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    row.preflight = {
      status: preflight.status,
      allowOrigin: preflight.headers.get("access-control-allow-origin"),
      allowed: preflight.headers.get("x-cors-allowed"),
      seenOrigin: preflight.headers.get("x-cors-origin"),
    };
    const post = await fetch(url, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-meeting-id": meeting, ...authHeaders(token) },
      body: JSON.stringify({ meetingId: meeting }),
    });
    row.post = {
      status: post.status,
      allowOrigin: post.headers.get("access-control-allow-origin"),
      allowed: post.headers.get("x-cors-allowed"),
    };
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  return row;
}

const rows = [];
for (const origin of origins) {
  rows.push(await probe(base, meeting, origin));
}

if (json) {
  console.log(JSON.stringify({ base, meeting, rows: rows.map((r) => ({ ...r, verdict: verdict(r) })) }, null, 2));
} else {
  console.log(`cors-probe → ${base}（meeting=${meeting}）`);
  for (const row of rows) {
    if (row.error !== null) {
      console.log(`  ✗ ${row.origin}：打不到 worker（${row.error}）`);
      continue;
    }
    const mark = verdict(row).startsWith("allowed") ? "✅" : "⛔";
    console.log(
      `  ${mark} ${row.origin}：preflight ${row.preflight.status}` +
        ` allow-origin=${row.preflight.allowOrigin ?? "(無)"}` +
        ` x-cors-allowed=${row.preflight.allowed ?? "(未開旗標)"}` +
        `｜POST ${row.post.status} allow-origin=${row.post.allowOrigin ?? "(無)"}` +
        ` → ${verdict(row)}`,
    );
  }
  if (token === "") {
    console.log(
      "註：沒帶 --token，所以 POST 會是 401 AUTH_INVALID（TECH-009 之後 fail-closed）——" +
        "這不是 CORS 壞了；要看 POST 真的通請加 --token <DEVICE_TOKEN>。",
    );
  }
  console.log(hint(rows));
}

process.exit(exitCodeFor(rows));