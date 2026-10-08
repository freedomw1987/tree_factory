/**
 * 線性圖示的 path 資料（DESIGN.md §5 規則 8）。
 *
 * **與原型同源**：這份資料是從 `docs/prd/01-listen.html` 的 `IP` 對照表抽出來的
 * （同一份設計不得長出兩種圖示）。要新增圖示時先改原型、再把資料抽過來，
 * 不要在這裡手寫新的圖形。
 *
 * 規格：24 viewBox / `stroke="currentColor"` / stroke-width 1.75 / `fill="none"`；
 * 不得自帶顏色（否則「顏色即狀態」的語意會失效）。
 */
export const ICON_PATHS = {
  chat:
    '<path d="M20.5 11.6a8.1 8.1 0 0 1-8.6 8 9.2 9.2 0 0 1-3.6-.8L4.2 20.4l1.5-4a8 8 0 0 1-2-4.8 8.3 8.3 0 0 1 8.6-8 8.3 8.3 0 0 1 8.2 8z"/>',
  mic:
    '<path d="M12 3.2a3 3 0 0 1 3 3v5.6a3 3 0 0 1-6 0V6.2a3 3 0 0 1 3-3z"/><path d="M5.5 11.4a6.5 6.5 0 0 0 13 0"/><path d="M12 17.9v2.9M9 20.8h6"/>',
  ban:
    '<circle cx="12" cy="12" r="8.6"/><path d="M6.2 6.2 17.8 17.8"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/**
 * 取得圖形指令：**只認自有鍵**。
 *
 * 為什麼不直接 `ICON_PATHS[name]`：`name` 若意外傳入非自身鍵（例如 `"toString"`），
 * 會沿 prototype chain 取到 `Object.prototype.toString` 並被 `{@html}` 當內容渲染。
 * 不是 XSS（值不是使用者輸入），但這種「查表漏到原型鏈」不該出現在守則元件裡。
 */
export function iconShape(name: IconName): string {
  return Object.hasOwn(ICON_PATHS, name) ? ICON_PATHS[name] : "";
}
