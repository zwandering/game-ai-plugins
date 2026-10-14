#!/usr/bin/env node
/* Measures raw play/undo throughput and fixed-depth search speed of the current
 * engine vs. test/engine-v1.js on the same random midgame positions.
 * Usage: node test/bench-speed.js */
'use strict';
const cur = require('../src/engine.js')();
const v1 = require('./engine-v1.js')();
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function positions(n) {
  const out = [], rnd = mulberry32(7);
  for (let k = 0; k < n; k++) {
    const b = new Array(225).fill(0);
    let c = 1;
    for (let i = 0; i < 24; i++) {
      let p; do { p = (5 + Math.floor(rnd() * 5)) * 15 + 5 + Math.floor(rnd() * 5); } while (b[p]);
      b[p] = c; c = 3 - c;
    }
    out.push(b);
  }
  return out;
}
const pos = positions(20);
for (const [label, lib] of [['v1', v1], ['current', cur]]) {
  const e = new lib.Engine({ rule: process.env.RULE || 'freestyle' });
  let t = Date.now(), ops = 0;
  for (const b of pos) {
    e.setBoard(b);
    for (let p = 0; p < 225; p++) if (!e.board[p]) { e.play(p, 1); e.undo(); ops++; }
  }
  const playMs = Date.now() - t;
  t = Date.now(); let nodes = 0;
  for (const b of pos) {
    e.setBoard(b);
    e.rootFilter = null; e.rootWidth = 24; e.leafVcfNodes = 60; e.deadline = Infinity; e.aborted = false; e.nodes = 0;
    e.negamax(1, 4, -2000000, 2000000, 0, 3);
    nodes += e.nodes;
  }
  const searchMs = Date.now() - t;
  console.log(label.padEnd(8), 'play+undo', (ops / playMs).toFixed(0), 'per ms;', 'depth-4 search', nodes, 'nodes in', searchMs, 'ms =', (nodes / searchMs).toFixed(1), 'nodes/ms');
}
