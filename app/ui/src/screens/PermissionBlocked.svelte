<script lang="ts">
  import { backToList, openStartSheet, rec } from "../lib/app.svelte";
  import Icon from "../lib/ui/Icon.svelte";
</script>

<!--
  權限被拒（阻斷頁）（FR-102 / AC-3：未授權時說明原因並引導至系統設定，**不得靜默失敗**）。
  這裡刻意是「阻斷頁」而不是一個 toast：沒有麥克風就沒有這個產品，含糊帶過等於騙使用者。
-->
<section class="blocked" data-testid="perm-blocked">
  <!-- 圖示對齊原型：權限被拒用 `ban`（`docs/prd/01-listen.html` 的空狀態／權限頁）。 -->
  <p class="big" aria-hidden="true"><Icon name="ban" size={38} /></p>
  <h2>沒有麥克風權限</h2>
  <p>{rec.snapshot.notice?.message ?? "本 App 需要麥克風權限才能錄製會議內容。"}</p>

  <ol class="steps">
    <li>打開 iOS「設定」</li>
    <li>找到 tree_factory</li>
    <li>把「麥克風」打開</li>
  </ol>

  <div class="actions">
    <button type="button" class="ghost" onclick={backToList}>先回首頁</button>
    <button type="button" class="primary" data-testid="btn-perm-retry" onclick={openStartSheet}>
      已開啟，再試一次
    </button>
  </div>
</section>

<style>
  .blocked {
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

  p {
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.6;
  }

  .steps {
    margin: var(--space-4) 0 0;
    padding-left: var(--space-6);
    color: var(--text);
    font-size: 14px;
    line-height: 1.8;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: var(--space-3);
    margin-top: var(--space-6);
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
</style>
