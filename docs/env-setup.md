# 環境前置紀錄（TECH-001）

| 項目 | 值 |
| --- | --- |
| 對應票 | `docs/backlog.md` TECH-001（P0 / 2 SP / 擋門票）|
| 目的 | 把「錄音 → 逐字稿 → 三層記錄 → 匯出」整條線的開發與驗證工具鏈在本機裝齊，並留下**可重跑**的證據 |
| 執行日期 | 2026-10-08 |
| 機器 | macOS（Apple Silicon arm64）/ Xcode 27.0 / shell = zsh |

---

## 1. 結果總表

| 項目 | 需求 | 結果 | 證據命令 |
| --- | --- | --- | --- |
| Xcode | 15+ **完整版**（非 CLT）| ✅ 27.0（27A266a）| `xcodebuild -version` |
| iOS Simulator runtime | 至少一台可開的 iPhone | ✅ iOS 27.0 Simulator（24A434 / arm64）| `xcrun simctl list devices available` |
| rustup | toolchain 管理器（無它無法加 iOS target）| ✅ 1.29.1 | `rustup --version` |
| rustc / cargo | stable | ✅ 1.99.0（rustup 管理）| `rustc --version` |
| iOS Rust targets | 3 個 | ✅ `aarch64-apple-ios` / `aarch64-apple-ios-sim` / `x86_64-apple-ios` | `rustup target list --installed` |
| clippy / rustfmt | §2.3 Gate 2 用 | ✅ 皆已裝 | `rustup component list --installed` |
| CocoaPods | Tauri 2 iOS **必需**（`gen/apple/Podfile`）| ✅ 1.17.0 | `pod --version` |
| tauri-cli | 2.x | ✅ 2.11.4（`cargo tauri`）| `cargo tauri --version` |
| node / npm / pnpm / bun | — | ✅ 22.23.1 / 10.9.8 / 11.22.0 / 1.3.14 | `node -v` |
| wrangler | Cloudflare 部署工具 | ✅ 4.148.0（`~/.local/bin/wrangler`，免 sudo）| `wrangler --version` |
| Cloudflare 帳號 | Workers / Durable Object | ✅ `davidaasm@gmail.com`（Account ID `989bd6be…`）| `wrangler whoami` |
| Apple 開發者帳號 | **模擬器不需要**；真機測試與簽章才要 | ❓ 待確認 | — |

---

## 2. 驗收三條（TECH-001 AC）

```console
$ rustup target list --installed | grep ios
aarch64-apple-ios
aarch64-apple-ios-sim
x86_64-apple-ios

$ xcrun simctl list devices available | grep -m1 iPhone
    iPhone 18 Pro (56439690-28D4-4136-A80C-CBAE5DDCE4AD) (Shutdown)
    iPhone 18 Pro Max / iPhone 17e / iPhone Air / iPhone 17 亦可用（iOS 27.0）

$ wrangler whoami
👋 You are logged in with an OAuth Token, associated with the email davidaasm@gmail.com.
│ Davidaasm@gmail.com's Account │ 989bd6bed8ac2b33221a5fbc76798be1 │
```

---

## 3. 這次實際做了什麼（可重跑的命令序列）

```bash
# ① 裝 rustup（官方腳本；--no-modify-path 讓我們自己控制 PATH 順序）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --profile default --default-toolchain stable --no-modify-path

# ② 加 iOS targets
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# ③ 移除 Homebrew rustc（避免雙 toolchain；先確認無人依賴：brew uses --installed rust → 空）
brew uninstall rust

# ④ CocoaPods（Tauri 2 iOS 的 Podfile 需要）
brew install cocoapods

# ⑤ wrangler（npm prefix = ~/.local → 不需要 sudo）
npm i -g wrangler && wrangler login

# ⑥ iOS Simulator runtime（約 8 GB，20~40 分鐘，免 sudo）
xcodebuild -downloadPlatform iOS
```

`~/.zshrc` 追加（放最後一行＝放 PATH 最前面，確保贏過 Homebrew）：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

---

## 4. 踩到的坑與對應決策

| 坑 | 現象 | 決策 |
| --- | --- | --- |
| **backlog §7 漏列 CocoaPods** | Tauri 2 iOS 會產生 `gen/apple/Podfile`，沒有 `pod` 會在 `tauri ios init` 用奇怪的方式失敗 | 已補進 §7；本檔一併記錄 |
| **雙 toolchain 汙染** | Homebrew 的 `rustc` 與 rustup 的 `rustc` 並存，`which rustc` 可能指到錯的，且 Homebrew 版**無法**加 iOS target | 移除 Homebrew `rust`（先以 `brew uses --installed rust` 確認無依賴）；`~/.cargo/bin` 置於 PATH 最前 |
| Xcode 只有 CLT 的常見錯誤 | `simctl` / `xcodebuild` 會找不到 | 本機已是完整版 Xcode 27.0，且 `xcodebuild -checkFirstLaunchStatus` 回 0（首啟元件已備）|
| npm 全域安裝要 sudo | 常見於 Homebrew node | 本機 npm prefix = `~/.local` → 免 sudo（維持 `~/.local/bin` 已在 PATH）|
| `tauri` 指令找不到 | tauri-cli 裝的是 `cargo-tauri`，正確用法是 `cargo tauri` | 統一用 `cargo tauri …`；不另外造 `tauri` 別名 |

