// Independent brute-force renju referee (no engine code). Board: flat array of 225, 0/1(black)/2(white).
const S = 15, DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inb = (r, c) => r >= 0 && r < S && c >= 0 && c < S;
function runLen(b, r, c, dr, dc, color) {
  color = color || 1;
  let n = 1, rr = r + dr, cc = c + dc;
  while (inb(rr, cc) && b[rr * S + cc] === color) { n++; rr += dr; cc += dc; }
  rr = r - dr; cc = c - dc;
  while (inb(rr, cc) && b[rr * S + cc] === color) { n++; rr -= dr; cc -= dc; }
  return n;
}
// Offsets k on direction d where adding black (p already black) makes an exact five containing p.
function fivePoints(b, r, c, d) {
  const [dr, dc] = DIRS[d], pts = [];
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + dr * k, cc = c + dc * k;
    if (!inb(rr, cc) || b[rr * S + cc] !== 0) continue;
    let contig = true;
    const step = k > 0 ? 1 : -1;
    for (let j = step; j !== k; j += step) if (b[(r + dr * j) * S + c + dc * j] !== 1) { contig = false; break; }
    if (!contig) continue;
    b[rr * S + cc] = 1;
    const len = runLen(b, rr, cc, dr, dc);
    b[rr * S + cc] = 0;
    if (len === 5) pts.push(k);
  }
  return pts;
}
function foursIn(b, r, c, d) {
  const pts = fivePoints(b, r, c, d);
  if (pts.length === 2 && pts[1] - pts[0] === 5) return 1; // straight four
  return pts.length;
}
function straightFour(b, r, c, d) {
  const pts = fivePoints(b, r, c, d);
  return pts.length === 2 && pts[1] - pts[0] === 5;
}
let calls = 0, maxDepth = 0;
function forbidden(b, p, depth) {
  depth = depth || 0;
  if (depth > maxDepth) maxDepth = depth;
  calls++;
  if (b[p] !== 0) return false;
  const r = (p / S) | 0, c = p % S;
  b[p] = 1;
  try {
    let over = false;
    for (let d = 0; d < 4; d++) {
      const len = runLen(b, r, c, DIRS[d][0], DIRS[d][1]);
      if (len === 5) return false;
      if (len > 5) over = true;
    }
    if (over) return true;
    let fours = 0; const hasFour = [];
    for (let d = 0; d < 4; d++) { const f = foursIn(b, r, c, d); fours += f; hasFour[d] = f > 0; }
    if (fours >= 2) return true;
    let threes = 0;
    for (let d = 0; d < 4; d++) {
      if (hasFour[d]) continue;
      if (realThree(b, p, d, depth)) threes++;
    }
    return threes >= 2;
  } finally { b[p] = 0; }
}
// p already black on b: is there a real three through p in direction d?
function realThree(b, p, d, depth) {
  const r = (p / S) | 0, c = p % S, [dr, dc] = DIRS[d];
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + dr * k, cc = c + dc * k;
    if (!inb(rr, cc) || b[rr * S + cc] !== 0) continue;
    const q = rr * S + cc;
    b[q] = 1;
    const sf = straightFour(b, r, c, d) && straightFour(b, rr, cc, d);
    b[q] = 0;
    if (sf && !forbidden(b, q, (depth || 0) + 1)) return true;
  }
  return false;
}
// Line-only three test (ignores forbidden-ness of the four point)
function tableThree(b, p, d) {
  const r = (p / S) | 0, c = p % S, [dr, dc] = DIRS[d];
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + dr * k, cc = c + dc * k;
    if (!inb(rr, cc) || b[rr * S + cc] !== 0) continue;
    b[rr * S + cc] = 1;
    const sf = straightFour(b, r, c, d) && straightFour(b, rr, cc, d);
    b[rr * S + cc] = 0;
    if (sf) return true;
  }
  return false;
}
module.exports = { S, DIRS, forbidden, realThree, tableThree, foursIn, fivePoints, runLen,
  stats: () => ({ calls, maxDepth }), resetStats: () => { calls = 0; maxDepth = 0; } };
