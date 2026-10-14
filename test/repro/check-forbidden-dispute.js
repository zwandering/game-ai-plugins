// A renju self-play game where the match harness's simple checker flagged a black move
// as forbidden but the engine did not. Compare engine, the harness checker and the
// recursive referee from the second review on that position.
// Usage: node test/repro/check-forbidden-dispute.js <match.json> <gi> <ply>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const { isForbiddenInd } = require('../match.js');
const ref = require('../review2/referee.js');
const [file, gi, plyArg] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.gi === +gi);
const ply = +plyArg;
const b = new Array(225).fill(0);
for (let i = 0; i < ply; i++) b[g.moves[i].p] = g.moves[i].c;
const p = g.moves[ply].p;
const e = new G.Engine({ rule: 'renju' });
e.setBoard(b);
console.log(e.toString());
const name = q => String.fromCharCode(65 + q % 15) + ((q / 15) | 0);
console.log('move', name(p), 'engine isForbidden', e.isForbidden(p), '| harness checker', isForbiddenInd(b, p), '| review2 referee', ref.forbidden(b, p, 0));
for (let d = 0; d < 4; d++) console.log('  dir', d, 'engine shape', G.SHAPE_NAMES[e.shape[d * 225 + p]]);
