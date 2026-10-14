// Replays a match game up to the engine's first false VCT claim, then plays the
// claimed line out against a strong defender to find the refutation.
// Usage: node test/repro/debug-vct-claim.js <match.json> <gameIndex> <ply>
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, gi, plyArg] = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(file, 'utf8'));
const g = games.find(x => x.gi === +gi);
const ply = +plyArg;
const e = new G.Engine({ rule: g.rule });
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
for (let i = 0; i < ply; i++) e.play(g.moves[i].p, g.moves[i].c);
const me = g.moves[ply].c;
console.log(e.toString());
console.log('side to move', me === 1 ? 'X' : 'O', 'actual move', name(g.moves[ply].p), JSON.stringify(g.moves[ply].info));
const v = e.findVct(me, 40000, 14, Infinity);
console.log('findVct', v && { plies: v.plies, move: name(v.move) });
// Play out: attacker follows findVct each time, defender uses a long think.
const strong = new G.Engine({ rule: g.rule });
let c = me;
const line = [];
for (let k = 0; k < 30; k++) {
  if (e.hasWon(3 - c)) { console.log('winner', (3 - c) === me ? 'ATTACKER' : 'DEFENDER'); break; }
  let p;
  if (c === me) {
    const r = e.findVct(me, 40000, 14, Infinity);
    if (!r) { console.log('attacker lost the VCT at step', k, 'line', line.join(' ')); console.log(e.toString()); break; }
    p = r.move;
  } else {
    strong.setBoard(Array.from(e.board));
    p = strong.think(c, { timeMs: 3000, vct: false }).move;
  }
  line.push((c === me ? '+' : '-') + name(p));
  e.play(p, c);
  c = 3 - c;
}
console.log('line', line.join(' '));

// Fresh engine, big budget: is each attacker-to-move position along the line still a VCT win?
{
  const P = s => (+s.slice(2)) * 15 + s.charCodeAt(1) - 65;
  const moves = [];
  for (let i = 0; i < ply; i++) moves.push([g.moves[i].p, g.moves[i].c]);
  let cc = me;
  for (let k = 0; k <= line.length; k++) {
    if (cc === me) {
      const f = new G.Engine({ rule: g.rule });
      for (const [p, c] of moves) f.play(p, c);
      const r = f.findVct(me, 400000, 20, Infinity);
      console.log('step', k, 'fresh VCT', r ? 'WIN ' + r.plies + ' via ' + name(r.move) : 'none');
    }
    if (k < line.length) { moves.push([P(line[k]), cc]); cc = 3 - cc; }
  }
}

// Second pass: for each defender reply in the refutation, was it in genDefence()?
{
  const e2 = new G.Engine({ rule: g.rule });
  for (let i = 0; i < ply; i++) e2.play(g.moves[i].p, g.moves[i].c);
  const P = s => (+s.slice(2)) * 15 + s.charCodeAt(1) - 65;
  let cc = me;
  for (const tok of line) {
    const p = P(tok);
    if (cc !== me) {
      const n = e2.genDefence(cc, 0);
      const set = new Set(); for (let i = 0; i < n; i++) set.add(e2.candBuf[0][i] % 256);
      const mi = me - 1;
      console.log('defender', tok, 'inDefenceSet', set.has(p), 'attackerFive', e2.catCount[mi * 5 + 4], 'attackerWin2', e2.catCount[mi * 5 + 3], 'setSize', n);
    }
    e2.play(p, cc); cc = 3 - cc;
  }
}
