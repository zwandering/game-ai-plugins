// Count positions where the normal VCT (40000 nodes, 14 plies) finds a win but the
// 'winning'-mode VCT (400000 nodes, 20 plies) does not (fresh caches each time; deadline
// as in think: 0.7 * timeMs).
// Usage: node test/review2/vct-monotone.js <pos.json> [samples=200] [timeMs=1500]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, sArg = '200', tArg = '1500'] = process.argv.slice(2);
const pos = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = +sArg, T = +tArg;
const step = Math.max(1, Math.floor(pos.length / S));
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
let small = 0, big = 0, lost = 0, n = 0;
const t0 = Date.now();
for (let i = 0; i < pos.length && Date.now() - t0 < 250000; i += step) {
  const P = pos[i];
  for (const a of [P.toMove, 3 - P.toMove]) {
    const e = new G.Engine({ rule: P.rule, ttBits: 10 });
    e.setBoard(P.board);
    const ai = a - 1, di = 2 - a;
    if (e.catCount[ai * 5 + 4] || e.catCount[di * 5 + 4] || e.catCount[ai * 5 + 3]) continue;
    if (e.findVcf(a, 60000, 30)) continue;
    n++;
    e.clearCaches();
    const r1 = e.findVct(a, 40000, 14, Infinity);
    e.clearCaches();
    const r2 = e.findVct(a, 400000, 20, Date.now() + T * 0.7);
    if (r1) small++;
    if (r2) big++;
    if (r1 && !r2) { lost++; console.log(`pos#${i} att ${a}: small finds ${name(r1.move)} (${r1.plies}), winning-mode search finds nothing`); }
  }
}
console.log(`${file}: positions ${n}, small finds ${small}, winning-mode finds ${big}, small-only ${lost}`);
