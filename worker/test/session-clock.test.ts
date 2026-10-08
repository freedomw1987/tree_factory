// TECH-008：session 讀取帶入「現在時間」——擋下「時間軸被推到未來」的 DB 竊改。
//
// **這一票真正擋下什麼（Gate 4 oracle 實測後校正，不要寫得比事實大）**：
//   設 Δ = 兩欄一起平移的量、elapsed = `now - started_at`（平移前），則
//     `違規 ⟺ Δ > elapsed + SESSION_CLOCK_TOLERANCE_MS`
//   會擋住的只有「把 `started_at` 推到『現在 + 60s』之後」；**Δ ≤ elapsed + 60s 一律放行**，
//   所以「已錄 1 小時後再往後推 1 小時（上限從 2h 變 3h）」是**放行**的（見檔尾釘樁群）。
//   理由：這裡只能驗**位置**，DB 內沒有不可同步改寫的錨點；真正的補法要 DO 外的錨點 → 另立票。
//
// 動手改 `session.ts` / `session-store.ts` / `meeting-do.ts` 之前先紅的是 **7 條**：
//   * 純函式 `sessionClockViolation` 不存在（未來的 started_at 沒有任何檢查）。
//   * `SessionStore.read(nowMs)` 沒有時間參數 → 「推到未來」的平移完全看不到。
//   * DO 對壞資料只回 `INTERNAL`，分不出「被竊改」與「程式 bug」。
// 護欄群（改動前後都要綠）：合法的舊會議、錄到上限卻沒人碰過的 recording session、
// 「時鐘回調」的容忍 —— 時間帶入不得讓既有收尾路徑失效或被誤擋。
// 釘樁群（檔尾）：把**擋不掉的那一半**釘在測試裡（已知限制就是規格的一部分），
// 免得未來有人看到一排綠燈就以為「同量平移一律擋得住」。

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MEETING_MAX_MS,
  SESSION_CLOCK_TOLERANCE_MS,
  sessionClockViolation,
  startSession,
  stopSession,
  type MeetingSession,
} from "../src/session.js";
import { MeetingDurableObject, type MeetingDurableObjectContext } from "../src/meeting-do.js";
import type { MeetingBindings } from "../src/harness/meeting-harness.js";
import { SessionStore, type SessionSql } from "../src/storage/session-store.js";

const STARTED = 1_700_000_000_000;

/** 把 node:sqlite 包成 DO `storage.sql` 的形狀（與 session-store.test.ts 同做法）。
 *
 * 多回一個 `writes`：蒐集所有非讀取的語句，用來證明「讀取失敗時一行都不寫」
 * （只比對欄位值不夠 —— 寫回同一份壞資料，值還是一樣的）。 */
function sqlDevice(): { db: DatabaseSync; sql: SessionSql; writes: string[] } {
  const db = new DatabaseSync(":memory:");
  const writes: string[] = [];
  const sql: SessionSql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(select|with|pragma|explain)/i.test(query)) {
        const rows =
          bindings.length > 0 ? db.prepare(query).all(...(bindings as never[])) : db.prepare(query).all();
        return { toArray: () => rows };
      }
      writes.push(query);
      if (bindings.length > 0) {
        db.prepare(query).run(...(bindings as never[]));
      } else {
        db.exec(query);
      }
      return { toArray: () => [] };
    },
  };
  return { db, sql, writes };
}

/** 兩欄一起往後推（差額仍是 2h）：這正是原本的驗證看不到的竊改。 */
function shiftSessionBy(db: DatabaseSync, deltaMs: number): void {
  db.prepare("UPDATE meeting_session SET started_at_ms = started_at_ms + ?, ends_at_ms = ends_at_ms + ? WHERE id = 1").run(
    deltaMs,
    deltaMs,
  );
}

function doDevice(nowMs = STARTED): {
  durable: MeetingDurableObject;
  db: DatabaseSync;
  tick: (ms: number) => void;
} {
  const db = new DatabaseSync(":memory:");
  let now = nowMs;
  const ctx: MeetingDurableObjectContext = {
    now: () => now,
    id: { toString: () => "do-test" },
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          if (/^\s*(select|with|pragma|explain)/i.test(query)) {
            const rows =
              bindings.length > 0
                ? db.prepare(query).all(...(bindings as never[]))
                : db.prepare(query).all();
            return { toArray: () => rows, rowsWritten: 0 };
          }
          if (bindings.length > 0) {
            const result = db.prepare(query).run(...(bindings as never[]));
            return { toArray: () => [], rowsWritten: Number(result.changes) };
          }
          db.exec(query);
          return { toArray: () => [], rowsWritten: 0 };
        },
      },
      async setAlarm() {},
      async getAlarm() {
        return null;
      },
      async transaction<T>(callback: (tx: { rollback(): void }) => T | Promise<T>): Promise<T> {
        return callback({ rollback: () => {} });
      },
    },
  } as unknown as MeetingDurableObjectContext;
  return { durable: new MeetingDurableObject(ctx, {} as MeetingBindings), db, tick: (ms) => (now += ms) };
}

