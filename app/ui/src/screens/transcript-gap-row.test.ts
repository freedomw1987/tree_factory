import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import TranscriptGapRow from "./TranscriptGapRow.svelte";

/** M01-US-107 AC-2 / AC-3：逐字稿的缺口列（元件層）。 */
describe("M01-US-107 TranscriptGapRow", () => {
  it("M01-Given 未閉合的缺口 When 渲染 Then 說出中斷起點與「結束時間未知」", () => {
    const { body } = render(TranscriptGapRow, {
      props: { gap: { seq: 3, fromMs: 63_000, toMs: null, synced: true } },
    });
    expect(body).toContain('data-testid="transcript-gap"');
    expect(body).toContain('data-gap-seq="3"');
    expect(body).toContain('data-gap-open="true"');
    expect(body).toContain("此段未錄到（從 01:03 起中斷，結束時間未知）");
  });

  it("M01-Given 已閉合的缺口 When 渲染 Then 寫出範圍與長度，且不再是 open", () => {
    const { body } = render(TranscriptGapRow, {
      props: { gap: { seq: 1, fromMs: 12_000, toMs: 230_000, synced: true } },
    });
    expect(body).toContain('data-gap-open="false"');
    expect(body).toContain("此段未錄到（00:12 – 03:50，共 3 分 38 秒）");
  });

  it("M01-Given 還沒同步到伺服端 When 渲染 Then 誠實標「待同步」（不得看起來已經存好）", () => {
    const pending = render(TranscriptGapRow, {
      props: { gap: { seq: 2, fromMs: 5_000, toMs: 9_000, synced: false } },
    }).body;
    expect(pending).toContain('data-testid="gap-pending"');

    const synced = render(TranscriptGapRow, {
      props: { gap: { seq: 2, fromMs: 5_000, toMs: 9_000, synced: true } },
    }).body;
    expect(synced).not.toContain('data-testid="gap-pending"');
  });
  it("M01-Given 這筆與伺服端衝突 When 渲染 Then 明說「與伺服端不一致」（不得長得像正常缺口）", () => {
    const conflict = render(TranscriptGapRow, {
      props: { gap: { seq: 1, fromMs: 20_000, toMs: null, synced: true, conflict: true } },
    }).body;
    expect(conflict).toContain('data-testid="gap-conflict"');
    expect(conflict).toContain("與伺服端不一致");
  });

  it("M01-Given 伺服端已結束、這筆永遠送不出去 When 渲染 Then 說「僅存本機」而不是「待同步」", () => {
    const terminal = render(TranscriptGapRow, {
      props: { gap: { seq: 2, fromMs: 5_000, toMs: 9_000, synced: false, terminal: true } },
    }).body;
    expect(terminal).toContain('data-testid="gap-terminal"');
    expect(terminal).toContain("僅存本機");
    // 「待同步」是承諾「之後會同步」——永久送不出去的不能這樣說（Gate 4 F5）。
    expect(terminal).not.toContain('data-testid="gap-pending"');
  });
});