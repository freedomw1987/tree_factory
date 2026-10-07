# SPIKE-003：`@earendil-works/pi-durable` 能否跑在 Cloudflare Durable Object 內實測

- **對應 Module**：M02（記）／M03（問）——決定「會議大腦」放哪裡
- **狀態**：✅ 完成（2026-10-08，trust mode 執行）
- **執行者**：trust mode 自動執行（`docs/trust-log.md`）
- **時限目標**：1 天內給結論 → 實際約 55 分鐘
- **結論一句話**：**可以，而且是官方背書的路** —— 只要寫一個 **100 行**的 `SqliteDatabase`
  façade 把 DO SQLite 接起來，`Harness`（agent 大腦）就能在 Durable Object 內完整開機、
  跑完一次 turn、關掉重開還讀回同一場會議；**不需要 `nodejs_compat`**，整個 bundle 只有 860 KiB。

## 1. 為什麼要做這個 Spike

這是全案的**架構分水嶺**。DESIGN / system-design 把「會議大腦」放在 Cloudflare 的
PiHarness + Durable Object 上，但 `@earendil-works/pi-durable` 是 Node-first 的 Beta 套件，
`engines: node >= 22.19`；如果它只能在 Node 跑，整個後端就要改成「Node 服務 + Cloudflare 儲存」，
連帶影響 M02 的寫入時序、M03 的檢索點、以及「全 Workers AI」的成本前提。

## 2. 實驗設計（四關卡，由內而外）

| 關卡 | 驗什麼 | 工具 |
| --- | --- | --- |
| A. 依賴事實清查 | 真實 API 名稱、node: 內建模組落在哪些檔案、`SqliteDatabase` 介面有幾個方法 | 讀 `node_modules` 的 `.d.ts` 與 dist |
| B. 本機 smoke | 同一支 adapter 用 `node:sqlite` 當替身，跑「開機 → turn → 關掉重開」 | `spike/spike-003/test/smoke.mjs` |
| C. **官方一致性套件** | adapter 的**契約語意**是否正確（不是只有我們試過的呼叫能跑） | `@earendil-works/pi-durable/testing` 的 `registerStorageConformance`（23 個案例） |
| D. **真實 workerd** | 在 `wrangler dev` 的 Durable Object 內用真 DO SQLite 跑同一份程式碼 | `spike/spike-003/src/index.js` + `wrangler deploy --dry-run` |

## 3. 實測結果

### 3.1 依賴事實（關卡 A）

| 項目 | 事實 |
| --- | --- |
| **真名** | 沒有 `PiHarness` 這個符號；是 **`Harness.open(storage, options, context)`** |
| 匯入路徑 | `Harness` / `createRegistry` 從 `@earendil-works/pi-durable`；**`SqliteStorage` 從 `/storage/sqlite`**（不在根） |
| `SqliteStorage.open(db)` | 內部自行跑 `applySqliteMigrations`；**9 張表全部是 `STRICT`** |
| `SqliteDatabase` 介面 | 只有 6 個方法：`exec` / `run` / `get` / `all` / `transaction` / `close` |
| `node:*` 落點 | 只在 `storage/sqlite/node`、`env/node`、`env/node-watch` → **核心 + `/storage/sqlite`（抽象）+ `/env`（抽象）與 runtime 無關** |
| Workerd 內唯一殘留 | bundle 內有一處 **lazy** `importNodeModule("node:fs/promises")`，位於 `defaultProviderAuthContext().fileExists()` —— 只在走「檔案式憑證」時才會被呼叫，DO 路徑不會碰 |
| 模型 provider | **pi-ai 內建 `cloudflare-workers-ai`**（`cloudflareWorkersAIProvider(): Provider<"openai-completions">`）→ 原架構「全 Workers AI」**成立，不必繞 OpenAI 相容端點** |
| 測試友善 | `providers/faux`（`fauxProvider()` / `fauxAssistantMessage()`）可離線跑完整 turn，零成本 |

### 3.2 本機 smoke（關卡 B，`spike/results/spike-003-smoke.txt`）

```text
✓ SqliteStorage.open 成功（schema migration 跑完）
  表數=9，其中 STRICT=9
  sqlite_version=3.51.3
✓ Harness.open + root() 成功，conversationId=1
✓ 一次完整 turn 完成：status=done type=input
✓ harness.close() 完成（storage 亦隨之關閉）
✓ 重開後：conversation 相同=true，entries=2 → 2
SPIKE-003 smoke：全部通過 ✅
```

### 3.3 官方一致性套件（關卡 C，`spike/results/spike-003-conformance.txt`）

```text
ok 1 - DoSqliteDatabase（DO SQLite 形狀）
# tests 23
# pass 23
# fail 0
```

> 官方套件要求 Vitest/Jest 形狀的 runner；這裡用 `node:test` 加一層 40 行 shim 跑起來，
> 沒有為了驗證而引入 Vitest。

### 3.4 真實 workerd（關卡 D）

`npx wrangler deploy --dry-run`（**不部署**）：

```text
Total Upload: 860.61 KiB / gzip: 161.22 KiB
Binding                      Resource
env.HARNESS (HarnessDO)      Durable Object
```

→ **沒有 `nodejs_compat`** 也能打包成功。

`wrangler dev --local` 起 Durable Object，打 `GET /?step=full`
（報告：`spike/results/spike-003-do-report.json`）：

