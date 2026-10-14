// refreshCell zeroes renju-black cells whose table shapes contain >=2 open threes, but the
// recursive isForbidden says some of them are legal (one of the threes is fake).
// Quantify, and find positions where such a cell is a legal winning four-three that the engine misses.
const G = require('../../src/engine.js')();
const R = require('./referee.js');
const { Engine } = G;
const NPOS = +(process.argv[2] || 20000);
let seed = +(process.argv[3] || 31337);
const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const e = new Engine({ rule: 'renju', ttBits: 16 });
const nm = q => String.fromCharCode(65 + q % 15) + ((q / 15) | 0);
let verified = 0, positions = 0, posWith = 0, cellsZ = 0, cellsZfour = 0, missedWins = 0;
const shown = [];
for (let it = 0; it < NPOS; it++) {
  const b = new Array(225).fill(0);
  const nst = 12 + rnd(30);
  for (let k = 0; k < nst; k++) { const p = (3 + rnd(9)) * 15 + 3 + rnd(9); if (!b[p]) b[p] = rnd(100) < 55 ? 1 : 2; }
  e.setBoard(b);
  if (e.hasWon(1) || e.hasWon(2)) continue;
  positions++;
  let any = false;
  for (let p = 0; p < 225; p++) {
    if (b[p] || e.cat[p] !== 0) continue;
    let ot = 0, fours = 0, bad = false;
    for (let d = 0; d < 4; d++) { const s = e.shape[d * 225 + p]; if (s === 4) ot++; else if (s === 5 || s === 6) fours++; else if (s >= 7) bad = true; }
    if (bad || fours >= 2 || ot < 2) continue;
    if (e.isForbidden(p) || R.forbidden(b, p)) continue;
    any = true; cellsZ++;
    if (fours === 1) {
      cellsZfour++;
      // Legal four-three: black to move, white has no four/five threats of its own.
      if (e.catCount[1 * 5 + 4] > 0 || e.catCount[1 * 5 + 3] > 0) continue;
      if (e.catCount[0 * 5 + 4] > 0 || e.catCount[0 * 5 + 3] > 0) continue; // black already has a five / open four elsewhere
      // verify by brute force: p, forced block, then black has a legal straight-four point
      e.play(p, 1);
      let blk = -1; for (let q = 0; q < 225; q++) if (e.cat[q] === 4) blk = q;
      let win = false;
      if (blk >= 0 && e.catCount[1 * 5 + 4] === 0) {
        e.play(blk, 2);
        if (e.catCount[1 * 5 + 4] === 0 && e.catCount[1 * 5 + 3] === 0) {
          const bb = Array.from(e.board);
          for (let q = 0; q < 225 && !win; q++) {
            if (bb[q]) continue;
            for (let d = 0; d < 4; d++) if (e.shape[d * 225 + q] === 6 && !R.forbidden(bb, q)) { win = true; break; }
          }
        }
        e.undo();
      }
      e.undo();
      if (!win) continue;
      verified++;
      const vcf = e.findVcf(1, 60000, 30);
      const t = e.think(1, { timeMs: 500 });
      if (!vcf) {
        missedWins++;
        if (shown.length < 2) shown.push({ it, p: nm(p), vcf, think: { move: nm(t.move), reason: t.reason, score: t.score }, board: e.toString() });
      }
    }
  }
  if (any) posWith++;
}
console.log({ positions, positionsWithLegalZeroedCell: posWith, cells: cellsZ, fourThreeCells: cellsZfour, legalFourThreeWinsMissedByVcf: missedWins, verified });
for (const s of shown) { console.log(s.it, 'winning four-three at', s.p, 'findVcf', s.vcf, 'think', s.think); console.log(s.board); }
