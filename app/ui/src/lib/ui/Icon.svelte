<script lang="ts">
  import { iconShape, type IconName } from "./icons";

  /**
   * 線性圖示（DESIGN.md §5 規則 8）：**不得用 emoji 當圖示**。
   * 規格固定為 24 viewBox / `stroke="currentColor"` / stroke-width 1.75 / `fill="none"`，
   * 顏色一律繼承父層（顏色即狀態），尺寸由呼叫端決定（內文 18pt、空狀態 38pt）。
   */
  const {
    name,
    size = 18,
    label,
  }: { name: IconName; size?: number; label?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
  focusable="false"
  data-testid={`icon-${name}`}
>
  <!-- 圖形指令是 repo 內的常數（不是使用者輸入），且經 `iconShape` 只認自有鍵，故以 @html 展開。 -->
  {@html iconShape(name)}
</svg>
