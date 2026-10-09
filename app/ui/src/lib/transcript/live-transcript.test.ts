import { describe, expect, it } from "vitest";

import {
  FOLLOW_THRESHOLD_PX,
  LiveTranscript,
  RENDER_BUDGET,
  mergeTimeline,
  type GapRow,
  type SegmentRow,
  type TimelineEntry,
  type TranscriptLine,
} from "./live-transcript";

/**
 * M01-US-104 AC-1~4 與 DoD「渲染預算」的狀態機測試（純模組，node 環境）。
 *
 * 為什麼跟畫面分開：跟隨 / 未讀 / 去重都是**規則**，而規則要能被突變測試殺。
 * 捲動本身（真的把 scrollTop 改掉、真的上滑）由 `e2e/live-transcript.spec.ts` 在真瀏覽器驗。
 */

function row(seq: number, over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    seq,
    speakerId: 0,
    text: `第 ${seq} 句`,
    startMs: seq * 1_000,
    endMs: seq * 1_000 + 900,
    ...over,
  };
}

/** 第 index 個句子列（不是句子就讓測試炸，不要靜默變成 undefined）。 */
function lineAt(entries: readonly TimelineEntry[], index: number): TranscriptLine {
  const entry = entries[index];
  if (entry === undefined || entry.kind !== "line") throw new Error(`entries[${index}] 不是句子`);
  return entry.line;
}

/** 畫面會看到的句子文字（依時間軸順序）。 */
function pageTexts(live: LiveTranscript): string[] {
  return live
    .timeline()
    .filter((entry) => entry.kind === "line")
    .map((entry) => (entry.kind === "line" ? entry.line.text : ""));
}

/** 第 index 個缺口列。 */
function gapAt(entries: readonly TimelineEntry<GapRow>[], index: number): GapRow {
  const entry = entries[index];
  if (entry === undefined || entry.kind !== "gap") throw new Error(`entries[${index}] 不是缺口`);
  return entry.gap;
}

