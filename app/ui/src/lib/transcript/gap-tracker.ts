/**
 * M01-US-107：背景／鎖屏的逐字稿缺口追蹤器（純 TS，可單測）。
 *
 * 為什麼不寫在 `app.svelte.ts`：runes 需要編譯才能跑，這裡的規則（同一次中斷只標一筆、
 * 離線不丟、重開不重算 seq）是**這張票的核心**，必須能在 vitest 裡被直接驗。
 *
 * 三個關鍵決定（詳見 docs/design/M01-US-107-transcript-gap.md §2）：
 * - D2 **先開後閉**：`hidden` 當下寫一筆 `toMs:null`（app 可能再也沒回來），
 *   回前景時用同一個 seq 補上結束時間。
 * - D3 **seq 持久化**：重開後從本機既有最大值 +1。若從 1 重算，新缺口會被伺服端
 *   當成「同 seq 重送」而丟掉——那是最糟的靜默資料錯誤。
 * - D4 同 seq 只能是同一次中斷：記憶體裡的 `#openSeq` 擋掉重複的 `hidden`。
 *   重開（`load()`）後刻意把它清成 null：上一次的未閉合缺口是**過去**的區間，
 *   這次再中斷是新的區間（中間 app 是關著的，那段也沒錄到）。
 */

export interface TranscriptGap {
  seq: number;
  /** 相對會議開始的毫秒。 */
  fromMs: number;
  /** `null` = 還沒回到前景（UI 必須明說「結束時間未知」）。 */
  toMs: number | null;
}

export interface GapRecord extends TranscriptGap {
  /** 伺服端是否已收下（false = 待補送）。 */
  synced: boolean;
  /**
   * 與伺服端既有缺口衝突（同 seq、不同 fromMs）：永久性錯誤，不再重送。
   * 顯示時要說出來——使用者看到的是伺服端那份範圍，不是本機這份。
   */
  conflict?: boolean;
  /**
   * 伺服端**永久**不再接受這筆（`SESSION_ENDED` / `LIMIT_REACHED` / `SESSION_NOT_STARTED`）。
   * 本機保留但不再重送——繼續顯示「待同步」等於對使用者承諾一件永遠不會發生的事。
   */
  terminal?: boolean;
}

export interface GapApi {
  writeGap(input: TranscriptGap): Promise<void>;
  listGaps(): Promise<TranscriptGap[]>;
}

export interface GapStorage {
  read(): GapRecord[];
  write(gaps: GapRecord[]): void;
}

export interface GapTrackerOptions {
  api: GapApi;
  storage: GapStorage;
  /** 相對會議開始的毫秒（由 recorder store 的 `snapshot.elapsedMs` 提供）。 */
  elapsedMs(): number;
  onChange?(gaps: GapRecord[]): void;
}

export class GapTracker {
  readonly #api: GapApi;
  readonly #storage: GapStorage;
  readonly #elapsedMs: () => number;
  readonly #onChange: ((gaps: GapRecord[]) => void) | undefined;
  #gaps: GapRecord[] = [];
  /** 記憶體中的「這一輪還開著的缺口」；重開後一定是 null（見檔頭）。 */
  #openSeq: number | null = null;

  constructor(options: GapTrackerOptions) {
    this.#api = options.api;
    this.#storage = options.storage;
    this.#elapsedMs = options.elapsedMs;
    this.#onChange = options.onChange;
  }

  gaps(): GapRecord[] {
    return this.#gaps.map((gap) => ({ ...gap }));
  }

  /** 重開（或換到這場會議）時：讀回本機缺口，並把「未閉合」的狀態歸零。 */
  async load(): Promise<void> {
    this.#gaps = readRecords(this.#storage);
    this.#openSeq = null;
    this.#emit();
    await Promise.resolve();
  }

