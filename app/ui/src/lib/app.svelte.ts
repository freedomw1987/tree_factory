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
import type { UploadOutcome } from "./recorder/uploader";
import { HttpSessionClient, SessionApiError } from "./session/api";

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
    upsert({
      id: meetingId,
      title,
      startedAtMs: Date.now() - snapshot.elapsedMs,
      endsAtMs: Date.now() + snapshot.remainingMs,
      status: "recording",
    });
    app.view = "meeting";
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
}

export async function endMeeting(): Promise<void> {
  if (store === null) return;
  await store.stopByUser();
  // 最後一段（`dataavailable`）剛落地，給它一次補送機會再離開畫面。
  await flushChunks();
  if (app.currentMeetingId !== null) setStatus(app.currentMeetingId, "ended");
  syncSnapshot();
  app.view = "list";
}

export async function resumeMeeting(): Promise<void> {
  if (store === null) return;
  await store.resume();
  syncSnapshot();
  await flushChunks();
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
  }
}

/** 上限畫面的兩個出口（AC-6）：產生記錄 / 開新一場。 */
export function closeLimitSession(choice: "generate" | "new"): void {
  store?.closeSession();
  if (app.currentMeetingId !== null) setStatus(app.currentMeetingId, "ended");
  syncSnapshot();
  if (choice === "generate") {
    app.view = "list";
    app.toast = "記錄產生由 M02-US-203 接上；2:00 前的逐字稿與音檔已完整保留。";
    return;
  }
  app.view = "start";
}

/** 前景/背景切換（AC-4）：由 main.ts 綁上瀏覽器事件。 */
export function notifyVisibility(hidden: boolean): void {
  store?.notifyVisibility(hidden);
  syncSnapshot();
  if (hidden && app.currentMeetingId !== null && rec.snapshot.state === "interrupted") {
    setStatus(app.currentMeetingId, "interrupted");
  }
  if (!hidden) void flushChunks();
}
