// Audit of "0%" entries in the heat map: for positions from real self-play games,
// run analyze() and check every move it scores as lost (win == 0) independently:
// play the move, let the opponent answer any four we made, and search for an
// opponent VCF/VCT with large budgets. Also counts how often a position has
// only one non-zero move.
// Usage: node test/repro/zero-winrate-audit.js <match.json> [positions=40]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, nPos = '40'] = process.argv.slice(2);
const games = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = p => String.fromCharCode(65 + p % 15) + (15 - ((p / 15) | 0));

function oppForcedWin(e, p, me) {
  const opp = 3 - me;
  e.play(p, me);
  let played = 1, res = null;
  // our move made a four: opponent must block first
  let five = -1;
  for (let q = 0; q < 225; q++) if (e.cat[(me - 1) * 225 + q] === 4) { five = q; break; }
  if (five >= 0) {
    if (e.legal(five, opp)) { e.play(five, opp); played++; }
    else { for (let i = 0; i < played; i++) e.undo(); return null; }
    // after the block it is OUR move again: we are only lost if no reply of ours
    // survives. Let a fresh engine search our best reply.
    const f = new G.Engine({ rule: e.rule });
    f.setBoard(Array.from(e.board));
    const r = f.think(me, { timeMs: 1500 });
    for (let i = 0; i < played; i++) e.undo();
    fourStats.total++;
    if (r.score <= -G.WIN_THRESHOLD) return 'after our four is blocked we are still lost';
    fourStats.notLost++;
    return null;
  }
  const v = e.findVcf(opp, 80000, 30) || e.findVct(opp, 300000, 18);
  for (let i = 0; i < played; i++) e.undo();
  return v ? 'opponent wins by force in ' + v.plies : null;
}

const fourStats = { total: 0, notLost: 0 };
let positions = 0, onlyOne = 0, zeros = 0, confirmed = 0, unconfirmed = [];
outer:
for (const g of games) {
  for (let ply = 8; ply < g.moves.length - 4; ply += 5) {
    const b = new Array(225).fill(0);
    for (let i = 0; i < ply; i++) b[g.moves[i].p] = g.moves[i].c;
    const me = g.moves[ply].c;
    const e = new G.Engine({ rule: g.rule });
    e.setBoard(b);
    const res = e.analyze(me, { timeMs: 1000, analysisMs: 900, pvPlies: 1 });
    if (res.best.reason !== 'search') continue; // forced positions are trivially 0/100
    positions++;
    const z = res.moves.filter(m => m.win === 0);
    if (res.moves.filter(m => m.win > 0).length <= 1) onlyOne++;
    for (const m of z) {
      zeros++;
      const why = oppForcedWin(e, m.move, me);
      if (why) confirmed++; else unconfirmed.push(`game ${g.gi} ply ${ply} ${name(m.move)} (score ${m.score}, depth ${m.depth})`);
    }
    if (positions >= +nPos) break outer;
  }
}
console.log(`positions ${positions}; positions where only one move is not 0%: ${onlyOne}`);
console.log(`0% moves ${zeros}: confirmed by independent VCF/VCT search ${confirmed}, not confirmed ${unconfirmed.length}`);
console.log(`of these, 0% moves that are fours: ${fourStats.total}; not actually lost after the forced block: ${fourStats.notLost}`);
for (const u of unconfirmed.slice(0, 15)) console.log('  unconfirmed:', u);
