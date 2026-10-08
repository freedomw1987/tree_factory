<script lang="ts">
  import { endMeeting, rec, resumeMeeting, closeLimitSession, app } from "../lib/app.svelte";
  import { formatClock, minutesUntilLimit } from "../lib/recorder/limit";

  const HOLD_MS = 1_000;

  let holdProgress = $state(0);
  let holding = $state(false);
  let holdStartedAt = 0;
  let frame: number | null = null;

  const snapshot = $derived(rec.snapshot);
  const recording = $derived(snapshot.state === "recording");
  const interrupted = $derived(snapshot.state === "interrupted");
  const limitReached = $derived(snapshot.state === "limit_reached");
  /** 最後一次有在錄的時間點：中斷時畫面要誠實顯示「幾點斷的」。 */
  let interruptedAtMs = $state(0);

  $effect(() => {
    if (interrupted) interruptedAtMs = Date.now();
  });

  function step(now: number): void {
    holdProgress = Math.min(1, (now - holdStartedAt) / HOLD_MS);
    if (holdProgress >= 1) {
      void finishHold();
      return;
    }
    frame = requestAnimationFrame(step);
  }

  function startHold(): void {
    if (holding || limitReached) return;
    holding = true;
    holdStartedAt = performance.now();
    frame = requestAnimationFrame(step);
  }

  function cancelHold(): void {
    holding = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    holdProgress = 0;
  }

  async function finishHold(): Promise<void> {
    cancelHold();
    await endMeeting();
  }

  $effect(() => () => {
    if (frame !== null) cancelAnimationFrame(frame);
  });
</script>

<!--
  會議中（DESIGN.md §3.1 的 5 狀態：Happy / Loading 等待首句 / Error / Edge 剩 5 分鐘黃橫幅 /
  已達上限）＋ §4.2 的中斷誠實告知。
  三個絕對不能違反的原則：
  1. 紅燈只在**真的在錄**時亮（中斷與上限都要熄）；
  2. 切背景時計時器必須凍結並明說中斷時間（不得假裝還在錄）；
  3. 會議中不跳頁、不彈 modal（P1）——結束會議用「長按填滿」避免誤觸（§4.1 決定 3）。