async function call(
  durable: MeetingDurableObject,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await durable.fetch(
    new Request(`https://meeting.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("M01-TECH-008 session 讀取的時間合理性", () => {
  it("M01-TECH-008 Given 會議在未來開始 When 檢查 Then 指名 started_at_ms 的違規說明", () => {
    const session = startSession("m-1", STARTED + 60 * 60 * 1000);
    const violation = sessionClockViolation(session, STARTED);
    expect(violation).toContain("started_at_ms");
  });

  it("M01-TECH-008 Given 容忍邊界 When 檢查 Then 恰好容忍內放行、再多 1 毫秒就違規", () => {
    const atEdge = startSession("m-1", STARTED + SESSION_CLOCK_TOLERANCE_MS);
    expect(sessionClockViolation(atEdge, STARTED)).toBeNull();
    const overEdge = startSession("m-1", STARTED + SESSION_CLOCK_TOLERANCE_MS + 1);
    expect(sessionClockViolation(overEdge, STARTED)).not.toBeNull();
  });

  it("M01-TECH-008 Given 合法的舊會議（10 小時前結束）When 檢查 Then 放行（沒有下界規則）", () => {
    const old = stopSession(startSession("m-1", STARTED), STARTED + 60_000, "user");
    expect(sessionClockViolation(old, STARTED + 10 * 60 * 60 * 1000)).toBeNull();
  });

  it("M01-TECH-008 Given 錄到上限卻沒人碰過的 recording session When 檢查 Then 不算違規（交給過期收尾）", () => {
    const recording = startSession("m-1", STARTED);
    expect(sessionClockViolation(recording, STARTED + MEETING_MAX_MS + 60 * 60 * 1000)).toBeNull();
  });

  it("M01-TECH-008 Given ends_at 被推超過「現在 + 上限」（差額也破了）When 檢查 Then 指名 ends_at_ms", () => {
    // 這一條是獨立斷言：正常情況下它由 started_at 規則 + 不變式共同涵蓋，
    // 但若未來有人調整檢查順序或放寬不變式，它必須自己站得住。
    const tampered: MeetingSession = {
      ...startSession("m-1", STARTED),
      endsAtMs: STARTED + MEETING_MAX_MS + SESSION_CLOCK_TOLERANCE_MS + 1,
    };
    expect(sessionClockViolation(tampered, STARTED)).toContain("ends_at_ms");
  });

  it("M01-TECH-008 Given 剛開始錄音（elapsed 0）When 兩欄一起往後推 1 小時 Then SESSION_CORRUPT 且 DB 未被改寫", () => {
    const { db, sql, writes } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    shiftSessionBy(db, 60 * 60 * 1000);
    const before = writes.length;
    expect(() => store.read(STARTED)).toThrowError(/SESSION_CORRUPT/);
    // 唯讀：驗證失敗不得寫回任何東西（少了這一行，「寫回同一份壞資料」是抓不到的）。
    expect(writes.length).toBe(before);
    const rows = db.prepare("SELECT started_at_ms AS s, ends_at_ms AS e FROM meeting_session").all() as {
      s: number;
      e: number;
    }[];
    expect(rows[0]).toEqual({ s: STARTED + 60 * 60 * 1000, e: STARTED + MEETING_MAX_MS + 60 * 60 * 1000 });
  });

  it("M01-TECH-008 Given 時鐘回調（讀取時刻比開始早 30 秒）When 讀取 Then 放行（容忍真實抖動）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    expect(store.read(STARTED - 30_000)?.session.startedAtMs).toBe(STARTED);
  });

  it("M01-TECH-008 Given DO 的 session 剛開始錄音（elapsed 0）被平移 1 小時 When GET /session Then 500 且 error=SESSION_CORRUPT", async () => {
    const { durable, db } = doDevice();
    expect((await call(durable, "/session/start", {})).status).toBe(201);
    shiftSessionBy(db, 60 * 60 * 1000);
    const response = await call(durable, "/session");
    expect(response.status).toBe(500);
    expect(response.body.error).toBe("SESSION_CORRUPT");
    expect(response.body.recoverable).toBe(false);
  });

  it("M01-TECH-008 Given 正常會議 When GET /session Then 200 且仍在 recording（時間檢查不誤擋）", async () => {
    const { durable } = doDevice();
    await call(durable, "/session/start", {});
    const response = await call(durable, "/session");
    expect(response.status).toBe(200);
    expect(response.body.phase).toBe("recording");
  });

  it("M01-TECH-008 Given 錄到上限後沒人碰過 When GET /session Then 200 且被收成 limit（時間帶入不得擋掉收尾）", async () => {
    const { durable, tick } = doDevice();
    await call(durable, "/session/start", {});
    tick(MEETING_MAX_MS + 60_000);
    const response = await call(durable, "/session");
    expect(response.status).toBe(200);
    expect(response.body.phase).toBe("limit_reached");
    expect(response.body.endedReason).toBe("limit");
  });

  // ---- 釘樁群：以下是**已知限制**，不是「還沒想到」。改壞了要讓它紅。 ----
  // 依據：`違規 ⟺ Δ > elapsed + TOL`（見檔頭）。ecosystem 沒有可信錨點之前，
  // 「已錄時間以內的平移」與「真實歷史」在 DB 裡無法區分，所以只能放行 ——
  // 這一半必須被測試釘住，否則整排綠燈會給出「同量平移擋得住」的假保證。

  it("M01-TECH-008 Given 已錄 1 小時 When 兩欄一起再往後推 1 小時 Then 放行（已知限制，見 AC 刻意不做）", async () => {
    const { durable, db, tick } = doDevice();
    expect((await call(durable, "/session/start", {})).status).toBe(201);
    tick(60 * 60 * 1000); // 真的錄了 1 小時
    shiftSessionBy(db, 60 * 60 * 1000); // 差值仍是 2h
    const response = await call(durable, "/session");
    // 放行不是 bug 被漏掉，是這一票的**已知邊界**：釘在這裡，未來補了錨點就會紅。
    expect(response.status).toBe(200);
    expect(response.body.phase).toBe("recording");
    // 原本只剩 1 小時，現在又是滿滿 2 小時 —— 上限確實被續命了。
    expect(response.body.remainingMs).toBe(MEETING_MAX_MS);
  });

  it("M01-TECH-008 Given 已超過上限的會議 When 平移把時間軸搬到現在 Then 放行（上限可被續命）", async () => {
    const { durable, db, tick } = doDevice();
    await call(durable, "/session/start", {});
    tick(130 * 60 * 1000); // 已過 2h 上限
    shiftSessionBy(db, 130 * 60 * 1000);
    const response = await call(durable, "/session");
    // 過期會議被「搬」回現在就復活了；靠 alarm 擋不住（見設計 D7：alarm 會跟著被改的值跑）。
    expect(response.status).toBe(200);
    expect(response.body.phase).toBe("recording");
    expect(response.body.remainingMs).toBe(MEETING_MAX_MS);
  });

  it("M01-TECH-008 Given 平移量 = 已錄時間 + 容忍值 + 1ms When 讀取 Then 擋下（真正的邊界）", async () => {
    const { durable, db, tick } = doDevice();
    await call(durable, "/session/start", {});
    const elapsed = 5 * 60 * 1000;
    tick(elapsed);
    shiftSessionBy(db, elapsed + SESSION_CLOCK_TOLERANCE_MS + 1);
    const response = await call(durable, "/session");
    expect(response.status).toBe(500);
    expect(response.body.error).toBe("SESSION_CORRUPT");
  });

  it("M01-TECH-008 Given 剛開始錄音（elapsed 0）When 時鐘回跳 61 秒 Then 擋下（會議開頭鎖死）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    // 回跳的容忍量同樣是 `elapsed + TOL`：剛開始錄音時只容忍 60 秒。
    // 這是刻意的降級（寧可吵鬧也不要靜默延長上限），代價寫在交付文 §4。
    expect(() => store.read(STARTED - 61_000)).toThrowError(/SESSION_CORRUPT/);
  });

  it("M01-TECH-008 Given 讀取時間不是有限數 When 讀取 Then SESSION_CORRUPT（不得靜默放行）", () => {
    const { sql } = sqlDevice();
    const store = new SessionStore(sql);
    store.write({ session: startSession("m-1", STARTED), transcriptWrites: 0 });
    // NaN / Infinity 會讓兩條上界比較全部是 false → 檢查靜默失效（Gate 4 oracle F2）。
    expect(() => store.read(Number.NaN)).toThrowError(/SESSION_CORRUPT/);
    expect(() => store.read(Number.POSITIVE_INFINITY)).toThrowError(/SESSION_CORRUPT/);
  });

  it("M01-TECH-008 Given 壞資料 When alarm 醒來 Then 也拋 SESSION_CORRUPT（平台會重試，見設計 D4/D5）", async () => {
    const { durable, db } = doDevice();
    await call(durable, "/session/start", {});
    shiftSessionBy(db, 60 * 60 * 1000);
    // alarm 不吞錯：壞資料下每次醒來都拋，平台會重試 —— 這是**已知**行為，
    // 釘在這裡以示「不是意外」，並提醒未來別用它當第二錨點（設計 D7）。
    await expect(durable.alarm()).rejects.toThrowError(/SESSION_CORRUPT/);
  });
});
