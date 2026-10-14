// The 'winning' flag replaces the normal VCT (40000 nodes, 14 plies) with a single
// bigger one (400000 nodes, 20 plies, deadline 0.7*timeMs).  findVct is not monotone in
// (nodes, maxPly): the bigger search can exhaust its budget/deadline on deep lines and
// return null where the small one finds the win -> the engine drops a won attack exactly
// when it was following one.
// Usage: node test/review2/winning-flag-drop.js [timeMs=1500]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const T = +(process.argv[2] || 1500);
const P = JSON.parse(fs.readFileSync(__dirname + '/pos-free.json', 'utf8'))[288];
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const cell = s => (+s.slice(1)) * 15 + (s.charCodeAt(0) - 65);
const O = 2;
const e = new G.Engine({ rule: 'freestyle' });
e.setBoard(P.board);
const r1 = e.think(O, { timeMs: T });
console.log('move 1: O think ->', name(r1.move), r1.reason, r1.score, 'winning flag', e.winning);
const b2 = P.board.slice();
b2[r1.move] = O; b2[cell('B4')] = 1; // X defends at B4 (the reply the review verifier found hardest)
e.setBoard(b2);
console.log('continuation keeps caches/flag:', e.winning);
const r2 = e.think(O, { timeMs: T });
console.log('move 2 (same engine, winning=true): ->', name(r2.move), r2.reason, r2.score, JSON.stringify(r2.phases));
const f = new G.Engine({ rule: 'freestyle' });
f.setBoard(b2);
const r3 = f.think(O, { timeMs: T });
console.log('move 2 (fresh engine, winning=false): ->', name(r3.move), r3.reason, r3.score, JSON.stringify(r3.phases));
for (const [n, d] of [[40000, 14], [400000, 20]]) {
  const g = new G.Engine({ rule: 'freestyle' }); g.setBoard(b2);
  const t = Date.now(); const r = g.findVct(O, n, d, Infinity);
  console.log(`  fresh findVct(O, ${n}, ${d}) ->`, r && name(r.move) + ' plies ' + r.plies, Date.now() - t, 'ms');
}
