'use strict';
// Verify: time-management finding (0.4 stop rule, overruns).
// Loads src/engine.js in memory, instruments the iterative-deepening loop (no file edits).
//   node test/verify-strength-2.js [timeMs=300] [gamesPerRule=4]     (env STOPF=0.6 to change the stop factor)
const fs = require('fs'), path = require('path');
const src0 = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
function load(src) { const m = { exports: {} }; new Function('module', 'require', 'process', src)(m, require, process); return m.exports(); }
const LOOP_OLD = "const s = this.negamax(me, depth, -INF, INF, 0, 3);";
const LOOP_NEW = "const __ts = now(); const s = this.negamax(me, depth, -INF, INF, 0, 3); (this.__iters = this.__iters || []).push({ depth, ms: now() - __ts, at: now() - t0, aborted: this.aborted, rb: this.rootBest });";
const STOP_OLD = "if (now() - t0 > timeMs * 0.4) break;";
const PRE_OLD = "// Iterative deepening.";
for (const a of [LOOP_OLD, STOP_OLD, PRE_OLD]) if (!src0.includes(a)) throw new Error('anchor not found: ' + a);
const src = src0.replace(LOOP_OLD, LOOP_NEW).replace(PRE_OLD, "this.__pre = now() - t0; " + PRE_OLD)
  .replace(STOP_OLD, "if (now() - t0 > timeMs * (+process.env.STOPF || 0.4)) break;");
const GA = load(src);
const T = +(process.argv[2] || 300), GAMES = +(process.argv[3] || 4);
let seed = 777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const els = [], ratios = [], pres = [], stopAt = []; let searchCalls = 0, overT = 0, worst = 0, worstInfo = null, abortChanged = 0;
for (const rule of ['freestyle', 'renju']) for (let g = 0; g < GAMES; g++) {
  const e = new GA.Engine({ rule }); let c = 1;
  for (let k = 0; k < 6; k++) { let p; do { p = (5 + Math.floor(rnd() * 5)) * 15 + 5 + Math.floor(rnd() * 5); } while (e.board[p] || (c === 1 && e.isForbidden(p))); e.play(p, c); c = 3 - c; }
  for (let m = 0; m < 70; m++) {
    e.__iters = []; e.__pre = 0;
    const t0 = Date.now(); const r = e.think(c, { timeMs: T }); const el = Date.now() - t0;
    els.push(el); if (el > T) overT++; if (el > worst) { worst = el; worstInfo = { reason: r.reason, pre: e.__pre, iters: e.__iters.length }; }
    if (r.reason === 'search') {
      searchCalls++; pres.push(e.__pre);
      const it = e.__iters.filter(x => !x.aborted);
      for (let i = 1; i < it.length; i++) if (it[i - 1].ms > 5) ratios.push(it[i].ms / it[i - 1].ms);
      const last = e.__iters[e.__iters.length - 1];
      if (last) { stopAt.push({ aborted: last.aborted, at: last.at }); if (last.aborted && it.length && last.rb >= 0 && r.move !== it[it.length - 1].rb) abortChanged++; }
    }
    if (r.move < 0) break; e.play(r.move, c); if (e.hasWon(c)) break; c = 3 - c;
  }
}
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('STOPF', process.env.STOPF || 0.4, 'T', T, 'calls', els.length, 'search', searchCalls);
console.log('elapsed avg', avg(els).toFixed(0), 'p50', q(els, .5), 'p90', q(els, .9), 'max', worst, JSON.stringify(worstInfo), '>T', overT);
console.log('pre-search (root VCF etc) ms avg', avg(pres).toFixed(1), 'p90', q(pres, .9).toFixed(0), 'max', Math.max(...pres).toFixed(0));
console.log('iteration cost ratio t(d+1)/t(d): p25', q(ratios, .25).toFixed(2), 'p50', q(ratios, .5).toFixed(2), 'p75', q(ratios, .75).toFixed(2), 'n', ratios.length);
console.log('search ended by abort:', stopAt.filter(s => s.aborted).length, '/', stopAt.length, ' aborted pass changed move:', abortChanged);
