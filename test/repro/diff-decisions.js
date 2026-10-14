// For games the current engine lost against v1, compare its move with v1's move
// on the same position (same time), then judge both with a deep search from the
// opponent's side. Prints positions where the current engine chose clearly worse.
// Usage: node test/repro/diff-decisions.js <match.json> [maxGames=6] [engopts-json]
'use strict';
const fs = require('fs');
const cur = require('../../src/engine.js')();
const v1 = require('../engine-v1.js')();
const [file, maxG = '6', optsJson = '{}'] = process.argv.slice(2);
const opts = JSON.parse(optsJson);
const games = JSON.parse(fs.readFileSync(file, 'utf8')).filter(g => !g.engineWon && !g.draw).slice(0, +maxG);
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const judge = new cur.Engine({ rule: 'freestyle' });
const reasons = {};
for (const g of games) {
  const A = new cur.Engine({ rule: g.rule }), B = new v1.Engine({ rule: g.rule });
  judge.rule = g.rule;
  const board = new Array(225).fill(0);
  for (let i = 0; i < g.moves.length; i++) {
    const m = g.moves[i];
    if (m.who === 'engine') {
      A.setBoard(board); const ra = A.think(m.c, Object.assign({ timeMs: 300 }, opts));
      B.setBoard(board); const rb = B.think(m.c, { timeMs: 300 });
      if (ra.move !== rb.move) {
        const val = mv => { const b2 = board.slice(); b2[mv] = m.c; const J = new cur.Engine({ rule: g.rule }); J.setBoard(b2); return -J.think(3 - m.c, { timeMs: 2500 }).score; };
        const va = val(ra.move), vb = val(rb.move);
        if (vb - va > 3000 || (vb > 900000 && va < 900000) || (va < -900000 && vb > -900000)) {
          const key = ra.reason + (ra.reason === 'search' ? '' : '');
          reasons[key] = (reasons[key] || 0) + 1;
          console.log(`game ${g.gi} ply ${i}: current ${name(ra.move)} (${ra.reason} ${ra.score} d${ra.depth}) judged ${va} | v1 ${name(rb.move)} (${rb.reason} ${rb.score} d${rb.depth}) judged ${vb}`);
        }
      }
    }
    board[m.p] = m.c;
  }
}
console.log('worse decisions by reason', JSON.stringify(reasons));
