// Re-run think()'s root filter (stillThreatened) on one position and compare with a strong check.
// node test/review2/probe-filter.js <pos.json> <idx> [timeMs=300]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, iArg, tArg = '300', ...mv] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(file, 'utf8'))[+iArg];
const cell = s => (+s.slice(1)) * 15 + (s.charCodeAt(0) - 65);
P.board = P.board.slice(); { let c = P.toMove; for (const m of mv) { P.board[cell(m)] = c; c = 3 - c; } P.toMove = c; }
const me = P.toMove, opp = 3 - me, T = +tArg;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const e = new G.Engine({ rule: P.rule });
e.setBoard(P.board);
const C = new G.Engine({ rule: P.rule, ttBits: 10 });
function strong(p) {
  C.setBoard(P.board); C.clearCaches(); C.play(p, me);
  if (C.hasWon(me)) { C.undo(); return 'wins'; }
  if (C.catCount[(me - 1) * 5 + 4] === 1) { C.undo(); return 'four(delay)'; }
  const r = C.findVcf(opp, 300000, 40);
  C.undo();
  return r ? 'LOSES(' + name(r.move) + ')' : 'safe';
}
const n = e.genNormal(me, 0, 60);
const cands = [];
for (let i = 0; i < n; i++) cands.push(e.candBuf[0][i] % 256);
for (let p = 0; p < 225; p++) if (e.cat[(me - 1) * 225 + p] >= 2 && cands.indexOf(p) < 0) cands.push(p);
const t1 = Date.now();
const rows = [];
for (const p of cands) {
  const t = Date.now();
  const th = e.stillThreatened(p, me, true, Infinity);
  rows.push(`${name(p)} cat=${e.cat[(me - 1) * 225 + p]} filter:${th ? 'threatened' : 'SAFE'} strong:${strong(p)} ${Date.now() - t}ms cum ${Date.now() - t1}ms`);
}
console.log(`think budget for the filter = ${T * 0.2}ms; candidates ${cands.length}`);
console.log(rows.join('\n'));
e.setBoard(P.board);
const r = e.think(me, { timeMs: T });
console.log('think ->', name(r.move), r.reason, r.score, JSON.stringify(r.phases));
