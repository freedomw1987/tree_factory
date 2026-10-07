#!/usr/bin/env node
/**
 * 原型驗證器（Step 5 證據來源）
 *
 * 用途：把 5 份原型 HTML 的「畫面 × 狀態」全數跑一遍，斷言 6 件事：
 *   1. 每個狀態都能切換，且渲染出內容（不是空白、沒有 undefined / NaN）
 *   2. 高亮（目前狀態）恰為 1 個
 *   3. 沒有任何 JS 錯誤（pageerror / console.error）
 *   4. 深層連結（#view）首次載入即生效
 *   5. 圖示全部是 inline SVG（幾何正常、有子節點、stroke=currentColor），不得殘留 emoji 當 icon
 *   6. 關鍵互動流程可走完（語音先填後送 / 點句編輯儲存 / 摘要就地編輯 / 刪標籤 sheet）
 *
 * 執行：node docs/prd/tools/verify-prototypes.js
 * 需求：Playwright（本機沒有瀏覽器時用系統 Chrome，故指定 channel:'chrome'）
 * 退出碼：0 = 全綠；1 = 有失敗（失敗清單印在最後）
 */
const PW = process.env.PW_PATH || 'playwright';
let chromium;
try { ({ chromium } = require(PW)); }
catch { ({ chromium } = require('/Users/apple/.npm/_npx/e41f203b7505f1fb/node_modules/playwright')); }

