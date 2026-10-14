// Probe one claim: node test/review2/probe.js <pos.json> <idx> <attacker 1|2> <moves...(e.g. C4 B4)>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, iArg, aArg, ...mv] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(file, 'utf8'))[+iArg];
const a = +aArg, d = 3 - a;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const cell = s => (+s.slice(1)) * 15 + (s.charCodeAt(0) - 65);
const e = new G.Engine({ rule: P.rule });
e.setBoard(P.board);
console.log('rule', P.rule, 'toMove', P.toMove, 'attacker', a);
console.log(e.toString());
const claim = e.findVct(a, 40000, 14, Infinity);
console.log('claim (warm=no)', claim && { plies: claim.plies, move: name(claim.move) });
let c = a;
for (const m of mv) {
  if (c === a) {
    // show defences the engine would consider after this attacker move
    e.play(cell(m), a);
    const n = e.genDefence(d, 40);
    const defs = []; for (let i = 0; i < n; i++) defs.push(name(e.candBuf[40][i] % 256));
    console.log(`after +${m}: genDefence ->`, defs.join(' '));
    e.undo();
  }
  e.play(cell(m), c); c = 3 - c;
}
console.log(e.toString());
console.log('to move:', c === a ? 'attacker' : 'defender');
if (c === a) {
  e.clearCaches();
  for (const [nodes, ply] of [[40000, 14], [400000, 20], [2000000, 30]]) {
    e.clearCaches();
    const t = Date.now();
    const r = e.findVct(a, nodes, ply, Infinity);
    console.log(`fresh findVct(${nodes},${ply}) ->`, r && { plies: r.plies, move: name(r.move) }, Date.now() - t, 'ms');
  }
}
