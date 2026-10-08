// TECH-010：`cors-probe.mjs` 的**可測**部分（純函式，不做 IO）。
//
// 為什麼要拆出來：TECH-010 的 Gate 4 oracle 用突變 M5（把 `verdict()` 改成一律回
// `"allowed"`）證實——原版把這些判斷寫在 `.mjs` 裡，**殺不死任何測試**：
// `worker/tsconfig.json` 的 `include` 只有 `src/**/*.ts` 與 `test/**/*.ts`，
// `scripts/**` 既不進 typecheck、也沒有單元測試。於是「離開碼 0/1/2」這個 AC
// 只有「母行程手動跑過」的證據；任何人重構 `verdict()` 都會**靜默**改變結論，
// 最壞情況是把「埠漂移」誤報成「可以進 webview 實測了」。
//
// 拆法：判斷邏輯（解析參數、判讀結果、算離開碼、解析清單）留在這裡，IO（fetch、
// 讀檔、印字）留在 `cors-probe.mjs`。測試在 `worker/test/cors-probe-lib.test.mjs`。

/** 刻意漂移的來源：dev 的 1420 換成 1421，用來對照「埠漂移」長什麼樣。 */
export const DRIFTED_ORIGIN = "http://localhost:1421";

/** `--help` 要印的用法（放在這裡，測試才能斷言它非空）。 */
export const USAGE = "用法：node scripts/cors-probe.mjs [--base URL] [--origin O]… [--meeting ID] [--json]";

/**
 * 從 `src/cors.ts` 的**原始碼文字**解析 dev 白名單——單一真相來源。
 *
 * 為什麼不 import：`src/cors.ts` 是 TypeScript，node 直接跑不起來（腳本刻意不引入
 * build 步驟，跟 `do-smoke.mjs` 一致）。與其複製一份清單（兩份一定會漂移），不如解析。
 *
 * @param {string} source `src/cors.ts` 的內容
 * @returns {string[] | null} 清單；`null` ＝連區塊都找不到（清單搬家了）
 */
export function devOrigins(source) {
  const block = /export const DEV_ORIGINS = \[([\s\S]*?)\];/.exec(source);
  if (block === null) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * 決定這次要探測哪些來源。
 *
 * oracle P2-3：解析到區塊但**抓到 0 筆**（例如有人把雙引號改成單引號）時，舊版會
 * 靜默退化成「只剩漂移對照組」，然後照樣印「有來源被擋…」——**誤導**（真正該測的
 * 六個 dev 來源根本沒測）。這裡把它變成明確錯誤（呼叫端 exit 2）。
 *
 * @returns {{ origins: string[], error: string | null }}
 */
export function resolveOrigins(explicit, parsed) {
  if (explicit.length > 0) return { origins: explicit, error: null };
  if (parsed === null) {
    return { origins: [], error: "解析不到 src/cors.ts 的 DEV_ORIGINS（清單搬家了？請更新這支腳本）" };
  }
  if (parsed.length === 0) {
    return { origins: [], error: "src/cors.ts 的 DEV_ORIGINS 解析出 0 筆（引號風格改了？請確認清單格式）" };
  }
  // 預設跑一組「應該要過」與一組「應該要被擋」：對照組比單點檢查更能看出漂移。
  return { origins: [...parsed, DRIFTED_ORIGIN], error: null };
}

/**
 * 解析 CLI 參數。**不呼叫 `process.exit`**（那是呼叫端的事），錯誤用 `error` 回傳。
 *
 * @returns {{ base: string, origins: string[], meeting: string, json: boolean, help: boolean, error: string | null }}
 */
export function parseArgs(argv) {
  const origins = [];
  let base = "http://127.0.0.1:8787";
  let meeting = "cors-probe";
  let json = false;
  const take = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { value: undefined, error: `${flag} 缺少值` };
    return { value, error: null };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { base, origins, meeting, json, help: true, error: null };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--base" || arg === "--meeting" || arg === "--origin") {
      const { value, error } = take(arg, i);
      if (error !== null) return { base, origins, meeting, json, help: false, error };
      i += 1;
      if (arg === "--base") base = value;
      else if (arg === "--meeting") meeting = value;
      else origins.push(value);
      continue;
    }
    return { base, origins, meeting, json, help: false, error: `未知參數：${arg}（--help 看用法）` };
  }
  return { base: base.replace(/\/$/, ""), origins, meeting, json, help: false, error: null };
}

