// Trace engine vs referee on one cell. usage: node debug-cell.js <boardfile> r c
const fs = require('fs');
const G = require(process.env.ENGINE || '../../src/engine.js')();
const R = require('./referee.js');
const b = G.parseBoard(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => /^\s*\d+ /.test(l)).map(l => l.replace(/^\s*\d+ /, '')).join('\n'));
const p = +process.argv[3] * 15 + +process.argv[4];
const e = new G.Engine({ rule: 'renju', ttBits: 4 });
e.setBoard(b);
const nm = q => String.fromCharCode(65 + q % 15) + ((q / 15) | 0);
// trace engine recursion
const orig = e.isForbidden;
let ind = '';
e.isForbidden = function (q, depth) {
  const sh = [0, 1, 2, 3].map(d => G.SHAPE_NAMES[this.shape[d * 225 + q]]);
  console.log(ind + 'engine isForbidden ' + nm(q) + ' depth ' + (depth || 0) + ' shapes ' + sh.join(','));
  ind += '  ';
  const r = orig.call(this, q, depth);
  ind = ind.slice(2);
  console.log(ind + ' -> ' + r);
  return r;
};
console.log('engine', e.isForbidden(p));
console.log('referee', R.forbidden(b, p));
// referee real-three per dir
b[p] = 1;
for (let d = 0; d < 4; d++) console.log('dir', d, 'tableThree', R.tableThree(b, p, d), 'realThree', R.realThree(b, p, d, 0), 'fours', R.foursIn(b, (p / 15) | 0, p % 15, d));
b[p] = 0;
