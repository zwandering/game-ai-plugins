// Review: renju black "open three" mis-detected because the 9-cell window cannot see a
// black stone at distance 5 that turns the straight four's outer five-point into an overline.
// Result: a legal black move is reported as a forbidden double-three.
const G = require('../../src/engine.js')();
const { Engine, idx, rc, BLACK, WHITE } = G;
const e = new Engine({ rule: 'renju' });
const a = new Array(225).fill(0);
// Row 7 (horizontal): X . . q X X . . X   -> cols 4, 8, 9, 12 black, q = col 7
// Column 7 (vertical):  q, (8,7), (9,7) black -> genuine open three
const black = [[7, 4], [7, 8], [7, 9], [7, 12], [8, 7], [9, 7]];
const white = [[0, 0], [0, 2], [14, 14], [14, 12], [0, 14], [14, 0]];
black.forEach(([r, c]) => a[idx(r, c)] = BLACK);
white.forEach(([r, c]) => a[idx(r, c)] = WHITE);
e.setBoard(a);
const q = idx(7, 7);
console.log('horiz shape at q:', G.SHAPE_NAMES[e.shape[0 * 225 + q]], ' vert shape at q:', G.SHAPE_NAMES[e.shape[1 * 225 + q]]);
console.log('isForbidden(7,7) =', e.isForbidden(q), '(expected false: horizontal is not a three)');

// Prove horizontal is not a three: after q, check every way to extend it to a straight four.
e.play(q, BLACK);
let straight = false;
for (const c of [5, 6, 10, 11]) {
  const p = idx(7, c);
  if (e.board[p]) continue;
  e.play(p, BLACK);
  // count exact-five points in row 7
  let fives = 0;
  for (let cc = 0; cc < 15; cc++) {
    const t = idx(7, cc); if (e.board[t]) continue;
    e.play(t, BLACK); if (e.hasWon(BLACK)) fives++; e.undo();
  }
  console.log(' after extra black at (7,' + c + '): exact-five points in row =', fives);
  if (fives >= 2) straight = true;
  e.undo();
}
console.log('horizontal can become straight four:', straight);
