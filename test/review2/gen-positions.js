// Generate midgame positions from fresh randomised games (random 3-6 stone openings,
// then fast engine self-play with 5% random moves).  Writes JSON [{rule, board, toMove, ply}].
// Usage: node test/review2/gen-positions.js <rule> <games> <seed> <out.json>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [rule = 'freestyle', games = '20', seedArg = '1', out = '/tmp/pos.json'] = process.argv.slice(2);
let seed = +seedArg;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const res = [];
const games_ = [];
for (let g = 0; g < +games; g++) {
  const e = new G.Engine({ rule }), J = new G.Engine({ rule });
  const b = new Array(225).fill(0);
  const moves = [];
  let c = 1;
  const nOpen = 3 + rnd(4);
  for (let i = 0; i < nOpen; i++) {
    let p;
    do { p = (5 + rnd(5)) * 15 + 5 + rnd(5); } while (b[p]);
    b[p] = c; moves.push({ p, c }); c = 3 - c;
  }
  for (let k = 0; k < 120; k++) {
    e.setBoard(b);
    let p;
    if (rnd(100) < 5) {
      const n = e.genNormal(c, 0, 12); p = e.candBuf[0][rnd(Math.max(1, n))] % 256;
    } else p = e.think(c, { timeMs: 40 }).move;
    if (p < 0 || b[p]) break;
    J.setBoard(b);
    if (rule === 'renju' && c === 1 && J.isForbidden(p)) break;
    // record position before the move
    if (moves.length >= 10) res.push({ rule, board: b.slice(), toMove: c, ply: moves.length, game: g });
    b[p] = c; moves.push({ p, c });
    J.setBoard(b);
    if (J.hasWon(c)) break;
    c = 3 - c;
  }
  games_.push({ gi: g, rule, moves });
}
fs.writeFileSync(out, JSON.stringify(res));
fs.writeFileSync(out.replace(/\.json$/, '') + '-games.json', JSON.stringify(games_));
console.log('positions', res.length, 'games', games_.length);
