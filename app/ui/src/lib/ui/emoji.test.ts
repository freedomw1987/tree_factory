import { describe, expect, it } from "vitest";

import { findEmoji, stripComments } from "./emoji";

/**
 * 守門自己也要被測試（DESIGN.md §5 規則 8 的「實作強制條款」）。
 *
 * 為什麼：Gate 4 checker（TECH-011 第 1 輪）指出 `stripComments` 用正則粗刪 `//`
 * 會把「同一行裡 `//` 之後的程式碼」也當成註解刪掉 → emoji 從守門底下溜過去。
 * 一個會漏的守門等於沒有守門，所以把去註解的邏輯抽成模組並把陷阱寫成測試。
 *
 * ⚠️ 本檔刻意用**碼位**（`\u{1F600}` 這種寫法）而不是直接打 emoji：
 * `icon.test.ts` 的守門連測試檔也掃（`src/**` 任何 emoji 字面值都算違規），
 * 這裡若直接打 emoji，規則就會被自己的測試打破。
 */
const SMILE = "\u{1F600}"; // 笑臉
const SPEECH = "\u{1F4AC}"; // 對話框
const MEMO = "\u{1F4DD}"; // 便條
const MIC = "\u{1F399}\u{FE0F}"; // 麥克風（含變體選擇符）
const FIRE = "\u{1F525}"; // 火

describe("stripComments（註解剝除）", () => {
  it("整行 // 註解要移除（註解裡的 emoji 不算違規）", () => {
    expect(stripComments("// 這裡說明為什麼不能用 emoji\nconst a = 1;")).not.toContain("emoji");
  });

  it("行尾 // 註解要移除", () => {
    expect(stripComments("const a = 1; // 備註：圖示用 Icon")).not.toContain("備註");
  });

  it("**陷阱**：字串裡的 // 不能吃掉後面的程式碼", () => {
    const code = `const u = "https://example.com"; const a = "${SMILE}";`;
    expect(stripComments(code)).toContain(SMILE);
  });

  it('**陷阱**：`"x//"` 這種字串不能讓整行後半消失', () => {
    const code = `const a = "x//" + "${SMILE}";`;
    expect(stripComments(code)).toContain(SMILE);
    expect(findEmoji(code)).toBe(SMILE);
  });

  it("**陷阱**：文字裡單獨一個引號（don't）不能吃掉後面的 emoji", () => {
    expect(findEmoji(`<p>don't use ${FIRE} here</p>`)).toBe(FIRE);
    expect(findEmoji(`<p class="a">${SPEECH}</p>`)).toBe(SPEECH);
  });

  it("區塊註解與 HTML 註解要移除（emoji 出現在裡面不算違規）", () => {
    expect(findEmoji(`/* 舊版用 ${MIC} 當圖示 */ const a = 1;`)).toBeNull();
    expect(findEmoji(`<!-- 舊版用 ${MIC} 當圖示 --> <p>hi</p>`)).toBeNull();
  });

  it("去註解後行號不跑掉（跨行註解要保留換行，掃描器才報得準）", () => {
    const src = `/* 第一行\n第二行\n第三行 */\nconst a = 1;\n`;
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });
});

describe("findEmoji（emoji 偵測）", () => {
  it("抓到產品程式碼裡的 emoji", () => {
    expect(findEmoji(`<p class="big">${SPEECH}</p>`)).toBe(SPEECH);
    expect(findEmoji(`<span aria-hidden="true">${MEMO}</span>`)).toBe(MEMO);
    expect(findEmoji(`<p class="big" aria-hidden="true">${MIC}</p>`)).toBe(MIC);
    expect(findEmoji(`.icon::after { content: "${FIRE}"; }`)).toBe(FIRE);
  });

  it("變體選擇符要連在一起回報（麥克風符號不能只回報半個）", () => {
    const got = findEmoji(MIC) ?? "";
    expect(got).toBe(MIC);
    expect([...got].length).toBe(2); // 基礎符號 + 變體選擇符 = 2 個碼位
  });

  it("排版符號不算 emoji（箭頭、圈號是正常文案與註解用字）", () => {
    expect(findEmoji("把 A → B 的流程畫出來（① 先做 X）")).toBeNull();
    expect(findEmoji('const arrows = "← ↑ → ↓";')).toBeNull();
  });

  it("乾淨的程式碼不誤報", () => {
    expect(findEmoji('<svg viewBox="0 0 24 24" stroke="currentColor"></svg>')).toBeNull();
  });
});
