// think() with winning=true runs ONLY findVct(400000, 20, 0.7*T); on these positions the
// normal findVct(40000, 14) finds a win and the winning-mode one does not (no vctWin entry,
// e.g. after the caches were cleared or the engine/worker was recreated).
// Usage: node test/review2/winning-mode-miss.js [timeMs=1500]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const T = +(process.argv[2] || 1500);
const pos = JSON.parse(fs.readFileSync(__dirname + '/pos-free.json', 'utf8'));
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
for (const [i, a] of [[288, 2], [388, 1]]) {
  const P = pos[i];
  for (const win of [false, true]) {
    const e = new G.Engine({ rule: P.rule });
    e.setBoard(P.board);
    e.winning = win;
    const r = e.think(a, { timeMs: T });
    console.log(`pos#${i} attacker ${a} winning=${win}: think -> ${name(r.move)} ${r.reason} score ${r.score} ${JSON.stringify(r.phases)}`);
  }
}
