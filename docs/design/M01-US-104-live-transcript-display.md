# M01-US-104 設計：會議中即時顯示逐字稿（interim / 自動跟隨）

> 對應 Backlog: M01-US-104（P1 / 3 SP），AC 見 [`docs/ac/M01-US-104.md`](../ac/M01-US-104.md)。
> 上游：M01-US-103（帳本 + 串流落地）、TECH-013（讀取分頁／增量契約）。
> 設計者：Agent（trust mode 2026-10-09），決策逐條寫在 `docs/trust-log.md`。

## 1 問題與範圍

逐字稿**真的落地了**（US-103），但裝置端一個字都還沒顯示——現在的會議畫面只有
「等待第一句…」與缺口列（US-107）。本票是**顯示層**：

| 做 | 不做 |
| --- | --- |
| interim（未定稿）與 committed（已定稿）兩種樣式 | 不做 STT 接線（裝置端 audio → nova 的 WS 管線＝`TECH-003` P0/2SP 與 `INT-M01-M02-01` P0/5SP，皆未做） |
| 自動跟隨最新 + 上滑停止跟隨 + 「回到最新 · N 句新」 | 不改帳本、不改 worker 路由（讀取用 TECH-013 既有契約） |
| 渲染預算（最近 30 句 + 當前 interim + 缺口） | 不做編輯 / 搜尋 / 匯出（M04 / M02） |
| 讀取失敗的誠實狀態 | 不做跨請求 `pending`（TECH-012） |

## 2 資料流

```
worker DO（帳本 transcript_segments）
   │  GET /transcript/segments?since=<seq>&limit=<n>   ← TECH-013 契約
   ▼
LiveTranscriptFeed（輪詢；nextSince 水漂；hasMore 立刻續抓）
   │  applyPage({segments, nextSince})
   ▼
LiveTranscript（純狀態機；在 app/ui/src/lib/transcript/live-transcript.ts）
   │  committed[] ＋ interim（單一槽）＋ following / unread
   ▼
mergeTimeline(lines, gaps, budget)  → 畫面列（MeetingScreen 的 .transcript）
```

**interim 的來源（誠實聲明）**：裝置端還沒有 STT 連線，所以 interim 目前由**可注入來源**餵入
（`LiveTranscript.applyInterim()`）。真接線（audio → nova → interim 事件）屬 `TECH-003` /
`INT-M01-M02-01`（皆 P0，尚無人做）；
E2E 以既有紀律的 dev 鉤子 `__tf.pushInterim()` 驅動（同 US-107 的 `__tf.notifyVisibility()`，
那個鉤子同樣只在 dev 註冊）。這一條寫進 AC 的「測不到的部分」。

## 3 決策

