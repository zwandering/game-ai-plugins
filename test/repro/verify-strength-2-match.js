'use strict';
// Engine (0.4 stop rule, unmodified) vs engine with the stop factor replaced by F (in-memory patch).
//   node test/verify-strength-2-match.js <rule> <games> <F> [timeMs=300] [seed=1]
const fs = require('fs'), path = require('path');
const src0 = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
const STOP_OLD = "if (now() - t0 > timeMs * 0.4) break;";
if (!src0.includes(STOP_OLD)) throw new Error('anchor');
function load(src) { const m = { exports: {} }; new Function('module', 'require', src)(m, require); return m.exports(); }
const [rule, GAMES, F, T = 300, SEED = 1] = [process.argv[2], +process.argv[3], +process.argv[4], +(process.argv[5] || 300), +(process.argv[6] || 1)];
const A = load(src0), B = load(src0.replace(STOP_OLD, `if (now() - t0 > timeMs * ${F}) break;`));
let seed = SEED; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
let wA = 0, wB = 0, d = 0;
for (let g = 0; g < GAMES; g++) {
  // same opening for game pairs, colours swapped
  if (g % 2 === 0) seed = SEED * 1000 + g;
  const ea = new A.Engine({ rule }), eb = new B.Engine({ rule });
  let c = 1; const open = [];
  for (let k = 0; k < 4; k++) { let p; do { p = (5 + Math.floor(rnd() * 5)) * 15 + 5 + Math.floor(rnd() * 5); } while (ea.board[p] || (c === 1 && ea.isForbidden(p))); ea.play(p, c); eb.play(p, c); c = 3 - c; }
  const aColor = g % 2 === 0 ? 1 : 2; let winner = 0;
  for (let m = 0; m < 200; m++) {
    const e = c === aColor ? ea : eb; const r = e.think(c, { timeMs: T });
    if (r.move < 0 || ea.board[r.move]) break;
    if (rule === 'renju' && c === 1 && ea.isForbidden(r.move)) { winner = 2; break; }
    ea.play(r.move, c); eb.play(r.move, c);
    if (ea.hasWon(c)) { winner = c; break; }
    c = 3 - c;
  }
  if (!winner) d++; else if (winner === aColor) wA++; else wB++;
  console.log('game', g, 'A(0.4) as', aColor === 1 ? 'black' : 'white', 'winner', winner === 0 ? 'draw' : winner === aColor ? 'A' : 'B');
}
console.log('SUMMARY', rule, 'F', F, 'A(0.4)', wA, 'B', wB, 'draw', d);
