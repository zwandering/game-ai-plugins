// Renju: a legal black move P = H7 (row 7, col 7) that makes a four + a real open three
// + a FAKE open three (both straight-four points of the diagonal three are overline
// points).  refreshCell() counts raw open threes, so cat[BLACK][P] = CAT_NONE.
// Consequences:
//  - findVcf(BLACK) misses the 4-3 win starting at P;
//  - genDefence(BLACK) omits P as a counter-four, so findVct(WHITE) claims a win that
//    black refutes with P (unsound VCT claim; think(WHITE) plays it as 'vct').
// Usage: node test/review2/renju-fake33-counterfour.js
'use strict';
const G = require('../../src/engine.js')();
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const at = (r, c) => r * 15 + c;
const b = new Array(225).fill(0);
const X = (r, c) => { b[at(r, c)] = 1; }, O = (r, c) => { b[at(r, c)] = 2; };
// row 7: O X X X P .   -> P makes a (closed) four, five point I7
O(7, 3); X(7, 4); X(7, 5); X(7, 6);
// column 7: P X X      -> real open three (straight-four points H6, H10)
X(8, 7); X(9, 7);
// diagonal: P X X      -> fake three: its straight-four points G6 and K10 are overline points
X(8, 8); X(9, 9);
// G6 overline in column 6: O X X X X G6 X(=G7)
O(1, 6); X(2, 6); X(3, 6); X(4, 6); X(5, 6);
// K10 overline on the anti-diagonal: X(8,12) X(9,11) K10 X(11,9) X(12,8) X(13,7)
X(8, 12); X(9, 11); X(11, 9); X(12, 8); X(13, 7);
O(9, 10); O(10, 8); O(6, 4); // break black side shapes (row 9, diagonal F7-H9)
// White's attack far away: L13/M13 + N11/N12 -> N13 makes a double open three
O(13, 11); O(13, 12); O(11, 13); O(12, 13);
// a couple of extra white stones so stone counts are plausible (white to move)
O(0, 0); O(0, 14); O(14, 0); O(1, 0); O(14, 14);
if (process.env.VCFLINE) console.log('black VCF line:', require('./tmp-vcfline.js')(b, 'renju', 1));
const nb = b.filter(v => v === 1).length, nw = b.filter(v => v === 2).length;
const e = new G.Engine({ rule: 'renju' });
e.setBoard(b);
console.log(e.toString());
console.log('stones X', nb, 'O', nw);
const P = at(7, 7);
console.log('black raw cat at P', e.cat[P], '(0 = NONE), shapes', [0, 1, 2, 3].map(d => G.SHAPE_NAMES[e.shape[d * 225 + P]]).join(','));
console.log('isForbidden(P)', e.isForbidden(P), ' legal(P, X)', e.legal(P, 1));
console.log('isForbidden(G6)', e.isForbidden(at(6, 6)), 'isForbidden(K10)', e.isForbidden(at(10, 10)));
console.log('black threats: four cells', e.catCount[2], 'win2', e.catCount[3], 'five', e.catCount[4]);
console.log('findVcf(X) ->', JSON.stringify(e.findVcf(1, 200000, 30)));
// what really happens after P
e.play(P, 1);
console.log('after X P: X five points', e.catCount[4], 'cat(H6)', e.cat[at(6, 7)], 'isForbidden(H6)', e.isForbidden(at(6, 7)));
e.undo();
const v = e.findVct(2, 40000, 14, Infinity);
console.log('findVct(O) ->', v && { move: name(v.move), plies: v.plies });
const t = e.think(2, { timeMs: 1500 });
console.log('think(O) ->', name(t.move), t.reason, t.score);
// play out O's claimed move, then X's refutation by hand: P, forced block, open four
const seq = [];
const play = (p, c) => { if (!e.legal(p, c)) throw new Error('illegal ' + name(p)); e.play(p, c); seq.push((c === 1 ? 'X' : 'O') + name(p)); };
play(v ? v.move : at(13, 13), 2);
console.log('X to move; genDefence(X) after the claim move:', (() => { const n = e.genDefence(1, 40); const a = []; for (let i = 0; i < n; i++) a.push(name(e.candBuf[40][i] % 256)); return a.join(' '); })());
play(P, 1);
const blk = e.firstCellWithCat(1, 4); console.log('O must block X five at', name(blk), '; O five points:', e.catCount[5 + 4]);
play(blk, 2);
play(at(6, 7), 1);
console.log('after X H6: X five points', e.catCount[4], ' O five points', e.catCount[5 + 4]);
const b1 = e.firstCellWithCat(1, 4); play(b1, 2);
const f = e.firstCellWithCat(1, 4); play(f, 1);
console.log(seq.join(' '), '-> X has won:', e.hasWon(1));
