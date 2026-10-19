#!/usr/bin/env node
/* 离线单元测试：链接清洗、调度器、以及在一个伪造的小 Wikipedia 上跑 evaluate。 */
'use strict';
const assert = require('assert');
const { parseHTML } = require('linkedom');
const core = require('../src/core.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const doc = html => parseHTML('<!doctype html><html><body><div id="r">' + html + '</div></body></html>').document;

test('hrefToTitle / normTitle', () => {
  assert.strictEqual(core.hrefToTitle('/wiki/Ottoman_Empire#History'), 'Ottoman Empire');
  assert.strictEqual(core.hrefToTitle('/wiki/UTC%E2%88%9207:00'), 'UTC−07:00');
  assert.strictEqual(core.hrefToTitle('/wiki/ISO_3166-2:US'), 'ISO 3166-2:US');
  assert.strictEqual(core.hrefToTitle('/wiki/File:Foo.jpg'), null);
  assert.strictEqual(core.hrefToTitle('/wiki/Category:Bar'), null);
  assert.strictEqual(core.hrefToTitle('/w/index.php?title=X&redlink=1'), null);
  assert.strictEqual(core.hrefToTitle('#cite_note-1'), null);
  assert.strictEqual(core.normTitle('  iPhone_x '), 'IPhone x');
});

test('extractVisibleLinks 套用游戏的清洗规则', () => {
  const d = doc(`
    <p><a href="/wiki/Alpha">Alpha</a> <a href="/wiki/Beta" class="mw-redirect">B</a>
       <sup class="reference"><a href="#cite_note-1">[1]</a></sup> <a href="/wiki/Alpha">again</a></p>
    <div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>
    <p><a href="/wiki/Gamma" class="mw-disambig">Gamma</a></p>
    <div class="mw-heading mw-heading2"><h2 id="See_also">See also</h2></div>
    <ul><li><a href="/wiki/Delta">Delta</a></li></ul>
    <div class="mw-heading mw-heading3"><h3>Sub of see also</h3></div>
    <p><a href="/wiki/Epsilon">Epsilon</a></p>
    <div class="mw-heading mw-heading2"><h2 id="Legacy">Legacy</h2></div>
    <p><a href="/wiki/Zeta">Zeta</a></p>
    <div class="navbox"><a href="/wiki/Eta">Eta</a></div>
    <h2>References</h2><p><a href="/wiki/Theta">Theta</a></p>`);
  const links = core.extractVisibleLinks(d.getElementById('r'));
  assert.deepStrictEqual([...links.keys()], ['Alpha', 'Beta', 'Gamma', 'Zeta']);
  assert.strictEqual(links.get('Alpha').text, 'Alpha');
  assert.strictEqual(links.get('Beta').redirect, true);
  assert.strictEqual(links.get('Gamma').disamb, true);
});

test('调度器：优先级先行、每分钟上限', async () => {
  const s = core.makeScheduler(1, 1000);
  const order = [];
  const job = (name, ms) => () => new Promise(r => setTimeout(() => { order.push(name); r(); }, ms));
  await Promise.all([s.run(job('first', 20), 2), s.run(job('low', 1), 2), s.run(job('high', 1), 0)]);
  assert.deepStrictEqual(order, ['first', 'high', 'low']);

  const capped = core.makeScheduler(3, 2);
  let ran = 0;
  capped.run(async () => { ran++; });
  capped.run(async () => { ran++; });
  capped.run(async () => { ran++; });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(ran, 2, '第三个请求应该等到窗口过去');
  assert.strictEqual(capped.stats().queued, 1);
});

// ---- 伪造的 Wikipedia ----
// Start → A(以及重定向写法 Arel) / B / C ；A → P → T（3 步）；B 只在 navbox 里链接 T；C 链接 T 的重定向 Tr。
const PAGES = {
  Start: '<a href="/wiki/A">A</a> <a href="/wiki/B">B</a> <a href="/wiki/C">C</a> <a href="/wiki/Arel" class="mw-redirect">a</a>',
  Start2: '<a href="/wiki/B">B</a> <a href="/wiki/A">A</a>',
  A: '<a href="/wiki/P">P</a> <a href="/wiki/Q">Q</a>',
  B: '<a href="/wiki/Q">Q</a><div class="navbox"><a href="/wiki/T">T</a></div>',
  C: '<a href="/wiki/Tr" class="mw-redirect">t</a>',
  P: '<a href="/wiki/T">T</a>',
  Q: '<a href="/wiki/A">A</a>',
  T: '<a href="/wiki/A">A</a>',
};
const BACKLINKS = { T: [{ title: 'B' }, { title: 'P' }, { title: 'Tr', redirect: true, redirlinks: [{ title: 'C' }] }] };
const REDIRECTS = { Arel: 'A', Tr: 'T' };

function fakeWiki() {
  const calls = [];
  const fetch = async url => {
    const q = Object.fromEntries(new URL(url).searchParams);
    calls.push(q);
    let body;
    if (q.action === 'parse') {
      const title = REDIRECTS[q.page] || q.page;
      body = PAGES[title] == null ? { error: { code: 'missingtitle' } } : { parse: { title, text: { '*': PAGES[title] } } };
    } else if (q.list === 'backlinks') {
      body = { query: { backlinks: q.blfilterredir ? (BACKLINKS[q.bltitle] || []).filter(b => !b.redirect) : BACKLINKS[q.bltitle] || [] } };
    } else if (q.list === 'search') {
      body = { query: { search: [], searchinfo: { totalhits: 3 } } };
    } else if (q.prop === 'redirects') {
      body = { query: { pages: [{ title: q.titles, redirects: Object.keys(REDIRECTS).filter(k => REDIRECTS[k] === q.titles).map(title => ({ title })) }] } };
    } else if (q.titles) {
      const ts = q.titles.split('|');
      body = { query: {
        redirects: ts.filter(t => REDIRECTS[t]).map(t => ({ from: t, to: REDIRECTS[t] })),
        pages: ts.map(t => REDIRECTS[t] || t).map(t => PAGES[t] != null ? { title: t, length: PAGES[t].length } : { title: t, missing: true }),
      } };
    } else throw new Error('unexpected request ' + url);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

function linksOf(title) {
  return [...core.extractVisibleLinks(doc(PAGES[title]).getElementById('r'))].map(([t, info]) => Object.assign({ title: t }, info));
}

async function solve(start, opts) {
  const w = fakeWiki();
  const solver = core.createSolver({ fetch: w.fetch, parseHTML: h => parseHTML(h).document, options: opts });
  const st = solver.setTarget('en', 'T');
  await st.ready;
  while (!st.backlinksDone) await new Promise(r => setTimeout(r, 5));
  const res = await solver.evaluate('en', start, linksOf(start), opts && opts.eval);
  return { res, st, calls: w.calls };
}

test('evaluate：重定向直达是 2 步，navbox 里的链接不算，重定向别名合并', async () => {
  const { res, st } = await solve('Start');
  assert.ok(st.R.has('Tr') && st.B1.has('C') && st.B1.has('B'));
  const by = Object.fromEntries(res.ranked.map(c => [c.title, c]));
  assert.strictEqual(res.ranked[0].title, 'C');
  assert.strictEqual(by.C.tier, 1);
  assert.notStrictEqual(by.B.tier, 1, 'B 只在 navbox 里链接目标');
  assert.deepStrictEqual(by.A.aliases, ['Arel']);
  assert.strictEqual(by.Arel, undefined);
  assert.ok(res.done);
});

test('evaluate：没有 2 步时验证中转页，得到 3 步路线', async () => {
  const { res } = await solve('Start2');
  const by = Object.fromEntries(res.ranked.map(c => [c.title, c]));
  assert.strictEqual(res.ranked[0].title, 'A');
  assert.strictEqual(by.A.tier, 2);
  assert.deepStrictEqual(by.A.viaVerified, ['P']);
  assert.strictEqual(by.B.tier, 3);
});

test('evaluate：链接里直接有目标就是直达，且不发多余请求', async () => {
  const w = fakeWiki();
  const solver = core.createSolver({ fetch: w.fetch, parseHTML: h => parseHTML(h).document });
  solver.setTarget('en', 'T');
  await solver.target.ready;
  const before = w.calls.length;
  const res = await solver.evaluate('en', 'P', linksOf('P'));
  assert.strictEqual(res.ranked[0].title, 'T');
  assert.strictEqual(res.ranked[0].tier, 0);
  assert.strictEqual(w.calls.filter((c, i) => i >= before && c.action === 'parse').length, 0);
});

test('evaluate：去过的页面降分', async () => {
  const { res } = await solve('Start2', { eval: { visited: new Set(['A']) } });
  const by = Object.fromEntries(res.ranked.map(c => [c.title, c]));
  assert.ok(by.A.visited);
  assert.ok(by.A.prior < by.B.prior);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok  ', t.name); } catch (e) { failed++; console.log('FAIL', t.name, '\n   ', e.message); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
