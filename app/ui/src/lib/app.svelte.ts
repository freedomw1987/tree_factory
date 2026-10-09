/**
 * M01-US-101 的 app 狀態層（Svelte 5 runes）。
 *
 * 這裡是「畫面狀態」與「錄音核心」之間的唯一接縫：
 * - 畫面狀態（view / tab / 會議列表）住在這個檔案；
 * - 錄音核心（狀態機 + 麥克風 + session）住在 `lib/recorder/*`，只有透過 `RecorderStore` 溝通。
 *
 * 依 DESIGN.md §3.0：階段 A 就必須有底部 tab bar 容器（預設 tab = 會議），
 * 且深層連結不得指涉「首頁」——所以 view 只是畫面名稱，不是導覽結構。
 */

import { ChunkPipeline, ChunkRecovery, chunkUploadApi, type RecoveryEntry } from "./recorder/chunk-pipeline";
import { openChunkStore, type OpenedChunkStore } from "./recorder/chunk-store";
import { MEETING_MAX_MS } from "./recorder/limit";
import { MediaRecorderCapture, type CaptureChunk } from "./recorder/media";
import { RecorderStore, type RecorderSnapshot } from "./recorder/store";
import { WakeLockManager, type WakeLockSentinelLike, type WakeLockState } from "./recorder/wake-lock";
import type { UploadOutcome } from "./recorder/uploader";
import { HttpSessionClient, SessionApiError } from "./session/api";
import { createLocalGapStorage, GapTracker, listPendingGapMeetings, type GapRecord } from "./transcript/gap-tracker";
import { LiveTranscript, type TimelineEntry } from "./transcript/live-transcript";
import { LiveTranscriptFeed, type FeedStatus } from "./transcript/live-transcript-feed";

export type View = "list" | "start" | "permission" | "meeting" | "recover";
export type Tab = "meetings" | "chat";

export type MeetingStatus = "recording" | "interrupted" | "ended" | "limit_reached";

export interface MeetingListItem {
  id: string;
  title: string;
  startedAtMs: number;
  endsAtMs: number;
  status: MeetingStatus;
}

const STORAGE_KEY = "tree_factory.meetings.v1";
const EMPTY_SNAPSHOT: RecorderSnapshot = {
  state: "idle",
  pending: false,
  elapsedMs: 0,
  remainingMs: MEETING_MAX_MS,
  warn: false,
  gapMarked: 0,
};

export const app = $state({
  tab: "meetings" as Tab,
  view: "list" as View,
  /** 列表載入中（DESIGN §3.1 首頁的 Loading 狀態）。 */
  loadingList: true,
  meetings: [] as MeetingListItem[],
  currentMeetingId: null as string | null,
  currentTitle: "",
  starting: false,
  /** 給畫面的一次性提示（例：產生記錄還沒接上）。 */
  toast: null as string | null,
  /** M01-US-102 恢復畫面：還有未確認分段的會議（null = 沒有或還沒掃描）。 */
  recovery: null as { durable: boolean; entries: RecoveryEntry[] } | null,
  /** 恢復動作進行中（按鈕鎖定用）。 */
  recoveryBusy: false,
  /** M01-US-107：這一場會議的逐字稿缺口（依 seq 排序，含未同步的）。 */
  gaps: [] as GapRecord[],
  /**
   * M01-US-108：螢幕防關的現況（畫面要誠實反映，見 wake-lock.ts 的 `wakeLockHint`）。
   * `active` = 真的壓住了；`unsupported` / `denied` / `lost` = 沒壓住，畫面必須明說「請保持畫面開啟」。
   */
  wakeLockState: "idle" as WakeLockState,
});

export const rec = $state({ snapshot: EMPTY_SNAPSHOT });

export function workerBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_WORKER_BASE_URL;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : "http://127.0.0.1:8787";
}

