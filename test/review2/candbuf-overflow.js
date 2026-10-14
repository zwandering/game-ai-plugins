// Deep counter-four chains inside VCT exceed candBuf (MAX_PLY+2 = 51 buffers):
// vctAttack's "block the defender's four" branch and vctDefend's "block the
// attacker's four" branch recurse without checking rem, so the VCT ply can grow
// past maxPly and past the candBuf array.
// Usage: node test/review2/candbuf-overflow.js [freestyle|renju]
'use strict';
const G = require('../../src/engine.js')();
const rule = process.argv[2] || 'freestyle';
const b = new Array(225).fill(0);
const set = (r, c, v) => { b[r * 15 + c] = v; };
// Black (X): a double-three point at H7 (row 7 col 8): row 7 X X _, column 8 X X _
set(7, 6, 1); set(7, 7, 1); set(5, 8, 1); set(6, 8, 1);
// White (O): many independent closed threes -> one counter-four each
for (const r of [0, 3, 11, 14]) {
  set(r, 0, 1); set(r, 1, 2); set(r, 2, 2); set(r, 3, 2);           // X O O O . .
  set(r, 14, 1); set(r, 13, 2); set(r, 12, 2); set(r, 11, 2);       // . . O O O X
}
for (const c of [0, 14]) {
  set(5, c, 1); set(6, c, 2); set(7, c, 2); set(8, c, 2);           // vertical X O O O . .
}
for (const c of [6, 8]) {
  set(0, c, 1); set(1, c, 2); set(2, c, 2); set(3, c, 2);
}
const P = G.Engine.prototype;
let maxPly = 0;
const orig = P.genDefence;
P.genDefence = function (me, ply) { if (ply > maxPly) maxPly = ply; return orig.call(this, me, ply); };
const e = new G.Engine({ rule });
e.setBoard(b);
console.log(e.toString());
console.log('white four cells', e.catCount[1 * 5 + 2], 'black four cells', e.catCount[0 * 5 + 2], 'black five cells', e.catCount[4]);
try {
  const r = e.findVct(1, 200000, 14, Infinity);
  console.log('findVct(X, maxPly 14) ->', r, 'max genDefence ply', maxPly);
} catch (err) { console.log('findVct THREW:', err.message, '| max genDefence ply', maxPly); }
maxPly = 0;
try {
  e.setBoard(b);
  const r = e.think(1, { timeMs: 1000 });
  console.log('think ->', r.move, r.reason, 'max genDefence ply', maxPly);
} catch (err) { console.log('think THREW:', err.message, '| max genDefence ply', maxPly); }
