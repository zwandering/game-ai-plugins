const fs = require('fs'), path = require('path');
const G = require('../../src/engine.js')();
const R = require('./referee.js');
const txt = fs.readFileSync(path.join(__dirname, 'case3.txt'), 'utf8').split('\n').filter(l => /^\s*\d+ /.test(l)).map(l => l.replace(/^\s*\d+ /, '')).join('\n');
const b = G.parseBoard(txt);
const e = new G.Engine({ rule: 'renju', ttBits: 16 });
e.setBoard(b);
const bd = () => Array.from(e.board);
const p = 10 * 15 + 5;
console.log('F10 referee forbidden', R.forbidden(bd(), p), 'engine legal', e.legal(p, 1));
e.play(p, 1);
const fives = []; for (let q = 0; q < 225; q++) if (e.cat[q] === 4) fives.push(q);
console.log('black five points after F10', fives, 'white cats four/win2/five', e.catCount[5 + 2], e.catCount[5 + 3], e.catCount[5 + 4]);
for (const blk of fives) {
  e.play(blk, 2);
  const w2 = []; for (let q = 0; q < 225; q++) if (e.cat[q] === 3) w2.push(q);
  console.log(' block', blk, 'WIN2 pts', w2.map(q => [q, 'refForbidden', R.forbidden(bd(), q)]));
  for (const q of w2) {
    e.play(q, 1);
    const f = []; for (let x = 0; x < 225; x++) if (e.cat[x] === 4) f.push([x, R.forbidden(bd(), x)]);
    console.log('  after', q, 'black five pts', JSON.stringify(f), 'white five/four', e.catCount[5 + 4], e.catCount[5 + 2]);
    e.undo();
  }
  e.undo();
}
e.undo();
console.log('white at root five/four/win2', e.catCount[5 + 4], e.catCount[5 + 2], e.catCount[5 + 3]);
console.log('findVct', JSON.stringify(e.findVct(1, 200000, 30, Date.now() + 20000)));
const t = e.think(1, { timeMs: 2000 });
console.log('think', JSON.stringify(t).slice(0, 300));
