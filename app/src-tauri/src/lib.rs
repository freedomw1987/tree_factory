//! tree_factory — Tauri 2 應用程式入口（SPIKE-002：iOS webview 收音探針）。
//!
//! 手機入口由 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 提供；
//! 桌機（macOS）入口則走 `src/main.rs`。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
