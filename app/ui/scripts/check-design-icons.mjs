#!/usr/bin/env node
/**
 * DESIGN.md §5 規則 8「圖示一律用 inline SVG，不得用 emoji」的**全檔守門**（純 node，零依賴）。
 *
 * 為什麼不能只靠 vitest 那支（`src/lib/ui/icon.test.ts`）：
 *   Vite 的 `?raw` / `?inline` 讀 `.css` 都回**空字串**（實測 len 0），所以 `.css` 掃不到 ——
 *   而 CSS 正是 emoji 最陰的落點（`content:"..."`）。這裡直接讀檔，沒有這個盲點：
 *   掃 `app/ui/src/**`（**任何**副檔名）+ `index.html`。
 *
 * 另外補一條 DESIGN 明文要求、但 vitest 沒有的守門：**原型 ↔ app 同源**。
 *   `icons.ts` 的圖形指令必須與 `docs/prd/01-listen.html` 的 `IP` 對照表逐字元相同，
 *   兩邊任一側被改動都要亮燈（條款：「規則要有會失敗的測試才算規則」）。
 *
 * 用 `npm run check:icons` 單獨跑；也掛在 `npm test` 與 `npm run lint` 裡。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(HERE, "..");
const REPO_ROOT = join(UI_ROOT, "..", "..");
const PROTO_PATH = join(REPO_ROOT, "docs/prd/01-listen.html");
const ICONS_TS = join(UI_ROOT, "src", "lib", "ui", "icons.ts");
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);

/** 與 `src/lib/ui/emoji.ts` 同義（改那邊要同步改這裡；emoji.ts 有測試守著它）。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\u{FE0F}?/u;
const QUOTES = new Set(['"', "'", "`"]);

const keepNewlines = (text) => "\n".repeat(text.split("\n").length - 1);

function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += keepNewlines(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "<" && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? text.length : end + 3;
      out += keepNewlines(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (QUOTES.has(c)) {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i] ?? "";
        const done = text[i] === quote;
        i += 1;
        if (done) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 遞迴收集檔案（跳過 node_modules / dist）。 */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/** 從 `const <name>={...}` / `export const <name> = {...}` 抓出 `key:'...'` 對照表。 */
function parseMap(text, name) {
  const at = text.indexOf(`const ${name}`);
  if (at === -1) return {};
  const open = text.indexOf("{", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = text.slice(open + 1, close);
  const map = {};
  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)) {
    map[match[1]] = match[2];
  }
  return map;
}

const files = [...walk(join(UI_ROOT, "src")), join(UI_ROOT, "index.html")];
const problems = [];

// 1) 產品程式碼（任何副檔名，含 .css）不得出現 emoji
for (const file of files) {
  const clean = stripComments(readFileSync(file, "utf8"));
  const hit = clean.match(EMOJI);
  if (hit) {
    const line = clean.slice(0, hit.index).split("\n").length;
    problems.push(`emoji：${relative(UI_ROOT, file)}:${line} 出現 ${hit[0]}`);
  }
}

// 2) 圖示表必須與原型同源（逐字元）
const proto = parseMap(readFileSync(PROTO_PATH, "utf8"), "IP");
const app = parseMap(readFileSync(ICONS_TS, "utf8"), "ICON_PATHS");
for (const [key, shape] of Object.entries(app)) {
  if (!(key in proto)) problems.push(`同源：icons.ts 的 ${key} 在原型 IP 表找不到`);
  else if (proto[key] !== shape) {
    problems.push(`同源：${key} 與原型不同\n    app  : ${shape}\n    proto: ${proto[key]}`);
  }
}

// 3) 程式碼裡用到的圖示，兩張表都要有
const used = new Set();
for (const file of files) {
  if (!file.endsWith(".svelte")) continue;
  for (const match of readFileSync(file, "utf8").matchAll(/<Icon\b[^>]*\bname="([^"]+)"/g)) {
    used.add(match[1]);
  }
}
for (const key of used) {
  if (!(key in app)) problems.push(`用到：<Icon name="${key}"> 不在 icons.ts`);
  else if (!(key in proto)) problems.push(`用到：<Icon name="${key}"> 不在原型 IP 表`);
}

console.log(
  `掃描 ${files.length} 檔 · 圖示表 ${Object.keys(app).length} 個（原型 ${Object.keys(proto).length} 個）· 程式碼用到 ${used.size} 個：${[...used].join(", ")}`,
);

if (problems.length > 0) {
  console.error(`\n設計圖示守門 FAIL（${problems.length} 項）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\n修法：圖示一律用 <Icon name=\"...\">（DESIGN.md §5 規則 8），圖形取自原型 IP 表。");
  process.exit(1);
}

console.log("守門 PASS：產品程式碼無 emoji；圖示與 docs/prd/01-listen.html 逐字元同源。");
