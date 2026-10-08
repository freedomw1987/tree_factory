<script lang="ts">
  import { app, dismissToast, setTab } from "./lib/app.svelte";
  import Icon from "./lib/ui/Icon.svelte";
  import MeetingList from "./screens/MeetingList.svelte";
  import MeetingScreen from "./screens/MeetingScreen.svelte";
  import PermissionBlocked from "./screens/PermissionBlocked.svelte";
  import RecoverPrompt from "./screens/RecoverPrompt.svelte";
  import StartSheet from "./screens/StartSheet.svelte";
</script>

<!--
  App 外殼（DESIGN.md §3.0）。
  階段 A 就必須有底部 tab bar 容器：預設 tab = 會議，但導航結構已經是「分頁」而不是
  「會議列表 = 根畫面」，階段 B 反轉首頁時只需改一個常數。
  會議中畫面刻意不顯示 tab bar（會議中零打斷，P1）。
-->
<div class="shell">
  {#if app.view === "meeting"}
    <MeetingScreen />
  {:else}
    <main class="content">
      {#if app.tab === "meetings"}
        {#if app.view === "list"}
          <MeetingList />
        {:else if app.view === "start"}
          <StartSheet />
        {:else if app.view === "permission"}
          <PermissionBlocked />
        {:else if app.view === "recover"}
          <RecoverPrompt />
        {/if}
      {:else}
        <section class="empty" data-testid="chat-empty">
          <p class="big"><Icon name="chat" size={38} /></p>
          <h2>還沒有資料可以問</h2>
          <p class="dim">等你開完第一場會議，就能問我「上次決定了什麼」。</p>
        </section>
      {/if}
    </main>

    <nav class="tabbar" aria-label="主要分頁">
      <button
        type="button"
        data-testid="tab-meetings"
        class:active={app.tab === "meetings"}
        onclick={() => setTab("meetings")}
      >
        <span aria-hidden="true"><Icon name="mic" /></span>
        <span>會議</span>
      </button>
      <button
        type="button"
        data-testid="tab-chat"
        class:active={app.tab === "chat"}
        onclick={() => setTab("chat")}
      >
        <span aria-hidden="true"><Icon name="chat" /></span>
        <span>對話</span>
      </button>
    </nav>
  {/if}

  {#if app.toast !== null}
    <div class="toast" role="status" data-testid="toast">
      <span>{app.toast}</span>
      <button type="button" onclick={dismissToast}>知道了</button>
    </div>
  {/if}
</div>

<style>
  .shell {
    /* 高度必須是「確定值」：只給 min-height 的話，子元素的 `flex: 1`
       （flex-basis: 0%）對未定高度無法解析，會退回「依內容」→ 逐字稿一長就把
       畫面往下撐，底部的「長按結束會議」被推到 3000px 以外（iPhone 真機實測）。
       app shell 固定在視窗高，捲動交給各畫面自己處理。 */
    height: 100dvh;
    display: flex;
    flex-direction: column;
    /* 真機（瀏海／狀態列）：index.html 用 viewport-fit=cover，內容會延伸到系統 UI
       底下；不讓開的話最上面的按鈕（例：「開始會議」在 y=16~60）會落在約 50pt 高的
       狀態列裡，點擊被 iOS 的「點狀態列回頂部」手勢吃掉。iPhone 12 mini 實測回報
       「按不到開始會議 button」即此故；桌機瀏覽器沒有狀態列，E2E 測不出來。 */
    padding-top: var(--safe-top);
  }

  .content {
    flex: 1;
    /* 外框固定高度之後，比畫面長的內容（例：會議列表）在這裡捲，不外推外框。 */
    overflow-y: auto;
    padding: var(--space-4);
    padding-bottom: calc(var(--tap) + var(--space-6));
  }

  .tabbar {
    position: fixed;
    inset: auto 0 0 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding-bottom: var(--safe-bottom);
  }

  .tabbar button {
    min-height: var(--tap);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: none;
    border: 0;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: color var(--dur) ease-out;
  }

  .tabbar button.active {
    color: var(--accent);
  }

  .empty {
    text-align: center;
    padding: var(--space-8) var(--space-4);
  }

  .empty .big {
    /* 圖示自帶尺寸（DESIGN §5 規則 8：空狀態 38pt），這裡只管間距；
       line-height: 0 避免 inline SVG 的基線留白影響與下方文字的距離。 */
    margin: 0 0 var(--space-3);
    line-height: 0;
  }

  .empty h2 {
    font-size: 20px;
    margin: 0 0 var(--space-2);
  }

  .dim {
    color: var(--text-dim);
    margin: 0;
  }

  .toast {
    position: fixed;
    left: var(--space-4);
    right: var(--space-4);
    bottom: calc(var(--tap) + var(--space-6));
    display: flex;
    align-items: center;
    gap: var(--space-3);
    justify-content: space-between;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: var(--space-3) var(--space-4);
    font-size: 14px;
  }

  .toast button {
    border: 1px solid var(--border);
    border-radius: var(--r-btn);
    background: none;
    color: var(--accent);
    font: inherit;
    min-height: 32px;
    padding: 0 var(--space-3);
    cursor: pointer;
  }
</style>
