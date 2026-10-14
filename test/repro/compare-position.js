// Run current engine and v1 on one match position several times; print move/depth/nodes/time.
// Usage: node test/repro/compare-position.js <match.json> <gi> <ply> [timeMs=300] [engopts-json]
'use strict';
const fs = require('fs');
const cur = require('../../src/engine.js')();
const v1 = require('../engine-v1.js')();
const [file, gi, ply, ms = '300', optsJson = '{}'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const board = new Array(225).fill(0);
for (let i = 0; i < +ply; i++) board[g.moves[i].p] = g.moves[i].c;
const me = g.moves[+ply].c;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
for (const [label, lib, opts] of [['v1', v1, {}], ['current', cur, JSON.parse(optsJson)]]) {
  const e = new lib.Engine({ rule: g.rule });
  for (let k = 0; k < 3; k++) {
    e.setBoard(board);
    const r = e.think(me, Object.assign({ timeMs: +ms }, opts));
    console.log(label.padEnd(8), name(r.move), r.reason, 'score', r.score, 'depth', r.depth, 'nodes', r.nodes, 'ms', r.timeMs, r.phases ? JSON.stringify(r.phases) : '');
  }
}
