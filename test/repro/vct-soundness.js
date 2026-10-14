// Empirical VCT soundness: sample positions from match games, let the side to move
// (or the side NOT to move, as the opponent-threat check does) run findVct; for every
// claimed win, play it out (attacker: think with generous time, defender: strong think
// without VCT pruning) and count refutations.
// Usage: node test/repro/vct-soundness.js <match.json> [samples=40] [attackerMs=1500] [defenderMs=1500]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, samples = '40', aMs = '1500', dMs = '1500'] = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
let claims = 0, held = 0, refuted = 0, tried = 0;
outer:
for (const g of games) {
  for (let ply = 6; ply < g.moves.length - 2; ply += 3) {
    if (tried >= +samples * 6) break outer;
    tried++;
    const board = new Array(225).fill(0);
    for (let i = 0; i < ply; i++) board[g.moves[i].p] = g.moves[i].c;
    const toMove = g.moves[ply].c;
    for (const att of [toMove, 3 - toMove]) {
      const e = new G.Engine({ rule: g.rule });
      e.setBoard(board);
      const mi = att - 1, oi = 2 - att;
      if (e.catCount[oi * 5 + 4] > 0 || e.catCount[mi * 5 + 4] > 0 || e.catCount[mi * 5 + 3] > 0) continue; // trivial or illegal setups
      if (e.findVcf(att, 20000, 24)) continue; // VCF wins are not what we test here
      const r = e.findVct(att, 40000, 14, Infinity);
      if (!r) continue;
      claims++;
      // playout
      const A = new G.Engine({ rule: g.rule }), D = new G.Engine({ rule: g.rule }), J = new G.Engine({ rule: g.rule });
      const b = board.slice(); let c = att, winner = 0; const line = [];
      for (let k = 0; k < 50 && !winner; k++) {
        const eng = c === att ? A : D;
        eng.setBoard(b);
        const res = c === att ? eng.think(c, { timeMs: +aMs }) : eng.think(c, { timeMs: +dMs });
        if (res.move < 0) break;
        if (g.rule === 'renju' && c === 1) { J.setBoard(b); if (J.isForbidden(res.move)) { winner = 2; line.push('FOUL ' + name(res.move)); break; } }
        b[res.move] = c; line.push((c === att ? '+' : '-') + name(res.move));
        J.setBoard(b); if (J.hasWon(c)) winner = c;
        c = 3 - c;
      }
      if (winner === att) held++;
      else {
        refuted++;
        console.log(`REFUTED game ${g.gi} ply ${ply} attacker ${att === 1 ? 'X' : 'O'} (to move: ${att === toMove}) claim ${r.plies} via ${name(r.move)}; winner ${winner}; line ${line.join(' ')}`);
      }
      if (claims >= +samples) break outer;
    }
  }
}
console.log(`claims ${claims}, held ${held}, refuted ${refuted}`);
