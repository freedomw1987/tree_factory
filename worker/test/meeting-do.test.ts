// TECH-004：`MeetingDurableObject` 的 HTTP 介面邊界（不進 storage 的那幾條路徑）。
//
// 這裡只驗「參數驗證」與「設定錯誤要講清楚」——需要真 SQLite 的路徑（/health、/submit）
// 由 `harness-persistence.test.ts`（node:sqlite 替身）與 workerd 冒煙測試覆蓋。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALARM_DELAY_MS,
  MAX_ALARM_DELAY_MS,
  MeetingDurableObject,
  type MeetingDurableObjectContext,
} from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";

interface Harness {
  durable: MeetingDurableObject;
  alarms: number[];
  sqlCalls: string[];
}

/** 最小的 DO context 替身：只記錄呼叫，不假裝自己是 SQLite。 */
function makeDurable(env: MeetingBindings = {}): Harness {
  const alarms: number[] = [];
  const sqlCalls: string[] = [];
  let currentAlarm: number | null = null; // 平台會記住已設的 alarm，替身也要記
  const ctx: MeetingDurableObjectContext = {
    storage: {
      sql: {
        exec(sql: string) {
          sqlCalls.push(sql);
          return { toArray: () => [] };
        },
      },
      async setAlarm(atMs: number) {
        alarms.push(atMs);
        currentAlarm = atMs;
      },
      async getAlarm() {
        return currentAlarm;
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    },
    id: { toString: () => "do-test" },
  };
  return { durable: new MeetingDurableObject(ctx, env), alarms, sqlCalls };
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  method = "GET",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(new Request(`https://meeting.test${path}`, { method }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** TECH-009 D7：`/wake` 與 `/release` 改成 POST-only，會改狀態的端點不再用 GET 打。 */
function post(durable: MeetingDurableObject, path: string) {
  return call(durable, path, "POST");
}

describe("MeetingDurableObject（TECH-004）", () => {
  it("/wake 沒帶 ms → 400 MS_REQUIRED（不可退化成 0 造成忙迴圈）", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await post(durable, "/wake");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(body.example).toBe(`/wake?ms=${DEFAULT_ALARM_DELAY_MS}`);
    expect(alarms).toEqual([]);
  });

  it("/wake?ms= 空字串 → 400 MS_REQUIRED（Number(\"\") 是 0，絕不可以放行）", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await post(durable, "/wake?ms=");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(alarms).toEqual([]);
  });

  it("/wake?ms=（只有空白）→ 400 MS_REQUIRED", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await post(durable, "/wake?ms=%20%20");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(alarms).toEqual([]);
  });

  it("/wake 非數字或負數 → 400 MS_INVALID", async () => {
    const { durable, alarms } = makeDurable();
    for (const raw of ["abc", "-1"]) {
      const { status, body } = await post(durable, `/wake?ms=${raw}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: "MS_INVALID", value: raw });
    }
    expect(alarms).toEqual([]);
  });

  it(`/wake 超過 ${MAX_ALARM_DELAY_MS}ms → 400 MS_TOO_LARGE（一次醒來最多再往前排這麼久）`, async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await post(durable, `/wake?ms=${MAX_ALARM_DELAY_MS + 1}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "MS_TOO_LARGE", max: MAX_ALARM_DELAY_MS });
    expect(alarms).toEqual([]);
  });

  it("/wake 邊界值（剛好等於上限）與正常值 → 200 並真的設定 alarm", async () => {
    const { durable, alarms } = makeDurable();
    const boundary = await post(durable, `/wake?ms=${MAX_ALARM_DELAY_MS}`);
    expect(boundary.status).toBe(200);
    expect(boundary.body).toMatchObject({ scheduled: true, previous: null });

    const normal = await post(durable, "/wake?ms=1500");
    expect(normal.status).toBe(200);
    // 1500ms 比 5 分鐘早 → 接力規則「只往前調」會改寫它，並回報原本的 alarm。
    expect(normal.body).toMatchObject({ scheduled: true, previous: alarms[0] });
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!).toBeLessThan(alarms[0]!);
  });

  it("未知 HARNESS_PROVIDER → 500 PROVIDER_UNKNOWN，且不碰 storage（不用別的 provider 頂替）", async () => {
    const { durable, sqlCalls } = makeDurable({ HARNESS_PROVIDER: "not-a-provider" });
    const { status, body } = await call(durable, "/health");
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: "PROVIDER_UNKNOWN", recoverable: true });
    expect(sqlCalls).toEqual([]);
  });

  it("模型 id 打錯 → 500 MODEL_UNAVAILABLE，且不碰 storage", async () => {
    const { durable, sqlCalls } = makeDurable({
      CLOUDFLARE_API_KEY: "key",
      CLOUDFLARE_ACCOUNT_ID: "account",
      REALTIME_MODEL_ID: "@cf/typo/does-not-exist",
    });
    const { status, body } = await call(durable, "/health");
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: "MODEL_UNAVAILABLE" });
    expect(sqlCalls).toEqual([]);
  });

  it("缺憑證 → 401 AUTH_INVALID（唯一允許阻斷的錯誤碼）", async () => {
    const { durable } = makeDurable({});
    const { status, body } = await call(durable, "/health");
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "AUTH_INVALID", recoverable: false });
  });

  it("/wake?ms=0 是明確的「立刻接力」（與沒帶 ms 的退化不同）", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await post(durable, "/wake?ms=0");
    expect(status).toBe(200);
    expect(body).toMatchObject({ scheduled: true });
    expect(alarms).toHaveLength(1);
  });

  it("/wake?ms=0.5／0x1f／1e3 → 400 MS_INVALID（只收十進位整數字串）", async () => {
    for (const raw of ["0.5", "0x1f", "1e3", " 1500x", "+5"]) {
      const { durable, alarms } = makeDurable();
      const { status, body } = await post(durable, `/wake?ms=${encodeURIComponent(raw)}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: "MS_INVALID" });
      expect(alarms).toEqual([]);
    }
  });

  it("/wake?ms=+5（未編碼，query 中 + 是空白）與 %201500 → 400 MS_INVALID（嚴格模式不 trim）", async () => {
    // 第二輪修了「只收十進位整數字串」，但當時測試用 encodeURIComponent(`+5`) → `%2B5`，
    // 測不到**原始 URL 的 `+`**；而 URLSearchParams 會把 `+` 解成空白，若再 trim 就等於放行 `?ms=+5`
    //（近似立即 alarm）。所以格式檢查必須看「原字串」，不能先 trim。
    const { durable, alarms } = makeDurable();
    const plus = await post(durable, "/wake?ms=+5");
    expect(plus.status).toBe(400);
    expect(plus.body).toMatchObject({ error: "MS_INVALID" });

    const spaced = await post(durable, "/wake?ms=%201500");
    expect(spaced.status).toBe(400);
    expect(spaced.body).toMatchObject({ error: "MS_INVALID" });

    expect(alarms).toEqual([]);
  });

  it("TECH-009 AC-5：`/wake` 非 POST（GET／PUT／DELETE）→ 405 + Allow: POST，且不得設 alarm", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const harness = makeDurable();
      const response = await harness.durable.fetch(
        new Request("https://meeting.test/wake?ms=1500", { method }),
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("POST");
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: "METHOD_NOT_ALLOWED",
      });
      // 這才是重點：simple GET 不只要「回錯」，還不能有副作用。
      expect(harness.alarms, method).toHaveLength(0);
    }
  });

  it("TECH-009 AC-5：`/release` 非 POST → 405 + Allow: POST，且不得放掉正在交付中的 harness", async () => {
    const harness = makeDurable();
    // 不 await：讓 open 停在 in-flight，這樣「release 有沒有真的生效」才有鑑別力
    // （Gate 4 第 1 輪 reviewer P3-3：原本只看 `released:false` 推論，但那兩種情況輸出相同）。
    const health = harness.durable.fetch(new Request("https://meeting.test/health"));
    // GET 先發、**不 await**：`fetch()` 會同步執行到方法閘門才回 405，
    // 所以下面那次 POST 一定還看到 in-flight 的 open，`deferredReleases` 才有鑑別力。
    const blocked = harness.durable.fetch(new Request("https://meeting.test/release"));
    const { body } = await post(harness.durable, "/release");
    // 真正生效的只有那一次 POST：deferredReleases 恰好 1（被擋掉的 GET 沒有進來過；否則會是 2）。
    expect(body).toMatchObject({ released: false, deferred: true, deferredReleases: 1 });
    const response = await blocked;
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: "METHOD_NOT_ALLOWED",
    });
    await expect(health).resolves.toBeInstanceOf(Response);
  });

  it("TECH-009 AC-5：`/session/start`、`/session/stop` 非 POST → 405 + Allow: POST，且不得寫 session", async () => {
    // Gate 4 第 1 輪 reviewer P2-2：這兩條與 `/wake` 是**同一個形狀**（不必帶 body 就能改狀態），
    // 只靠入口層憑證把關並不一致——判準既然是「會改狀態」，就一起收斂。
    for (const path of ["/session/start", "/session/stop"]) {
      const harness = makeDurable();
      const response = await harness.durable.fetch(new Request(`https://meeting.test${path}`));
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("POST");
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: "METHOD_NOT_ALLOWED",
        path,
      });
      // 這才是重點：`GET /session/start` 從前會真的建 session 並 arm alarm。
      const after = await call(harness.durable, "/session");
      expect(after.status, path).toBe(404);
      expect(after.body, path).toMatchObject({ error: "SESSION_NOT_STARTED" });
      expect(harness.alarms, path).toHaveLength(0);
    }
  });

  it("/release 沒東西可放 → { released:false, deferred:false } 並回報 stats", async () => {
    const { durable } = makeDurable();
    const { status, body } = await post(durable, "/release");
    expect(status).toBe(200);
    expect(body).toMatchObject({ released: false, deferred: false, deferredReleases: 0, opens: 0 });
  });

  it("/release 撞上正在交付中的 harness → deferred:true，且不關掉它", async () => {
    const { durable } = makeDurable();
    // 不 await：讓 open 停在 in-flight，再去 release。
    const health = durable.fetch(new Request("https://meeting.test/health"));
    const { status, body } = await post(durable, "/release");
    expect(status).toBe(200);
    expect(body).toMatchObject({ released: false, deferred: true, deferredReleases: 1 });
    await expect(health).resolves.toBeInstanceOf(Response); // 交付照常完成（不因 release 而斷）
  });

  it("未知路徑 → 404 NOT_FOUND", async () => {
    const { durable } = makeDurable();
    const { status, body } = await call(durable, "/nope");
    expect(status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
  });
});
