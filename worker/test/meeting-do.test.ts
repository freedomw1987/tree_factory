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

async function call(durable: MeetingDurableObject, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(new Request(`https://meeting.test${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("MeetingDurableObject（TECH-004）", () => {
  it("/wake 沒帶 ms → 400 MS_REQUIRED（不可退化成 0 造成忙迴圈）", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await call(durable, "/wake");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(body.example).toBe(`/wake?ms=${DEFAULT_ALARM_DELAY_MS}`);
    expect(alarms).toEqual([]);
  });

  it("/wake?ms= 空字串 → 400 MS_REQUIRED（Number(\"\") 是 0，絕不可以放行）", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await call(durable, "/wake?ms=");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(alarms).toEqual([]);
  });

  it("/wake?ms=（只有空白）→ 400 MS_REQUIRED", async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await call(durable, "/wake?ms=%20%20");
    expect(status).toBe(400);
    expect(body.error).toBe("MS_REQUIRED");
    expect(alarms).toEqual([]);
  });

  it("/wake 非數字或負數 → 400 MS_INVALID", async () => {
    const { durable, alarms } = makeDurable();
    for (const raw of ["abc", "-1"]) {
      const { status, body } = await call(durable, `/wake?ms=${raw}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: "MS_INVALID", value: raw });
    }
    expect(alarms).toEqual([]);
  });

  it(`/wake 超過 ${MAX_ALARM_DELAY_MS}ms → 400 MS_TOO_LARGE（一次醒來最多再往前排這麼久）`, async () => {
    const { durable, alarms } = makeDurable();
    const { status, body } = await call(durable, `/wake?ms=${MAX_ALARM_DELAY_MS + 1}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "MS_TOO_LARGE", max: MAX_ALARM_DELAY_MS });
    expect(alarms).toEqual([]);
  });

  it("/wake 邊界值（剛好等於上限）與正常值 → 200 並真的設定 alarm", async () => {
    const { durable, alarms } = makeDurable();
    const boundary = await call(durable, `/wake?ms=${MAX_ALARM_DELAY_MS}`);
    expect(boundary.status).toBe(200);
    expect(boundary.body).toMatchObject({ scheduled: true, previous: null });

    const normal = await call(durable, "/wake?ms=1500");
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
    const { status, body } = await call(durable, "/wake?ms=0");
    expect(status).toBe(200);
    expect(body).toMatchObject({ scheduled: true });
    expect(alarms).toHaveLength(1);
  });

  it("/wake?ms=0.5／0x1f／1e3 → 400 MS_INVALID（只收十進位整數字串）", async () => {
    for (const raw of ["0.5", "0x1f", "1e3", " 1500x", "+5"]) {
      const { durable, alarms } = makeDurable();
      const { status, body } = await call(durable, `/wake?ms=${encodeURIComponent(raw)}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: "MS_INVALID" });
      expect(alarms).toEqual([]);
    }
  });

  it("/release 沒東西可放 → { released:false, deferred:false } 並回報 stats", async () => {
    const { durable } = makeDurable();
    const { status, body } = await call(durable, "/release");
    expect(status).toBe(200);
    expect(body).toMatchObject({ released: false, deferred: false, deferredReleases: 0, opens: 0 });
  });

  it("/release 撞上正在交付中的 harness → deferred:true，且不關掉它", async () => {
    const { durable } = makeDurable();
    // 不 await：讓 open 停在 in-flight，再去 release。
    const health = durable.fetch(new Request("https://meeting.test/health"));
    const { status, body } = await call(durable, "/release");
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
