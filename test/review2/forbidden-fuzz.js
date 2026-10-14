// Compare engine.isForbidden with the independent referee on random clustered positions,
// and check isForbidden leaves the engine state untouched.
// usage: node forbidden-fuzz.js [positions] [seed]
const G = require(process.env.ENGINE || '../../src/engine.js')();
const R = require('./referee.js');
const { Engine } = G;
const NPOS = +(process.argv[2] || 3000);
let seed = +(process.argv[3] || 12345);
const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const e = new Engine({ rule: 'renju', ttBits: 4 });
const snap = () => JSON.stringify([e.hashLo, e.hashHi, e.history.length, e.stones, Array.from(e.catCount), Array.from(e.total),
  Array.from(e.board).join(''), Array.from(e.cat).join(''), Array.from(e.score).join(','), Array.from(e.shape).join(''), Array.from(e.nb).join('')]);
let cells = 0, mism = 0, stateBad = 0, forb = 0, fakeDT = 0, fakeDTlegalCatNone = 0;
const ex = [];
const t0 = Date.now();
for (let it = 0; it < NPOS; it++) {
  const b = new Array(225).fill(0);
  const span = 5 + rnd(6), r0 = rnd(15 - span + 1), c0 = rnd(15 - span + 1);
  const nst = 8 + rnd(Math.min(span * span - 4, 45));
  const pb = 50 + rnd(30);
  for (let k = 0; k < nst; k++) {
    const p = (r0 + rnd(span)) * 15 + c0 + rnd(span);
    if (b[p]) continue;
    b[p] = rnd(100) < pb ? 1 : 2;
  }
  // skip positions where someone already has a five (not reachable)
  e.setBoard(b);
  if (e.hasWon(1) || e.hasWon(2)) continue;
  const before = snap();
  for (let p = 0; p < 225; p++) {
    if (b[p]) continue;
    cells++;
    const got = e.isForbidden(p);
    const want = R.forbidden(b, p);
    if (want) forb++;
    if (got !== want) { mism++; (got ? (global.ft = (global.ft || 0) + 1) : (global.tf = (global.tf || 0) + 1)); if (ex.length < 8) ex.push({ it, p: [(p / 15) | 0, p % 15], got, want, board: e.toString() }); }
    // table-based double three zeroed in refreshCell but actually legal
    if (!want && e.cat[p] === 0) {
      let ot = 0; for (let d = 0; d < 4; d++) if (e.shape[d * 225 + p] === 4) ot++;
      let fours = 0, over = false, five = false;
      for (let d = 0; d < 4; d++) { const s = e.shape[d * 225 + p]; if (s === 7) five = true; if (s === 8) over = true; if (s === 5 || s === 6) fours++; if (s === 9) fours += 2; }
      if (!five && !over && fours < 2 && ot >= 2) { fakeDT++; }
    }
  }
  if (snap() !== before) stateBad++;
}
console.log({ engineTrueRefFalse: global.ft || 0, engineFalseRefTrue: global.tf || 0, cells, mism, stateBad, forb, legalButZeroedDoubleThree: fakeDT, refStats: R.stats(), sec: (Date.now() - t0) / 1000 });
for (const x of ex) { console.log(x.it, 'cell', x.p, 'engine', x.got, 'referee', x.want); console.log(x.board); }
