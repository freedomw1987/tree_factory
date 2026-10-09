# 信任模式交接報告（第二次）：TECH-007 未複驗狀態

- 日期：2026-10-09
- 窗口：07:28:15 ~ 11:53（用戶於 11:52 指示 finalize）
- 上一份交接：`docs/deliverable/2026-10-09-trust-mode-handoff.md`（那是 10:33 的第一版）

## 0. 更新（2026-10-09 12:10）：第二輪已補跑、TECH-007 已提交

本檔寫於 11:53 finalize 當下，當時的狀態是「第二輪 Gate 4 尚未執行、TECH-007 未提交」——
下面的交接清單保留原樣，作為當時的現場紀錄。使用者選擇補跑之後：

- 第二輪 workflow `ae3cf322-3b71-498c-a417-3c912bbbb844`：reviewer `a106e4b5-…` **可合併（附註）**（4 × P3，全是文件數字／行號）、
  oracle `e28c27d8-…` **可合併**（3 × P3）——**0 × P0/P1**。
- 4 條 reviewer P3 已修（第一輪／第二輪閘門數字混寫、交付文證據行號、「76px」更正為 68px、§5.2「未執行」過期）；
  oracle P3-2 要求的橫向複跑兩次皆 `9 passed`；oracle P3-3 要求的層級備註已補。
- TECH-007 已提交：`feat(app/ui)` `63d52ea` ＋ docs（與本檔同批）。
- 因此「交接清單」第 1／2／6 步已由本輪完成；仍未驗的四項（真機 `env()`、其他畫面橫向、動態字級、5px 遮擋）不變。

## 1. 一句話狀態

TECH-012 已提交；**TECH-007 的產品碼、測試與文件都已完成並跑過 Gate 1／2／3 ＋ 突變表，
但第二輪 Gate 4 沒跑到，因此尚未提交**（工作區原狀保留）。

## 2. 交接清單（照順序做完就能收尾）

```bash
cd /Users/apple/Sites/localhost/tree_factory

# ① 重啟第二輪 Gate 4（reviewer 唯讀／oracle 才能跑 Playwright；埠 8787／1420 需先確認沒人佔用）
lsof -nP -iTCP:8787 -sTCP:LISTEN; lsof -nP -iTCP:1420 -sTCP:LISTEN

# ② 由主 agent 執行（腳本已驗過語法，139 行）：
#    subagent({ workflow: "/tmp/tech007-gate4-r2.js", async: true })

# ③ 收到兩個通道結論後，把結論與逐條處置填回交付文 §5.2，
#    並在 docs/trust-log.md 追加一條「Gate 4 第二輪結案」。

# ④ 閘門複跑（本輪已綠，收尾前再確認一次）
cd worker && npx tsc --noEmit 2>&1 | tail -3; npx markdownlint-cli2 --config ../.markdownlint-cli2.jsonc "../docs/**/*.md" "../*.md" | tail -3
cd ../app/ui && npx vitest run 2>&1 | tail -3 && npx playwright test --output=/tmp/pw-t007-final --reporter=line 2>&1 | tail -3

# ⑤ 提交（只加這一票的路徑；跳過 3 個 apple xcode 檔與 2 個 spike 檔；不要 push）
git add app/ui/index.html app/ui/src/App.svelte app/ui/src/lib/layout/safe-area.test.ts \
        app/ui/e2e/iphone-screens.spec.ts \
        docs/ac/TECH-007.md docs/design/TECH-007-iphone-screens-layout.md \
        docs/deliverable/2026-10-09-TECH-007-手機寬度版面收斂.md \
        docs/deliverable/2026-10-09-trust-mode-handoff-2.md docs/backlog.md docs/trust-log.md
git status --short   # 確認沒有多餘檔案被帶進去
```

## 3. 已完成且已驗的證據（可重驗）

| 項目 | 數字／位置 |
| --- | --- |
| Gate 1 紅 | 單元 `4 failed ｜ 5 passed (9)`；E2E `9 failed` ＋ `4 passed`（9 條紅全是橫向）；log `/tmp/tech007-r2-gate1-red.log` |
| Gate 1 綠 | spec `13 passed (8.4s)`；單元 `9 passed` |
| Gate 2 | `typecheck` 0/0；`check:icons` PASS；`vitest` **231 passed（23 檔）**；markdownlint **77 檔 0 issues** |
| Gate 3 | 全套 E2E **52 passed（56.1s）**（既有 39 ＋ 新增 13；既有斷言沒有改） |
| 突變表 | `/tmp/tech007-mutations.py` 10 條：M1 `0`／M1b `3`／M2 `9`／M3 `9`／M4 `3`／M5 `13`／M6 `6`／M7 `6`／M8 `1`／M9 `1` |
| 突變產物 sha256 | 腳本 `8fd9686f…`；表格 `b8207ea7…`；log `9b482011…`（交付文 §4 的表格與腳本輸出**逐字相符 True**） |
| 第一輪 Gate 4 | workflow `082b7633-f3b3-47ef-be87-396407227a78`；reviewer `577a7ced-…`（可合併附註，2 P2 ＋ 6 P3）；oracle `9d3e3b8b-…`（可合併附註，1 P2 ＋ 6 P3） |

## 4. 未驗／未做（不可宣稱已完成）

1. **第二輪 Gate 4 未跑**（見 §1 與交付文 §5.2）。
2. **真機驗收未做**：橫向安全區在 E2E 裡是**注入的常數**（`addStyleTag` 寫死 44pt），
   真機 `env(safe-area-inset-*)` 的實際值沒有量過。
3. **其他畫面在橫向未驗**：會議中畫面、`RecoverPrompt`、逐字稿缺口列。
4. **動態字級未驗**：`html { font-size: 24px }` 之後 44px 門檻與不溢出斷言是否仍成立。
5. **橫向權限頁 CTA 底部約 5px 疊在 tabbar 下**：留痕不修（見交付文 §6）。

## 5. 風險與建議

- 若第二輪 Gate 4 回來有 P0／P1，**修完要再跑一輪**（改到測試碼就算 remediation）。
- 若決定不跑第二輪就提交，請把「未複驗」明確寫在提交訊息裡，不要讓 §5.1 的附註看起來像背書。
- 下一張票的建議順序不變：TECH-003 仍卡在缺少 Cloudflare 憑證（無法驗真的 STT），
  可先取 TECH-009（P1／3 SP）。
