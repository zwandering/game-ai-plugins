// Time findVct with a deadline on one match position and count where calls go.
// Usage: node test/repro/profile-vct.js <match.json> <gi> <ply> [deadlineMs=50] [nodes=400000]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, gi, ply, dl = '50', nodes = '400000'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const board = new Array(225).fill(0);
for (let i = 0; i < +ply; i++) board[g.moves[i].p] = g.moves[i].c;
const me = g.moves[+ply].c;
const e = new G.Engine({ rule: g.rule });
e.setBoard(board);
const counts = { attack: 0, defend: 0, vcf: 0, genDefence: 0, genDefenceMoves: 0 };
const wrap = (name, extra) => { const f = e[name].bind(e); e[name] = function (...a) { counts[name === 'vctAttack' ? 'attack' : name === 'vctDefend' ? 'defend' : name]++; const r = f(...a); if (extra) extra(r); return r; }; };
wrap('vctAttack'); wrap('vctDefend'); wrap('vcf'); wrap('genDefence', (n) => { counts.genDefenceMoves += n; });
if (process.env.PRE) { // replay think()'s earlier phases first
  const t0 = performance.now();
  e.findVcf(me, 60000, 30, t0 + 30); e.findVcf(3 - me, 60000, 30, performance.now() + 30);
  console.log('pre phases', (performance.now() - t0).toFixed(1), 'ms; cache sizes', e.vcfFail.size, e.vctFail.size, e.vctWin.size);
}
const t = Date.now();
const r = e.findVct(me, +nodes, 20, performance.now() + +dl);
console.log('result', r, 'elapsed', Date.now() - t, 'ms (deadline', dl, 'ms)', JSON.stringify(counts), 'vctNodes left', e.vctNodes);