  /**
   * `visibilitychange → hidden`（或鎖屏）當下呼叫。
   * 同一次中斷重複觸發 → **什麼都不做**（AC-3）。
   */
  async handleHidden(): Promise<void> {
    if (this.#openSeq !== null) return;
    const gap: GapRecord = {
      seq: nextSeq(this.#gaps),
      fromMs: elapsedOf(this.#elapsedMs()),
      toMs: null,
      synced: false,
    };
    this.#gaps = [...this.#gaps, gap];
    this.#openSeq = gap.seq;
    // 先落地再送出：`hidden` 之後 app 隨時可能被系統殺掉，本機是最後的保證。
    this.#persist();
    this.#emit();
    await this.#push(gap.seq);
  }

  /** 回到前景／續錄／結束會議時呼叫：補上結束時間（只延長、不縮短）。 */
  async handleVisible(): Promise<void> {
    const seq = this.#openSeq;
    if (seq === null) return;
    this.#openSeq = null;
    const current = this.#gaps.find((gap) => gap.seq === seq);
    if (current === undefined) return;
    const toMs = Math.max(current.fromMs, elapsedOf(this.#elapsedMs()));
    this.#gaps = this.#gaps.map((gap) => (gap.seq === seq ? { ...gap, toMs, synced: false } : gap));
    this.#persist();
    this.#emit();
    await this.#push(seq);
  }

  /**
   * 對帳：把待補送的送出去，並把伺服端有而本機沒有的缺口拉回來。
   * 離線是常態（`hidden` 常伴隨斷網），所以這裡**不丟錯**：失敗就留著下次再試。
   * 已判定永久送不出去的（`terminal`）不重試，不然每次啟動都白打一次伺服端。
   */
  async sync(): Promise<void> {
    for (const gap of this.#gaps.filter((item) => !item.synced && item.terminal !== true)) {
      await this.#push(gap.seq);
    }
    try {
      const remote = await this.#api.listGaps();
      this.#merge(remote);
      this.#persist();
      this.#emit();
    } catch {
      // 連不上：保留本機狀態（下次 sync 再拉）。
    }
  }

  /** 送出一筆（成敗都只影響 `synced` 旗標，不影響本機資料）。 */
  async #push(seq: number): Promise<void> {
    const gap = this.#gaps.find((item) => item.seq === seq);
    if (gap === undefined) return;
    if (gap.conflict === true || gap.terminal === true) return; // 永久性：再送一百次也不會變，不再打伺服端
    try {
      await this.#api.writeGap({ seq: gap.seq, fromMs: gap.fromMs, toMs: gap.toMs });
      this.#gaps = this.#gaps.map((item) => (item.seq === seq ? { ...item, synced: true } : item));
      this.#persist();
      this.#emit();
    } catch (error) {
      if (conflictOf(error)) {
        // 衝突代表伺服端已經有同 seq 但不同的缺口；本機這份作廢但**不刪**（使用者看得到才不會被騙）。
        // 範圍整筆等下一次 `sync()` 的 pull-merge 換成伺服端那份（F2：不混兩邊的時間）。
        this.#gaps = this.#gaps.map((item) =>
          item.seq === seq ? { ...item, synced: true, conflict: true } : item,
        );
        this.#persist();
        this.#emit();
        return;
      }
      if (permanentOf(error)) {
        // 伺服端說這一場已經結束 / 到了上限：這一筆永遠送不進去。本機保留（不刪），
        // 但標成 terminal 不再重試，UI 也得說「僅存本機」（Gate 4 F5）。
        this.#gaps = this.#gaps.map((item) =>
          item.seq === seq ? { ...item, synced: false, terminal: true } : item,
        );
        this.#persist();
        this.#emit();
        return;
      }
      // 其他錯誤（斷網、伺服端 5xx）：保留 `synced:false`，由下一次 sync 補送。
    }
  }

  #merge(remote: TranscriptGap[]): void {
    const map = new Map(this.#gaps.map((gap) => [gap.seq, gap]));
    for (const item of remote) {
      if (!isValidGap(item)) continue;
      const local = map.get(item.seq);
      const conflict = local !== undefined && local.fromMs !== item.fromMs;
      if (conflict) {
        // 兩邊對同一個 seq 講不同的起點：本機那份本來就被伺服端拒了（409 GAP_CONFLICT），
        // 所以整筆用伺服端那份，**不混**本機的結束時間（F2：混了會生出不存在的區間）。
        map.set(item.seq, {
          seq: item.seq,
          fromMs: item.fromMs,
          toMs: item.toMs,
          synced: true,
          conflict: true,
        });
        continue;
      }
      // 「本機說有結束時間、伺服端說還開著」時**不可**改判為已同步（D-US107-7）：
      // 那代表先前補 `toMs` 那一次被拒收（會議已結束 / 上限到點），若這裡把 `synced` 升成 true，
      // 那個結束時間就再也不會被送出——畫面上會出現一個伺服端沒有的結束時間。
      const localHasEnd = local?.toMs !== null && local?.toMs !== undefined;
      const remoteHasEnd = item.toMs !== null;
      const synced = localHasEnd && !remoteHasEnd ? (local?.synced ?? false) : true;
      const merged = mergeToMs(local?.toMs ?? null, item.toMs);
      map.set(item.seq, {
        seq: item.seq,
        // 伺服端是權威來源：以它那份 fromMs 為準。
        fromMs: item.fromMs,
        // 任何情況下都不可以讓 `toMs < fromMs`（gate 4 F2 的防線）。
        toMs: merged === null ? null : Math.max(merged, item.fromMs),
        synced,
        ...(local?.terminal === true ? { terminal: true } : {}),
      });
    }
    this.#gaps = [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  #persist(): void {
    try {
      this.#storage.write(this.#gaps);
    } catch {
      // 本機寫不進去（隱私模式 / 額度滿）：畫面仍可用，只是重開後要靠伺服端補回。
    }
  }

  #emit(): void {
    this.#onChange?.(this.gaps());
  }
}

/** 本機（localStorage）儲存：一場會議一個 key。 */
export const GAP_STORAGE_PREFIX = "tree_factory.transcript-gaps.v1:";

/**
 * 哪些會議還有**沒送出去**的缺口（重開後補送用）。
 *
 * 為什麼需要它：`hidden` 當下斷網、使用者接著把 app 從背景滑掉，這時本機那筆就會一直躺在
 * localStorage；沒有這個掃描，它永遠不會被送到伺服端——而使用者已經看到「未錄到」的缺口了。
 */
export function listPendingGapMeetings(
  storage: Pick<Storage, "length" | "key" | "getItem"> | undefined = globalThis.localStorage,
): string[] {
  if (storage === undefined) return [];
  const pending: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(GAP_STORAGE_PREFIX)) continue;
      const meetingId = key.slice(GAP_STORAGE_PREFIX.length);
      if (meetingId === "") continue;
      const records = parseRecords(storage.getItem(key));
      // `terminal` 的不算「待補送」：它們已經被判永久送不出去，掃進來只會每次啟動白試一次
      // （又要等一輪 409）。
      if (records.some((record) => !record.synced && record.terminal !== true)) pending.push(meetingId);
    }
  } catch {
    return pending;
  }
  return pending;
}

