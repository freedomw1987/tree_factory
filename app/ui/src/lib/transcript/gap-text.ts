/**
 * M01-US-107：缺口列的文案（AC-2）。
 *
 * 為什麼獨立成一個純函式：文案本身是**規格**——「未閉合的缺口必須明說結束時間未知」
 * 是這張票的誠實要求，不能埋在 Svelte 模板裡順手拼字串、事後沒人測得到。
 *
 * 時間用 US-101 的 `formatClock`（hh:mm:ss，超過 1 小時才有小時位）：
 * 會議內所有時間都用同一種寫法。
 */

import { formatClock } from "../recorder/limit";

export interface GapLike {
  fromMs: number;
  toMs: number | null;
}

/** 「此段未錄到（…）」：範圍已知就寫範圍；還開著就誠實說「不知道何時結束」。 */
export function formatGapText(gap: GapLike): string {
  const from = formatClock(gap.fromMs);
  if (gap.toMs === null) return `此段未錄到（從 ${from} 起中斷，結束時間未知）`;
  const span = gap.toMs - gap.fromMs;
  const lengthText = span < 1_000 ? "長度不到 1 秒" : `共 ${formatDuration(span)}`;
  return `此段未錄到（${from} – ${formatClock(gap.toMs)}，${lengthText}）`;
}

/**
 * 人類可讀的長度：秒 / 分 / 小時（1 分整就寫「1 分」，不要「1 分 0 秒」）。
 *
 * 刻意用 `Math.floor`（不是四捨五入）：同一列的頭尾時間也是 `formatClock`（同樣向下取整），
 * 長度跟著同一個基準才自洽——「00:01 – 00:02，共 1 秒」看起來就是 1 秒；
 * 若長度四捨五入就會出現「00:01 – 00:02，共 2 秒」這種自相矛盾的列。
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 1) return "不到 1 秒";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes === 0 ? `${hours} 小時` : `${hours} 小時 ${minutes} 分`;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 逐字稿的閱讀順序：缺口與句子共用 seq 排序（US-103 接上文字時也走這條）。 */
export function sortBySeq<T extends { seq: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}