/**
 * M01-US-103：Deepgram nova-3 **原始串流訊息** → 本專案的分段事件。
 *
 * 為什麼要這一層：`segmentation.ts`（US-109）吃的是整理過的 `StreamEvent`，
 * 但真正從 WebSocket 進來的是 `{type:"Results", channel:{alternatives:[{words:[…]}]}}` 這種形狀。
 * 中間若沒有翻譯層，聚段器就永遠只能餵測試資料——那等於沒有接上 STT。
 *
 * 設計約束：
 *   - **純函式、無 I/O**：同一則訊息必得同一組事件，且可用 SPIKE-001 的真跡重播（見 test）。
 *   - **壞訊息不丟錯**：串流裡什麼都可能出現（平台升級、心跳、截斷的多工），
 *     一個壞訊息不該毒死整條管線 → 一律回空陣列，讓呼叫端繼續跑。
 *   - **單位邊界**：Deepgram 原生是**秒**，本層轉成**毫秒**（本產品正準單位），
 *     所以「秒」只出現在這個檔案裡。
 *   - **缺 `speaker` 時當 0**：沒開 `diarize` 的來源（單人 dictation）不該讓每個字都消失；
 *     「全部都是 0 號」是誠實的表示（＝沒有分軌資訊），不是捏造。
 */

import type { DiarizedWord } from "./segmentation.js";

/** 解析後的事件（分段器的輸入超集）。 */
export type NovaEvent =
  | { type: "words"; final: boolean; words: DiarizedWord[] }
  | { type: "utterance_end" }
  | { type: "speech_started"; timestampMs: number };

/**
 * 把一則原始訊息翻成 0 到多個事件。
 *
 * - `Results` → `words`（`is_final` 原樣帶出，管線靠它決定要不要落地）
 * - `UtteranceEnd` → `utterance_end`
 * - `SpeechStarted` → `speech_started`（目前只記錄，尚未使用）
 * - 其他（`Metadata`、心跳、未知型別）→ 空陣列
 */
export function parseNovaMessage(raw: unknown): NovaEvent[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const message = raw as Record<string, unknown>;

  if (message.type === "UtteranceEnd") {
    return [{ type: "utterance_end" }];
  }

  if (message.type === "SpeechStarted") {
    const timestamp = message.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return [];
    return [{ type: "speech_started", timestampMs: Math.round(timestamp * 1000) }];
  }

  if (message.type !== "Results") return [];

  const words = toWords(alternativesOf(message));
  if (words.length === 0) return [];
  return [{ type: "words", final: message.is_final === true, words }];
}

/** `channel.alternatives[0].words`；形狀不符時回空陣列。 */
function alternativesOf(message: Record<string, unknown>): unknown {
  const channel = message.channel;
  if (channel === null || typeof channel !== "object") return undefined;
  const alternatives = (channel as Record<string, unknown>).alternatives;
  if (!Array.isArray(alternatives)) return undefined;
  const first = alternatives[0];
  if (first === null || typeof first !== "object") return undefined;
  return (first as Record<string, unknown>).words;
}

/**
 * 過濾出可用的字。
 * 缺時間戳（或時間戳不是數字）的字**單獨丟掉**，其餘照收——
 * 這比「整段陪葬」誠實：壞一個字不該讓一句話消失。
 */
function toWords(value: unknown): DiarizedWord[] {
  if (!Array.isArray(value)) return [];
  const words: DiarizedWord[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const word = entry as Record<string, unknown>;
    const start = word.start;
    const end = word.end;
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    const text = typeof word.word === "string" ? word.word : "";
    if (text === "") continue;
    const speaker = typeof word.speaker === "number" && Number.isInteger(word.speaker) && word.speaker >= 0
      ? word.speaker
      : 0;
    words.push({
      word: text,
      ...(typeof word.punctuated_word === "string" ? { punctuated_word: word.punctuated_word } : {}),
      speaker,
      start,
      end,
    });
  }
  return words;
}