let store: RecorderStore | null = null;
let unsubscribe: (() => void) | null = null;
let openedStore: OpenedChunkStore | null = null;
let storeInit: Promise<void> | null = null;
let pipeline: ChunkPipeline | null = null;
let recovery: ChunkRecovery | null = null;
let gapTracker: GapTracker | null = null;
let wakeLockManager: WakeLockManager | null = null;
let conflictReported = false;
let gapReported = false;

/** 錄音核心（畫面不得直接改它，只能呼叫這裡的 action）。 */
export function recorderStore(): RecorderStore | null {
  return store;
}

/** 依會議 id 取得該場的上傳 API（恢復流程用；與即時錄音走同一條 HTTP client）。 */
function chunkApiFor(meetingId: string) {
  return chunkUploadApi(new HttpSessionClient({ baseUrl: workerBaseUrl(), meetingId }));
}

/**
 * M01-US-107：這一場會議的缺口追蹤器。
 *
 * 為什麼要 `load()` 才開始：seq 一定要接著本機既有最大值往下（D3）。
 * 從 1 重算的話，重開後的第一次中斷會被伺服端當成「同 seq 重送」而丟——
 * 使用者會看到一段沒有任何標記的空白，那是最糟的靜默資料錯誤。
 */
async function startGapTracking(meetingId: string): Promise<void> {
  gapTracker = new GapTracker({
    api: new HttpSessionClient({ baseUrl: workerBaseUrl(), meetingId }),
    storage: createLocalGapStorage(meetingId),
    // 牆鐘 elapsed（不是 `snapshot.elapsedMs`）：中斷時 snapshot 是凍結值，用它會把缺口
    // 記成 0 秒——真實缺了幾分鐘卻說「長度不到 1 秒」（Gate 4 F1）。
    elapsedMs: () => store?.wallClockElapsedMs ?? 0,
    onChange: setGaps,
  });
  await gapTracker.load();
}

/**
 * M01-US-104：畫面上的缺口**只有這一條路徑**能改。
 *
 * 為什麼不能只寫 `app.gaps = gaps`：畫面現在渲染的是 `transcript.entries`（一份算好的快照），
 * 只改 `app.gaps` 的話缺口列會停在舊物件上——離線補送成功後「待同步」會永遠掛著
 * （本機已經 `synced:true`，畫面卻還說沒送出去）。
 */
function setGaps(gaps: GapRecord[]): void {
  app.gaps = gaps;
  syncTranscript();
}

/**
 * M01-US-104：即時逐字稿的畫面狀態。
 *
 * 為什麼 `entries` 是「算好再放進 $state」而不是在畫面裡直接呼叫 `timeline()`：
 * `timeline()` 會排序＋裁切；每次渲染都算等於每一句到來都做一次全表排序。
 */
export const transcript = $state({
  entries: [] as TimelineEntry<GapRecord>[],
  committed: 0,
  omitted: 0,
  following: true,
  unread: 0,
  status: { ok: true, error: null, lastOkMs: null } as FeedStatus,
});

let liveTranscript = new LiveTranscript<GapRecord>();
let transcriptFeed: LiveTranscriptFeed | null = null;

function syncTranscript(): void {
  liveTranscript.applyGaps(app.gaps);
  transcript.entries = liveTranscript.timeline();
  const counts = liveTranscript.counts;
  transcript.committed = counts.committed;
  transcript.omitted = counts.omitted;
  transcript.following = liveTranscript.following;
  transcript.unread = liveTranscript.unread;
}

/**
 * M01-US-104 D9：輪詢的生命週期只有一條規則——在會議畫面且真的在錄音才讀。
 * 離開畫面 / 中斷 / 達上限 / 權限阻斷都停：沒有新句還一直打是無意義的流量。
 */
function syncTranscriptPolling(): void {
  if (app.view === "meeting" && rec.snapshot.state === "recording") transcriptFeed?.start();
  else transcriptFeed?.stop();
}

/** 使用者**自己**把逐字稿往上滑（AC-3）：離底部多遠決定要不要繼續跟隨。 */
export function notifyTranscriptScroll(distancePx: number): void {
  liveTranscript.notifyUserScroll(distancePx);
  syncTranscript();
}

