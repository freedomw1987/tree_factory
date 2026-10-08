// M01-TECH-010：`scripts/cors-probe.mjs` 的判斷邏輯（Gate 4 oracle 的 P1 修法）。
//
// 為什麼需要這個檔案：oracle 的突變 M5（把 `verdict()` 改成一律回 `"allowed"`）
// **殺不死任何測試**——因為判斷邏輯原本寫在 `.mjs` 裡，既不在 `tsconfig` 的 `include`
// （只有 `src/**/*.ts`、`test/**/*.ts`），也沒有單元測試。於是「離開碼 0/1/2」
// 這個驗收條件只有「母行程手動跑過」的證據，重構會**靜默**改變結論。
// 修法：把純函式抽到 `scripts/cors-probe-lib.mjs`，由這個檔案守門。

import { describe, expect, it } from "vitest";

import {
  DRIFTED_ORIGIN,
  USAGE,
  devOrigins,
  exitCodeFor,
  hint,
  parseArgs,
  resolveOrigins,
  verdict,
} from "../scripts/cors-probe-lib.mjs";

const row = (over) => ({ origin: "http://x.test", preflight: null, post: null, error: null, ...over });

describe("M01-TECH-010 cors-probe 的判斷邏輯", () => {
  it("M01-TECH-010-Given 診斷標頭說 allowed=true When 判讀 Then allowed", () => {
    expect(verdict(row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: "true" } }))).toBe(
      "allowed",
    );
  });

  it("M01-TECH-010-Given 診斷標頭說 allowed=false When 判讀 Then blocked（這就是埠漂移的現場）", () => {
    expect(verdict(row({ preflight: { status: 204, allowOrigin: null, allowed: "false" } }))).toBe("blocked");
  });

  it("M01-TECH-010-Given 沒開旗標（無診斷標頭）When 判讀 Then 退回看 allow-origin 並明講沒開旗標", () => {
    expect(verdict(row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: null } }))).toBe(
      "allowed（無診斷標頭：DEBUG_ORIGINS 沒開）",
    );
    expect(verdict(row({ preflight: { status: 204, allowOrigin: null, allowed: null } }))).toBe(
      "blocked（無診斷標頭）",
    );
  });

  it("M01-TECH-010-Given 打不到 worker When 判讀 Then unreachable（不是 blocked，兩者處置不同）", () => {
    expect(verdict(row({ error: "fetch failed" }))).toBe("unreachable");
  });

  it("M01-TECH-010-Given 有來源打不到 When 算離開碼 Then 2（先確認 wrangler 起來了、埠對不對）", () => {
    expect(
      exitCodeFor([
        row({ error: "fetch failed" }),
        row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: "true" } }),
      ]),
    ).toBe(2);
  });

  it("M01-TECH-010-Given 全部通過 When 算離開碼 Then 0；有任何一個被擋 Then 1", () => {
    expect(
      exitCodeFor([row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: "true" } })]),
    ).toBe(0);
    expect(
      exitCodeFor([
        row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: "true" } }),
        row({ preflight: { status: 204, allowOrigin: null, allowed: "false" } }),
      ]),
    ).toBe(1);
    // 沒開旗標的兩種結果也要算對（否則 dev 現場會拿到 0＝「可以進 webview 實測了」）。
    expect(exitCodeFor([row({ preflight: { status: 204, allowOrigin: null, allowed: null } })])).toBe(1);
    // reviewer P2-5：空輸入目前不可達（resolveOrigins 保證 ≥1 筆），但純函式不該給「綠」的方向。
    expect(exitCodeFor([])).toBe(2);
    expect(hint([])).toContain("沒有來源");
  });

  it("M01-TECH-010-Given 預設參數 When 解析 Then base 去尾斜線、meeting 有預設、不帶 --origin 時清單為空", () => {
    expect(parseArgs([])).toEqual({
      base: "http://127.0.0.1:8787",
      origins: [],
      meeting: "cors-probe",
      json: false,
      help: false,
      error: null,
    });
    expect(parseArgs(["--base", "http://127.0.0.1:9000/", "--json"]).base).toBe("http://127.0.0.1:9000");
    expect(parseArgs(["--json"]).json).toBe(true);
  });

  it("M01-TECH-010-Given 重複的 --origin When 解析 Then 全部收下（對照組比單點檢查更能看出漂移）", () => {
    const args = parseArgs(["--origin", "tauri://localhost", "--origin", DRIFTED_ORIGIN]);
    expect(args.origins).toEqual(["tauri://localhost", DRIFTED_ORIGIN]);
    expect(args.error).toBeNull();
  });

  it("M01-TECH-010-Given 未知參數或缺少值 When 解析 Then 回錯誤（且不自己 exit，交給呼叫端）", () => {
    expect(parseArgs(["--bogus"]).error).toContain("未知參數：--bogus");
    expect(parseArgs(["--base"]).error).toContain("--base 缺少值");
    expect(parseArgs(["--origin", "--json"]).error).toContain("--origin 缺少值");
    expect(parseArgs(["--help"]).help).toBe(true);
    // reviewer P2-4：`USAGE` 的註解說「測試才能斷言它非空」，那就真的斷言。
    expect(USAGE).toContain("--base");
  });

  it("M01-TECH-010-Given 沒開旗標且有來源被擋 When 給提示 Then 說明「無法分辨漂移與 ALLOWED_ORIGINS 覆寫」", () => {
    // 第二輪 oracle P2-2：worker 已用 ALLOWED_ORIGINS 覆寫時，預設清單全紅，
    // 舊提示卻叫人「請設定 ALLOWED_ORIGINS」——把人送去追不存在的埠漂移。
    const rows = [row({ preflight: { status: 204, allowOrigin: null, allowed: null } })];
    const text = hint(rows);
    expect(text).toContain("ALLOWED_ORIGINS");
    expect(text).toContain("--origin");
    expect(text).not.toContain("請設定／更新 ALLOWED_ORIGINS");
  });

  it("M01-TECH-010-Given 開了旗標且有來源被擋 When 給提示 Then 才指向埠漂移；全綠／打不到另有提示", () => {
    const blocked = [row({ preflight: { status: 204, allowOrigin: null, allowed: "false" } })];
    expect(hint(blocked)).toContain("埠漂移");
    expect(hint([row({ preflight: { status: 204, allowOrigin: "http://x.test", allowed: "true" } })])).toContain(
      "可以進 webview 實測了",
    );
    expect(hint([row({ error: "fetch failed" })])).toContain("wrangler dev 有起來");
  });

  it("M01-TECH-010-Given src/cors.ts 的內容 When 解析 Then 取雙引號清單；找不到區塊回 null", () => {
    const source = [
      "export const DEV_ORIGINS = [",
      '  "http://localhost:1420",',
      '  "tauri://localhost",',
      "];",
    ].join("\n");
    expect(devOrigins(source)).toEqual(["http://localhost:1420", "tauri://localhost"]);
    expect(devOrigins("const DEV_ORIGINS = 42;")).toBeNull();
  });

  it("M01-TECH-010-Given 清單解析出 0 筆 When 決定要測哪些來源 Then 報錯（不靜默退化成只剩漂移對照組）", () => {
    // oracle P2-3：舊版在這裡只會靜默地測一個來源，然後印誤導的結論。
    const empty = resolveOrigins([], []);
    expect(empty.error).toContain("解析出 0 筆");
    expect(empty.origins).toEqual([]);
    const missing = resolveOrigins([], null);
    expect(missing.error).toContain("解析不到");
    const ok = resolveOrigins([], ["http://localhost:1420"]);
    expect(ok.origins).toEqual(["http://localhost:1420", DRIFTED_ORIGIN]);
    // 使用者自己指定來源時，就不碰 `src/cors.ts`（例如只想驗一個正式環境來源）。
    expect(resolveOrigins(["https://app.example"], null).origins).toEqual(["https://app.example"]);
  });
});