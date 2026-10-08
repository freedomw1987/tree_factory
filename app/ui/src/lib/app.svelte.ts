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

import { MEETING_MAX_MS } from "./recorder/limit";
import { MediaRecorderCapture } from "./recorder/media";
import { RecorderStore, type RecorderSnapshot } from "./recorder/store";
import { HttpSessionClient, SessionApiError } from "./session/api";

export type View = "list" | "start" | "permission" | "meeting";
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
});

export const rec = $state({ snapshot: EMPTY_SNAPSHOT });

export function workerBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_WORKER_BASE_URL;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : "http://127.0.0.1:8787";
}

let store: RecorderStore | null = null;
let unsubscribe: (() => void) | null = null;

/** 錄音核心（畫面不得直接改它，只能呼叫這裡的 action）。 */
export function recorderStore(): RecorderStore | null {
  return store;
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
  const capture = new MediaRecorderCapture();
  store = new RecorderStore({
    now: () => Date.now(),
    capture,
    session: new HttpSessionClient({ baseUrl: workerBaseUrl(), meetingId }),
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
  if (app.currentMeetingId !== null) setStatus(app.currentMeetingId, "ended");
  syncSnapshot();
  app.view = "list";
}

export async function resumeMeeting(): Promise<void> {
  if (store === null) return;
  await store.resume();
  syncSnapshot();
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
}
