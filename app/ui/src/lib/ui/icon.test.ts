import { describe, expect, it } from "vitest";

import { findEmoji } from "./emoji";
import { ICON_PATHS } from "./icons";

/**
 * DESIGN.md §5 規則 8「圖示一律用 inline SVG，不得用 emoji 當圖示」的**靜態守門**。
 *
 * 為什麼需要這支測試：規則 v2.2（2026-10-07）就立了，PRD 原型也改了 100+ 處，
 * 但 `app/ui` 的實作漏做，直到 2026-10-09 真機驗收才被用戶發現（TECH-011）。
 * 人眼複查會再漏，所以規則要有**會失敗的測試**。
 *
 * 用 Vite 的 `?raw`（不是 `node:fs`）讀原始碼：`tsconfig.json` 沒有 node types。
 * ⚠️ 這個手法的**已知盲點**：`?raw` 讀 `.css` 回空字串（實測 `?raw`／`?inline` 皆 len 0），
 * 所以 `.css` 由 `scripts/check-design-icons.mjs`（node 腳本）負責掃 —— 兩者互補。
 * 去註解的邏輯在 `emoji.ts`（自己有測試：`emoji.test.ts`）。
 */
const SVELTE_SOURCES = import.meta.glob("../../**/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TS_SOURCES = import.meta.glob("../../**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const INDEX_HTML = import.meta.glob("../../../index.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 找出所有「程式碼裡」的 emoji（檔名: emoji）。 */
function findEmojiInSources(): string[] {
  const offenders: string[] = [];
  for (const [path, raw] of [
    ...Object.entries(SVELTE_SOURCES),
    ...Object.entries(TS_SOURCES),
    ...Object.entries(INDEX_HTML),
  ]) {
    const hit = findEmoji(raw);
    if (hit) offenders.push(`${path}: ${hit}`);
  }
  return offenders;
}

describe("圖示規則（DESIGN.md §5 規則 8）", () => {
  it("掃描範圍真的涵蓋 UI 原始碼（先守住測試自己，避免 glob 失效造成假通過）", () => {
    expect(Object.keys(SVELTE_SOURCES).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(TS_SOURCES).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(INDEX_HTML)).toHaveLength(1);
  });

  it("UI 原始碼（去掉註解後）不得出現 emoji 當圖示", () => {
    expect(findEmojiInSources()).toEqual([]);
  });

  it('每一處 <Icon name="..."> 的名字都在圖示表內（打錯字會失敗）', () => {
    const used = new Set<string>();
    for (const raw of Object.values(SVELTE_SOURCES)) {
      for (const match of raw.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g)) {
        const iconName = match[1];
        if (iconName) used.add(iconName);
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(3);
    const unknown = [...used].filter((name) => !(name in ICON_PATHS));
    expect(unknown).toEqual([]);
  });

  it("圖示表本身是線性 path（不是 emoji、不是點陣圖）", () => {
    const names = Object.keys(ICON_PATHS);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const [name, shape] of Object.entries(ICON_PATHS)) {
      expect(shape, `${name} 必須是 SVG 圖形指令`).toMatch(/^<(path|circle|rect)/);
      expect(findEmoji(shape), `${name} 不得含 emoji`).toBeNull();
      expect(shape, `${name} 不得自帶顏色（顏色由父層 currentColor 決定）`).not.toMatch(
        /stroke="(?!none)|fill="(?!none)/,
      );
    }
  });
});
