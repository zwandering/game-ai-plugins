// Repro: VCT recursion past MAX_PLY+2 -> candBuf[51] undefined -> TypeError, engine left with
// extra stones on the board (no undo). Found by candbuf-search.js freestyle 100 1 (try 4).
// Usage: node test/review2/candbuf-crash.js
'use strict';
const G = require('../../src/engine.js')();
const b = [0,0,0,1,2,2,2,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,2,2,0,0,0,0,1,2,2,2,1,2,2,2,0,0,0,0,0,0,0,1,2,2,2,0,0,1,2,2,2,0,0,0];
const e = new G.Engine({ rule: 'freestyle' });
e.setBoard(b);
console.log(e.toString());
const before = e.stones;
for (const [label, fn] of [
  ['findVct(X, 40000, 14)', () => e.findVct(1, 40000, 14, Infinity)],
  ['findVct(X, 400000, 20)', () => e.findVct(1, 400000, 20, Infinity)],
  ['think(X, 1500ms)', () => { const r = e.think(1, { timeMs: 1500 }); return { move: r.move, reason: r.reason }; }],
  ['think(X, 1500ms) after winning=true', () => { e.winning = true; const r = e.think(1, { timeMs: 1500 }); return { move: r.move, reason: r.reason }; }],
]) {
  e.setBoard(b);
  try { console.log(label, '->', JSON.stringify(fn())); }
  catch (err) { console.log(label, 'THREW', err.message, '| stones before', before, 'after', e.stones); }
}
