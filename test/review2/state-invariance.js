// 1) clustered play/undo vs fresh setBoard (renju + freestyle), full shape arrays incl. occupied cells' cats
// 2) isForbidden wrapped: state must be identical before/after every call made by think/findVcf/findVct.
const G = require('../../src/engine.js')();
const { Engine } = G;
let seed = +(process.argv[2] || 4242);
const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
let bad = 0, checks = 0;
for (const rule of ['renju', 'freestyle']) {
  const e = new Engine({ rule, ttBits: 4 }), f = new Engine({ rule, ttBits: 4 });
  for (let it = 0; it < 20000; it++) {
    if (e.history.length > 0 && (rnd(3) === 0 || e.stones > 60)) e.undo();
    else { let p, tries = 0; do { p = (4 + rnd(7)) * 15 + 4 + rnd(7); } while (e.board[p] && ++tries < 50); if (e.board[p]) { let q = 0; while (e.board[q]) q++; p = q; } e.play(p, rnd(100) < 65 ? 1 : 2); }
    if (it % 4) continue;
    f.setBoard(Array.from(e.board));
    checks++;
    const sh = (x, B) => Array.from(x).map((v, i) => B[i % 225] ? 0 : v);
    if (!eq(sh(e.shape, e.board), sh(f.shape, f.board)) || !eq(e.score, f.score) || !eq(e.cat, f.cat) || !eq(e.catCount, f.catCount) || !eq(e.total, f.total) || !eq(e.nb, f.nb) || e.hashLo !== f.hashLo) { bad++; if (bad < 3) console.log('mismatch', rule, it); }
  }
}
console.log('incremental checks', checks, 'mismatches', bad);

// 2)
const e = new Engine({ rule: 'renju', ttBits: 16 });
const orig = e.isForbidden;
let calls = 0, viol = 0, depthMax = 0;
const snap = () => [e.hashLo, e.hashHi, e.history.length, e.stones, Array.from(e.catCount).join(), Array.from(e.total).join(), Array.from(e.cat).join(''), Array.from(e.board).join('')].join('|');
e.isForbidden = function (p, depth) {
  if ((depth || 0) > depthMax) depthMax = depth;
  const top = !depth;
  const s = top ? snap() : null;
  const r = orig.call(this, p, depth);
  if (top) { calls++; if (snap() !== s) viol++; }
  return r;
};
const t0 = Date.now();
for (let g = 0; g < 40 && Date.now() - t0 < 150000; g++) {
  const b = new Array(225).fill(0);
  for (let k = 0; k < 14 + rnd(16); k++) { const p = (3 + rnd(9)) * 15 + 3 + rnd(9); if (!b[p]) b[p] = (k % 2) ? 2 : 1; }
  e.setBoard(b);
  if (e.hasWon(1) || e.hasWon(2)) continue;
  for (const c of [1, 2]) {
    e.findVcf(c, 5000, 20); e.findVct(c, 5000, 12);
    e.think(c, { timeMs: 300 });
  }
}
console.log({ isForbiddenTopCalls: calls, stateViolations: viol, depthMax });
