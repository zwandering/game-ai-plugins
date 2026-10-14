// Measure think() wall time vs requested timeMs on sampled midgame positions.
// Each position: fresh setBoard (as the worker does), optionally winning=true.
// Usage: node test/review2/time-overrun.js <pos.json> <timeMs> <samples> [winning=0]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, tArg = '300', sArg = '40', winArg = '0'] = process.argv.slice(2);
const pos = JSON.parse(fs.readFileSync(file, 'utf8'));
const T = +tArg, S = +sArg;
const step = Math.max(1, Math.floor(pos.length / S));
const e = new G.Engine({ rule: pos[0].rule });
const rows = [];
for (let i = 0; i < pos.length && rows.length < S; i += step) {
  const p = pos[i];
  e.setBoard(p.board);
  if (+winArg) e.winning = true;
  const t0 = Date.now();
  const r = e.think(p.toMove, { timeMs: T });
  const dt = Date.now() - t0;
  rows.push({ i, dt, reason: r.reason, phases: r.phases });
}
rows.sort((a, b) => b.dt - a.dt);
const over = rows.filter(r => r.dt > T * 1.1);
console.log(`${file} timeMs=${T} n=${rows.length} max=${rows[0].dt} median=${rows[rows.length >> 1].dt} over110%=${over.length}`);
for (const r of rows.slice(0, 5)) console.log(`  pos#${r.i} ${r.dt}ms ${r.reason} ${JSON.stringify(r.phases)}`);
