// Per-phase think() time on the positions of a match file (engine moves only).
// Usage: node test/repro/profile-think.js <match.json> [engopts-json]
'use strict';
const fs = require('fs');
const cur = require('../../src/engine.js')();
const [file, optsJson = '{}'] = process.argv.slice(2);
const opts = JSON.parse(optsJson);
const sum = {}; let n = 0;
for (const g of JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, 8)) {
  const e = new cur.Engine({ rule: g.rule }); const board = new Array(225).fill(0);
  for (const m of g.moves) {
    if (m.who === 'engine') {
      e.setBoard(board); const r = e.think(m.c, Object.assign({ timeMs: 300 }, opts));
      if (r.reason === 'search') {
        n++;
        for (const [k, v] of Object.entries(r.phases || {})) sum[k] = (sum[k] || 0) + v;
        sum.total = (sum.total || 0) + r.timeMs; sum.depth = (sum.depth || 0) + r.depth;
      }
    }
    board[m.p] = m.c;
  }
}
for (const k in sum) sum[k] = +(sum[k] / n).toFixed(1);
console.log('search moves', n, 'avg per phase (ms)', JSON.stringify(sum));