| # | 決策 | 理由 | 可推翻 |
| --- | --- | --- | --- |
| D1 | committed 走 `GET /transcript/segments?since` **輪詢**（1000ms），不做 SSE / WS | TECH-013 就是為了這條路鋪的；WS 要 worker upgrade 支援，成本不在本票 | 若之後有真 WS 推播（US-106 原生層 era） |
| D2 | interim 由 `applyInterim()` 注入，**不落地**、不進帳本 | interim 會變動重寫，落地就違反 US-103 的 AC-6（只有 final 落地） | 若改為「顯示伺服端 pending」（需先做 TECH-012） |
| D3 | 跟隨狀態機（`following` / `unread`）住在純模組，DOM 只回報「是否離底部」 | 跟隨邏輯要能被突變測試殺；DOM 讀不到的東西不能當規格 | — |
| D4 | 離底部門檻 `FOLLOW_THRESHOLD_PX = 24`；超過即停止跟隨 | 手指微微抖動不該讓「回到最新」跳出來 | 若實測誤觸率高 |
| D5 | `unread` 只累加 **committed** 句，不累加 interim | 「N 句新」是句數承諾；interim 還不是一句 | — |
| D6 | 渲染預算＝最近 **30 句** committed ＋ 當前 interim ＋ 預算內的缺口；被省略的在列首明示「上方已省略 N 句」 | AC-4 的 DoD 要預算被鎖住；省略必須**看得見**，不能假裝全在畫面上 | 若 ≥500 句實測不卡則可放寬 |
| D7 | 句子與缺口合併成一條時間軸（`mergeTimeline`），依 `startMs` / `fromMs` 排序；同時間句子先 | 缺口列必須落在它真的發生的位置，否則「幾點斷的」會誤導 | 若 M04 要做多欄時間軸 |
| D8 | `applyPage()` 必須吸收對應的 interim（同段不得出現兩份）：定稿起點**不早於** interim 起點，**或**兩者時間區間**嚴格**相交（`rangesOverlap`，端點相接**不算**；且只看這一頁新增的列） | AC-2 的核心；重複顯示＝使用者以為被記了兩次。只比「起點先後」會漏掉真實 STT 把 final 起點**回填**到句子第一個字的情形 → 畫面會留一句鬼影 | 若真 STT 的 final 永遠不比 interim 早，可退回只比起點。**嚴格**的理由：連續句常是前句 `endMs === 後句 startMs`，放寬成「相接即相交」會誤殺正在說的那句 |
| D9 | 輪詢只在 `view === "meeting"` 且錄音活躍（`recording`）時；`interrupted` / `limit_reached` / 離開畫面即停 | 沒有新句還一直打是無意義的流量 | 若之後 interrupted 仍可能有句進來 |
| D10 | 讀取失敗**保留舊內容**＋分兩種文案：畫面本來是空的→「逐字稿暫時讀不到，連線恢復後會自動補上」；畫面已有內容→「…下面內容是稍早的」。狀態物件有 `lastOkMs`，但**畫面沒有顯示 mm:ss**（不假裝有時間戳） | 清空會被讀成「沒人在說話」——正是本票要防的誤解 | — |
| D11 | 追蹤水位用伺服端回的 `nextSince`，不用前端自己算 `max(seq)+1` | 空頁回 `null`（TECH-013 契約）：同一個 `since` 再問一次仍是空頁，不會有前進的假象 | — |
| D12 | 停止跟隨期間**不寫入 `scrollTop`** | AC-4 的「不得跳動」只能靠「根本不動它」保證；任何補償式修正都會抖 | — |
| D13 | `app.gaps` 與畫面**只有一條**寫入路徑 `setGaps()`（＝`app.gaps` + `syncTranscript()`） | 畫面渲染的是算好的 `transcript.entries` 快照；只改 `app.gaps` 會讓缺口列停在舊物件上 | — |
| D14 | 裁掉前綴時，缺口只在「整段都落在地板之下」才收掉（`gap.toMs === null \|\| gap.toMs >= floorMs`） | 跨過裁切點的缺口若跟著收掉，畫面會少報一次中斷——那比多一列更糟 | — |
| D15 | 去重鍵分兩個命名空間：有冪等鍵→`seg:<idempotencyKey>`，沒有鍵→`seq:<seq>` | 生產環境的鍵是伺服端合成的 `seg:<speakerId>:<startMs>`；若把沒鍵的列也組成 `seg:<seq>`，`idempotencyKey:"0"` 的列會與 `seq:0` 的列**互撞而被無聲丟掉** | — |
| D16 | 省略句數與實際裁切**共用同一個預算欄位**（`timeline(budget)` 先記 `#budget`，`counts.omitted` 用它算） | 兩套真相會出現「只畫 2 句卻說省略 0 句」 | — |
| D17 | 每個輪詢 tick 最多抓 `MAX_PAGES_PER_TICK = 20` 頁 | 上游若壞掉（`hasMore:true` 但水位不前進），續抓迴圈不會讓出事件迴圈 → 畫面直接凍住。上限只是「慢一點」，不是「漏掉」 | 若真需要一次補大量（例：恢復整場）改走獨立補頁流程 |
| D18 | interim 的清除接在「會讓它變成假話」的四個時點：結束會議、上限到點、離開會議畫面（含權限阻擋頁退回）、進背景（`clearInterim()`）；邊界解析一律用 `Number.isSafeInteger`，非整數水位視為 `null`（數字字串接受；`null`／空字串**不得**變成 `0`） | 進背景後裝置端不再收音，留著「正在說…」就是一句永遠不會定稿的謊；`?since=NaN` 會 400，而重讀同一頁會被冪等鍵去重（比 400 安全） | — |
| D19 | 畫面顯示的講者編號一律是「帳本 `speakerId` ＋ 1」（內部 0 起算） | 0 起算是傳輸契約（US-103），照原值顯示會出現「講者 0」；顯示層負責 +1，測試釘在元件層 | 若之後有真講者名（US-105）就改成以名代號 |