/** AC-4：「回到最新 · N 句新」。 */
export function backToLatest(): void {
  liveTranscript.backToLatest();
  syncTranscript();
}

/**
 * 餵入一段未定稿的文字（AC-1）。
 * 裝置端還沒有 STT 連線，所以目前只有 dev 鉤子（`__tf.pushInterim`）用它；
 * 真接線（audio → nova → interim 事件）是後續票的事——不假裝它已經有了。
 */
export function pushInterim(input: {
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
}): void {
  liveTranscript.applyInterim(input);
  syncTranscript();
}

/** 換一場會議：舊的句子不可以跟著帶過去（上一場的內容會變成幻覺）。 */
function resetTranscript(client: HttpSessionClient): void {
  transcriptFeed?.stop();
  liveTranscript = new LiveTranscript<GapRecord>();
  transcript.entries = [];
  transcript.committed = 0;
  transcript.omitted = 0;
  transcript.following = true;
  transcript.unread = 0;
  transcript.status = { ok: true, error: null, lastOkMs: null };
  transcriptFeed = new LiveTranscriptFeed({
    client,
    live: liveTranscript,
    onChange: (status) => {
      transcript.status = status;
      syncTranscript();
    },
  });
}

/**
 * M01-US-108：螢幕防關的 adapter。
 *
 * 為什麼不直接寫 `navigator.wakeLock`：這個 API 在測試環境不存在，而真正會出錯的是狀態機
 * （進背景後要重取、系統釋放要限量重試），注入 adapter 才能在單元測試 / E2E 驗（D2）。
 */
function wakeLockAdapter() {
  const api = (
    navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }
  ).wakeLock;
  return {
    isSupported: () => typeof api?.request === "function",
    request: () => api!.request("screen"),
  };
}

/** 螢幕防關管理器（延遲建立：非瀏覽器環境 import 這個檔案時不得炸）。 */
function wakeLock(): WakeLockManager {
  wakeLockManager ??= new WakeLockManager({
    adapter: wakeLockAdapter(),
    onChange: (state) => {
      app.wakeLockState = state;
    },
  });
  return wakeLockManager;
}

/** 開本機分段儲存（IndexedDB；不可用時退回記憶體並記在 `durable`）。 */
async function ensureStore(): Promise<void> {
  if (openedStore !== null) return;
  storeInit ??= openChunkStore().then((opened) => {
    openedStore = opened;
  });
  await storeInit;
}

/**
 * M01-US-102 AC-3：app 啟動時掃本機暫存，有未完成的會議就進恢復畫面。
 * 為什麼在 `loadMeetings()` 之後才呼叫：先把列表畫出來，不讓掃描卡住首頁畫面。
 */
export async function initRecovery(): Promise<void> {
  await ensureStore();
  const opened = openedStore;
  if (opened === null) return;
  recovery = new ChunkRecovery({ store: opened.store, durable: opened.durable, apiFor: chunkApiFor });
  const entries = await recovery.scan();
  app.recovery = { durable: opened.durable, entries };
  if (entries.length > 0 && (app.view === "list" || app.view === "start")) {
    app.view = "recover";
  }
}

/**
 * M01-US-107：啟動時把「上次沒送出去的缺口」補完。
 *
 * 情境：`hidden` 當下斷網 → 使用者把 app 從背景滑掉。本機那筆缺口永遠躺在 localStorage，
 * 而畫面已經跟使用者說過「這段未錄到」——沒補送就是騙人。
 * 還沒在錄音的會議沒有 tracker 可接，所以這裡自己造一個小的跑一次（重送是幂等的）。
 */
export async function syncPendingGaps(): Promise<void> {
  for (const meetingId of listPendingGapMeetings()) {
    const tracker = new GapTracker({
      api: new HttpSessionClient({ baseUrl: workerBaseUrl(), meetingId }),
      storage: createLocalGapStorage(meetingId),
      elapsedMs: () => 0, // 只有已存在的缺口會被補送，不會新增
      ...(meetingId === app.currentMeetingId ? { onChange: setGaps } : {}),
    });
    await tracker.load();
    await tracker.sync();
  }
}

