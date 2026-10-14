// Repeated think() on one position with every findVct/findVcf call timed against its deadline.
// Usage: node test/repro/profile-think-calls.js <match.json> <gi> <ply> [timeMs=300] [runs=3]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, gi, ply, ms = '300', runs = '3'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const board = new Array(225).fill(0);
for (let i = 0; i < +ply; i++) board[g.moves[i].p] = g.moves[i].c;
const me = g.moves[+ply].c;
const e = new G.Engine({ rule: g.rule });
for (const fn of ['findVct', 'findVcf']) {
  const f = e[fn].bind(e);
  e[fn] = function (c, nodes, maxPly, deadline) {
    const t = performance.now();
    const r = f(c, nodes, maxPly, deadline);
    const el = performance.now() - t;
    const budget = deadline ? deadline - t : Infinity;
    if (el > 20 || el > budget + 5) console.log(`  ${fn}(${c === me ? 'me' : 'opp'}, ${nodes}, ${maxPly}) took ${el.toFixed(1)}ms, budget ${budget.toFixed(1)}ms, result ${r ? r.plies : null}`);
    return r;
  };
}
for (let k = 0; k < +runs; k++) {
  e.setBoard(board);
  const r = e.think(me, { timeMs: +ms });
  console.log(`run ${k}: ${r.reason} ${r.score} depth ${r.depth} ${r.timeMs}ms ${JSON.stringify(r.phases)}`);
}
