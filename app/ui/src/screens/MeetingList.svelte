<script lang="ts">
  import { app, openStartSheet, sortedMeetings } from "../lib/app.svelte";
  import { formatClock } from "../lib/recorder/limit";

  const items = $derived(sortedMeetings());

  function clockOf(startedAtMs: number): string {
    return formatClock(Date.now() - startedAtMs);
  }

  function labelOf(status: string): string {
    if (status === "recording") return "錄音中";
    if (status === "interrupted") return "已中斷";
    if (status === "limit_reached") return "已達上限";
    return "已結束";
  }
</script>

<!--
  首頁 / 會議列表（DESIGN.md §3.1：Happy / Loading / Empty 三態）。
  進行中的會議一律置頂並且紅點 + 計時（§3.0 表格）——使用者最可能的誤操作就是
  「手機放桌上，隨手點開正在錄的會議」，所以進行中的一眼要看得到。
-->
<header class="head">
  <h1>會議</h1>
  <button type="button" data-testid="btn-start-meeting" onclick={openStartSheet}>開始會議</button>
</header>

{#if app.loadingList}
  <ul class="list" data-testid="list-loading" aria-busy="true">
    {#each [0, 1, 2] as row (row)}
      <li class="skeleton" aria-hidden="true"></li>
    {/each}
  </ul>
  <p class="dim">載入列表…</p>
{:else if items.length === 0}
  <section class="empty" data-testid="list-empty">
    <p class="big">🎙️</p>
    <h2>還沒有任何會議</h2>
    <p class="dim">第一場會議開完之後，逐字稿、摘要與待辦都會出現在這裡。</p>
  </section>
{:else}
  <ul class="list" data-testid="meeting-list">
    {#each items as item (item.id)}
      <li class="item" data-testid="meeting-item" data-status={item.status}>
        <span class="dot" class:rec={item.status === "recording"} class:warn={item.status === "interrupted"}></span>
        <span class="title">{item.title}</span>
        <span class="status mono">
          {labelOf(item.status)}
          {#if item.status === "recording"}· {clockOf(item.startedAtMs)}{/if}
        </span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h1 {
    font-size: 28px;
    margin: 0;
  }

  .head button {
    min-height: var(--tap);
    padding: 0 var(--space-4);
    border: 0;
    border-radius: var(--r-btn);
    background: var(--accent);
    color: #06121f;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: var(--space-4) 0 0;
    display: grid;
    gap: var(--space-2);
  }

  .item {
    display: grid;
    grid-template-columns: 12px 1fr auto;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: var(--space-3) var(--space-4);
    min-height: var(--tap);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-dim);
  }

  .dot.rec {
    background: var(--rec);
  }

  .dot.warn {
    background: var(--warn);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: 12px;
    color: var(--text-dim);
  }

  .skeleton {
    height: 54px;
    border-radius: var(--r-card);
    background: var(--surface);
    border: 1px solid var(--border);
  }

  .empty {
    text-align: center;
    padding: var(--space-8) var(--space-4);
  }

  .big {
    font-size: 40px;
    margin: 0 0 var(--space-3);
  }

  .empty h2 {
    font-size: 20px;
    margin: 0 0 var(--space-2);
  }

  .dim {
    color: var(--text-dim);
    margin: var(--space-2) 0 0;
    font-size: 14px;
  }
</style>