export function createLocalGapStorage(
  meetingId: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage,
): GapStorage {
  const key = `${GAP_STORAGE_PREFIX}${meetingId}`;
  return {
    read: () => parseRecords(storage?.getItem(key)),
    write: (gaps) => {
      try {
        if (gaps.length === 0) {
          storage?.removeItem(key);
          return;
        }
        storage?.setItem(key, JSON.stringify(gaps));
      } catch {
        // 同上：寫不進去不是致命錯誤。
      }
    },
  };
}

/** 下一個 seq = 本機最大值 + 1（**不可**重算，見 D3）。 */
export function nextSeq(gaps: Array<{ seq: number }>): number {
  return gaps.reduce((max, gap) => Math.max(max, gap.seq), 0) + 1;
}

/** 兩個結束時間取「較長」的那個（`null` = 尚未閉合，讓位給已知值）。 */
export function mergeToMs(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** elapsed 一律取非負整數毫秒（裝置端時間軸可能因系統時鐘倒退變負）。 */
export function elapsedOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isValidGap(value: unknown): value is TranscriptGap {
  const gap = value as { seq?: unknown; fromMs?: unknown; toMs?: unknown };
  if (!Number.isSafeInteger(gap.seq) || (gap.seq as number) < 1) return false;
  if (!Number.isSafeInteger(gap.fromMs) || (gap.fromMs as number) < 0) return false;
  if (gap.toMs === null || gap.toMs === undefined) return true;
  return Number.isSafeInteger(gap.toMs) && (gap.toMs as number) >= (gap.fromMs as number);
}

function isValidRecord(value: unknown): value is GapRecord {
  return isValidGap(value) && typeof (value as { synced?: unknown }).synced === "boolean";
}

/** 把任何帶 `code` 的錯誤當成 API 錯誤判斷（不 import api.ts，保持這層沒有相依）。 */
function conflictOf(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "GAP_CONFLICT";
}

/** 伺服端永久拒絕（會議已結束 / 上限到點 / 還沒開始）：重試再多次也不會成功。 */
function permanentOf(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "PERMANENT";
}

/** 解析本機存的缺口陣列；壞掉（不是 JSON / 不是陣列 / 單筆不合法）一律當成沒有，不丟錯。 */
function parseRecords(raw: string | null | undefined): GapRecord[] {
  try {
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidRecord) : [];
  } catch {
    return [];
  }
}

function readRecords(storage: GapStorage): GapRecord[] {
  try {
    return storage
      .read()
      .filter(isValidRecord)
      .map((record) => ({ ...record }))
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}