/**
 * M01-US-102：分段內容指紋。
 *
 * 契約（裝置端與伺服端必須一致，寫在這裡當單一來源）：
 * **SHA-256(bytes) 的小寫十六進位，取前 16 個字元**。
 *
 * 為什麼要指紋：`seq` 單獨不夠——同一段被換成不同內容（裝置端資料損毀、或兩個會議的
 * 分段被混在一起）時，只有內容比對才看得出來；這時候絕不能覆蓋（設計 §2 D2）。
 *
 * 為什麼只取前 16 hex（64 bit）：足夠分辨「不同內容」（碰撞機率對本用途可忽略），
 * 而且短到可以放進每一列與每次回應，不需要壓縮。
 */

const HASH_CHARS = 16;

export async function sha256Hex16(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.slice(0, HASH_CHARS);
}
