// Review: fuzz incremental play/undo state against a fresh setBoard of the same position.
const G = require('../../src/engine.js')();
const { Engine } = G;
let seed = 7;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
let bad = 0, checks = 0;
for (const rule of ['freestyle', 'renju']) {
  const e = new Engine({ rule, ttBits: 4 }), f = new Engine({ rule, ttBits: 4 });
  for (let it = 0; it < 3000; it++) {
    if (e.history.length > 0 && (rnd(3) === 0 || e.stones > 120)) e.undo();
    else { let p; do { p = rnd(225); } while (e.board[p]); e.play(p, 1 + rnd(2)); }
    f.setBoard(Array.from(e.board));
    checks++;
    const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const sh = s => Array.from(s).map((v, i) => e.board[i % 225] ? 0 : v);
    if (!eq(sh(e.shape), sh(f.shape)) || !eq(e.score, f.score) || !eq(e.cat, f.cat) || !eq(e.catCount, f.catCount) ||
      !eq(e.total, f.total) || !eq(e.nb, f.nb) || e.hashLo !== f.hashLo || e.hashHi !== f.hashHi) { bad++; if (bad < 3) console.log('mismatch', rule, it); }
  }
}
console.log('checks', checks, 'mismatches', bad);
