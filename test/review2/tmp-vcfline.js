// print a VCF line for colour c on a board (helper for building adversarial positions)
'use strict';
const G = require('../../src/engine.js')();
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
module.exports = function vcfLine(board, rule, c) {
  const e = new G.Engine({ rule }); e.setBoard(board);
  const line = [];
  for (let k = 0; k < 20; k++) {
    const r = e.findVcf(c, 200000, 30); if (!r) break;
    e.play(r.move, c); line.push('+' + name(r.move));
    if (e.hasWon(c)) break;
    const b = e.firstCellWithCat(c, 4); if (b < 0) { line.push('(no single block)'); break; }
    e.play(b, 3 - c); line.push('-' + name(b));
  }
  return line.join(' ');
};
