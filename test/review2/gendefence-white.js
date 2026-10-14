// Renju, white to move, black threatens an open four (CAT_WIN2). Every white move after which black has
// no exact five and no legal straight four (brute force + referee) must be in genDefence(WHITE).
const G = require('../../src/engine.js')();
const R = require('./referee.js');
const e = new G.Engine({ rule: 'renju', ttBits: 4 });
let seed = +(process.argv[2] || 777);
const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const nm = q => String.fromCharCode(65 + q % 15) + ((q / 15) | 0);
let pos = 0, missing = 0, extra = 0, total = 0; const ex = [];
function blackWinsNext(b) { // black to move: exact five, or a legal straight-four point that cannot be stopped
  for (let q = 0; q < 225; q++) {
    if (b[q]) continue;
    const r = (q / 15) | 0, c = q % 15;
    b[q] = 1; let five = false, sf = false;
    for (let d = 0; d < 4; d++) { if (R.runLen(b, r, c, R.DIRS[d][0], R.DIRS[d][1]) === 5) five = true; }
    b[q] = 0;
    if (five) return true;
    if (R.forbidden(b, q)) continue;
    b[q] = 1;
    for (let d = 0; d < 4; d++) {
      const pts = R.fivePoints(b, r, c, d);
      if (pts.length === 2 && pts[1] - pts[0] === 5) sf = true;
    }
    b[q] = 0;
    if (sf) return true;
  }
  return false;
}
const t0 = Date.now();
for (let it = 0; it < 200000 && pos < 1500 && Date.now() - t0 < 200000; it++) {
  const b = new Array(225).fill(0);
  const nst = 10 + rnd(25);
  for (let k = 0; k < nst; k++) { const p = (3 + rnd(9)) * 15 + 3 + rnd(9); if (!b[p]) b[p] = rnd(100) < 55 ? 1 : 2; }
  e.setBoard(b);
  if (e.hasWon(1) || e.hasWon(2)) continue;
  if (e.catCount[0 * 5 + 3] === 0 || e.catCount[0 * 5 + 4] > 0 || e.catCount[1 * 5 + 4] > 0 || e.catCount[1 * 5 + 3] > 0) continue;
  pos++;
  const n = e.genDefence(2, 0);
  const set = new Set(); for (let i = 0; i < n; i++) set.add(e.candBuf[0][i] % 256);
  for (let q = 0; q < 225; q++) {
    if (b[q]) continue;
    b[q] = 2;
    // white counter-four is also a valid candidate; only check pure defences
    const ok = !blackWinsNext(b);
    b[q] = 0;
    if (ok) { total++; if (!set.has(q)) { missing++; if (ex.length < 3) ex.push({ it, q: nm(q), board: e.toString() }); } }
  }
}
console.log({ positions: pos, realDefences: total, missingFromGenDefence: missing });
for (const x of ex) { console.log(x.it, 'missing', x.q); console.log(x.board); }
