// Verify finding: isForbidden counts a straight four not containing p.
const fs = require('fs'), path = require('path');
const G = require('../../src/engine.js')();
const F = require('./engine-fixed.js')();
const R = require('./referee.js');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').filter(l => /^\s*\d+ /.test(l)).map(l => l.replace(/^\s*\d+ /, '')).join('\n');
const P = (r, c) => r * 15 + c;
{
  const b = G.parseBoard(read('case2.txt'));
  const e = new G.Engine({ rule: 'renju', ttBits: 4 });
  e.setBoard(b);
  const p = P(8, 11);
  console.log('case2 L8 src:', e.isForbidden(p), 'referee:', R.forbidden(b, p));
  e.play(p, 1);
  for (const [nm, x] of [['L4', P(4, 11)], ['L7', P(7, 11)], ['L11', P(11, 11)]]) {
    console.log(' ', nm, 'shapes', [0, 1, 2, 3].map(d => e.shape[d * 225 + x]), 'forbidden(depth1)', e.isForbidden(x, 1));
  }
  e.undo();
}
// Minimal clean board, depth 0 -> recursion depth 1 only, no depth-cap involvement.
const nb = Array(225).fill(0);
for (const r of [1, 2, 4, 8, 9]) nb[P(r, 7)] = 1;          // column H: X X . X . . p X X .
for (const c of [3, 4, 5, 6, 8]) nb[P(10, c)] = 1;         // (10,7) is an overline point
nb[P(7, 5)] = 1; nb[P(7, 6)] = 1;                          // row 7: second open three through p
// a few white stones far away for realism
for (const q of [P(13, 13), P(13, 12), P(0, 14), P(14, 0), P(12, 0), P(0, 0), P(14, 14), P(12, 14), P(0, 12), P(14, 2)]) nb[q] = 2;
for (const [k, M] of [['src', G], ['fixed', F]]) {
  const e2 = new M.Engine({ rule: 'renju', ttBits: 4 });
  e2.setBoard(Int8Array.from(nb));
  console.log('minimal H7', k, e2.isForbidden(P(7, 7)), 'referee', R.forbidden(nb, P(7, 7)), 'overline pt (10,7) forbidden', e2.isForbidden(P(10, 7)));
}
