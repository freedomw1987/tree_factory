/**
 * TECH-014：時間軸的可信錨點（HMAC 覆蓋 `meetingId｜startedAtMs｜endsAtMs`）。
 *
 * 為什麼需要這個檔：TECH-008 的位置檢查（`sessionClockViolation`）真正的不變式是
 * 「兩欄一起平移 ≤ elapsed + 60s ＝ 放行」——在會議尾端，上限可被無聲續命。
 * 本票用 HMAC 補上「同量平移」的可偵測性：信任根是一把只在伺服器 env 裡的密鑰，
 * 改得了 DB 不等於簽得出 MAC。
 *
 * 三個邊界（沿用既有模式，不另寫）：
 * - 純函式為主：方便 unit test、避免在 DO 內 await 拆散 read→gate→write 原子性（D5）。
 * - `crypto.subtle.sign` 必須 async，所以「DO 甦醒時算一次」與「每次讀取同步比對」拆成兩半（D5）。
 * - 金鑰正規化：未設／空字串／只有空白 → 視同未設定（fail-closed，D6）。
 *
 * AC-1（MAC 形式）、AC-5（fail-closed）、AC-7-②（持有金鑰者可重簽）由本檔覆蓋。
 */

import { constantTimeEquals } from "./edge-auth.js";

/** MAC 覆蓋字串的版本前綴（D3）。未來改覆蓋範圍時可分辨新舊錨，不必改表結構。 */
export const ANCHOR_VERSION = 1;

/**
 * `SESSION_ANCHOR_KEY` 的正規化：未設／空字串／只有空白 → `null`（讓呼叫端用 fail-closed）。
 *
 * 為什麼 trim：環境變數的尾巴常見多餘換行／空白，hash 前必須清掉。
 * 為什麼 32 bytes 下限：HMAC-SHA256 的金鑰低於 32 bytes 不會拒算，但**金鑰強度不夠**；
 * 實務上建議用 32+ bytes 的隨機字串（見 `docs/env-setup.md` 範例）。
 */
export function anchorKey(env: { SESSION_ANCHOR_KEY?: string } | undefined): string | null {
  const raw = env?.SESSION_ANCHOR_KEY;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 覆蓋字串（宣告在設計裡，實作與測試都用同一個常數）。 */
export function sessionAnchorMessage(version: number, meetingId: string, startedAtMs: number, endsAtMs: number): string {
  return `v${version}|${meetingId}|${startedAtMs}|${endsAtMs}`;
}

/**
 * 計算錨的 MAC（hex 64 字元）。
 *
 * 為什麼包成 `Promise<string>`：WebCrypto `sign()` 是 async；本函式被 DO 在
 * `blockConcurrencyWhile` 內呼叫一次（D5），其餘讀取路徑**不**直接用它（同步閘門比對兩個數字就夠）。
 *
 * 為什麼傳入 `key` 而不是 `env`：讓單元測試能用任意金鑰（不必建 `env` 物件），
 * 也讓「`env.SESSION_ANCHOR_KEY` 不存在」這條 fail-closed 規則在**更外層**判定（本檔只算 MAC）。
 */
export async function anchorMac(
  key: string,
  meetingId: string,
  startedAtMs: number,
  endsAtMs: number,
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    enc.encode(sessionAnchorMessage(ANCHOR_VERSION, meetingId, startedAtMs, endsAtMs)),
  );
  return toHex(new Uint8Array(sig));
}

/**
 * 比對兩個錨列是否一致（用 `constantTimeEquals`，沿用 `edge-auth.ts` 既有實作）。
 *
 * 為什麼不自己寫 === 比較：理論上 MAC 結果已是 hex 64 字元，
 * 但**長度不同也走完全長**是「常數時間」的靈魂（edge-auth.ts 內有實測），
 * 為了不重寫一遍且保證一致性，這裡 import 既有的。
 */
export function anchorEquals(a: { mac: string } | null, b: { mac: string } | null): boolean {
  if (a === null || b === null) return false;
  return constantTimeEquals(a.mac, b.mac);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}