function dropRecoveryEntry(meetingId: string): void {
  const current = app.recovery;
  if (current === null) return;
  const entries = current.entries.filter((entry) => entry.meetingId !== meetingId);
  app.recovery = entries.length === 0 ? null : { ...current, entries };
  if (entries.length === 0 && app.view === "recover") app.view = "list";
}

function uploadErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把一次上傳結果翻譯成使用者看得懂的一句話。
 *
 * 為什麼要分開講（Gate 4 F3/F7）：
 * - 「內容衝突」不可講成「連線恢復後會自動重試」——它永遠不會成功，使用者等不到；
 * - 「缺段」是這張票唯一能做的補救通報（AC-4）：伺服端已跳過、本機也沒有那份檔案，補不回來。
 * 兩個都只講一次（`*Reported`），否則每 30 秒都會再蓋掉別人的提示。
 */
function reportOutcome(outcome: UploadOutcome): void {
  if (!conflictReported && outcome.conflictSeqs.length > 0) {
    conflictReported = true;
    app.toast =
      outcome.contentMismatchSeqs.length > 0
        ? `第 ${outcome.contentMismatchSeqs.join("、")} 段與伺服端內容不一致（不覆蓋），已保留在本機等你處理。`
        : `第 ${outcome.conflictSeqs.join("、")} 段無法上傳，已保留在本機等你處理。`;
    return;
  }
  if (!gapReported && outcome.gapSeqs.length > 0) {
    gapReported = true;
    app.toast = `時間軸偵測到缺段：第 ${outcome.gapSeqs.join("、")} 段沒有音檔，無法自動補回。`;
  }
}

/** 即時錄音收到一段：算指紋 → 落盤 → 上傳（順序固定在 pipeline 內）。 */
async function ingestChunk(chunk: CaptureChunk): Promise<void> {
  const active = pipeline;
  if (active === null) return;
  try {
    reportOutcome(await active.ingest({ seq: chunk.seq, blob: chunk.blob }));
  } catch (error) {
    // pipeline 一般會把可重試的錯誤變成 outcome；走到這裡是未預期錯誤，明說不吞。
    app.toast = `音檔暫存失敗：${uploadErrorText(error)}`;
  }
}

/** 補送尚未確認的分段（網路恢復、回到前景、結束會議時呼叫）。 */
export async function flushChunks(): Promise<void> {
  if (pipeline === null) return;
  try {
    reportOutcome(await pipeline.flush());
  } catch {
    // 補送失敗就等下一次觸發（backoff 在 queue 內），不干擾錄音。
  }
}

/** 使用者選「續傳」：對未完成的會議依伺服端帳本回補。 */
export async function resumeUnfinished(meetingId: string): Promise<void> {
  if (recovery === null || app.recoveryBusy) return;
  app.recoveryBusy = true;
  try {
    const outcome = await recovery.resume(meetingId);
    const done = outcome.pending === 0 && outcome.conflictSeqs.length === 0;
    // 還有沒送完 / 有衝突的段就留在畫面上：資料還在，就不該讓使用者以為處理完了。
    if (done) dropRecoveryEntry(meetingId);
    if (outcome.conflictSeqs.length > 0) {
      app.toast = `已回補 ${outcome.sent} 段；第 ${outcome.conflictSeqs.join("、")} 段內容衝突，已保留在本機等你處理。`;
    } else if (outcome.gapSeqs.length > 0) {
      app.toast = `已回補 ${outcome.sent} 段；時間軸仍有第 ${outcome.gapSeqs.join("、")} 段缺音檔。`;
    } else if (done) {
      app.toast = `已回補 ${outcome.sent} 段未送出的音檔。`;
    } else {
      app.toast = `已回補 ${outcome.sent} 段，仍有 ${outcome.pending} 段待送（連線恢復後會自動重試）。`;
    }
  } catch (error) {
    app.toast = `回補失敗：${uploadErrorText(error)}`;
  } finally {
    app.recoveryBusy = false;
  }
}

