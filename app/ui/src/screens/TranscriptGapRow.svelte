<script lang="ts">
  import type { GapRecord } from "../lib/transcript/gap-tracker";
  import { formatGapText } from "../lib/transcript/gap-text";
  import Icon from "../lib/ui/Icon.svelte";

  interface Props {
    gap: GapRecord;
  }

  let { gap }: Props = $props();
</script>

<!--
  M01-US-107 AC-2：逐字稿裡的一段空白要**說出來**，不能靜默留白。
  注意：`toMs === null` 是「還沒回到前景」的正常狀態，此時文案由 formatGapText 負責
  明說「結束時間未知」——不要在這裡自己補一個猜的結束時間。
-->
<li class="gap" data-testid="transcript-gap" data-gap-seq={gap.seq} data-gap-open={gap.toMs === null}>
  <span class="mark" aria-hidden="true"><Icon name="ban" size={14} /></span>
  <span class="text">{formatGapText(gap)}</span>
  {#if gap.conflict}
    <span class="conflict" data-testid="gap-conflict" title="這筆以伺服端記錄為準">與伺服端不一致</span>
  {/if}
  {#if gap.terminal}
    <span class="terminal" data-testid="gap-terminal" title="伺服端已結束，這筆不會同步">僅存本機</span>
  {:else if !gap.synced}
    <span class="pending" data-testid="gap-pending" title="尚未同步到伺服端">待同步</span>
  {/if}
</li>

<style>
  .gap {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-left: 3px solid var(--warn);
    border-radius: var(--r-btn);
    background: color-mix(in srgb, var(--warn) 12%, var(--surface));
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.6;
  }

  .mark {
    display: inline-flex;
    color: var(--warn);
  }

  .text {
    flex: 1;
  }

  .pending,
  .conflict,
  .terminal {
    flex: none;
    font-size: 12px;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
  }

  .conflict,
  .terminal {
    color: var(--warn);
    border-color: var(--warn);
  }
</style>