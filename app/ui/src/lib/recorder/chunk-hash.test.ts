// M01-US-102：分段指紋（裝置端）。
// 契約與 worker 端同一條：SHA-256(bytes) 小寫十六進位前 16 字元（見 worker/src/hash.ts）。
// 兩邊必須一致，否則每次上傳都會被伺服器判成「同 seq 不同內容」→ 409，整個恢復流程失效。

import { describe, expect, it } from "vitest";

import { sha256Hex16 } from "./chunk-hash";

describe("M01-US-102 sha256Hex16", () => {
  // 黃金向量：與 `worker/test/hash.test.ts` **同一組字面值**。
  // 為什麼非釘不可：這兩份實作要能互相比對（恢復對帳會拿伺服端指紋與本機比），
  // 不一致會讓每一段都被判成「同 seq 不同內容」，恢復流程全滅。
  it("M01-Given 固定位元組 When 取指紋 Then 等於黃金向量（與 worker 端同一條契約）", async () => {
    const bytes = new TextEncoder().encode("tree_factory-us102");
    expect(await sha256Hex16(bytes.buffer as ArrayBuffer)).toBe("eeef17c1e796515f");
  });

  it("M01-Given 固定位元組 When 取指紋 Then 16 個小寫十六進位字元（長度是契約的一部分）", async () => {
    const hash = await sha256Hex16(new Uint8Array([1, 2, 3]).buffer);
    expect(hash).toBe("039058c6f2c0cb49");
  });

  it("M01-Given 同樣內容 When 取兩次 Then 相同（可重現，恢復時才比得出來）", async () => {
    const a = await sha256Hex16(new Uint8Array([7, 7, 7]).buffer);
    const b = await sha256Hex16(new Uint8Array([7, 7, 7]).buffer);
    expect(a).toBe(b);
  });

  it("M01-Given 不同內容 When 取指紋 Then 不同（同 seq 換內容必須能被發現）", async () => {
    const a = await sha256Hex16(new Uint8Array([1]).buffer);
    const b = await sha256Hex16(new Uint8Array([2]).buffer);
    expect(a).not.toBe(b);
  });

  it("M01-Given 空位元組 When 取指紋 Then 等於 SHA-256 空輸入前 16 hex（不丟錯）", async () => {
    const hash = await sha256Hex16(new ArrayBuffer(0));
    expect(hash).toBe("e3b0c44298fc1c14");
  });
});
