<script lang="ts">
  import { app, cancelStartSheet, confirmStart } from "../lib/app.svelte";

  /** 預設標題：會議最常見的命名就是「什麼時候」；使用者不輸入也能直接開始（會議要快）。 */
  function defaultTitle(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `會議 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  let title = $state(defaultTitle());
  let touched = $state(false);

  const blank = $derived(title.trim() === "");

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    touched = true;
    if (blank) return;
    void confirmStart(title);
  }
</script>

<!--
  準備開始（標題 sheet）（DESIGN.md §3.1：Happy / Error 標題空白擋下 / Edge 超長標題）。
  這裡是「按下開始前」唯一的一步：不跳頁、不問東問西（§4.1 決定 1：會議要快）。
-->
<section class="sheet" data-testid="start-sheet">
  <h2>開始會議</h2>
  <p class="dim">給這場會議一個名字（等一下在列表裡才認得出來）。</p>

  <form onsubmit={submit}>
    <label for="meeting-title">會議標題</label>
    <input
      id="meeting-title"
      data-testid="input-title"
      type="text"
      maxlength="80"
      bind:value={title}
      oninput={() => (touched = true)}
      placeholder="例：週一產品會議"
    />
    {#if touched && blank}
      <p class="error" role="alert" data-testid="title-error">標題不能空白；不想命名就按「開始」用預設的也可以。</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={cancelStartSheet}>取消</button>
      <button type="submit" class="primary" data-testid="btn-start-confirm" disabled={app.starting}>
        {app.starting ? "啟動中…" : "開始"}
      </button>
    </div>
  </form>

  <p class="note">開始後會請你允許麥克風；iOS 前景錄音上限 2 小時。</p>
</section>

<style>
  .sheet {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sheet) var(--r-sheet) var(--r-card) var(--r-card);
    padding: var(--space-6);
    margin-top: var(--space-4);
  }

  h2 {
    margin: 0 0 var(--space-2);
    font-size: 20px;
  }

  .dim {
    color: var(--text-dim);
    font-size: 14px;
    margin: 0 0 var(--space-4);
  }

  label {
    display: block;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: var(--space-2);
  }

  input {
    width: 100%;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border-radius: var(--r-btn);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }

  .error {
    color: var(--err);
    font-size: 13px;
    margin: var(--space-2) 0 0;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: var(--space-3);
    margin-top: var(--space-4);
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

  .primary:disabled {
    opacity: 0.6;
  }

  .note {
    margin: var(--space-4) 0 0;
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
