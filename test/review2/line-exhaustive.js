// Exhaustive single-line check: every black/white pattern in the 11-cell window around p,
// for several anchor cells / directions (incl. edges), engine renju-black shape vs referee.
const G = require('../../src/engine.js')();
const R = require('./referee.js');
const e = new G.Engine({ rule: 'renju', ttBits: 4 });
const S_OPEN_THREE = 4, S_FOUR = 5, S_OPEN_FOUR = 6, S_FIVE = 7, S_OVERLINE = 8, S_DFOUR = 9;
const anchors = [[7, 7], [7, 0], [7, 2], [7, 4], [7, 12], [7, 14], [3, 3], [0, 6], [12, 9], [4, 11]];
let checked = 0, bad = 0; const ex = [];
for (const [r, c] of anchors) for (let d = 0; d < 4; d++) {
  const [dr, dc] = R.DIRS[d];
  for (let key = 0; key < 59049; key++) {
    const b = new Array(225).fill(0);
    let k = key, ok = true;
    for (let i = 0; i < 10; i++) {
      const v = k % 3; k = (k - v) / 3;
      const off = i < 5 ? i - 5 : i - 4;
      const rr = r + dr * off, cc = c + dc * off;
      if (rr < 0 || rr > 14 || cc < 0 || cc > 14) { if (v) { ok = false; break; } continue; }
      b[rr * 15 + cc] = v;
    }
    if (!ok) continue;
    const p = r * 15 + c;
    // skip if a five already on board
    e.setBoard(b);
    if (e.hasWon(1) || e.hasWon(2)) continue;
    checked++;
    const got = e.shape[d * 225 + p];
    b[p] = 1;
    const len = R.runLen(b, r, c, dr, dc);
    let want;
    if (len === 5) want = S_FIVE; else if (len > 5) want = S_OVERLINE;
    else {
      const f = R.foursIn(b, r, c, d), pts = R.fivePoints(b, r, c, d);
      if (f >= 2) want = S_DFOUR; else if (pts.length === 2) want = S_OPEN_FOUR; else if (f === 1) want = S_FOUR;
      else want = R.tableThree(b, p, d) ? S_OPEN_THREE : -1;
    }
    b[p] = 0;
    const gotN = (got === S_OPEN_THREE || got >= S_FOUR) ? got : -1;
    // forbidden decision on a single line must agree too
    const fe = e.isForbidden(p), fr = R.forbidden(b, p);
    if (gotN !== want || fe !== fr) { bad++; if (ex.length < 10) ex.push({ r, c, d, key, got: G.SHAPE_NAMES[got], want, fe, fr }); }
  }
}
console.log({ checked, bad });
for (const x of ex) console.log(x);
