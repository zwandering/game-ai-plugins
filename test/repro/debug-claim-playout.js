// From the position where the engine claimed a forced win, play it out with full
// think() on both sides (attacker with generous time) to see whether the claim holds.
// Usage: node test/repro/debug-claim-playout.js <match.json> <gi> <ply> [attackerMs=3000] [defenderMs=3000]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, gi, plyArg, aMs = '3000', dMs = '3000'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const ply = +plyArg;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const board = new Array(225).fill(0);
for (let i = 0; i < ply; i++) board[g.moves[i].p] = g.moves[i].c;
const me = g.moves[ply].c;
const att = new G.Engine({ rule: g.rule }), def = new G.Engine({ rule: g.rule }), judge = new G.Engine({ rule: g.rule });
let c = me; const line = [];
for (let k = 0; k < 60; k++) {
  const eng = c === me ? att : def;
  eng.setBoard(board);
  const r = eng.think(c, { timeMs: c === me ? +aMs : +dMs });
  line.push((c === me ? '+' : '-') + name(r.move) + (c === me ? '(' + r.reason + ' ' + r.score + ')' : ''));
  board[r.move] = c;
  judge.setBoard(board);
  if (judge.hasWon(c)) { console.log('winner:', c === me ? 'ATTACKER (claim holds)' : 'DEFENDER (claim refuted)'); break; }
  c = 3 - c;
}
console.log(line.join(' '));
