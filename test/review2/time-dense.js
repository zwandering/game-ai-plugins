// think() wall time on four-dense positions (the unbounded findVcf(60000) calls and the
// VCT counter-four chains have no deadline).  Usage: node test/review2/time-dense.js [timeMs=300]
'use strict';
const G = require('../../src/engine.js')();
const T = +(process.argv[2] || 300);
const b = [0,0,0,1,2,2,2,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,1,2,2,2,1,2,2,2,0,0,0,0,0,0,0,1,2,2,2,0,0,1,2,2,2,0,0,0];
for (const rule of ['freestyle', 'renju']) for (const c of [1, 2]) {
  const e = new G.Engine({ rule });
  e.setBoard(b);
  const t = Date.now();
  let r;
  try { r = e.think(c, { timeMs: T }); } catch (x) { console.log(rule, c, 'THREW', x.message); continue; }
  console.log(rule, 'colour', c, 'requested', T, 'took', Date.now() - t, 'ms', r.reason, JSON.stringify(r.phases));
}
