// Strong check of specific "0%" moves: after the move, the opponent searches for
// 3 s; a forced-win score confirms the loss. If not confirmed, play it out with
// strong engines on both sides.
// Usage: node test/repro/verify-zero-moves.js <match.json> <gi>:<ply>:<cell> [...]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, ...specs] = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(file, 'utf8'));
const P = s => (15 - +s.slice(1)) * 15 + s.charCodeAt(0) - 65;
const name = p => String.fromCharCode(65 + p % 15) + (15 - ((p / 15) | 0));
for (const spec of specs) {
  const [gi, ply, cell] = spec.split(':');
  const g = games.find(x => x.gi === +gi);
  const b = new Array(225).fill(0);
  for (let i = 0; i < +ply; i++) b[g.moves[i].p] = g.moves[i].c;
  const me = g.moves[+ply].c, opp = 3 - me;
  b[P(cell)] = me;
  const e = new G.Engine({ rule: g.rule });
  e.setBoard(b);
  const r = e.think(opp, { timeMs: 3000 });
  let verdict = r.score >= G.WIN_THRESHOLD ? `opponent finds forced win (${r.reason}, ${1000000 - r.score} plies)` : `opponent score ${r.score} (${r.reason})`;
  if (r.score < G.WIN_THRESHOLD) {
    // playout with strong engines
    const A = new G.Engine({ rule: g.rule }), B = new G.Engine({ rule: g.rule }), J = new G.Engine({ rule: g.rule });
    const bb = b.slice(); let c = opp, winner = 0;
    for (let k = 0; k < 40 && !winner; k++) {
      const eng = c === opp ? A : B; eng.setBoard(bb);
      const m = eng.think(c, { timeMs: 1500 }).move; if (m < 0) break;
      bb[m] = c; J.setBoard(bb); if (J.hasWon(c)) winner = c; c = 3 - c;
    }
    verdict += `; playout winner: ${winner === opp ? 'opponent' : winner === me ? 'us' : 'none'}`;
  }
  console.log(`game ${gi} ply ${ply} ${cell}: ${verdict}`);
}