/** 使用者明確選「丟棄」：刪掉本機暫存（畫面已做二次確認）。 */
export async function discardUnfinished(meetingId: string): Promise<void> {
  if (recovery === null || app.recoveryBusy) return;
  app.recoveryBusy = true;
  try {
    await recovery.discard(meetingId);
    dropRecoveryEntry(meetingId);
    app.toast = "已丟棄本機暫存的音檔。";
  } catch (error) {
    app.toast = `丟棄失敗：${uploadErrorText(error)}`;
  } finally {
    app.recoveryBusy = false;
  }
}

/** 從恢復畫面離開（使用者暫時不想處理，保留本機檔）。 */
export function dismissRecovery(): void {
  app.view = "list";
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(app.meetings));
  } catch {
    // 隱私模式等情況寫不進去：畫面仍可用，只是重開後列表會不見（v1 可接受，US-102 會改成伺服端）。
  }
}

function readPersisted(): MeetingListItem[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MeetingListItem[]) : [];
  } catch {
    return [];
  }
}

/** 進行中（錄音活躍 / 已中斷 / 已達上限）一律置頂（DESIGN §3.0）。 */
export function sortedMeetings(): MeetingListItem[] {
  const rank = (status: MeetingStatus): number =>
    status === "recording" ? 0 : status === "interrupted" ? 1 : status === "limit_reached" ? 2 : 3;
  return [...app.meetings].sort((a, b) => rank(a.status) - rank(b.status) || b.startedAtMs - a.startedAtMs);
}

export async function loadMeetings(): Promise<void> {
  app.loadingList = true;
  // 先讀本機；之後（US-102 起）會改成讀伺服端。
  await Promise.resolve();
  app.meetings = readPersisted();
  app.loadingList = false;
}

function upsert(listItem: MeetingListItem): void {
  const index = app.meetings.findIndex((item) => item.id === listItem.id);
  if (index === -1) {
    app.meetings = [listItem, ...app.meetings];
  } else {
    app.meetings = app.meetings.map((item) => (item.id === listItem.id ? listItem : item));
  }
  persist();
}

function setStatus(id: string, status: MeetingStatus): void {
  upsert({ ...(app.meetings.find((item) => item.id === id) ?? { id, title: "", startedAtMs: Date.now(), endsAtMs: Date.now() + MEETING_MAX_MS }), status });
}

export function setTab(tab: Tab): void {
  app.tab = tab;
}

export function openStartSheet(): void {
  app.view = "start";
}

export function cancelStartSheet(): void {
  app.view = "list";
}

export function dismissToast(): void {
  app.toast = null;
}

function syncSnapshot(): void {
  if (store !== null) rec.snapshot = store.snapshot;
}

