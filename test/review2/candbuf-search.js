// Randomised search for positions where VCT recursion exceeds maxPly / candBuf.
// Black has a double-three point at I7; white gets many closed threes (counter-fours).
// Usage: node test/review2/candbuf-search.js [rule] [tries=200] [seed=1]
'use strict';
const G = require('../../src/engine.js')();
const rule = process.argv[2] || 'freestyle';
const tries = +(process.argv[3] || 200);
let seed = +(process.argv[4] || 1);
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const P = G.Engine.prototype;
let maxPly = 0;
const orig = P.genDefence;
P.genDefence = function (me, ply) { if (ply > maxPly) maxPly = ply; return orig.call(this, me, ply); };
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
let best = 0;
for (let t = 0; t < tries; t++) {
  const b = new Array(225).fill(0);
  const set = (r, c, v) => { b[r * 15 + c] = v; };
  set(7, 6, 1); set(7, 7, 1); set(5, 8, 1); set(6, 8, 1);
  const reserved = new Set([7 * 15 + 5, 7 * 15 + 8, 7 * 15 + 9, 4 * 15 + 8, 8 * 15 + 8, 9 * 15 + 8, 7 * 15 + 4, 3 * 15 + 8]);
  const e = new G.Engine({ rule });
  let placed = 0;
  for (let k = 0; k < 400 && placed < 30; k++) {
    const [dr, dc] = DIRS[rnd(4)];
    const r = rnd(15), c = rnd(15);
    const cells = [];
    let ok = true;
    for (let i = 0; i < 6; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (rr < 0 || rr > 14 || cc < 0 || cc > 14) { ok = false; break; }
      const p = rr * 15 + cc;
      if (b[p] !== 0 || reserved.has(p)) { ok = false; break; }
      cells.push(p);
    }
    if (!ok) continue;
    const save = b.slice();
    b[cells[0]] = 1; b[cells[1]] = 2; b[cells[2]] = 2; b[cells[3]] = 2;
    e.setBoard(b);
    // keep: black no fours/fives, white no five / open-four / open-three cells, black 3-3 point still there
    if (e.catCount[0 * 5 + 2] || e.catCount[0 * 5 + 3] || e.catCount[0 * 5 + 4] ||
        e.catCount[1 * 5 + 4] || e.catCount[1 * 5 + 3] || e.catCount[1 * 5 + 1] || e.cat[7 * 15 + 8] !== 1) {
      for (let i = 0; i < 225; i++) b[i] = save[i];
      continue;
    }
    placed++;
  }
  e.setBoard(b);
  maxPly = 0;
  let err = null, r = null;
  try { r = e.findVct(1, 400000, 20, Date.now() + 20000); } catch (x) { err = x; }
  if (maxPly > best || err) {
    best = Math.max(best, maxPly);
    console.log(`try ${t}: segments ${placed} white fours ${e.catCount[1 * 5 + 2]} maxPly ${maxPly} result ${JSON.stringify(r)} ${err ? 'THREW ' + err.message : ''}`);
    if (err) {
      console.log(e.toString());
      console.log('board json', JSON.stringify(b));
      break;
    }
  }
}
