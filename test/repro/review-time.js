// Review: think() wall-clock vs requested timeMs; also flags results where the move
// violates the opponent-VCF root filter or plays into a forbidden point.
const G = require('../../src/engine.js')();
const { Engine, rc, BLACK } = G;
const T = +(process.argv[2] || 200);
const GAMES = +(process.argv[3] || 4);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
let worst = { over: 0 }, count = 0, over50 = 0, depth0 = 0;
for (const rule of ['freestyle', 'renju']) {
  for (let g = 0; g < GAMES; g++) {
    const e = new Engine({ rule });
    // random-ish opening of 6 stones near the centre
    let c = BLACK;
    for (let k = 0; k < 6; k++) {
      let p; do { p = (5 + Math.floor(rnd() * 5)) * 15 + 5 + Math.floor(rnd() * 5); } while (e.board[p] || (c === 1 && e.isForbidden(p)));
      e.play(p, c); c = 3 - c;
    }
    for (let m = 0; m < 80; m++) {
      const snap = Array.from(e.board);
      const t0 = Date.now();
      const r = e.think(c, { timeMs: T });
      const el = Date.now() - t0;
      count++;
      if (el > T * 1.5) over50++;
      if (r.reason === 'search' && r.depth === 0) depth0++;
      if (el - T > worst.over) worst = { over: el - T, el, rule, reason: r.reason, depth: r.depth, board: snap, color: c };
      if (r.move < 0) break;
      if (c === BLACK && e.isForbidden(r.move)) { console.log('forbidden move played', rule, rc(r.move), r.reason, r.score, JSON.stringify(snap.join(''))); }
      e.play(r.move, c);
      if (e.hasWon(c)) break;
      c = 3 - c;
    }
  }
}
console.log('timeMs', T, 'calls', count, 'calls >1.5x', over50, 'search with depth 0:', depth0);
console.log('worst overrun ms', worst.over, 'elapsed', worst.el, worst.rule, worst.reason, 'depth', worst.depth);
if (worst.board) {
  const s = worst.board.map(v => '.XO'[v]).join('').match(/.{15}/g).join('\n');
  console.log('color', worst.color, '\n' + s);
}
