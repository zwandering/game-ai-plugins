// Review: renju "three" whose only straight-four points are themselves forbidden is not a
// real three (RIF rule 9.3), but isForbidden() counts it, rejecting a legal black move.
const G = require('../../src/engine.js')();
const { Engine, idx, BLACK } = G;
const e = new Engine({ rule: 'renju' });
const a = new Array(225).fill(0);
const black = [
  [8, 7], [9, 7],                                  // vertical: genuine open three with q
  [7, 8], [7, 9],                                  // horizontal: q,(7,8),(7,9) looks like an open three
  [4, 6], [5, 6], [6, 6], [8, 6], [9, 6],          // (7,6) would be a vertical overline -> forbidden
  [4, 10], [5, 10], [6, 10], [8, 10], [9, 10],     // (7,10) would be a vertical overline -> forbidden
];
black.forEach(([r, c]) => a[idx(r, c)] = BLACK);
e.setBoard(a);
const q = idx(7, 7);
console.log('before q: isForbidden(7,6)=', e.isForbidden(idx(7, 6)), 'isForbidden(7,10)=', e.isForbidden(idx(7, 10)));
console.log('shapes at q: horiz', G.SHAPE_NAMES[e.shape[0 * 225 + q]], 'vert', G.SHAPE_NAMES[e.shape[1 * 225 + q]],
  'diag', G.SHAPE_NAMES[e.shape[2 * 225 + q]], 'anti', G.SHAPE_NAMES[e.shape[3 * 225 + q]]);
console.log('isForbidden(7,7) =', e.isForbidden(q), '(RIF: false, horizontal three cannot become a straight four legally)');
e.play(q, BLACK);
console.log('after q: isForbidden(7,6)=', e.isForbidden(idx(7, 6)), 'isForbidden(7,10)=', e.isForbidden(idx(7, 10)));
