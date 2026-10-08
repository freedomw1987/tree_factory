// M01-US-102：分段指紋（伺服端）。
//
// 為什麼要有「黃金向量」：這支函式與裝置端的 `app/ui/src/lib/recorder/chunk-hash.ts` 是
// 兩份獨立的實作，而它們的輸出必須**逐字元相同**——一旦不一致，每次上傳都會被自己的
// 指紋比對判成「同 seq 不同內容」（409），整個恢復流程失效。
// 兩邊都釘住同一組字面值，任何一邊偷改（換演算法、改成大寫 hex、少切一個字）都會在這裡紅。

import { describe, expect, it } from "vitest";

import { sha256Hex16 } from "../src/hash";

describe("M01-US-102 sha256Hex16（伺服端）", () => {
  it("M01-Given 固定位元組 When 取指紋 Then 等於黃金向量（與裝置端同一條契約）", async () => {
    const bytes = new TextEncoder().encode("tree_factory-us102");
    expect(await sha256Hex16(bytes.buffer as ArrayBuffer)).toBe("eeef17c1e796515f");
  });

  it("M01-Given 空位元組 When 取指紋 Then 等於 SHA-256 空輸入前 16 hex", async () => {
    expect(await sha256Hex16(new ArrayBuffer(0))).toBe("e3b0c44298fc1c14");
  });

  it("M01-Given 同 seq 換一個位元組 When 取指紋 Then 不同（衝突必須被發現，不可覆蓋）", async () => {
    const a = await sha256Hex16(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    const b = await sha256Hex16(new Uint8Array([1, 2, 4]).buffer as ArrayBuffer);
    expect(a).toBe("039058c6f2c0cb49");
    expect(b).not.toBe(a);
  });
});
