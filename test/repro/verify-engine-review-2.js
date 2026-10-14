const G = require('../../src/engine.js')();
const { Engine, idx, rc, BLACK, WHITE } = G;
function mk() {
  const e = new Engine({ rule: 'freestyle' });
  const a = new Array(225).fill(0);
  [[5, 4], [10, 2], [10, 3], [10, 4], [0, 14], [14, 0]].forEach(([r, c]) => a[idx(r, c)] = BLACK);
  [[5, 5], [5, 6], [5, 7], [6, 8], [7, 8], [10, 1]].forEach(([r, c]) => a[idx(r, c)] = WHITE);
  e.setBoard(a); return e;
}
for (const ms of [5, 10, 20, 50, 100, 300, 1500]) {
  const r = mk().think(BLACK, { timeMs: ms });
  console.log('timeMs', ms, JSON.stringify(rc(r.move)), r.score, 'depth', r.depth, r.reason);
}
// Emulate proposed fix: in filter calls (nodes===6000), play opp's forced block first.
const e = mk();
const orig = e.findVcf.bind(e);
e.findVcf = function (c, nodes, d) {
  if (nodes === 6000) {
    const me = 3 - c;
    let blk = -1;
    for (let q = 0; q < 225; q++) { if (this.board[q]) continue; this.play(q, me); const w = this.hasWon(me); this.undo(); if (w) { blk = q; break; } }
    if (blk >= 0) { this.play(blk, c); const v = orig(c, nodes, d); this.undo(); return v; }
  }
  return orig(c, nodes, d);
};
for (const d of [2, 3, 5]) { const r = e.think(BLACK, { timeMs: 100000, maxDepth: d }); console.log('patched maxDepth', d, JSON.stringify(rc(r.move)), r.score); }
