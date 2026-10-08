<script lang="ts">
  import { app, discardUnfinished, dismissRecovery, resumeUnfinished } from "../lib/app.svelte";
  import Icon from "../lib/ui/Icon.svelte";

  /*
    M01-US-102 AC-3：app 被殺 / 斷電重開後，若本機還有未確認的分段，**必須先問使用者**，
    不得自動丟棄。丟棄是不可逆動作，所以在同一個畫面做二次確認（不另開系統對話框，
    因為這在 webview 不一定存在，且無法用 Playwright 穩定驅動）。
  */
  let confirming = $state<string | null>(null);

  function titleOf(meetingId: string): string {
    return app.meetings.find((item) => item.id === meetingId)?.title ?? "未命名會議";
  }
</script>

<!--
  恢復詢問（阻斷頁）：列出還有暫存音檔的會議，讓使用者選「續傳」或「丟棄」。
  先做「續傳」再談「丟棄」——預設動作是保住資料，不是清掉資料。
-->
<section class="recover" data-testid="recover-screen">
  <p class="big" aria-hidden="true"><Icon name="mic" size={38} /></p>
  <h2>有未完成的會議</h2>
  <p class="lead">
    上次錄音中斷前，有音檔還沒送到伺服端。要現在補送，或是丟棄本機暫存？
  </p>
  {#if app.recovery?.durable === false}
    <p class="warn" data-testid="recover-volatile">
      這個環境沒有可用的本機儲存，關掉 App 後暫存會消失；請保持這個畫面開啟並選「續傳」。
    </p>
  {/if}

  <ul class="list">
    {#each app.recovery?.entries ?? [] as entry (entry.meetingId)}
      <li class="item" data-testid="recover-item">
        <div class="meta">
          <strong>{titleOf(entry.meetingId)}</strong>
          <span class="dim">還有 {entry.pending} 段未送出</span>
        </div>

        {#if confirming === entry.meetingId}
          <p class="confirm-text" data-testid="recover-confirm-text">確定要丟棄？丟棄後無法復原。</p>
          <div class="row">
            <button
              type="button"
              class="ghost"
              data-testid="btn-recover-discard-cancel"
              onclick={() => (confirming = null)}
            >
              取消
            </button>
            <button
              type="button"
              class="danger"
              data-testid="btn-recover-discard-confirm"
              disabled={app.recoveryBusy}
              onclick={() => {
                confirming = null;
                void discardUnfinished(entry.meetingId);
              }}
            >
              確定丟棄
            </button>
          </div>
        {:else}
          <div class="row">
            <button
              type="button"
              class="ghost"
              data-testid="btn-recover-discard"
              disabled={app.recoveryBusy}
              onclick={() => (confirming = entry.meetingId)}
            >
              丟棄
            </button>
            <button
              type="button"
              class="primary"
              data-testid="btn-recover-resume"
              disabled={app.recoveryBusy}
              onclick={() => void resumeUnfinished(entry.meetingId)}
            >
              續傳
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  <div class="later">
    <button type="button" class="linkbtn" data-testid="btn-recover-later" onclick={dismissRecovery}>
      稍後再說（保留本機暫存）
    </button>
  </div>
</section>

<style>
  .recover {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: var(--space-6);
    margin-top: var(--space-4);
  }

  .big {
    /* 圖示自帶尺寸（DESIGN §5 規則 8：空狀態 38pt），這裡只管間距。 */
    margin: 0 0 var(--space-3);
    line-height: 0;
  }

  h2 {
    margin: 0 0 var(--space-3);
    font-size: 20px;
  }

  .lead {
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.6;
  }

  .warn {
    margin: var(--space-3) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--warn, #b7791f);
    border-radius: var(--r-btn);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
  }

  .list {
    list-style: none;
    margin: var(--space-4) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-3);
  }

  .item {
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: var(--space-3) var(--space-4);
    display: grid;
    gap: var(--space-3);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dim {
    color: var(--text-dim);
    font-size: 13px;
  }

  .confirm-text {
    margin: 0;
    font-size: 13px;
    color: var(--text);
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .row button {
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

  .danger {
    background: none;
    border: 1px solid var(--danger, #c53030);
    color: var(--danger, #c53030);
  }

  .later {
    margin-top: var(--space-5);
    text-align: center;
  }

  .linkbtn {
    background: none;
    border: 0;
    color: var(--accent);
    font: inherit;
    font-size: 14px;
    min-height: var(--tap);
    cursor: pointer;
  }
</style>
