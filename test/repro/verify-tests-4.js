const createGomokuEngine = require('../../src/engine.js');
const G = createGomokuEngine(); const e = new G.Engine({ rule: 'renju' });
const b = new Array(225).fill(0); const P = (r, c) => r * 15 + c;
[[7, 2], [8, 7], [9, 7], [8, 8], [9, 9], [12, 1]].forEach(([r, c]) => b[P(r, c)] = 1);
[[7, 3], [7, 4], [7, 5], [7, 6], [1, 1], [1, 13]].forEach(([r, c]) => b[P(r, c)] = 2);
e.setBoard(b);
console.log('r7c7 isForbidden:', e.isForbidden(P(7, 7)), 'legal(black):', e.legal(P(7, 7), 1));
const r = e.think(1, { timeMs: 500 });
console.log('move', r.move, '=r' + Math.floor(r.move / 15) + 'c' + r.move % 15, r.reason, r.score, 'legal:', e.legal(r.move, 1));
// check proposed fix building block: genNormal(me,0,1)
const n = e.genNormal(1, 0, 1); const p = e.candBuf[0][0] % 256;
console.log('genNormal n', n, 'first', p, 'legal', e.legal(p, 1));
