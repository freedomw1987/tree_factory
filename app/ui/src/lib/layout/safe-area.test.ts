// M01 真機驗收修復：iPhone 瀏海／狀態列與 Home Indicator 造成的兩個「按不到」。
//
// 為什麼要有這個測試：`index.html` 用了 `viewport-fit=cover`，webview 的內容會
// 延伸到系統 UI（狀態列、Home Indicator）底下。桌機瀏覽器沒有這些東西，Chromium
// 的 E2E 跑再多次都不會發現；只有真機（iPhone 12 mini，2026-10-09 實測）才暴露：
//
//   1. 「開始會議」落在 y=16~60，被約 50pt 高的狀態列蓋住 → 「按不到開始會議 button」
//   2. 「長按結束會議」落在 y=794~810，整顆在 34pt 的底部手勢區裡 → 「結束會議按不到」
//
// 這裡用「原始碼不變式檢查」而不是渲染量測：純 CSS 版面在 node 環境量不到，
// 但真正要守的規則很單純——**既然選了 viewport-fit=cover，就必須自己讓開上下兩邊；
// 而且視窗高度只有 App 外框能決定**。幾何的部分交給 Playwright（見
// `e2e/iphone-viewport.spec.ts`，它會注入 iPhone 的安全區數值）。
import { describe, expect, it } from "vitest";
import indexHtml from "../../../index.html?raw";

// ⚠️ 掃描範圍只有 .svelte 與 index.html：vite 的 `?raw` 讀 .css 會拿到空字串（空值
// 會讓「只能定義一次」這條規則假通過），所以安全區的定義放在 index.html。
const rawSources = import.meta.glob("../../**/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 去掉註解再做字串檢查，否則說明用的文字（例如「用 100dvh 會溢出」）會變成假警報。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
}

const sources: Array<{ path: string; text: string }> = [
  ...Object.entries(rawSources).map(([path, text]) => ({ path, text: stripComments(text) })),
  { path: "index.html", text: stripComments(indexHtml) },
];

describe("M01 真機可見性：瀏海／狀態列留白（viewport-fit=cover 的義務）", () => {
  it("index.html 仍設定 viewport-fit=cover（若改掉，本測試的前提要一起重評）", () => {
    const html = sources.find((s) => s.path === "index.html");
    expect(html?.text).toContain("viewport-fit=cover");
  });

  it("頂端必須讓開 safe-area-inset-top（否則最上面的按鈕會被狀態列吃掉）", () => {
    const hits = sources.filter((s) => s.text.includes("env(safe-area-inset-top"));
    expect(hits.map((h) => h.path), "沒有任何樣式使用 env(safe-area-inset-top)").not.toEqual([]);
  });

  it("底端必須讓開 safe-area-inset-bottom（Home Indicator）", () => {
    const hits = sources.filter((s) => s.text.includes("env(safe-area-inset-bottom"));
    expect(hits.map((h) => h.path), "沒有任何樣式使用 env(safe-area-inset-bottom)").not.toEqual([]);
  });

  it("安全區只能在 index.html 定義一次，畫面樣式用變數（E2E 才能注入假值重現真機）", () => {
    expect(sources.find((s) => s.path === "index.html")?.text, "index.html 應該定義 --safe-top / --safe-bottom")
      .toContain("--safe-top: env(safe-area-inset-top");
    const offenders = sources
      .filter((s) => s.path !== "index.html" && s.text.includes("env(safe-area-inset-"))
      .map((s) => s.path);
    expect(offenders, "請改用 var(--safe-top) / var(--safe-bottom)").toEqual([]);
  });
});

// 真機驗收第二課（2026-10-09，同一天）：修好瀏海之後，使用者回報「結束會議 button
// 按不到」。原因是 `MeetingScreen` 的 `.meeting` 用了 `min-height: 100dvh`，但它被
// 放在**已經有頂部留白的外框 `.shell` 裡**，於是畫面硬是比視窗再高出一截，最後的
// 「長按結束會議」被推到畫面最底端。桌機底部安全區 = 0，按鈕只差 32px 還能按；
// iPhone 12 mini 底部有 34pt 的 Home Indicator 手勢區，按鈕整顆落在裡面 →
// 手指按住時事件被系統手勢吃掉。
//
// 規則：**視窗高度只有 App 外框可以決定**（`#app` / `.shell`），子畫面填滿父容器就好。
describe("M01 真機可見性：子畫面不得自己拿視窗高度", () => {
  it("src/screens/ 底下不得使用 vh/dvh/svh/lvh 視窗單位", () => {
    const offenders = sources
      .filter((s) => s.path.includes("/screens/") && /\d(vh|dvh|svh|lvh)\b/.test(s.text))
      .map((s) => s.path);
    expect(offenders, "畫面元件自己用視窗高度會溢出父容器底部的 padding（真機按鈕被推去手勢區）").toEqual([]);
  });
});


// TECH-007（橫向）：肖像時瀏海在上下，轉橫之後換到**左右**。規則跟上下完全一樣：
// 安全區變數只能有一個宣告處（index.html），元件只能用 `var()`。追加這一組的理由是
// 「宣告了卻沒有人用」——那樣橫向的內容照樣壓在瀏海底下，而且 E2E 注入的假安全區
// （`--safe-left` / `--safe-right`）會完全沒有效果，那些斷言就變成假的。
describe("TECH-007 橫向安全區：瀏海在左右（viewport-fit=cover 的第二邊）", () => {
  it("index.html 也必須宣告左右安全區（只宣告上下，橫向就沒有留白）", () => {
    const html = sources.find((s) => s.path === "index.html");
    expect(html?.text, "index.html 應該定義 --safe-left").toContain("--safe-left: env(safe-area-inset-left");
    expect(html?.text, "index.html 應該定義 --safe-right").toContain("--safe-right: env(safe-area-inset-right");
  });

  it("左右安全區的 fallback 必須是 0px（少了它，不支援 env() 的環境會整排歪掉）", () => {
    const html = sources.find((s) => s.path === "index.html");
    expect(html?.text).toContain("--safe-left: env(safe-area-inset-left, 0px)");
    expect(html?.text).toContain("--safe-right: env(safe-area-inset-right, 0px)");
  });

  it("index.html 的左右安全區宣告各只能有一次（重複宣告會蓋掉前一個）", () => {
    const html = sources.find((s) => s.path === "index.html");
    const text = html?.text ?? "";
    expect(text.match(/--safe-left\s*:/g)?.length ?? 0, "index.html 重複宣告 --safe-left").toBe(1);
    expect(text.match(/--safe-right\s*:/g)?.length ?? 0, "index.html 重複宣告 --safe-right").toBe(1);
  });

  it("App.svelte 必須真的用 var(--safe-left) / var(--safe-right)（宣告了沒用等於沒宣告）", () => {
    const app = sources.find((s) => s.path.endsWith("/App.svelte"));
    expect(app, "找不到 App.svelte 的原始碼").toBeDefined();
    expect(app!.text, "外框沒有讓開左安全區").toContain("var(--safe-left)");
    expect(app!.text, "外框沒有讓開右安全區").toContain("var(--safe-right)");
  });
});