---

## 5. 仍未完成 / 帶進後續票

| 項目 | 影響票 | 說明 |
| --- | --- | --- |
| Apple 開發者帳號（付費）| 真機測試 | 模擬器開發（階段 A 全程）**不需要**；要上真機 / TestFlight 時才要 |
| Android SDK | 無（本案 iOS only）| 決策已排除，不裝 |
| Regression pipeline 骨架（`REGRESSION_MODULE=M01` 全套）| M01-US-101 ~ 105、INT-M01-M02-01 的 DoD | backlog 明載「pipeline 腳本由 TECH-001 建立」；但 runner 與探針語言取決於 SPIKE-001/002 的技術結論 → 待第一張有程式碼的票時一次立對 |

---

## 6. 邊緣授權與速率限制的環境設定（TECH-009）

`worker/src/index.ts` 的 `/m/**` 閘門是 **fail-closed**：沒設定 `DEVICE_TOKEN` 的 worker，會對所有
`/m/**`（`OPTIONS` 與 `GET /` 除外）回 `500 AUTH_NOT_CONFIGURED`。**這是刻意的**——「沒設就放行」的
靜默開發模式，正是這一票要消滅的失敗模式。

### 6.1 worker（伺服端）

```bash
# ① 正式環境：secret 不進版控，交給 Cloudflare 的 secret store
cd worker && wrangler secret put DEVICE_TOKEN      # 貼上同一把憑證

# ② 本機開發：worker/.dev.vars（已在 .gitignore）
#    DEVICE_TOKEN=<與 app 同一把>
#    RATE_LIMIT_MAX=300          # 選用，預設 300
#    RATE_LIMIT_WINDOW_MS=60000  # 選用，預設 60000
cd worker && npx wrangler dev --port 8787
```

`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` 的解析規則是「**不合法就用預設**」：空白、`0`、負數、
小數、`1e3`、`0x10`、亂字串一律視為沒設定（**不會**變成無上限、也**不會**變成全部 `429`）。

### 6.2 app（裝置端）

```bash
# 開發：把同一把憑證給 Vite（playwright.config.ts 的 webServer 就是這樣餵 E2E 的）
cd app/ui && VITE_DEVICE_TOKEN=<同一把> npm run dev
```

沒設 / 空字串 / 只有空白 → **不送** `Authorization`（`deviceTokenFrom` 會回 `undefined`），
於是請求會被伺服端回 `401`，UI 顯示「裝置授權已失效，請重新配對」。
**刻意不提供**「開發時自動放行」的旗標。

### 6.3 開發時怎麼確認閘門是通的

```bash
# CORS 探測：沒帶 --token 時 POST 會是 401（那是憑證問題，不是 CORS 壞了；探測器會自己講）
cd worker && node scripts/cors-probe.mjs --token <同一把>

# 入口層 + DO 全鏈路（真 workerd）
cd worker && DEVICE_TOKEN=<同一把> node scripts/do-smoke.mjs
```

> ⚠️ **啟動 worker 時的坑（實測踩過）**：`DEVICE_TOKEN=s3cret npx wrangler dev` **不會**把 binding
> 餵進 worker（wrangler 不從 process env 取 binding）——你會看到每個 `/m/**` 都回
> `500 AUTH_NOT_CONFIGURED`，然後誤判「閘門壞了」。**環境變數前綴只有 Node 腳本
> （`do-smoke.mjs`／`cors-probe.mjs`）在用**；worker 端要 `.dev.vars` 或 `--var`：
> `cd worker && npx wrangler dev --port 8787 --var DEVICE_TOKEN:s3cret --var HARNESS_PROVIDER:faux`。
> 少了 `HARNESS_PROVIDER:faux` 時 `/health` 會回 `401 AUTH_INVALID`「provider 需要
> `CLOUDFLARE_API_KEY`」——那不是憑證關擋的，是 harness 的模型憑證沒設（同一個碼的兩義，
> 見 `docs/ac/TECH-009.md` 的範圍界定）。

---

---

## 變動歷史

| 日期 | 版本 | 變更 | 作者 |
| --- | --- | --- | --- |
| 2026-10-09 | v1.2 | §6.3 補「啟動 worker 的坑」：`DEVICE_TOKEN=… npx wrangler dev` 不會把 binding 餵進 worker（要 `.dev.vars` 或 `--var`），以及缺 `HARNESS_PROVIDER:faux` 時 `/health` 回 401 `AUTH_INVALID` 是模型憑證問題、不是憑證關 | Agent（trust mode 執行階段 / TECH-009 Gate 4 第 2 輪）|
| 2026-10-09 | v1.1 | 新增 §6：`DEVICE_TOKEN`（worker secret／`.dev.vars`）與 `VITE_DEVICE_TOKEN`（app 建置）的設定步驟、不合法的 `RATE_LIMIT_*` 用預設的規則、以及 `cors-probe.mjs --token` / `do-smoke.mjs` 兩個開發檢查流程 | Agent（trust mode 執行階段 / TECH-009）|
| 2026-10-08 | v1.0 | 初版：TECH-001 環境前置執行紀錄（含 CocoaPods 補漏、雙 toolchain 處理）| Agent（§2.3 執行）|
