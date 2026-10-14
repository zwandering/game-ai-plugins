// Investigate: why think() reports a forced loss (-999990) after the correct defence (5,8).
const G = require('../../src/engine.js')();
const { Engine, idx, rc, BLACK, WHITE } = G;
function mk() {
  const e = new Engine({ rule: 'freestyle' });
  const a = new Array(225).fill(0);
  [[5, 4], [10, 2], [10, 3], [10, 4], [0, 14], [14, 0]].forEach(([r, c]) => a[idx(r, c)] = BLACK);
  [[5, 5], [5, 6], [5, 7], [6, 8], [7, 8], [10, 1]].forEach(([r, c]) => a[idx(r, c)] = WHITE);
  e.setBoard(a); return e;
}
const ms = +(process.argv[2] || 1000);
let e = mk();
let r = e.think(BLACK, { timeMs: ms });
console.log('think B ->', JSON.stringify(rc(r.move)), r.score, 'depth', r.depth, 'pv', r.pv.map(p => `${rc(p).row},${rc(p).col}`).join(' '));
// Play (5,8) and ask white what it has
e = mk(); e.play(idx(5, 8), BLACK);
console.log('white VCF after (5,8):', JSON.stringify(e.findVcf(WHITE, 40000, 30)));
r = e.think(WHITE, { timeMs: ms });
console.log('think W after (5,8) ->', r.reason, JSON.stringify(rc(r.move)), r.score, 'depth', r.depth, 'pv', r.pv.map(p => `${rc(p).row},${rc(p).col}`).join(' '));
// Search each depth separately from the root with no filter
for (let d = 2; d <= 7; d++) {
  e = mk();
  const t = e.think(BLACK, { timeMs: 100000, maxDepth: d });
  console.log('maxDepth', d, '->', JSON.stringify(rc(t.move)), t.score, 'reached', t.depth);
}