/** 使用者按下「開始」：開 session → 取麥克風 → 進會議中（AC-1：3 秒內要有結論）。 */
export async function confirmStart(rawTitle: string): Promise<void> {
  const title = rawTitle.trim();
  if (title === "" || app.starting) return;
  app.starting = true;
  const meetingId = globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}`;
  await ensureStore();
  const client = new HttpSessionClient({ baseUrl: workerBaseUrl(), meetingId });
  conflictReported = false;
  gapReported = false;
  pipeline =
    openedStore === null
      ? null
      : new ChunkPipeline({ meetingId, store: openedStore.store, api: chunkUploadApi(client) });
  const capture = new MediaRecorderCapture({
    onChunk: (chunk) => {
      void ingestChunk(chunk);
    },
  });
  store = new RecorderStore({
    now: () => Date.now(),
    capture,
    session: client,
  });
  unsubscribe?.();
  unsubscribe = store.subscribe(() => syncSnapshot());
  app.currentMeetingId = meetingId;
  app.currentTitle = title;
  // 上一場的缺口／逐字稿不得帶到這一場。兩行是一組的：`app.gaps = []` 只是清畫面用的陣列，
  // 真正把狀態機換掉的是下一行的 `resetTranscript()`（Gate 4 P2：下一行若被移走，
  // 這行就會留下一個「只改陣列、沒更新狀態機」的舊 bug 入口）。
  app.gaps = [];
  resetTranscript(client);
  await startGapTracking(meetingId);
  try {
    await store.start();
  } catch (error) {
    app.toast =
      error instanceof SessionApiError
        ? `伺服端沒有接受這場會議（${error.code}）。請確認網路後再試。`
        : `無法開始會議：${error instanceof Error ? error.message : String(error)}`;
  }
  app.starting = false;
  syncSnapshot();
  const snapshot = store.snapshot;
  if (snapshot.state === "recording") {
    // M01-US-108 AC-1：真的開始錄音才壓螢幕（沒錄音就沒有續航問題）。
    void wakeLock().acquire();
    upsert({
      id: meetingId,
      title,
      startedAtMs: Date.now() - snapshot.elapsedMs,
      endsAtMs: Date.now() + snapshot.remainingMs,
      status: "recording",
    });
    app.view = "meeting";
    syncTranscriptPolling();
    return;
  }
  if (snapshot.notice?.code === "PERMISSION_DENIED") {
    // AC-3：不得靜默失敗 —— 進阻斷頁並提供「前往系統設定」。
    app.view = "permission";
    return;
  }
  app.view = "start";
}

/** 從權限阻斷頁回到列表（使用者可能已去設定開好權限）。 */
export function backToList(): void {
  app.view = "list";
  // 離開會議畫面就沒有「正在說…」了：留著只會讓下一次進來看到一句早就結束的話。
  liveTranscript.clearInterim();
  syncTranscript();
  syncTranscriptPolling();
}

export async function endMeeting(): Promise<void> {
  if (store === null) return;
  // 結束會議也是「中斷結束」：還開著的缺口要在收工前補上結束時間，不要留一個永遠未知的缺口。
  await gapTracker?.handleVisible();
  await store.stopByUser();
  // 最後一段（`dataavailable`）剛落地，給它一次補送機會再離開畫面。
  await flushChunks();
  await gapTracker?.sync();
  // 這一場結束了，舊 tracker 不能再收事件：否則之後 app 進背景會憑上一個 elapsedMs
  // 建出一筆「幽靈缺口」（會議早就結束了，逐字稿卻多一段「未錄到」）。
  gapTracker = null;
  // M01-US-108 D9：結束會議就把 sentinel 放掉（不再宣稱螢幕受保護），且不能再收 release 事件。
  wakeLock().stop();
  // M01-US-104：會議結束就不會再有 interim（`clearInterim()` 的註解承諾了這件事，這裡兑現它）。
  liveTranscript.clearInterim();
  syncTranscript();
  if (app.currentMeetingId !== null) setStatus(app.currentMeetingId, "ended");
  syncSnapshot();
  app.view = "list";
  syncTranscriptPolling();
}

export async function resumeMeeting(): Promise<void> {
  if (store === null) return;
  await store.resume();
  // **真的開始收音了**才關缺口：mic 又被拒 / 續錄失敗時，錄音還是停的，
  // 這一刻補結束時間會讓畫面少報中斷長度（見 gap-marking.spec.ts 的兩個 Edge 測試）。
  if (rec.snapshot.state === "recording") {
    await gapTracker?.handleVisible();
    // M01-US-108 D3：真的回到錄音才重新壓螢幕（中斷中取 wake lock 沒意義）。
    void wakeLock().acquire();
  }
  syncSnapshot();
  await flushChunks();
  await gapTracker?.sync();
  syncTranscriptPolling();
}

/** 由畫面每秒呼叫（到點自動結束的驅動來源）。 */
export function tickMeeting(): void {
  if (store === null) return;
  store.tick();
  syncSnapshot();
  if (app.currentMeetingId !== null && rec.snapshot.state === "limit_reached") {
    setStatus(app.currentMeetingId, "limit_reached");
  }
  if (app.currentMeetingId !== null && rec.snapshot.state === "interrupted") {
    setStatus(app.currentMeetingId, "interrupted");
    // M01-US-108：中斷了就不該繼續佔著 wake lock（畫面也不再宣稱受保護）。
    // 只在「真的還握著」時才收：每秒無條件 `stop()` 會把進背景後的 `suspended` 壓成 `idle`
    // （狀態在 tick 之間跳動），也會把 `lost` 的提示與重試預算一起清掉。
    if (app.wakeLockState === "active") wakeLock().stop();
  }
  if (rec.snapshot.state === "limit_reached" && app.wakeLockState === "active") {
    // 到上限之後不需要續航（錄音已經停了），放掉 sentinel。
    wakeLock().stop();
  }
  syncTranscriptPolling();
}

/** 上限畫面的兩個出口（AC-6）：產生記錄 / 開新一場。 */
export function closeLimitSession(choice: "generate" | "new"): void {
  void gapTracker?.handleVisible(); // 上限到點也是中斷結束：不要把缺口留成「結束時間未知」
  void gapTracker?.sync();
  // 同 endMeeting()：這一場結束了，舊 tracker 不得再收背景事件（免得建出幽靈缺口）。
  gapTracker = null;
  wakeLock().stop();
  // 同 endMeeting()：這一場不會再有 interim 了。
  liveTranscript.clearInterim();
  syncTranscript();
  store?.closeSession();
  if (app.currentMeetingId !== null) setStatus(app.currentMeetingId, "ended");
  syncSnapshot();
  if (choice === "generate") {
    app.view = "list";
    app.toast = "記錄產生由 M02-US-203 接上；2:00 前的逐字稿與音檔已完整保留。";
    syncTranscriptPolling();
    return;
  }
  app.view = "start";
  syncTranscriptPolling();
}

/** 前景/背景切換（AC-4）：由 main.ts 綁上瀏覽器事件。 */
export function notifyVisibility(hidden: boolean): void {
  // M01-US-107 D-US107-2：**必須先**標缺口再切狀態。
  // 切到 interrupted 之後計時器就凍結了，那時再讀 elapsedMs 會少算「畫面還在的前一刻」。
  // `handleHidden()` 的前半段是同步的，所以這裡不需要 await。
  // 只在「真的會中斷」時標：state.ts 的 `visibility_hidden` 只有在 recording 才轉成 interrupted，
  // 非錄音中（例如已達上限、已結束、還沒開始）進背景不是「未錄到」，標了就是假的缺口。
  const willInterrupt = hidden && rec.snapshot.state === "recording";
  // M01-US-108 D3：進背景時瀏覽器一定會收走 sentinel，主動收乾淨才不會把「系統本來就會做的事」
  // 誤判成 lost（那會在回前景時多出一張不必要的提示）。
  if (hidden) wakeLock().suspend();
  if (hidden) {
    // M01-US-104：進背景後裝置端不再收音（SPIKE-002），畫面上那句「正在說…」永遠不會被定稿
    // ——留著就是一句不會變的謊。回前景時輪詢會把真正定稿的句子補進來。
    liveTranscript.clearInterim();
    syncTranscript();
  }
  if (willInterrupt) void gapTracker?.handleHidden();
  store?.notifyVisibility(hidden);
  syncSnapshot();
  if (hidden && app.currentMeetingId !== null && rec.snapshot.state === "interrupted") {
    setStatus(app.currentMeetingId, "interrupted");
  }
  if (!hidden) {
    // 回到前景**不關**缺口：`visibility_visible` 不自動續錄（見 state.ts），錄音這一刻還是停的。
    // 缺口一律等真的續錄 / 結束會議 / 上限到點才收尾（那些點各自呼叫 handleVisible）。
    void flushChunks();
    void gapTracker?.sync();
    // M01-US-108 D4：回前景且**還在錄音**才重取（visible 不自動續錄，所以中斷中不取）。
    if (rec.snapshot.state === "recording") void wakeLock().acquire();
  }
  syncTranscriptPolling();
}
