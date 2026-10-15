// How good is the live win rate? On self-play games (both sides' evaluations
// recorded), measure: calibration/sharpness by game phase, move-to-move volatility,
// and how many moves before the end the prediction becomes decisive.
// Usage: node test/repro/winrate-quality.js <match.json> [...]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const engines = { freestyle: new G.Engine({ rule: 'freestyle' }), renju: new G.Engine({ rule: 'renju' }) };

const rows = [];   // { rule, ply, plies, pBlack, blackWon }
const jumps = { freestyle: [], renju: [] };
const decisive = { freestyle: [], renju: [] };
for (const f of process.argv.slice(2)) {
  for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (g.draw) continue;
    const e = engines[g.rule];
    const blackWon = g.result.winner === 1 ? 1 : 0;
    let prev = null, firstDecisive = null;
    g.moves.forEach((m, ply) => {
      if (!m.info || !['search', 'vcf', 'vct', 'win', 'open-four', 'lost'].includes(m.info.reason)) { prev = null; return; }
      const pMover = e.winRate(m.info.score, m.c);
      const pBlack = m.c === 1 ? pMover : 1 - pMover;
      rows.push({ rule: g.rule, ply, plies: g.plies, pBlack, blackWon });
      if (prev !== null && pBlack > 0.02 && pBlack < 0.98 && prev > 0.02 && prev < 0.98) jumps[g.rule].push(Math.abs(pBlack - prev));
      prev = pBlack;
      const right = blackWon ? pBlack : 1 - pBlack;
      if (firstDecisive === null && right >= 0.9) firstDecisive = g.plies - ply;
    });
    decisive[g.rule].push(firstDecisive === null ? 0 : firstDecisive);
  }
}
const pct = x => (x * 100).toFixed(0) + '%';
const q = (arr, f) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(f * (a.length - 1))]; };
for (const rule of ['freestyle', 'renju']) {
  const R = rows.filter(r => r.rule === rule);
  console.log(`\n== ${rule}: ${R.length} evaluations`);
  console.log('phase (moves played)   n     mean |p-0.5|   right side >50%   brier');
  for (const [a, b] of [[0, 9], [10, 19], [20, 29], [30, 44], [45, 225]]) {
    const S = R.filter(r => r.ply >= a && r.ply <= b);
    if (!S.length) continue;
    const sharp = S.reduce((s, r) => s + Math.abs(r.pBlack - 0.5), 0) / S.length;
    const acc = S.filter(r => (r.pBlack > 0.5) === !!r.blackWon).length / S.length;
    const brier = S.reduce((s, r) => s + (r.pBlack - r.blackWon) ** 2, 0) / S.length;
    console.log(`${String(a).padStart(3)}-${String(b).padEnd(3)}              ${String(S.length).padStart(5)}   ${pct(sharp).padStart(6)}        ${pct(acc).padStart(5)}        ${brier.toFixed(3)}`);
  }
  const J = jumps[rule];
  console.log(`move-to-move change (non-forced): median ${pct(q(J, 0.5))}, 90th pct ${pct(q(J, 0.9))}, share of jumps >= 10%: ${pct(J.filter(x => x >= 0.1).length / J.length)}`);
  const D = decisive[rule];
  console.log(`moves before the end when the winner first gets >= 90%: median ${q(D, 0.5)}, 25th pct ${q(D, 0.25)}`);
}
