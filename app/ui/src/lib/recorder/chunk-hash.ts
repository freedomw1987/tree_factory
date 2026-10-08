/**
 * M01-US-102：分段內容指紋（裝置端）。
 *
 * 契約（與 `worker/src/hash.ts` 同一條，兩邊必須一致）：
 * **SHA-256(bytes) 的小寫十六進位，取前 16 個字元**。
 *
 * 為什麼裝置端也要算：伺服端要能分辨「同 seq 同內容＝重送（可忽略）」與
 * 「同 seq 不同內容＝衝突（409，不可覆蓋）」。上傳本身不帶指紋（伺服端收到位元組後自己算），
 * 裝置端這份用在**恢復對帳**：`GET /audio/chunks` 會回報每個 seq 的伺服端指紋，
 * 兩邊不一致就代表「同 seq 不同內容」——此時不可刪本機檔、不可覆蓋（設計 §6；Gate 4 F4/F6）。
 * 兩邊的實作各自有一組相同的黃金向量測試，避免其中一邊偷改導致指紋永遠對不上。
 */

/** SHA-256 → 小寫 hex → 前 16 字元。 */
export async function sha256Hex16(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
}
