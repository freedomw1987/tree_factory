import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import Icon from "./Icon.svelte";

/** DESIGN.md §5 元件表的 `Icon` 規格：24 viewBox / `stroke="currentColor"` / stroke-width 1.75 / fill none。 */
describe("Icon 元件", () => {
  it("符合 DESIGN §5 的線性圖示規格", () => {
    const { body } = render(Icon, { props: { name: "chat" } });
    expect(body).toContain('viewBox="0 0 24 24"');
    expect(body).toContain('stroke="currentColor"');
    expect(body).toContain('stroke-width="1.75"');
    expect(body).toContain('fill="none"');
  });

  it("預設 18pt、空狀態可放大到 38pt（尺寸由呼叫端決定）", () => {
    expect(render(Icon, { props: { name: "mic" } }).body).toContain('width="18"');
    expect(render(Icon, { props: { name: "mic", size: 38 } }).body).toContain('width="38"');
  });

  it("純裝飾時對輔助科技隱藏；有意義時提供 aria-label", () => {
    const decorative = render(Icon, { props: { name: "ban" } }).body;
    expect(decorative).toContain('aria-hidden="true"');

    const meaningful = render(Icon, { props: { name: "mic", label: "會議正在錄音" } }).body;
    expect(meaningful).toContain('role="img"');
    expect(meaningful).toContain('aria-label="會議正在錄音"');
    expect(meaningful).not.toContain('aria-hidden="true"');
  });

  it("非自有鍵不得從 prototype chain 取值（name 是外部值時也不失控）", () => {
    const body = render(Icon, { props: { name: "toString" as never } }).body;
    expect(body).not.toContain("native code");
    expect(body).not.toContain("function");
  });

  it("不存在的 name 不得注入 HTML，也不畫出任何圖形（沒有 XSS 路徑）", () => {
    const body = render(Icon, { props: { name: '<img src=x onerror="alert(1)">' as never } }).body;
    expect(body).not.toContain("<img");
    expect(body).not.toMatch(/<path|<circle|<rect/);
  });

  it("帶得出可辨識的測試鉤子（E2E 用）與圖形內容", () => {
    const { body } = render(Icon, { props: { name: "chat" } });
    expect(body).toContain('data-testid="icon-chat"');
    expect(body).toMatch(/<path\b/);
  });
});
