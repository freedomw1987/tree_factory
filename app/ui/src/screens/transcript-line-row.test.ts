import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import { type TranscriptLine } from "../lib/transcript/live-transcript";
import TranscriptLineRow from "./TranscriptLineRow.svelte";

/** M01-US-104 AC-1 / AC-2：逐字稿列（元件層，SSR 渲染不出 DOM 行為，只驗語意）。 */

function line(over: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    key: "seg:0:2000",
    seq: 1,
    speakerId: 0,
    text: "這是定稿的句子",
    startMs: 2_000,
    endMs: 4_000,
    state: "committed",
    ...over,
  };
}

describe("M01-US-104 TranscriptLineRow", () => {
  it("M01-AC-1 Given 未定稿 When 渲染 Then 標成 interim 且不顯示講者（講者還可能變）", () => {
    const body = render(TranscriptLineRow, {
      props: { line: line({ state: "interim", seq: null, key: "interim:0", text: "我正在" }) },
    }).body;

    expect(body).toContain('data-testid="transcript-line"');
    expect(body).toContain('data-line-state="interim"');
    expect(body).toContain("我正在");
    expect(body).not.toContain('data-testid="line-speaker"');
  });

  it("M01-AC-1 Given 已定稿 When 渲染 Then 標成 committed 且顯示講者編號", () => {
    const body = render(TranscriptLineRow, { props: { line: line() } }).body;

    expect(body).toContain('data-line-state="committed"');
    expect(body).toContain('data-line-seq="1"');
    expect(body).toContain('data-testid="line-speaker"');
    expect(body).toContain("講者 1");
  });

  it("M01-AC-1 Given 兩種狀態 When 比較樣式 Then 不是只有顏色不同（色盲可及性）", () => {
    const interim = render(TranscriptLineRow, {
      props: { line: line({ state: "interim", seq: null, key: "interim:0" }) },
    }).body;
    const committed = render(TranscriptLineRow, { props: { line: line() } }).body;

    expect(interim).toContain("is-interim");
    expect(committed).not.toContain("is-interim");
    // interim 有講者以外的可辨識差異：斜體 class ＋ 沒有講者 chip。
    expect(interim).toContain("is-italic");
    expect(committed).toContain("is-committed");
  });

  it("M01-D19 Given 第二句起的講者 When 渲染 Then 講者編號是 1 起算（不是 0）", () => {
    const body = render(TranscriptLineRow, { props: { line: line({ speakerId: 1 }) } }).body;
    expect(body).toContain("講者 2");
    expect(body).not.toContain("講者 1<");
  });
});
