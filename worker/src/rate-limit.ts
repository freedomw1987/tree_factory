/**
 * TECH-009：邊緣速率限制（固定窗，per-isolate）。
 *
 * 為什麼要這一關（design D6）：憑證一旦洩漏或被暴力猜，唯一能延緩的就是「次數」。
 * 也為什麼**不放在 DO**：會議 id 是對手可控的（`/m/<任意字串>/…`），
 * 在 DO 層限流等於「每個新 id 一個新桶」——攻擊者只要每次換 id 就繞過了。
 *
 * 誠實的界線：狀態存在**單一 isolate 的記憶體**裡，
 * 所以這是「同一顆 isolate 內的固定窗」，不是全域速率限制（design D10）。
 *
 * 時間一律由呼叫端注入（`check(key, nowMs, cfg)`），
 * 「窗過期」「淘汰」才是立刻可驗的事實，不必真的等 60 秒。
 */

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX = 300;

/** 記憶體上限：超過就淘汰最舊的桶（洪水可以擠掉別人的桶，這是誠實的取捨）。 */
export const MAX_KEYS = 1000;

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

/** 只認 `RATE_LIMIT_*`（worker 的 env 兩者都是選填字串）。 */
export interface RateLimitEnv {
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  limit: number;
  windowMs: number;
}

/**
 * 解析整數設定：只收「純十進位正整數字串」（可含前後空白），其餘一律回預設。
 *
 * 為什麼不用 `Number()`：`Number("0")`＝0、`Number("")`＝0、`Number("1e3")`＝1000，
 * 任何一個都可能讓「設錯了」變成「無限制」或「全部被擋」這種最糟的靜默失敗
 * （design D6：沒有關掉限流的開關，設錯只能回預設）。
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

export function rateLimitConfig(env: RateLimitEnv): RateLimitConfig {
  return {
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
    max: positiveInt(env.RATE_LIMIT_MAX, DEFAULT_MAX),
  };
}

/**
 * 憑證指紋：把 token 換成定長的前 16 個十六進位字元（8 bytes）。
 *
 * 為什麼需要：限流鍵會活在 isolate 的記憶體裡（甚至可能出現在除錯輸出中），
 * 沒有理由把**憑證原文**放進去。指紋不是密碼學上的「不可逆」保證（token 熵夠高才成立），
 * 但它讓「記憶體裡的鍵」不再直接等於憑證。
 */
export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 限流鍵＝憑證指紋 + 來源 IP；沒有 IP（本機／測試）用 `-` 佔位，不與別人的桶混在一起。 */
export function clientKey(fingerprint: string, ip: string | null): string {
  return `${fingerprint}|${ip ?? "-"}`;
}

interface Bucket {
  windowStartMs: number;
  count: number;
}

/**
 * 固定窗計數器。
 *
 * 語意（design D6）：
 * - 窗內前 `max` 次放行，第 `max+1` 次起被擋，`remaining` 揭露剩餘次數；
 * - **被擋的那一次不往後推窗**（否則洪水可以讓同一個窗無限延長）；
 * - 窗過後自動重新計數，不需要任何人清理。
 */
export class FixedWindowLimiter {
  readonly #buckets = new Map<string, Bucket>();

  get size(): number {
    return this.#buckets.size;
  }

  check(key: string, nowMs: number, config: RateLimitConfig): RateLimitResult {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined || nowMs >= bucket.windowStartMs + config.windowMs) {
      bucket = { windowStartMs: nowMs, count: 0 };
      this.#admit(key, bucket, nowMs, config.windowMs);
    }
    const allowed = bucket.count < config.max;
    if (allowed) bucket.count += 1;
    return {
      allowed,
      // 精確值（毫秒）：由呼叫端換算成 `Retry-After` 的秒數。
      retryAfterMs: allowed ? 0 : Math.max(0, bucket.windowStartMs + config.windowMs - nowMs),
      remaining: Math.max(0, config.max - bucket.count),
      limit: config.max,
      windowMs: config.windowMs,
    };
  }

  /** 收鍵之前先確保容量：**先清過期，再 FIFO 淘汰**（過期的桶不該佔名額）。 */
  #admit(key: string, bucket: Bucket, nowMs: number, windowMs: number): void {
    if (this.#buckets.size >= MAX_KEYS) {
      for (const [candidate, entry] of this.#buckets) {
        if (nowMs >= entry.windowStartMs + windowMs) this.#buckets.delete(candidate);
      }
    }
    if (this.#buckets.size >= MAX_KEYS) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done !== true) this.#buckets.delete(oldest.value);
    }
    this.#buckets.set(key, bucket);
  }
}