```text
ok = True
  ✅ boot：SqliteStorage.open（DO SQLite + migration）+ Harness.open + root() | 0 ms | conversationId=1
  ✅ schema：STRICT 表已建立 | 0 ms | {'tables': 10, 'strict': 9}
  ✅ turn：submit → wait（faux provider，DO 內完成） | 0 ms | {'status': 'done'}
  ✅ durability：關掉再重開，同一場會議讀得回來 | 0 ms | {'sameConversation': True, 'entries': '10 → 10'}
  ✅ 跨請求持久：DO SQLite 自己的一張表 | 0 ms | {'visits': 1}
第二次請求 → visits = 2   ← DO 被回收再進來的持久性
```

### 3.5 三個踩到的坑（都要回寫設計）

1. **`harness.close()` 會一併關掉 storage** → 「重啟」的正確姿勢是
   *重建 adapter + storage + harness*（同一份 DO SQLite），不是拿舊的 storage 再開。
   在 DO 裡這正好等於「DO 被回收後的下一次請求」。
2. **DO SQL 不授權 `sqlite_version()`**（`not authorized to use function`）→
   平台對 SQL 函式有白名單，健康檢查不要用 `sqlite_version()`（可用 `sql.databaseSize`）。
3. **workerd 的 DO SQLite 比 Node 的 SQLite 嚴格**：
   `ctx.storage.sql.exec()` 一次一句、回傳 cursor（可迭代、也有 `.toArray()`）；
   `bigint` 繫結不支援 → adapter 要轉型別。

### 3.6 限制與風險

| 風險 | 說明 | 緩解 |
| --- | --- | --- |
| Harness 排程器 vs DO 生命週期 | Harness 用非同步排程器推進工作；DO 在請求結束後可能被凍結 | turn 一律在請求內 `submit → wait`；長工作改用 **alarms** 接力（設計待補） |
| 憑證注入 | 檔案式憑證（`defaultProviderAuthContext`）在 workerd 不可用 | 憑證走 `env` 繫結（secret）傳入 provider 設定；SPIKE-004 驗證 |
| Beta API 會變 | 版本 `1.0.4`，`Harness`/`SqliteStorage` 介面仍可能調整 | adapter 只有 100 行、契約由官方一致性套件守住 → 升級成本可控 |
| DO SQL 函式白名單 | 如 `sqlite_version()` 不可用 | 只用標準 CRUD；需要的函式先在 dev 驗 |

## 4. 驗收對照（backlog §3 SPIKE-003）

| 問題 | 結論 |
| --- | --- |
| Pi Durable 能否在 DO 內跑 | ✅ 核心 + SQLite 儲存層可在 workerd 完整運作（含 migration、turn、durability） |
| 需不需要 Node 相容層 | ❌ 不需要；bundle 860 KiB / gzip 161 KiB |
| 儲存層要不要重寫 | ❌ 不用；只需 100 行 façade（`spike/spike-003/src/do-sqlite.js`） |
| 成本 / 憑證前提 | 走 pi-ai 內建的 `cloudflare-workers-ai` provider（全 Workers AI 成立） |

## 5. 對設計的影響（要回寫的文件）

1. **system-design §1**：把 `PiHarness` 正名為 **`Harness`**，並註明
   `SqliteStorage` 走 `/storage/sqlite`、DO 內需 `DoSqliteDatabase` façade。
2. **system-design §6**：DO 內會有兩套表並存 —— pi-durable 的 9 張 `STRICT` 表
   （`pi_*`）＋ 產品自己的表（`meeting` / `transcript_segment` / …），
   同一個 DO SQLite，一起在 `SqliteStorage.open()` 的 migration 之後建立。
3. **`@cloudflare/voice` 正式棄用**（SPIKE-001 已定）→ 依 `agents` 的 `voice` 子模組。
4. **長工作要用 alarms**：Harness 的排程器不能跨越 DO 凍結 → M02 的「會後生成筆記」
   要用 alarm 接力，不能只靠背景 promise。
5. **憑證走 secret 繫結**，不要依賴檔案式 auth context。

## 6. 待辦（建議新增 / 更新的 backlog 項）

| 建議票 | 內容 | 優先級 |
| --- | --- | --- |
| TECH-003 | `@cloudflare/voice` 棄用、改依 `agents/voice`（SPIKE-001 已提，這裡再確認） | P0 |
| TECH-004（新） | DO 內的 Harness 生命週期封裝：單一實例 + 懶初始化 + alarms 接力 + 憑證繫結 | P0 |
| SPIKE-004 | 2 小時會議的真實成本（改用 `cloudflare-workers-ai` provider 實測） | P0 |

## 7. 重跑方式（可重現）

```bash
cd spike/spike-003
npm install

# 關卡 B：本機 smoke（用 node:sqlite 當 DO SQLite 替身）
node test/smoke.mjs

# 關卡 C：官方 storage 一致性套件
node --test test/conformance.mjs

# 關卡 D：真實 workerd（不部署）
npx wrangler deploy --dry-run --outdir /tmp/spike003-dist
npx wrangler dev --local --port 8788 --show-interactive-dev-session=false &
curl -s "http://127.0.0.1:8788/?step=full" | python3 -m json.tool
curl -s "http://127.0.0.1:8788/?step=none" | python3 -m json.tool   # visits 應遞增
```

## 8. 變動歷史

| 版本 | 日期 | 變動 |
| --- | --- | --- |
| v1.0 | 2026-10-08 | 初版：四關卡全綠、不需 nodejs_compat、100 行 façade、三個踩坑 |