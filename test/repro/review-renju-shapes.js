// Review: renju black shape-table bugs (window too short for exact-five; in-line double four).
const G = require('../../src/engine.js')();
const { Engine, idx, rc, BLACK, WHITE } = G;
const CAT = ['none', 'open-three', 'four', 'win2', 'five'];
function mk(black, white) {
  const e = new Engine({ rule: 'renju' });
  const a = new Array(225).fill(0);
  black.forEach(([r, c]) => a[idx(r, c)] = BLACK);
  white.forEach(([r, c]) => a[idx(r, c)] = WHITE);
  e.setBoard(a); return e;
}
const far = [[0, 0], [0, 2], [14, 14], [14, 12], [0, 14], [14, 0]];

// ---- Case A: four whose second "five point" is really an overline (stone at distance 5).
// Row 7: . . . . q X X X . X X   (q = col 4; col 8 already an overline point)
{
  const e = mk([[7, 5], [7, 6], [7, 7], [7, 9], [7, 10]], far.slice(0, 5));
  const q = idx(7, 4);
  console.log('A: shape(black,horiz,q) =', G.SHAPE_NAMES[e.shape[0 * 225 + q]], ' cat =', CAT[e.cat[q]]);
  console.log('A: isForbidden(7,8) =', e.isForbidden(idx(7, 8)), '(col 8 is an overline point)');
  const r = e.think(BLACK, { timeMs: 500 });
  console.log('A: think ->', r.reason, rc(r.move), 'score', r.score);
  // Verify reality: black plays q, white blocks (7,3), black's "other five point" (7,8) is an overline.
  e.play(q, BLACK); e.play(idx(7, 3), WHITE); e.play(idx(7, 8), BLACK);
  console.log('A: after q, W(7,3), B(7,8): black hasWon =', e.hasWon(BLACK), ' (expected false: 7-in-a-row overline)');
}

// ---- Case B: in-line double four X.XXX.X is forbidden for black, engine calls it an open four.
// Row 7 black at cols 4,6,8,10; q = col 7.
{
  const e = mk([[7, 4], [7, 6], [7, 8], [7, 10]], far.slice(0, 4));
  const q = idx(7, 7);
  console.log('B: shape =', G.SHAPE_NAMES[e.shape[0 * 225 + q]], ' cat =', CAT[e.cat[q]], ' isForbidden =', e.isForbidden(q), '(expected true)');
  console.log('B: legal(q,BLACK) =', e.legal(q, BLACK));
  const r = e.think(BLACK, { timeMs: 500 });
  console.log('B: think ->', r.reason, rc(r.move), 'score', r.score, '(expected: never (7,7))');
}
