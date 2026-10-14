// Black (to move) has a legal four-three at F10 (one of its two table open threes is fake, so it is
// not a double three), but refreshCell zeroes the cell (cat NONE), so findVcf(BLACK) cannot see it.
const fs = require('fs'), path = require('path');
const G = require('../../src/engine.js')();
const R = require('./referee.js');
const txt = fs.readFileSync(path.join(__dirname, 'case3.txt'), 'utf8').split('\n').filter(l => /^\s*\d+ /.test(l)).map(l => l.replace(/^\s*\d+ /, '')).join('\n');
const b = G.parseBoard(txt);
const e = new G.Engine({ rule: 'renju', ttBits: 16 });
e.setBoard(b);
const p = 10 * 15 + 5; // F10
console.log('F10 shapes', [0, 1, 2, 3].map(d => G.SHAPE_NAMES[e.shape[d * 225 + p]]), 'cat', e.cat[p], 'score', e.score[p]);
console.log('engine isForbidden(F10)', e.isForbidden(p), 'referee', R.forbidden(b, p));
console.log('findVcf(BLACK)', e.findVcf(1, 60000, 30));
e.play(p, 1);
const blk = e.firstCellWithCat(1, 4);
console.log('after F10: white must block at', blk);
e.play(blk, 2);
console.log('after block: black open-four points (cat WIN2)', e.catCount[0 * 5 + 3], 'white fours/fives', e.catCount[1 * 5 + 2], e.catCount[1 * 5 + 4]);
