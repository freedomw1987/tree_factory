/**
 * emoji 守門的共用邏輯（DESIGN.md §5 規則 8 的「實作強制條款」）。
 *
 * 抽成模組的理由：Gate 4 checker 指出去註解的邏輯有 false negative（會漏），
 * 而「會漏的守門」等於沒有守門 —— 所以這段邏輯本身必須有測試（`emoji.test.ts`）。
 */

/**
 * emoji 的碼位範圍（含變體選擇符 U+FE0F，例：`🎙️` = U+1F399 + U+FE0F）。
 * 刻意**不含** U+2190~U+21FF 箭頭與 U+2460 起圈號：
 * 它們是排版符號（`→`、`①`），不是 emoji 圖示，程式註解與文案都會用到。
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\u{FE0F}?/u;

const QUOTES = new Set(['"', "'", "`"]);

/** 把一段文字裡的換行保留下來（區塊註解跨行時，行號才不會跑掉）。 */
function keepNewlines(text: string): string {
  return "\n".repeat(text.split("\n").length - 1);
}

/**
 * 去掉註解：emoji 出現在註解裡不是「用 emoji 當圖示」，不該誤報。
 *
 * **逐字元掃描**（不是正則硬刪）：舊版用 `/(^|[^:])\/\/[^\n]*​/g` 粗刪，
 * 會把「同一行裡 `//` 之後的程式碼」當成註解一起刪掉 —— `const a = "x//" + "😀"`
 * 的 emoji 就這樣溜過守門。掃描器改成看得懂字串狀態，就不會吃掉字串後面的程式碼。
 *
 * ⚠️ 已知限制（誠實揭露）：不解析 regex literal（`/["']/`）與 template literal 的 `${}`，
 * 這些寫法可能讓之後的註解判讀偏差；寧可**少刪**（false positive 會被發現）也不要多刪（漏）。
 * 換行一律保留，所以去掉註解後的行號與原檔一致（給掃描器報行號用）。
 * ⚠️ 同一套邏輯在 `scripts/check-design-icons.mjs`（純 node，掃 `.css` 用）也有一份 —— 改這裡要同步改那裡。
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += keepNewlines(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end; // 保留行尾換行
      continue;
    }

    if (c === "<" && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? text.length : end + 3;
      out += keepNewlines(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (QUOTES.has(c)) {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i] ?? "";
        const done = text[i] === quote;
        i += 1;
        if (done) break;
      }
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** 回傳程式碼裡第一個 emoji（沒有則 null）。 */
export function findEmoji(text: string): string | null {
  return stripComments(text).match(EMOJI)?.[0] ?? null;
}