-->
<section class="meeting" data-testid="meeting-screen" data-rec-state={snapshot.state}>
  <header class="top">
    <div class="ident">
      <span
        class="dot"
        class:rec={recording}
        class:pulse={recording}
        data-testid="rec-light"
        aria-hidden="true"
      ></span>
      <span class="state" data-testid="rec-state-label">
        {recording ? "錄音中" : interrupted ? "錄音已中斷" : limitReached ? "已達上限" : "未錄音"}
      </span>
    </div>
    <span class="timer mono" data-testid="timer">{formatClock(snapshot.elapsedMs)}</span>
  </header>

  <p class="title" data-testid="meeting-title">{app.currentTitle}</p>

  {#if snapshot.warn && recording}
    <!-- FR-112：黃橫幅明說「再 N 分鐘」，且紅燈不得提前熄滅（上面仍在錄） -->
    <div class="banner warn" role="status" data-testid="banner-warn">
      再 {minutesUntilLimit(snapshot.remainingMs)} 分鐘就到 2 小時上限；記錄會完整保留。
    </div>
  {/if}

  {#if interrupted}
    <!-- AC-4：明確顯示中斷與中斷時間；解鎖回到前景要詢問（設計 §4.2） -->
    <div class="banner warn" role="alert" data-testid="banner-interrupt">
      <span>錄音已中斷（時間 {formatClock(snapshot.elapsedMs)}；{new Date(interruptedAtMs).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}）。鎖屏或切到背景時不會繼續收音。</span>
      <button type="button" data-testid="btn-resume" onclick={() => void resumeMeeting()}>
        繼續這場會議？
      </button>
    </div>
  {/if}

  <section class="transcript" data-testid="transcript">
    <p class="dim" data-testid="transcript-waiting">等待第一句…（逐字稿由 M01-US-103 / US-104 接上）</p>
  </section>

  {#if limitReached}
    <div class="limit" role="alert" data-testid="panel-limit">
      <h2>已達 2 小時上限</h2>
      <p>{snapshot.notice?.message ?? "2:00 之後的內容不會被記錄。"}</p>
      <p class="dim">2:00 前的逐字稿與音檔已完整保留，可以直接產生記錄。</p>
      <div class="actions">
        <button type="button" class="ghost" data-testid="btn-new-meeting" onclick={() => closeLimitSession("new")}>
          開新一場
        </button>
        <button type="button" class="primary" data-testid="btn-generate-note" onclick={() => closeLimitSession("generate")}>
          產生記錄
        </button>
      </div>
    </div>
  {:else}
    <button
      type="button"
      class="end"
      data-testid="btn-end-hold"
      aria-label="長按 1 秒結束會議"
      onpointerdown={startHold}
      onpointerup={cancelHold}
      onpointercancel={cancelHold}
      onpointerleave={cancelHold}
      onkeydown={(event) => {
        if (event.key === "Enter" || event.key === " ") startHold();
      }}
      onkeyup={cancelHold}
    >
      <span class="fill" style={`width: ${Math.round(holdProgress * 100)}%`}></span>
      <span class="label">{holding ? "放手取消 · 繼續長按結束" : "長按結束會議"}</span>
    </button>
  {/if}
</section>

<style>
  .meeting {
    /* 會議中不顯示 tab bar，這個畫面是 .shell 的直接子元素；由外框決定視窗高度，
       這裡只要「填滿剩下的空間」。用 100dvh 會變成「在已有頂部留白的外框裡再要一個
       完整視窗高」→ 底部溢出、最後的「長按結束會議」被推去 Home Indicator 手勢區
       （iPhone 12 mini 實測：使用者按不到）。 */
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    padding-bottom: calc(var(--space-8) + var(--safe-bottom));
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .ident {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-dim);
  }

  .dot.rec {
    background: var(--rec);
  }

  .state {
    font-size: 14px;
    color: var(--text-dim);
  }

  .timer {
    font-size: 28px;
    font-weight: 600;
  }

  .title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .banner {
    border-radius: var(--r-card);
    padding: var(--space-3) var(--space-4);
    font-size: 14px;
    line-height: 1.6;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .banner.warn {
    background: color-mix(in srgb, var(--warn) 16%, var(--surface));
    border: 1px solid var(--warn);
    color: var(--text);
  }

  .banner button {
    min-height: var(--tap);
    padding: 0 var(--space-4);
    border-radius: var(--r-btn);
    border: 1px solid var(--warn);
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .transcript {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: var(--space-4);
    min-height: 160px;
    /* 逐字稿長起來時自己捲，不要把下面的「長按結束會議」推出畫面
       （同一個「按不到」家族的第三個寫法：溢出 → 使用者得先用手往下滑）。 */
    overflow: auto;
  }

  .dim {
    color: var(--text-dim);
    font-size: 14px;
    margin: 0;
  }

  .limit {
    background: var(--surface-2);
    border: 1px solid var(--warn);
    border-radius: var(--r-card);
    padding: var(--space-4);
  }

  .limit h2 {
    margin: 0 0 var(--space-2);
    font-size: 18px;
  }

  .limit p {
    margin: 0 0 var(--space-2);
    font-size: 14px;
    line-height: 1.6;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .actions button {
    min-height: var(--tap);
    border-radius: var(--r-btn);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
  }

  .primary {
    background: var(--accent);
    border: 0;
    color: #06121f;
  }

  .end {
    position: relative;
    overflow: hidden;
    min-height: 56px;
    border-radius: var(--r-btn);
    border: 1px solid var(--err);
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  .end .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--err) 45%, transparent);
  }

  .end .label {
    position: relative;
  }
</style>