## 4 型別與介面（契約）

```ts
type LineState = "interim" | "committed";

interface TranscriptLine {
  key: string;          // committed: 有冪等鍵→`seg:<idempotencyKey>`；沒有鍵→`seq:<seq>`（兩個命名空間，D15）
                        // interim: `interim:<speakerId>`（同一時間單一槽）
  seq: number | null;   // interim 沒有 seq
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;        // interim 用目前已知終點（＝最新字詞時間）
  state: LineState;
}

// 缺口列帶**完整**的缺口物件（GapRecord 的 synced / conflict / terminal 都要畫）
interface GapRow { seq: number; fromMs: number; toMs: number | null; }
type TimelineEntry<G extends GapRow = GapRow> =
  | { kind: "line"; line: TranscriptLine }
  | { kind: "gap"; gap: G };

// 純狀態機（缺口型別用 class 層級泛型，畫面傳 GapRecord）
class LiveTranscript<G extends GapRow = GapRow> {
  // 寫入
  applyInterim(input: { speakerId: number; text: string; startMs: number; endMs: number }): void;
  clearInterim(): void;
  applyPage(page: { segments: readonly SegmentRow[]; nextSince: number | null }): void;  // 去重、單調
  applyGaps(gaps: readonly G[]): void;

  // 跟隨
  notifyUserScroll(distancePx: number): void;   // 離底部 > FOLLOW_THRESHOLD_PX → 停跟
  backToLatest(): void;                          // following = true, unread = 0

  // 讀
  get lines(): TranscriptLine[];
  get counts(): { committed: number; omitted: number; interim: number };
  get following(): boolean;
  get unread(): number;
  get pendingSince(): number | null;
  timeline(budget?: number): TimelineEntry<G>[];   // 句子 + 缺口，已排序、已裁切
}
```

`mergeTimeline` 的輸入是 `{ lines, gaps, budget }`，輸出是 `{ kind, line | gap }[]`，
被省略的句數以 `omitted` 回報（畫面要說出來）。

**與初版的差異（實作時修正）**：初版合約寫 `markScrolledAway()`，實作改成
`notifyUserScroll(distancePx)`。理由是「是否離底部」是 DOM 的事實（量得到的數字），
用布林旗標會迫使呼叫端自己判斷門檻，也讓 D4 的門檻值無法集中在一個地方；
另外 `isTrusted` **不能**用來分辨「使用者捲動」與「程式捲動」（Chromium 對程式設
`scrollTop` 也發 trusted 事件），所以改為「距離超過門檻且狀態有變才動作」。

## 5 樣式（AC-1 的可區分性寫在這裡，DoD 第 1 條）

| 項目 | interim（未定稿） | committed（已定稿） |
| --- | --- | --- |
| 顏色 | `var(--text-dim)` | `var(--text)` |
| 字型 | 斜體、`font-style: italic` | 正常 |
| 講者標籤 | **不顯示**（還沒定案，講者可能變） | 顯示 `講者 N` chip（`N` ＝帳本 `speakerId` ＋ 1，見 D19） |
| 資料屬性 | `data-line-state="interim"` | `data-line-state="committed"` |
| 語意 | 同一時間最多一列（單一槽） | 依 `seq` 遞增 |

**不得**用只有顏色差異來區分（色盲可及性）：斜體 + 講者標籤有無 + `data-line-state` 都不同。

## 6 驗證策略

