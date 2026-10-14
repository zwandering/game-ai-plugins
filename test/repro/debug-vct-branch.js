// Trace one VCT branch: position = game prefix + given moves, then explain how
// vctAttack evaluates it (which attacker move wins, and the forced line).
// Usage: node test/repro/debug-vct-branch.js <match.json> <gi> <ply> <attacker moves...as +XY/-XY>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, gi, plyArg, ...extra] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const ply = +plyArg;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const P = s => (+s.slice(2)) * 15 + s.charCodeAt(1) - 65;
const e = new G.Engine({ rule: g.rule });
for (let i = 0; i < ply; i++) e.play(g.moves[i].p, g.moves[i].c);
const me = g.moves[ply].c, opp = 3 - me;
for (const t of extra) e.play(P(t), t[0] === '+' ? me : opp);
console.log(e.toString());
const cat = (c, k) => e.catCount[(c - 1) * 5 + k];
console.log('attacker five/win2/four/three', cat(me, 4), cat(me, 3), cat(me, 2), cat(me, 1), ' defender five/win2/four', cat(opp, 4), cat(opp, 3), cat(opp, 2));
const toMove = extra.length % 2 === 0 ? me : opp;
if (toMove === me) {
  const r = e.findVct(me, 400000, 20, Infinity);
  console.log('attacker to move: findVct', r ? r.plies + ' via ' + name(r.move) : 'none');
} else {
  e.vctNodes = 400000; e.vctRoot = 0; e.vctDeadline = Infinity;
  const n = e.genDefence(opp, 1);
  const moves = []; for (let i = 0; i < n; i++) moves.push(e.candBuf[1][i] % 256);
  for (const d of moves) {
    e.play(d, opp);
    e.vctNodes = 400000; e.vctRoot = 99; // non-root semantics
    const r = e.vctAttack(me, 2, 20 + 99);
    e.undo();
    console.log('defence', name(d), '-> attacker', r ? 'wins in ' + r : 'NO WIN');
  }
}
