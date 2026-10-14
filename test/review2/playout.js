// Playout from pos + moves: node test/review2/playout.js <pos.json> <idx> <firstColor 1|2> <aMs> <dMs> <moves...>
// The colour to move after the given moves is the "attacker" A (think with aMs); other side thinks with dMs.
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, iArg, cArg, aMs, dMs, ...mv] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(file, 'utf8'))[+iArg];
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const cell = s => (+s.slice(1)) * 15 + (s.charCodeAt(0) - 65);
const b = P.board.slice();
let c = +cArg;
for (const m of mv) { b[cell(m)] = c; c = 3 - c; }
const att = c;
const A = new G.Engine({ rule: P.rule }), D = new G.Engine({ rule: P.rule }), J = new G.Engine({ rule: P.rule });
const line = [];
let winner = 0;
for (let k = 0; k < 60 && !winner; k++) {
  const eng = c === att ? A : D;
  eng.setBoard(b);
  const r = eng.think(c, { timeMs: c === att ? +aMs : +dMs });
  if (r.move < 0) break;
  J.setBoard(b);
  if (P.rule === 'renju' && c === 1 && J.isForbidden(r.move)) { winner = 2; line.push('FOUL ' + name(r.move)); break; }
  b[r.move] = c; line.push((c === att ? '+' : '-') + name(r.move) + (c === att ? `(${r.reason})` : ''));
  J.setBoard(b); if (J.hasWon(c)) winner = c;
  c = 3 - c;
}
console.log('attacker', att, 'winner', winner, line.join(' '));
