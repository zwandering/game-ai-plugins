#!/usr/bin/env node
/* Summarise match JSON files from test/match.js: results, average search depth,
 * think time, move-reason histogram and games where the engine claimed a forced
 * win (score >= 999800) but did not win (a soundness bug).
 * Usage: node test/analyse-match.js out1.json [out2.json ...] */
'use strict';
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const games = JSON.parse(fs.readFileSync(f, 'utf8'));
  const reasons = {};
  let dsum = 0, dn = 0, tsum = 0, tn = 0;
  const falseWins = [];
  for (const g of games) {
    let claimed = null;
    g.moves.forEach((m, ply) => {
      if (m.who !== 'engine' || !m.info) return;
      reasons[m.info.reason] = (reasons[m.info.reason] || 0) + 1;
      if (m.info.reason === 'search') { dsum += m.info.depth; dn++; }
      tsum += m.info.timeMs; tn++;
      if (!claimed && m.info.score >= 999800) claimed = { reason: m.info.reason, ply };
    });
    if (claimed && !g.engineWon) falseWins.push(Object.assign({ gi: g.gi }, claimed));
  }
  const w = games.filter(g => g.engineWon).length, d = games.filter(g => g.draw).length;
  console.log(f.split('/').pop(), 'W', w, 'L', games.length - w - d, 'D', d,
    'avgSearchDepth', (dsum / Math.max(1, dn)).toFixed(2), 'avgMs', (tsum / Math.max(1, tn)).toFixed(0),
    'reasons', JSON.stringify(reasons), 'falseWins', JSON.stringify(falseWins));
}