| 層 | 內容 |
| --- | --- |
| 單元（node） | `live-transcript.test.ts`：D3/D4/D5/D6/D7/D8/D10/D11/D14/D15/D16 的狀態機與時間軸（D10 讀取失敗／恢復在該檔 `:342` 也有一條）；`live-transcript-feed.test.ts`：D9/D10/D11/D17 的輪詢、水位單調與頁數上限；`session/list-segments.test.ts`：D10/D11/D18 的網路邊界（畸形水位／小數時間戳丟列／空頁的 `null` 不得變 `0`）。**測試標題的 `M01-D<n>` 前綴就是本表決策編號**（突變表才能對回決策）。未列在前綴裡的 D3–D6／D16 由 `M01-AC-*` 標題釘住（它們就是那幾條 AC 的直接條目）。突變表見交付文件 §3 |
| 元件（SSR） | `transcript-line-row.test.ts`：AC-1/AC-2 的樣式屬性、「不得同時兩份」與 D19 的編號 1 起算 |
| E2E（真 worker + 真瀏覽器） | `e2e/live-transcript.spec.ts`：寫入 segments → 畫面出現；interim → committed 取代；上滑 → 不跳動 + N 累加 → 點回底部；512 句 → DOM 只留 30 列 + 操作延遲量測 |
| 不做 | STT interim 真接線、跨請求 pending（TECH-012）、iOS 真機 |

## 7 風險

1. **interim 沒有真來源**：本票只交付顯示能力與 committed 的真接線。使用者可見的 interim 需要
`TECH-003`（P0/2SP）→ `INT-M01-M02-01`（P0/5SP）；在那之前，畫面上的「正在說…」只有 dev 鉤子能產生。
2. **輪詢 vs 電池**：1000ms 只在會議畫面；TECH-011（app 對齊 DESIGN）可再調。
3. **捲動斷言在 E2E 較脆**：手動上滑用 `page.mouse.wheel()` 觸發（真事件、非 `scrollTo`）；
捲動本身用「`data-following="false"` + 距底距離 > 門檻 + 列數仍是 30 + 第 0 列已前進」四件
可觀察事實斷言，**不**比對 `scrollTop` 的位元相等（允許 `≤`：Chromium 的 scroll anchoring 會微調它，比對相等會偽陽性）。
反之，**已停止跟隨**、沒有裁切、只新增一句那條**可以**比對 `scrollTop` 相等（`toBe`，`e2e/live-transcript.spec.ts:211`）
——該情境沒有裁切、也沒有 scroll anchoring 介入，而它之所以能比位元相等，正是因為先前的 `mouse.wheel`（`:199-200`）
已把 `data-following` 打成 `false`（**不是**「跟隨中」）。
4. **缺口補送的畫面回歸（實作時真的發生，由既有 E2E 抓到）**：畫面改成渲染 `transcript.entries` 快照後，
   `syncPendingGaps()` 的臨時 tracker 只寫 `app.gaps`、不會重算快照，於是「離線缺口線上補送成功」時
   本機已是 `synced:true`、畫面卻永遠掛著「待同步」。修法是 D13（單一寫入路徑）。
   教訓：把「資料來源」換成快照時，**所有**寫入點都要一起換，不能只換主路徑。

## 8 AC 追溯矩陣

| AC | 實作 | 測試 |
| --- | --- | --- |
| AC-1 interim 顯示且可區分 | `applyInterim` + `TranscriptLineRow` | 單元（interim 槽）+ SSR（`data-line-state`、樣式類別）+ E2E |
| AC-2 定稿取代 interim、不得重複 | `applyPage` 去重與吸收（D8/D15） | 單元（同段不得兩份）+ SSR + E2E（文字出現次數＝1） |
| AC-3 自動跟隨 / 上滑停止 | `following`（D3/D4）+ `MeetingScreen` 的 scroll adapter | 單元（狀態機）+ E2E（底部 / 上滑後不再跟） |
| AC-4 「回到最新 · N 句新」+ 不跳動 | `unread`（D5）+ `backToLatest` + D12 | 單元（累加 / 歸零）+ E2E（N 遞增、scrollTop 不變、點擊回底） |
| DoD 渲染預算 | `timeline(budget)`（D6） | 單元（>30 句只回 30 + omitted）+ E2E（512 句 → DOM 30 列 + 一次捲動／回流量測） |
