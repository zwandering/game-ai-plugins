// Max VCT recursion ply reached (genDefence ply) vs maxPly on game positions.
// Usage: node test/review2/vct-depth-stats.js <pos.json> [samples=300]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, sArg = '300'] = process.argv.slice(2);
const pos = JSON.parse(fs.readFileSync(file, 'utf8'));
const step = Math.max(1, Math.floor(pos.length / +sArg));
let cur = 0;
const orig = G.Engine.prototype.genDefence;
G.Engine.prototype.genDefence = function (me, ply) { if (ply > cur) cur = ply; return orig.call(this, me, ply); };
const hist = {};
let worst = { ply: 0 };
const t0 = Date.now();
for (let i = 0; i < pos.length && Date.now() - t0 < 240000; i += step) {
  const P = pos[i];
  for (const a of [1, 2]) {
    const e = new G.Engine({ rule: P.rule, ttBits: 10 });
    e.setBoard(P.board);
    cur = 0;
    try { e.findVct(a, 400000, 20, Date.now() + 1500); } catch (x) { console.log('THREW at pos', i, a, x.message); }
    hist[cur] = (hist[cur] || 0) + 1;
    if (cur > worst.ply) worst = { ply: cur, i, a };
  }
}
console.log(file, 'max genDefence ply histogram (maxPly=20):', JSON.stringify(hist), 'worst', JSON.stringify(worst));