const path = require('path');
const BASE = 'file://' + path.resolve(__dirname, '..') + '/';
const FILES = ['01-listen.html', '02-record.html', '03-ask.html', '04-edit.html', '05-concept.html'];
const DEEP = {
  '01-listen.html': ['home', 'start', 'meeting', 'perm', 'resume'],
  '02-record.html': ['tr', 'act', 'spk', 'fup', 'export'],
  '03-ask.html': ['src', 'mic', 'hist'],
  '04-edit.html': ['sum', 'act', 'regen'],
  '05-concept.html': ['card', 'merge', 'tag'],
};
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{26A0}\u{26A1}\u{270F}]/u;
const fails = [];
let total = 0;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });

  for (const f of FILES) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.goto(BASE + f);
    await page.waitForTimeout(250);

    const n = await page.locator('#panel button').count();
    let emojiHit = 0, icons = 0;
    for (let i = 0; i < n; i++) {
      const btn = page.locator('#panel button').nth(i);
      const label = (await btn.innerText()).trim();
      await btn.click();
      await page.waitForTimeout(70);
      total++;
      const r = await page.evaluate(() => {
        const out = { txt: '', kids: 0, active: 0, bad: [], icons: 0, emoji: [] };
        const app = document.querySelector('#app');
        out.txt = app.innerText.trim();
        out.kids = app.children.length;
        out.active = document.querySelectorAll('#panel button.on').length;
        if (/(^|>)(undefined|\[object|NaN)/.test(app.innerHTML)) out.bad.push('未填值');
        document.querySelectorAll('#app svg.si').forEach(s => {
          out.icons++;
          if (!s.children.length) out.bad.push('EMPTY-ICON（IP 查無此名）');
          if (s.getAttribute('stroke') !== 'currentColor') out.bad.push('stroke != currentColor');
          const b = s.getBoundingClientRect();
          // checkVisibility(): 對 display:none 的祖先（.toast / 未開的 .sheet）回 false，不算幾何異常
          if (s.checkVisibility() && (b.width < 16 || b.height < 16))
            out.bad.push('圖示過小 ' + Math.round(b.width) + 'x' + Math.round(b.height));
          if (s.getBoundingClientRect().width > s.parentElement.getBoundingClientRect().width)
            out.bad.push('圖示溢出：.' + s.parentElement.className);
          if (getComputedStyle(s).color !== getComputedStyle(s.parentElement).color)
            out.bad.push('圖示未繼承顏色');
          // 與同列第一行文字垂直置中（誤差 > 4px 就是「圖示浮起來/掉下去」）
          if (s.checkVisibility() && s.parentElement) {
            const tn = [...s.parentElement.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
            if (tn) {
              const rg = document.createRange(); rg.selectNodeContents(tn);
              // 取「第一行」的行盒（多行文字的 union box 中心會落在中間行，會誤判）
              const tr = rg.getClientRects()[0];
              if (tr && tr.height > 0) {
                const dy = Math.abs((b.top + b.height / 2) - (tr.top + tr.height / 2));
                if (dy > 4) out.bad.push('圖示未與文字對齊（誤差 ' + Math.round(dy) + 'px）');
              }
            }
          }
        });
        // 圖示槽必須是 SVG，不能是 emoji 文字
        document.querySelectorAll('#app .bn span, #app .tbar h3, #app .empty .ic, #app .eb').forEach(e => {
          if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{26A0}\u{26A1}\u{270F}]/u.test(e.textContent))
            out.emoji.push(e.className + ':' + e.textContent.trim().slice(0, 14));
        });
        return out;
      });
      icons += r.icons;
      if (r.txt.length < 40 && r.kids < 2) fails.push(`${f}「${label}」渲染過短（${r.txt.length} 字 / ${r.kids} 元素）`);
      if (r.bad.length) fails.push(`${f}「${label}」${[...new Set(r.bad)].join(';')}`);
      if (r.active !== 1) fails.push(`${f}「${label}」高亮數 = ${r.active}`);
      if (r.emoji.length) { emojiHit++; fails.push(`${f}「${label}」UI 仍用 emoji 當 icon：${r.emoji[0]}`); }
    }

    for (const v of DEEP[f]) {
      const q = await browser.newPage();
      const e2 = [];
      q.on('pageerror', e => e2.push(e.message));
      await q.goto(BASE + f + '#' + v);
      await q.waitForTimeout(150);
      const title = await q.locator('.tbar h3').innerText().catch(() => '');
      if (!title) fails.push(`${f}#${v} 深層連結未生效`);
      if (e2.length) fails.push(`${f}#${v} JS 錯誤 ${e2[0]}`);
      await q.close();
    }
    console.log(`${f}: 狀態 ${n}｜SVG 圖示 ${icons}｜JS 錯誤 ${errs.length ? errs.join('|') : '0 ✓'}｜emoji 殘留狀態 ${emojiHit}`);
    if (errs.length) fails.push(...errs.map(e => `${f} ${e}`));
    await page.close();
  }

  // ---- 互動流程 ----
  const p = await browser.newPage();
  await p.goto(BASE + '03-ask.html'); await p.waitForTimeout(250);
  if (!(await p.locator('#sendbtn').isDisabled())) fails.push('03-ask：空白輸入時送出鈕應 disabled');
  await p.locator('#micbtn').click(); await p.waitForTimeout(900);
  const filled = await p.locator('#qbox').inputValue();
  const hinted = /先填進輸入框/.test(await p.locator('#app').innerText());
  if (!filled || !hinted) fails.push('03-ask：語音「先填後送」流程異常');
  await p.locator('#sendbtn').click(); await p.waitForTimeout(1100);
  if (!/林小美負責補/.test(await p.locator('#app').innerText())) fails.push('03-ask：送出後未出現附來源回答');
  console.log(`03-ask 互動：先填後送 ✓（「${filled.slice(0, 12)}…」）｜送出後附來源 ✓`);

  const q2 = await browser.newPage();
  await q2.goto(BASE + '04-edit.html#tr'); await q2.waitForTimeout(250);
  await q2.locator('.line .c').nth(1).click(); await q2.waitForTimeout(150);
  await q2.locator('#editbox').fill('行銷的部分超支大概 12%，明細我週五給。'); await q2.waitForTimeout(120);
  await q2.locator('.cta.sm').first().click(); await q2.waitForTimeout(900);
  const t2 = await q2.locator('#app').innerText();
  if (!/已儲存/.test(t2) || !/明細我週五給/.test(t2)) fails.push('04-edit：逐字稿就地編輯後畫面未更新');
  await q2.goto(BASE + '04-edit.html#sum'); await q2.waitForTimeout(250);
  await q2.locator('.cta.sm.ghost').first().click(); await q2.waitForTimeout(150);
  if (await q2.locator('#sumbox').count() !== 1) fails.push('04-edit：摘要就地編輯 textarea 未出現');
  await q2.locator('#sumbox').fill('本季行銷預算不追加，挪移研發結餘支應（含預備金）。'); await q2.waitForTimeout(120);
  await q2.locator('.cta.sm').first().click(); await q2.waitForTimeout(400);
  if (!/含預備金/.test(await q2.locator('#app').innerText())) fails.push('04-edit：摘要儲存後未更新');
  console.log('04-edit 互動：逐字稿就地編輯 ✓｜摘要就地編輯 ✓');

  const q3 = await browser.newPage();
  await q3.goto(BASE + '05-concept.html#tag'); await q3.waitForTimeout(250);
  await q3.locator('#panel button', { hasText: '刪標籤不動會議' }).click(); await q3.waitForTimeout(200);
  await q3.locator('.cta.ghost').first().click(); await q3.waitForTimeout(200);
  if (await q3.locator('.sheet').count() !== 1) fails.push('05-concept：刪標籤確認 sheet 未出現');
  console.log('05-concept 互動：刪標籤確認 sheet ✓');

  await browser.close();
  console.log(`\n總計 ${total} 狀態｜失敗 ${fails.length}`);
  fails.forEach(x => console.log('  ✗ ' + x));
  process.exit(fails.length ? 1 : 0);
})();
