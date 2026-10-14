#!/usr/bin/env node
/*
 * Fits the engine-score -> win-probability model used by Engine.winRate().
 *
 * Model (per rule):  P(side to move wins) = 1 / (1 + exp(-(score / K + B * sign)))
 * with sign = +1 if the side to move is black, -1 if white, and `score` is
 * think()'s score from the mover's point of view (only plain 'search' results;
 * forced wins/losses are handled exactly by the engine).
 * The model is symmetric on purpose: P(black wins) is then the same whether it
 * is computed from black's search on black's turn or from white's search on
 * white's next turn (scores of consecutive positions are ~negatives of each
 * other), so the displayed win rate does not jump between turns.
 * Samples should come from self-play (same engine on both sides) so the colour
 * term measures the colour advantage, not a strength difference.
 *
 * Samples come from engine-vs-engine match logs written by test/match.js.
 *   node test/calibrate-winrate.js --extract out.csv match1.json match2.json ...   # build samples
 *   node test/calibrate-winrate.js test/data/winrate-samples.csv                  # fit + report
 */
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
if (args[0] === '--extract') {
  const out = args[1];
  const rows = ['rule,score,black,won,ply'];
  let skippedDraws = 0;
  for (const f of args.slice(2)) {
    for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      if (g.draw) { skippedDraws++; continue; }
      g.moves.forEach((m, ply) => {
        if (!m.info || m.info.reason !== 'search' || Math.abs(m.info.score) >= 999800) return; // both sides if recorded
        // the engine moved with colour m.c; did that colour win?
        const won = g.result.winner === m.c ? 1 : 0;
        rows.push([g.rule, m.info.score, m.c === 1 ? 1 : 0, won, ply].join(','));
      });
    }
  }
  fs.writeFileSync(out, rows.join('\n') + '\n');
  console.log('wrote', rows.length - 1, 'samples to', out, '(skipped draws:', skippedDraws + ')');
  process.exit(0);
}

const lines = fs.readFileSync(args[0], 'utf8').trim().split('\n').slice(1);
const byRule = {};
for (const l of lines) {
  const [rule, s, black, won, ply] = l.split(',');
  (byRule[rule] = byRule[rule] || []).push({ s: +s, b: +black, y: +won, ply: +ply });
}

const sig = x => 1 / (1 + Math.exp(-x));
const feats = d => [d.s / 1000, d.b ? 1 : -1]; // symmetric model: no free intercept
// Logistic regression on feats() by Newton's method.
function fit(data) {
  const k = 2;
  let w = [0.5, 0];
  for (let it = 0; it < 50; it++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const d of data) {
      const x = feats(d);
      const p = sig(x.reduce((a, v, i) => a + v * w[i], 0));
      for (let i = 0; i < k; i++) {
        g[i] += (d.y - p) * x[i];
        for (let j = 0; j < k; j++) H[i][j] -= p * (1 - p) * x[i] * x[j];
      }
    }
    for (let i = 0; i < k; i++) H[i][i] -= 1e-6; // tiny ridge
    const A = H.map((r, i) => r.concat([g[i]]));
    for (let i = 0; i < k; i++) {
      let piv = i; for (let q = i + 1; q < k; q++) if (Math.abs(A[q][i]) > Math.abs(A[piv][i])) piv = q;
      [A[i], A[piv]] = [A[piv], A[i]];
      for (let q = 0; q < k; q++) if (q !== i) { const f = A[q][i] / A[i][i]; for (let j = i; j <= k; j++) A[q][j] -= f * A[i][j]; }
    }
    const delta = A.map((r, i) => r[k] / r[i]);
    for (let i = 0; i < k; i++) w[i] -= delta[i];
    if (Math.max(...delta.map(Math.abs)) < 1e-9) break;
  }
  return w;
}

for (const [rule, data] of Object.entries(byRule)) {
  const w = fit(data);
  const K = 1000 / w[0];
  let ll = 0, brier = 0, base = 0;
  const mean = data.reduce((a, d) => a + d.y, 0) / data.length;
  for (const d of data) {
    const p = sig(d.s / K + w[1] * (d.b ? 1 : -1));
    ll += d.y ? Math.log(p) : Math.log(1 - p);
    brier += (p - d.y) ** 2; base += (mean - d.y) ** 2;
  }
  console.log(`${rule}: n=${data.length}  K=${K.toFixed(0)}  B=${w[1].toFixed(3)} (+B if black to move, -B if white)` +
    `  logloss=${(-ll / data.length).toFixed(4)}  brier=${(brier / data.length).toFixed(4)} (baseline ${(base / data.length).toFixed(4)})`);
  // calibration table: predicted vs observed in deciles
  const sorted = data.map(d => ({ p: sig(d.s / K + w[1] * (d.b ? 1 : -1)), y: d.y })).sort((a, b) => a.p - b.p);
  const bins = 10, rows = [];
  for (let k = 0; k < bins; k++) {
    const part = sorted.slice(Math.floor(k * sorted.length / bins), Math.floor((k + 1) * sorted.length / bins));
    const pm = part.reduce((a, d) => a + d.p, 0) / part.length, ym = part.reduce((a, d) => a + d.y, 0) / part.length;
    rows.push(`${(pm * 100).toFixed(0)}%->${(ym * 100).toFixed(0)}%`);
  }
  console.log('  predicted->observed by decile:', rows.join('  '));
}
