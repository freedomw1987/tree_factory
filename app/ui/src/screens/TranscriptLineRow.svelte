<script lang="ts">
  import type { TranscriptLine } from "../lib/transcript/live-transcript";

  interface Props {
    line: TranscriptLine;
  }

  let { line }: Props = $props();

  // 講者編號從 1 起算：帳本裡是 0 起算（SPIKE-001 的 speaker index），
  // 但畫面上「講者 0」會被讀成「沒有人在講話」。
  const speakerLabel = $derived(`講者 ${line.speakerId + 1}`);
</script>

<!--
  M01-US-104 AC-1：未定稿（interim）與已定稿（committed）必須**一眼可分辨**，
  而且不能只靠顏色（色盲可及性）：interim 斜體、不顯示講者 chip；committed 正常字體 + 講者 chip。
  AC-2：定稿後由 `commit` 吸收 interim——這裡不需要處理「同一句兩列」，那是狀態機的責任。
-->
<li
  class="line"
  class:is-interim={line.state === "interim"}
  class:is-italic={line.state === "interim"}
  class:is-committed={line.state === "committed"}
  data-testid="transcript-line"
  data-line-state={line.state}
  data-line-seq={line.seq ?? ""}
>
  {#if line.state === "committed"}
    <span class="who" data-testid="line-speaker">{speakerLabel}</span>
  {/if}
  <span class="text">{line.text}</span>
</li>

<style>
  .line {
    display: flex;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-1) var(--space-2);
    font-size: 15px;
    line-height: 1.7;
    color: var(--text);
  }

  .line.is-committed {
    border-left: 3px solid color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .line.is-interim {
    border-left: 3px dashed var(--border);
    color: var(--text-dim);
  }

  .is-italic .text {
    font-style: italic;
  }

  .who {
    flex: none;
    align-self: flex-start;
    margin-top: 2px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    font-size: 12px;
    font-style: normal;
    line-height: 18px;
    white-space: nowrap;
  }

  .text {
    flex: 1;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
