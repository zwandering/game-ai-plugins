// node test/review2/probe-vcf.js <pos.json> <idx> <color>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, iArg, cArg] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(file, 'utf8'))[+iArg];
const c = +cArg;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const e = new G.Engine({ rule: P.rule });
e.setBoard(P.board);
console.log(e.toString());
for (const [n, d] of [[6000, 24], [60000, 30], [300000, 30], [300000, 40], [3000000, 60]]) {
  e.clearCaches();
  const r = e.findVcf(c, n, d);
  console.log(`findVcf(${c}, ${n}, ${d}) ->`, r && name(r.move) + ' plies ' + r.plies, 'nodes left', e.vcfNodes);
}