describe("M01-US-104 即時逐字稿狀態機", () => {
  it("M01-AC-1 Given 有人正在說話 When 收到 interim Then 只有一列 interim 且沒有 seq", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 0, text: "我正在", startMs: 2_000, endMs: 3_000 });

    const entries = live.timeline();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "line" });
    const line = lineAt(entries, 0);
    expect(line?.state).toBe("interim");
    expect(line?.seq).toBeNull();
    expect(line?.text).toBe("我正在");
  });

  it("M01-AC-1 Given 已經有一列 interim When 再收到下一個 interim Then 只有一列（原地替換，不是累積）", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 0, text: "我正在", startMs: 2_000, endMs: 3_000 });
    live.applyInterim({ speakerId: 0, text: "我正在測試這", startMs: 2_000, endMs: 4_000 });

    const entries = live.timeline();
    expect(entries).toHaveLength(1);
    const line = lineAt(entries, 0);
    expect(line?.text).toBe("我正在測試這");
    expect(live.counts.interim).toBe(1);
  });

  it("M01-AC-2 Given interim 正在顯示 When 同一段定稿 Then interim 消失、只剩一列 committed", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 1, text: "我正在測試這", startMs: 2_000, endMs: 4_000 });
    live.applyPage({ segments: [row(1, { speakerId: 1, text: "我正在測試這句", startMs: 2_000 })], nextSince: 1 });

    const entries = live.timeline();
    expect(entries).toHaveLength(1);
    const line = lineAt(entries, 0);
    expect(line?.state).toBe("committed");
    expect(line?.seq).toBe(1);
    expect(live.counts.interim).toBe(0);
  });

  it("M01-AC-2 Given interim 與定稿的時間戳對不上 When 定稿到達 Then interim 仍必須被收掉（不得兩份文字）", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 0, text: "同一句話", startMs: 2_000, endMs: 4_000 });
    // 伺服端聚段後起點可能不同（重疊裁切 / UtteranceEnd 收尾）：不能因為 key 對不上就留著 interim。
    live.applyPage({ segments: [row(3, { text: "同一句話", startMs: 2_120 })], nextSince: 3 });

    const texts = live
      .timeline()
      .filter((entry) => entry.kind === "line")
      .map((entry) => (entry.kind === "line" ? entry.line.text : ""));
    expect(texts.filter((text) => text === "同一句話")).toHaveLength(1);
    expect(live.counts.interim).toBe(0);
  });

  it("M01-D8 Given interim 已在畫面上 When 落後補齊的較早定稿到達 Then interim 不得被收掉", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 0, text: "我正在說這句", startMs: 5_000, endMs: 6_000 });

    // 落後補齊：整頁都早於 interim（例如網路回來後補的舊段）
    live.applyPage({ segments: [row(1, { startMs: 1_000, endMs: 2_000 })], nextSince: 1 });
    expect(live.counts).toMatchObject({ committed: 1, interim: 1 });
    expect(lineAt(live.timeline(), 1).state).toBe("interim");

    // 只有涵蓋到 interim 時間點「之後」的定稿才算收掉它
    live.applyPage({ segments: [row(2, { startMs: 7_000, endMs: 8_000 })], nextSince: 2 });
    expect(live.counts.interim).toBe(0);
  });

  it("M01-AC-2 Given 同一頁被讀到兩次 When 套用 Then 同一 seq 不得變成兩列", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1), row(2)], nextSince: 2 });
    live.applyPage({ segments: [row(1), row(2)], nextSince: 2 });

    expect(live.counts.committed).toBe(2);
    expect(live.timeline().map((entry) => (entry.kind === "line" ? entry.line.seq : "gap"))).toEqual([1, 2]);
  });

  it("M01-AC-2 Given 後到的頁面帶回更舊的句子 When 套用 Then 依 seq 插回正確位置", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(5), row(6)], nextSince: 6 });
    live.applyPage({ segments: [row(3)], nextSince: 3 });

    expect(live.timeline().map((entry) => (entry.kind === "line" ? entry.line.seq : "gap"))).toEqual([3, 5, 6]);
  });

  it("M01-AC-3 Given 正在跟隨 When 新句進來 Then 未讀數仍是 0", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1)], nextSince: 1 });
    expect(live.following).toBe(true);
    expect(live.unread).toBe(0);

    live.applyPage({ segments: [row(2), row(3)], nextSince: 3 });
    expect(live.unread).toBe(0);
  });

  it("M01-AC-3 Given 使用者手動上滑 When 超過門檻 Then 停止跟隨；回到門檻內則恢復並歸零", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1)], nextSince: 1 });

    live.notifyUserScroll(FOLLOW_THRESHOLD_PX + 1);
    expect(live.following).toBe(false);

    live.applyPage({ segments: [row(2)], nextSince: 2 });
    expect(live.unread).toBe(1);

    live.notifyUserScroll(FOLLOW_THRESHOLD_PX);
    expect(live.following).toBe(true);
    expect(live.unread).toBe(0);
  });

  it("M01-AC-4 Given 已停止跟隨 When 新句進來 Then 未讀累加，且 interim 不計入", () => {
    const live = new LiveTranscript();
    live.notifyUserScroll(400);
    live.applyPage({ segments: [row(1), row(2)], nextSince: 2 });
    expect(live.unread).toBe(2);

    live.applyInterim({ speakerId: 0, text: "還沒定稿", startMs: 3_000, endMs: 3_500 });
    expect(live.unread).toBe(2);

    live.applyPage({ segments: [row(3), row(4), row(5)], nextSince: 5 });
    expect(live.unread).toBe(5);
  });

  it("M01-AC-4 Given 未讀累加中 When 點「回到最新」 Then 恢復跟隨且未讀歸零（之後不再累加）", () => {
    const live = new LiveTranscript();
    live.notifyUserScroll(400);
    live.applyPage({ segments: [row(1), row(2)], nextSince: 2 });

    live.backToLatest();
    expect(live.following).toBe(true);
    expect(live.unread).toBe(0);

    live.applyPage({ segments: [row(3)], nextSince: 3 });
    expect(live.unread).toBe(0);
  });

  it("M01-DoD Given 超過渲染預算 When 取時間軸 Then 只回最近 RENDER_BUDGET 句並說出省略幾句", () => {
    const live = new LiveTranscript();
    const many = Array.from({ length: RENDER_BUDGET + 10 }, (_, index) => row(index + 1));
    live.applyPage({ segments: many, nextSince: many.length });

    const entries = live.timeline();
    const lines = entries.filter((entry) => entry.kind === "line");
    expect(lines).toHaveLength(RENDER_BUDGET);
    // 保留的是**最近**的 30 句（最後一句一定在）。
    expect(lineAt(lines, lines.length - 1).seq).toBe(RENDER_BUDGET + 10);
    expect(lineAt(lines, 0).seq).toBe(11);
    expect(live.counts).toMatchObject({ committed: RENDER_BUDGET + 10, omitted: 10 });
  });

  it("M01-DoD Given 有 interim 且超過預算 When 取時間軸 Then interim 一定在（不被預算裁掉）", () => {
    const live = new LiveTranscript();
    const many = Array.from({ length: 40 }, (_, index) => row(index + 1));
    live.applyPage({ segments: many, nextSince: 40 });
    live.applyInterim({ speakerId: 0, text: "進行中", startMs: 41_000, endMs: 41_500 });

    const lines = live.timeline().filter((entry) => entry.kind === "line");
    expect(lines).toHaveLength(RENDER_BUDGET + 1);
    expect(lineAt(lines, lines.length - 1).state).toBe("interim");
  });

  it("M01-D8 Given 定稿回填了更早的句子起點 When 與 interim 時間重疊 Then interim 必須被收掉（不得兩份）", () => {
    const live = new LiveTranscript();
    live.applyInterim({ speakerId: 0, text: "我正在測試這句", startMs: 5_000, endMs: 6_000 });
    // 真實 STT 的 final 常把起點回填到第一個字的時間（比 interim 的粗起點更早）→
    // 只看「定稿起點是否晚於 interim 起點」會留下鬼影；這裡釘住「相交也算收掉」。
    live.applyPage({ segments: [row(4, { startMs: 4_500, endMs: 5_900 })], nextSince: 4 });

    expect(live.counts).toMatchObject({ committed: 1, interim: 0 });
    expect(pageTexts(live)).toEqual(["第 4 句"]);
  });

  it("M01-D8 Given 前一句的定稿與下一句的 interim 端點相接 When 遲到的定稿到達 Then 正在說的那句不得被收掉", () => {
    const live = new LiveTranscript();
    // 連續句子的常見形狀：前一句 `endMs === 後一句 startMs`。若把「端點相接」算成相交，
    // 前一秒的定稿晚到時就會誤殺「正在說…」——畫面少一句，而且直到下個 interim 才回來。
    live.applyInterim({ speakerId: 0, text: "下一句正在說", startMs: 2_000, endMs: 3_000 });
    live.applyPage({ segments: [row(1, { startMs: 1_000, endMs: 2_000 })], nextSince: 1 });

    expect(live.counts).toMatchObject({ committed: 1, interim: 1 });
    expect(lineAt(live.timeline(), 1).state).toBe("interim");
  });

  it("M01-D8 Given 這一頁同時有重複列與落後補齊列 When 重複列與 interim 重疊 Then 不得因此收掉 interim", () => {
    const live = new LiveTranscript();
    // 重複列（已見過）不該有任何副作用：吸收只看**這一頁新增**的列。
    live.applyPage({ segments: [row(4, { startMs: 3_000, endMs: 4_000 })], nextSince: 4 });
    live.applyInterim({ speakerId: 0, text: "正在說", startMs: 3_000, endMs: 4_000 });
    live.applyPage({
      segments: [row(4, { startMs: 3_000, endMs: 4_000 }), row(5, { startMs: 1_000, endMs: 1_200 })],
      nextSince: 5,
    });

    expect(live.counts).toMatchObject({ committed: 2, interim: 1 });
  });

  it("M01-D15 Given 兩列同序號、其中一列有冪等鍵 When 套用 Then 兩列都要在（鍵的命名空間不可互撞）", () => {
    const live = new LiveTranscript();
    // 舊版把「沒有鍵」也組成 `seg:<seq>`，於是 `seq:1` 與 `idempotencyKey:"1"` 撞成同一個鍵，
    // 後到的那一句會被無聲丟掉。
    live.applyPage({ segments: [row(1), row(2, { idempotencyKey: "1", text: "有冪等鍵的那句" })], nextSince: 2 });

    expect(live.counts.committed).toBe(2);
    expect(pageTexts(live)).toEqual(["第 1 句", "有冪等鍵的那句"]);
  });

  it("M01-D15 Given 生產形狀的冪等鍵 When 同一列被讀到兩次 Then 只留一列", () => {
    const live = new LiveTranscript();
    // 真實帳本列的鍵是伺服端合成的 `seg:<speakerId>:<startMs>`（transcript-stream.ts:178）。
    const production = row(1, { idempotencyKey: "seg:seg:0:1000" });
    live.applyPage({ segments: [production], nextSince: 1 });
    live.applyPage({ segments: [production], nextSince: 1 });

    expect(live.counts.committed).toBe(1);
    expect(pageTexts(live)).toEqual(["第 1 句"]);
  });

  it("M01-D14 Given 前綴被裁掉 When 取時間軸 Then 更早的缺口一起收掉、跨過裁切點的缺口要留", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1), row(2), row(3)], nextSince: 3 });
    live.applyGaps([
      { seq: 1, fromMs: 100, toMs: 200 },
      { seq: 2, fromMs: 1_500, toMs: 2_500 },
      { seq: 3, fromMs: 50, toMs: null },
    ]);

    // 預算 2 → 只看得到 seq 2、3（地板 2_000ms）：缺口 1 整段在地板下 → 收掉；
    // 缺口 2 跨過地板 → 必須留；缺口 3 未結案 → 必須留。
    const entries = live.timeline(2);
    expect(entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.gap.seq}` : `line:${entry.line.seq}`))).toEqual([
      "gap:3",
      "gap:2",
      "line:2",
      "line:3",
    ]);
  });

  it("M01-DoD Given 呼叫端指定較小的預算 When 取時間軸 Then 省略句數必須跟同一套預算（不得兩套真相）", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1), row(2), row(3)], nextSince: 3 });

    expect(live.timeline(2).filter((entry) => entry.kind === "line")).toHaveLength(2);
    // 畫面只畫 2 句，就不能說「省略 0 句」。
    expect(live.counts.omitted).toBe(1);
  });

  it("M01-AC-1 Given 有一句 interim When 會議結束（clearInterim）Then 那一列不再出現", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1)], nextSince: 1 });
    live.applyInterim({ speakerId: 1, text: "說話到一半就結束", startMs: 2_000, endMs: 2_500 });
    expect(live.counts.interim).toBe(1);

    live.clearInterim();
    expect(live.counts).toMatchObject({ committed: 1, interim: 0 });
    expect(pageTexts(live)).toEqual(["第 1 句"]);
  });

  it("M01-D7 Given 缺口與句子混在一起 When 取時間軸 Then 依時間排序，同一時間句子先", () => {
    const entries = mergeTimeline({
      lines: [
        { key: "seg:0:1000", seq: 1, speakerId: 0, text: "第一句", startMs: 1_000, endMs: 2_000, state: "committed" },
        { key: "seg:0:5000", seq: 2, speakerId: 0, text: "第二句", startMs: 5_000, endMs: 6_000, state: "committed" },
      ],
      gaps: [
        { seq: 1, fromMs: 3_000, toMs: 4_000 },
        { seq: 2, fromMs: 1_000, toMs: 1_500 },
      ],
      budget: 30,
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["line", "gap", "gap", "line"]);
    expect(gapAt(entries, 1).fromMs).toBe(1_000);
  });

  it("M01-D11 Given 伺服端回的 nextSince 比目前水位小 When 套用 Then 水位不得回退", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(9)], nextSince: 9 });
    expect(live.pendingSince).toBe(9);

    live.applyPage({ segments: [], nextSince: 4 });
    expect(live.pendingSince).toBe(9);

    live.applyPage({ segments: [], nextSince: null });
    expect(live.pendingSince).toBe(9);

    live.applyPage({ segments: [row(10)], nextSince: 10 });
    expect(live.pendingSince).toBe(10);
  });

  it("M01-D10 Given 讀取失敗過 When 之後成功 Then 舊句子仍在（不清空）", () => {
    const live = new LiveTranscript();
    live.applyPage({ segments: [row(1), row(2)], nextSince: 2 });
    // 讀取失敗是 feed 的事（見 live-transcript-feed.test.ts）；狀態機不得為此清空既有內容。
    expect(live.counts.committed).toBe(2);
    live.applyPage({ segments: [], nextSince: null });
    expect(live.counts.committed).toBe(2);
  });
});
