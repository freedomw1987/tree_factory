// 介面契約（M01-US-109「介面契約」）：
//   feed() 只回傳「已終結」的段落（被「講者變更 / 停頓超標 / UtteranceEnd」切開者）；
//   進行中的段落留在緩衝，用 pending() 取用、串流結束用 flush() 取出。
//   理由：串流中「最後一段」在下一字到來前不可判定完成——提早吐出正是「句子亂切」的來源。
import { describe, expect, it } from "vitest";

import { TranscriptSegmenter, type DiarizedWord } from "../src/segmentation";

/** 造一個 Deepgram 形狀的單字（start/end 為秒）。 */
function w(
  word: string,
  speaker: number,
  start: number,
  end: number,
  punctuated_word?: string,
): DiarizedWord {
  return punctuated_word === undefined
    ? { word, speaker, start, end }
    : { word, speaker, start, end, punctuated_word };
}

describe("TranscriptSegmenter（M01-US-109 逐字稿聚段器）", () => {
  describe("AC-1：同一講者連續發言 → 聚成一段", () => {
    it("M01-Given 三個同 speaker=0 的字、停頓皆 ≤1200ms When 餵入 Then 恰好一段，文字以單空格串接", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [
        w("good", 0, 0, 0.3, "Good"),
        w("morning", 0, 0.4, 0.8, "morning"),
        w("everyone", 0, 1.0, 1.5, "everyone."),
      ];

      // When
      const inProgress = segmenter.feed({ type: "words", words });
      const committed = segmenter.feed({ type: "utterance_end" });

      // Then（餵入時尚未終結 → 0 段；終結後 → 1 段）
      expect(inProgress).toHaveLength(0);
      expect(committed).toHaveLength(1);
      expect(committed[0]?.speakerId).toBe(0);
      expect(committed[0]?.text).toBe("Good morning everyone.");
      expect(committed[0]?.words).toHaveLength(3);
    });

    it("M01-Given 同上一段 When 檢查時間戳 Then startMs=首字 start、endMs=末字 end（皆換算毫秒）", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [w("a", 0, 1.25, 1.5), w("b", 0, 1.6, 2.345)];

      // When
      segmenter.feed({ type: "words", words });
      const segments = segmenter.feed({ type: "utterance_end" });

      // Then
      expect(segments[0]?.startMs).toBe(1250);
      expect(segments[0]?.endMs).toBe(2345);
    });

    it("M01-Given 未提供 punctuated_word When 聚段 Then 退回使用 word", () => {
      // Given
      const segmenter = new TranscriptSegmenter();

      // When
      segmenter.feed({ type: "words", words: [w("hello", 0, 0, 0.2), w("there", 0, 0.3, 0.5)] });
      const segments = segmenter.feed({ type: "utterance_end" });

      // Then
      expect(segments[0]?.text).toBe("hello there");
    });
  });

  describe("AC-2：講者變更 → 立即切段（即使停頓很短）", () => {
    it("M01-Given speaker 0→1 且停頓僅 100ms When 餵入 Then 兩段、順序與 speakerId 正確", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [
        w("我", 0, 0, 0.5, "我"),
        w("同意", 0, 0.6, 1.0, "同意"),
        w("但是", 1, 1.1, 1.4, "但是"),
        w("有個問題", 1, 1.5, 1.9, "有個問題"),
      ];

      // When（換人時第 1 段立即終結；第 2 段要等串流收尾）
      const onSwitch = segmenter.feed({ type: "words", words });
      const tail = segmenter.feed({ type: "utterance_end" });

      // Then
      expect(onSwitch).toHaveLength(1);
      expect(onSwitch[0]?.speakerId).toBe(0);
      expect(onSwitch[0]?.text).toBe("我 同意");
      expect(tail).toHaveLength(1);
      expect(tail[0]?.speakerId).toBe(1);
      expect(tail[0]?.text).toBe("但是 有個問題");
    });

    it("M01-Given speaker 由 0 起算 When 檢查 speakerId Then 保持 0 起算（不得 +1）", () => {
      // Given
      const segmenter = new TranscriptSegmenter();

      // When
      const first = segmenter.feed({ type: "words", words: [w("a", 0, 0, 0.2), w("b", 1, 0.25, 0.5)] });
      const second = segmenter.feed({ type: "utterance_end" });

      // Then
      expect([...first, ...second].map((s) => s.speakerId)).toEqual([0, 1]);
    });
  });

  describe("AC-3：停頓超過門檻 → 切段（等於門檻不切）", () => {
    it("M01-Given 同 speaker 停頓 1201ms When 餵入 Then 兩段", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [w("前", 0, 0, 0.5), w("後", 0, 1.701, 2.0)];

      // When（切點在餵入時就發生：第 1 段立即終結）
      const onPause = segmenter.feed({ type: "words", words });
      const tail = segmenter.flush();

      // Then
      expect(onPause).toHaveLength(1);
      expect(onPause[0]?.endMs).toBe(500);
      expect(tail?.startMs).toBe(1701);
    });

    it("M01-Given 同 speaker 停頓恰好 1200ms When 餵入 Then 不切段（嚴格大於才切）", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [w("前", 0, 0, 1.0), w("後", 0, 2.2, 2.5)];

      // When
      const onFeed = segmenter.feed({ type: "words", words });
      const segments = segmenter.feed({ type: "utterance_end" });

      // Then（恰等於門檻 → 不切 → 餵入時 0 段、終結後 1 段）
      expect(onFeed).toHaveLength(0);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.text).toBe("前 後");
    });

    it("M01-Given 自訂門檻 500ms When 停頓 600ms Then 切段（門檻可覆寫）", () => {
      // Given
      const segmenter = new TranscriptSegmenter({ pauseThresholdMs: 500 });
      const words = [w("前", 0, 0, 1.0), w("後", 0, 1.6, 2.0)];

      // When
      const onFeed = segmenter.feed({ type: "words", words });
      const tail = segmenter.flush();

      // Then
      expect(onFeed).toHaveLength(1);
      expect(tail?.text).toBe("後");
    });
  });

  describe("AC-4：UtteranceEnd 強制收尾，且不吞掉後續字", () => {
    it("M01-Given 緩衝有未完成內容 When 收到 utterance_end 再送同 speaker 近距離的字 Then 兩段且新字不遺失", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      segmenter.feed({ type: "words", words: [w("第一句", 0, 0, 0.8)] });

      // When
      const afterEnd = segmenter.feed({ type: "utterance_end" });
      const afterNext = segmenter.feed({
        type: "words",
        words: [w("下一句", 0, 0.85, 1.2)],
      });

      // Then
      expect(afterEnd).toHaveLength(1);
      expect(afterEnd[0]?.text).toBe("第一句");
      expect(afterNext).toHaveLength(0); // 新字還在緩衝中，未被丟棄
      expect(segmenter.pending()?.text).toBe("下一句");
    });

    it("M01-Given 串流結束時緩衝仍有內容 When 呼叫 flush Then 取出最後一段", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      segmenter.feed({ type: "words", words: [w("最後一句", 1, 10, 11)] });

      // When
      const last = segmenter.flush();

      // Then
      expect(last?.text).toBe("最後一句");
      expect(last?.speakerId).toBe(1);
      expect(segmenter.flush()).toBeNull(); // flush 具冪等性，不重複吐出
      expect(segmenter.pending()).toBeNull();
    });

    it("M01-Given 沒有緩衝內容 When 收到 utterance_end 或 flush Then 不得產生空段", () => {
      // Given
      const segmenter = new TranscriptSegmenter();

      // When / Then
      expect(segmenter.feed({ type: "utterance_end" })).toEqual([]);
      expect(segmenter.flush()).toBeNull();
    });
  });

  describe("邊界與例外", () => {
    it("M01-Given 空陣列 When 餵入 Then 回傳空陣列", () => {
      expect(new TranscriptSegmenter().feed({ type: "words", words: [] })).toEqual([]);
    });

    it("M01-Given 只有一個字 When 餵入 Then 該字仍在緩衝（尚未完成），flush 後為一段", () => {
      const segmenter = new TranscriptSegmenter();
      expect(segmenter.feed({ type: "words", words: [w("嗨", 0, 0, 0.3)] })).toEqual([]);
      expect(segmenter.flush()?.text).toBe("嗨");
    });

    it("M01-Given 輸入陣列 When 餵入 Then 不得修改輸入（不就地排序 / 不改物件）", () => {
      const segmenter = new TranscriptSegmenter();
      const words = [w("b", 0, 2, 2.5), w("a", 0, 3, 3.2)];
      const snapshot = JSON.stringify(words);

      segmenter.feed({ type: "words", words });

      expect(JSON.stringify(words)).toBe(snapshot);
    });

    it("M01-Given 時間戳為 NaN When 餵入 Then 不切成獨立段（防禦性：視為續段）", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      const words = [w("壞", 0, Number.NaN, Number.NaN), w("資料", 0, 0.1, 0.3)];

      // When
      const segments = segmenter.feed({ type: "words", words });

      // Then
      expect(segments).toHaveLength(0);
      expect(segmenter.pending()?.text).toBe("壞 資料");
    });

    it("M01-Given 已 flush When 再餵入新的字 Then 開新的一段（不殘留舊狀態）", () => {
      // Given
      const segmenter = new TranscriptSegmenter();
      segmenter.feed({ type: "words", words: [w("舊", 0, 0, 0.5)] });
      expect(segmenter.flush()?.text).toBe("舊");

      // When
      const reopened = segmenter.feed({ type: "words", words: [w("新", 1, 10, 10.5)] });

      // Then
      expect(reopened).toHaveLength(0);
      expect(segmenter.flush()?.text).toBe("新");
    });

    it("M01-Given 同一輸入 When 兩台聚段器各自跑 Then 輸出完全相同（無時鐘、決定性）", () => {
      const words = [w("x", 0, 0, 0.4), w("y", 1, 0.5, 0.9), w("z", 1, 2.5, 2.9)];
      const a = new TranscriptSegmenter();
      const b = new TranscriptSegmenter();

      expect(JSON.stringify(a.feed({ type: "words", words }))).toBe(
        JSON.stringify(b.feed({ type: "words", words })),
      );
    });
  });
});