/**
 * 判讀一列探測結果。
 *
 * `x-cors-allowed` 是 TECH-010 的診斷標頭（需 `DEBUG_ORIGINS=1`）；
 * 沒開旗標時退回看「有沒有 `access-control-allow-origin`」，並在字串裡明講沒開旗標，
 * 避免讀者以為「allowed」是完整判斷。
 */
export function verdict(row) {
  if (row.error !== null && row.error !== undefined) return "unreachable";
  const flag = row.preflight?.allowed ?? null;
  if (flag !== null) return flag === "true" ? "allowed" : "blocked";
  return row.preflight?.allowOrigin ? "allowed（無診斷標頭：DEBUG_ORIGINS 沒開）" : "blocked（無診斷標頭）";
}

/**
 * 離開碼：`2` ＝有來源打不到（先確認 wrangler 起來了、埠對不對）；
 * `1` ＝至少一個來源被擋（＝埠漂移現場，先修 `ALLOWED_ORIGINS`）；
 * `0` ＝全部通過（可以安心進 webview 實測）。
 */
export function exitCodeFor(rows) {
  if (rows.length === 0) return 2; // 沒有來源可測（reviewer P2-5）：不可給 0，那會被讀成「全過」
  if (rows.some((row) => verdict(row) === "unreachable")) return 2;
  return rows.every((row) => verdict(row).startsWith("allowed")) ? 0 : 1;
}

/**
 * 給人看的收尾提示。
 *
 * 為什麼要分支（第二輪 oracle P2-2）：第一版對「有被擋」一律印
 * 「若是 dev 埠漂移，請設定 `ALLOWED_ORIGINS`」——但如果 worker 其實**已經**用
 * `ALLOWED_ORIGINS=tauri://localhost` 覆寫，預設清單的六個 dev 來源就全紅，
 * 而提示卻叫開發者去追一個**不存在**的埠漂移。
 * 真正該說的是：「這顆 worker 沒開 `DEBUG_ORIGINS`，無法分辨漂移與覆寫；
 * 若你用了 `ALLOWED_ORIGINS`，請用 `--origin` 指定實際來源」。
 */
export function hint(rows) {
  if (rows.length === 0) return "沒有來源可測——先確認清單來源（--origin 或 src/cors.ts）。";
  if (rows.some((row) => row.error !== null && row.error !== undefined)) {
    return "提示：先確認 wrangler dev 有起來，且 --base 的埠與 wrangler 一致。";
  }
  if (rows.every((row) => verdict(row).startsWith("allowed"))) {
    return "全部來源都在白名單內——可以進 webview 實測了。";
  }
  // 有任何一列的診斷標頭可用嗎？沒有＝`DEBUG_ORIGINS` 沒開，成因無法分辨。
  const flagged = rows.some((row) => (row.preflight?.allowed ?? null) !== null);
  if (!flagged) {
    return (
      "有來源被擋，但這顆 worker 沒開 DEBUG_ORIGINS（看不到 x-cors-allowed）：" +
      "無法分辨「埠漂移」與「ALLOWED_ORIGINS 覆寫」。" +
      "若你用了 ALLOWED_ORIGINS，請用 --origin 指定實際來源；" +
      "若懷疑漂移，請帶 --var DEBUG_ORIGINS:1 重啟 worker 再看一次。"
    );
  }
  return "有來源被擋：若是 dev 埠漂移，請設定／更新 ALLOWED_ORIGINS（見 docs/design/TECH-010-*.md）。";
}
