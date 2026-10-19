#!/usr/bin/env node
/* 模拟比赛：从起点开始每一步都点引擎排第一的链接，统计步数和耗时。
 * 当前页的链接用与游戏相同的清洗规则从 action=parse 得到（等价于页面 DOM）。
 *   node test/sim.js                 跑内置的路线
 *   node test/sim.js "A" "B"         跑一条指定路线
 *   --budget N                       每页前瞻候选数（默认见 core.js）
 *   --think MS                       每步点击前等待的毫秒数，模拟人读页面（默认 2000）
 */
'use strict';
const { parseHTML } = require('linkedom');
const core = require('../src/core.js');

const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--budget') opt.evalBudget = +argv[++i];
  else if (argv[i] === '--max') opt.maxClicks = +argv[++i];
  else if (argv[i] === '--think') opt.think = +argv[++i];
  else pos.push(argv[i]);
}

const ROUTES = pos.length >= 2 ? [[pos[0], pos[1]]] : [
  ['Napoleon Dynamite', 'Ottoman Empire'],
  ['Cebocap', 'Rafflesia'],
  ['Pogo stick', 'Rafflesia'],
  ['Century egg', 'Albert Einstein'],
  ['Beanie Babies', 'Photosynthesis'],
  ['Mullet (haircut)', 'Byzantine Empire'],
  ['Habbo', 'Mount Everest'],
  ['AltaVista', 'Jazz'],
  ['Chernobyl disaster', 'Rafflesia'],
  ['SpongeBob SquarePants', 'Quantum mechanics'],
];

let requests = 0;
let throttled = 0;
const env = {
  fetch: async url => {
    requests++;
    const r = await fetch(url, { headers: { 'User-Agent': 'wikiracing-helper-test/0.1 (+https://github.com/zwandering/game-ai-plugins)' } });
    if (r.status === 429) throttled++;
    return r;
  },
  parseHTML: html => parseHTML(html).document,
  options: opt,
};

async function race(solver, start, goal, maxClicks) {
  const st = solver.setTarget('en', goal);
  await st.ready;
  let page = await solver.parsePage('en', start);
  const path = [page.title];
  const t0 = Date.now();
  const steps = [];
  while (!st.R.has(page.title) && path.length <= maxClicks) {
    const links = [...page.links].map(([title, info]) => Object.assign({ title }, info));
    await new Promise(r => setTimeout(r, opt.think == null ? 2000 : opt.think));
    const s0 = Date.now();
    const res = await solver.evaluate('en', page.title, links, { visited: new Set(path) });
    const best = res.ranked[0];
    if (!best) return { ok: false, path, steps, reason: 'no links' };
    steps.push({ from: page.title, pick: best.canon, tier: best.tier, ms: Date.now() - s0, evaluated: res.evaluated,
      b1: st.B1.size, b2: st.B2.size });
    if (best.tier === 0) { path.push(st.canon); break; }
    page = await solver.parsePage('en', best.canon);
    if (path.includes(page.title)) return { ok: false, path: path.concat(page.title), steps, reason: 'loop' };
    path.push(page.title);
  }
  return { ok: st.R.has(path[path.length - 1]), path, steps, ms: Date.now() - t0 };
}

(async () => {
  const maxClicks = opt.maxClicks || 12;
  const rows = [];
  const solver = core.createSolver(env);   // 共用一个实例：限速窗口和缓存跨路线保留，和浏览器里一致
  for (const [a, b] of ROUTES) {
    const r0 = requests;
    let r;
    try { r = await race(solver, a, b, maxClicks); } catch (e) { r = { ok: false, path: [a], steps: [], reason: e.message }; }
    const clicks = r.path.length - 1;
    console.log(`${r.ok ? 'OK ' : 'FAIL'} ${clicks} clicks  ${a} -> ${b}  (${requests - r0} req, ${((r.ms || 0) / 1000).toFixed(1)}s)`);
    console.log('     ' + r.path.join(' → ') + (r.reason ? `  [${r.reason}]` : ''));
    for (const s of r.steps) console.log(`       ${s.from} ⇒ ${s.pick}  tier=${s.tier} eval=${s.evaluated} ${s.ms}ms B1=${s.b1} B2=${s.b2}`);
    rows.push({ ok: r.ok, clicks });
  }
  const ok = rows.filter(r => r.ok);
  console.log(`\nsolved ${ok.length}/${rows.length}, mean clicks ${(ok.reduce((s, r) => s + r.clicks, 0) / Math.max(1, ok.length)).toFixed(2)}, ` +
    `${requests} requests, ${throttled} throttled (429)`);
})();
