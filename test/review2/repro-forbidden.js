// Two concrete isForbidden false positives (engine says forbidden, black's move is legal).
// case1: depth cap (depth >= 2 -> "treat threes as real") gives the wrong answer at H6.
// case2: a straight-four point on the line that does not contain p (L4) is counted as p's real three at L8.
const fs = require('fs'), path = require('path');
const R = require('./referee.js');
const load = f => require(f)();
const engines = { src: load('../../src/engine.js'), fixed: load('./engine-fixed.js') };
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').filter(l => /^\s*\d+ /.test(l)).map(l => l.replace(/^\s*\d+ /, '')).join('\n');
for (const [file, r, c] of [['case1.txt', 6, 7], ['case2.txt', 8, 11]]) {
  const out = { file, cell: String.fromCharCode(65 + c) + r };
  for (const [k, G] of Object.entries(engines)) {
    const e = new G.Engine({ rule: 'renju', ttBits: 4 });
    const b = G.parseBoard(read(file));
    e.setBoard(b);
    out[k] = e.isForbidden(r * 15 + c);
    out.referee = R.forbidden(b, r * 15 + c);
  }
  console.log(out);
}
