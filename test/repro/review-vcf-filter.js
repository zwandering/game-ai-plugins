// Review: the opponent-VCF root filter in think() marks any of my own four-moves as "safe",
// because findVcf(opp) returns 0 immediately when I have a five-point ("opponent's four must
// be answered first"), even though after the forced block the opponent's VCF is intact.
const G = require('../../src/engine.js')();
const { Engine, idx, rc, BLACK, WHITE } = G;
const e = new Engine({ rule: 'freestyle' });
const a = new Array(225).fill(0);
// White: closed three (5,5..7) blocked by black (5,4) + open two (6,8),(7,8): 4-3 at (5,8) = VCF.
// Black: closed three (10,2..4) blocked by white (10,1): four-moves at (10,5)/(10,6).
const black = [[5, 4], [10, 2], [10, 3], [10, 4], [0, 14], [14, 0]];
const white = [[5, 5], [5, 6], [5, 7], [6, 8], [7, 8], [10, 1]];
black.forEach(([r, c]) => a[idx(r, c)] = BLACK);
white.forEach(([r, c]) => a[idx(r, c)] = WHITE);
e.setBoard(a);
console.log('white VCF from root:', JSON.stringify(e.findVcf(WHITE, 20000, 24)));
// Replicate think()'s filter
const safe = [];
const n = e.genNormal(BLACK, 0, 60);
const cands = []; for (let i = 0; i < n; i++) cands.push(e.candBuf[0][i] % 256);
for (const p of cands) {
  e.play(p, BLACK);
  const still = e.findVcf(WHITE, 6000, 24);
  if (!still) safe.push(p);
  e.undo();
}
console.log('safe set:', safe.map(p => JSON.stringify(rc(p))).join(' '));
for (const p of safe) {
  e.play(p, BLACK);
  // If black just made a four, let white make the forced block and re-check white's VCF.
  const blk = (() => { for (let q = 0; q < 225; q++) { if (e.board[q]) continue; e.play(q, BLACK); const w = e.hasWon(BLACK); e.undo(); if (w) return q; } return -1; })();
  if (blk >= 0) {
    e.play(blk, WHITE);
    const v = e.findVcf(WHITE, 20000, 24);
    console.log(' "safe" four', JSON.stringify(rc(p)), '-> white blocks', JSON.stringify(rc(blk)), '-> white VCF again:', !!v);
    e.undo();
  }
  e.undo();
}
const r = e.think(BLACK, { timeMs: 1000 });
console.log('think ->', r.reason, JSON.stringify(rc(r.move)), 'score', r.score, 'depth', r.depth);
