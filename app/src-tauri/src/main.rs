// Windows 平台隱藏 console；其他平台此屬性無作用。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tree_factory_lib::run()
}
