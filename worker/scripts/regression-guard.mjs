#!/usr/bin/env node
/**
 * Gate 3 regression guard（依 ~/.pi/agent/skills/regression-guard）：
 *   - 禁止 watch / interactive 模式（TTY fail-fast，逾時 120 秒即判失敗）
 *   - REGRESSION_MODE=true 時自動執行；失敗輸出 suggestion
 *   - REGRESSION_MODULE=M01 可限定只跑某 Module 的探針（探針名含 Module 前綴）
 *   - 產生文本 + JSON 報告（REGRESSION_REPORT_PATH 可覆寫）
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const moduleFilter = process.env.REGRESSION_MODULE ?? "";
const reportPath = resolve(
  process.env.REGRESSION_REPORT_PATH ??
    `reports/regression${moduleFilter ? `-${moduleFilter.toLowerCase()}` : ""}.json`,
);
const startedAt = new Date();
const args = ["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`];
if (moduleFilter) args.push("-t", moduleFilter);

console.log(
  `[regression-guard] REGRESSION_MODE=${process.env.REGRESSION_MODE ?? "(unset)"} ` +
    `REGRESSION_MODULE=${moduleFilter || "(all)"} → npx ${args.join(" ")}`,
);
const result = spawnSync("npx", args, { stdio: "inherit", timeout: 120_000 });
const timedOut = result.error?.code === "ETIMEDOUT";

let report = null;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  /* 報告不存在＝測試根本沒跑起來 */
}

const failed = report?.numFailedTests ?? -1;
const passed = report?.numPassedTests ?? -1;
console.log(`\n[regression-guard] 結果：passed=${passed} failed=${failed}`);
console.log(`[regression-guard] 報告：${reportPath}`);

if (process.env.REGRESSION_OUTPUT !== "json-only" && report) {
  for (const file of report.testResults ?? []) {
    const rel = file.name.replace(`${process.cwd()}/`, "");
    for (const test of file.assertionResults ?? []) {
      console.log(`  ${test.status === "passed" ? "✓" : "✗"} ${rel} :: ${test.title}`);
    }
  }
}

// passed > 0 是必要的：`-t <Module>` 篩不到任何測試時 vitest 會以 0 退出，
// 若只看 exit code，會得到「0 個測試的綠燈」這種假通過。
const ok = !timedOut && result.status === 0 && failed === 0 && passed > 0;
if (!ok) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    `${reportPath}.suggestion.md`,
    [
      "# Gate 3 regression 失敗",
      "",
      `- 時間：${startedAt.toISOString()}`,
      `- 逾時（>120s，可能誤入 watch 模式）：${timedOut}`,
      `- passed / failed：${passed} / ${failed}`,
      "",
      "## 建議（suggestion）",
      "",
      "1. 先看失敗的探針名稱（含 Module 前綴）→ 對應 `docs/ac/` 的哪條 AC。",
      "2. 若是**實作錯**：修 `worker/src/`（不得改測試 expectation）。",
      "3. 若是**測試假設錯**：改測試並在 `docs/ac/` 明寫契約（M01-US-109 有先例）。",
      "4. 重跑：`REGRESSION_MODE=true npm run regression`。",
    ].join("\n"),
  );
  console.error(`\n[regression-guard] ❌ 失敗 → suggestion 已寫入 ${reportPath}.suggestion.md`);
} else {
  console.log("[regression-guard] ✅ 通過");
}
process.exit(ok ? 0 : 1);
