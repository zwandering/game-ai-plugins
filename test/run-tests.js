#!/usr/bin/env node
/*
 * Automated test suite for src/engine.js (plain node, no dependencies).
 *
 *   node test/run-tests.js            run everything
 *   node test/run-tests.js <filter>   run only tests whose name contains <filter>
 *   QUICK=1 node test/run-tests.js    smaller random sample sizes
 *
 * Prints one PASS/FAIL line per test, exits 1 if any test fails.
 * Tests marked KNOWN are failures that were analysed and confirmed to be
 * engine bugs (see the `known` text); they still count as failures.
 *
 * The suite contains an independent, slow but straightforward reference
 * implementation of the rules (five / overline / renju forbidden points with
 * recursive "real three" checks) and of a VCF solver, used to verify puzzles
 * and engine answers instead of trusting the engine's own pattern tables.
 */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'src', 'engine.js'))();
const { Engine, BLACK, WHITE, SIZE, WIN_THRESHOLD } = G;
const N = SIZE * SIZE;
const QUICK = !!process.env.QUICK;

// ===================================================================== reference rules
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inb = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const id = (r, c) => r * SIZE + c;
const name = p => (p < 0 || p >= N) ? String(p) : 'r' + ((p / SIZE) | 0) + 'c' + (p % SIZE);

function runLen(b, p, d, c) {
  const dr = DIRS[d][0], dc = DIRS[d][1], r = (p / SIZE) | 0, col = p % SIZE;
  let n = 1;
  for (let k = 1; ; k++) { const rr = r + dr * k, cc = col + dc * k; if (!inb(rr, cc) || b[id(rr, cc)] !== c) break; n++; }
  for (let k = 1; ; k++) { const rr = r - dr * k, cc = col - dc * k; if (!inb(rr, cc) || b[id(rr, cc)] !== c) break; n++; }
  return n;
}
const exactRule = (c, rule) => rule === 'renju' && c === BLACK;
const isFiveLen = (n, c, rule) => exactRule(c, rule) ? n === 5 : n >= 5;

/** Does stone c already placed at p make a five (per rule) in some direction? */
function makesFive(b, p, c, rule) { for (let d = 0; d < 4; d++) if (isFiveLen(runLen(b, p, d, c), c, rule)) return true; return false; }

/** With b[p] === c: empty cells on direction d whose placement makes a five that contains p. */
function fivePtsDir(b, p, d, c, rule) {
  const out = [], dr = DIRS[d][0], dc = DIRS[d][1], r = (p / SIZE) | 0, col = p % SIZE;
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const rr = r + dr * k, cc = col + dc * k;
    if (!inb(rr, cc)) continue;
    const e = id(rr, cc);
    if (b[e]) continue;
    let ok = true; const s = Math.sign(k);
    for (let j = s; j !== k; j += s) if (b[id(r + dr * j, col + dc * j)] !== c) { ok = false; break; }
    if (!ok) continue;
    b[e] = c; const n = runLen(b, e, d, c); b[e] = 0;
    if (isFiveLen(n, c, rule)) out.push(e);
  }
  return out;
}
const cheb = (a, b2) => Math.max(Math.abs(((a / SIZE) | 0) - ((b2 / SIZE) | 0)), Math.abs(a % SIZE - b2 % SIZE));
/** Number of fours that stone p (placed) forms in direction d. Straight four = 1, X_XXX_X = 2. */
function foursDir(b, p, d, c, rule) {
  const E = fivePtsDir(b, p, d, c, rule);
  if (E.length === 2 && cheb(E[0], E[1]) === 5) return 1;
  return E.length;
}
function straightFourDir(b, p, d, c, rule) {
  const E = fivePtsDir(b, p, d, c, rule);
  return E.length === 2 && cheb(E[0], E[1]) === 5;
}

/** Reference renju forbidden-point test for black at empty p (RIF definitions, recursive). */
function refForbidden(b, p, why) {
  if (b[p] !== 0) return false;
  b[p] = BLACK;
  try {
    let five = false, over = false;
    for (let d = 0; d < 4; d++) { const n = runLen(b, p, d, BLACK); if (n === 5) five = true; else if (n > 5) over = true; }
    if (five) return false;
    if (over) { if (why) why.push('overline'); return true; }
    let fours = 0, threes = 0;
    for (let d = 0; d < 4; d++) {
      const f = foursDir(b, p, d, BLACK, 'renju');
      fours += f;
      if (f === 0 && isRealThreeDir(b, p, d)) threes++;
    }
    if (fours >= 2) { if (why) why.push('double-four'); return true; }
    if (threes >= 2) { if (why) why.push('double-three'); return true; }
    return false;
  } finally { b[p] = 0; }
}
/** With black at p: can one non-forbidden black move on line d make a straight four containing p? */
function isRealThreeDir(b, p, d) {
  const dr = DIRS[d][0], dc = DIRS[d][1], r = (p / SIZE) | 0, col = p % SIZE;
  for (let k = -3; k <= 3; k++) {
    if (!k) continue;
    const rr = r + dr * k, cc = col + dc * k;
    if (!inb(rr, cc)) continue;
    const e = id(rr, cc);
    if (b[e]) continue;
    let ok = true; const s = Math.sign(k);
    for (let j = s; j !== k; j += s) if (b[id(r + dr * j, col + dc * j)] !== BLACK) { ok = false; break; }
    if (!ok) continue;
    b[e] = BLACK; const st = straightFourDir(b, e, d, BLACK, 'renju'); b[e] = 0;
    if (st && !refForbidden(b, e)) return true;
  }
  return false;
}
function refLegal(b, p, c, rule) { return p >= 0 && p < N && b[p] === 0 && !(rule === 'renju' && c === BLACK && refForbidden(b, p)); }

/** All empty cells where colour c would complete a five. */
function fivePoints(b, c, rule) {
  const out = [];
  for (let p = 0; p < N; p++) { if (b[p]) continue; b[p] = c; if (makesFive(b, p, c, rule)) out.push(p); b[p] = 0; }
  return out;
}
function nearStone(b, p, c, dist) {
  const r = (p / SIZE) | 0, col = p % SIZE;
  for (let dr = -dist; dr <= dist; dr++) for (let dc = -dist; dc <= dist; dc++) { const rr = r + dr, cc = col + dc; if (inb(rr, cc) && b[id(rr, cc)] === c) return true; }
  return false;
}
/** Legal cells where c makes at least one five-threat (a four) containing the new stone. */
function fourMoves(b, c, rule) {
  const out = [];
  for (let p = 0; p < N; p++) {
    if (b[p] || !nearStone(b, p, c, 4)) continue;
    b[p] = c;
    let f = false;
    if (!makesFive(b, p, c, rule)) for (let d = 0; d < 4 && !f; d++) if (fivePtsDir(b, p, d, c, rule).length) f = true;
    b[p] = 0;
    if (f && refLegal(b, p, c, rule)) out.push(p);
  }
  return out;
}
/** Legal moves after which c has two or more five points (open four / double four). */
function winThreatMoves(b, c, rule) {
  const out = [];
  for (const p of fourMoves(b, c, rule)) { b[p] = c; const fp = fivePoints(b, c, rule); b[p] = 0; if (fp.length >= 2) out.push(p); }
  return out;
}

/**
 * Reference VCF: attacker A to move. Returns first winning move or -1.
 * depth = max number of attacker moves including the final five.
 */
function refVcf(b, A, rule, depth, budget, memo) {
  memo = memo || new Map();
  const D = 3 - A;
  const fa = fivePoints(b, A, rule);
  if (fa.length) return fa[0];
  if (depth <= 1) return -1;
  const fd = fivePoints(b, D, rule);
  if (fd.length >= 2) return -1;
  const key = Buffer.from(b).toString('latin1') + depth;
  if (memo.has(key)) return memo.get(key);
  let cands;
  if (fd.length === 1) cands = refLegal(b, fd[0], A, rule) ? [fd[0]] : [];
  else cands = fourMoves(b, A, rule);
  let res = -1;
  for (const m of cands) {
    if (budget && --budget.n < 0) throw new Error('reference VCF budget exhausted');
    if (vcfMoveWins(b, A, m, rule, depth, budget, memo)) { res = m; break; }
  }
  memo.set(key, res);
  return res;
}
/** Does attacker move m win by continuous fours within `depth` attacker moves? */
function vcfMoveWins(b, A, m, rule, depth, budget, memo) {
  const D = 3 - A;
  if (!refLegal(b, m, A, rule)) return false;
  b[m] = A;
  try {
    if (makesFive(b, m, A, rule)) return true;
    if (fivePoints(b, D, rule).length) return false; // m left an opponent five threat unanswered
    const fp = fivePoints(b, A, rule);
    if (fp.length >= 2) return depth >= 2;
    if (fp.length === 0) return false;
    const bl = fp[0];
    if (D === BLACK && rule === 'renju' && refForbidden(b, bl)) return depth >= 2;
    b[bl] = D;
    try { return refVcf(b, A, rule, depth - 1, budget, memo) >= 0; } finally { b[bl] = 0; }
  } finally { b[m] = 0; }
}
/** Minimal VCF length (attacker moves incl. the five) up to maxD, 0 if none. */
function minVcf(b, A, rule, maxD, budgetN) {
  const memo = new Map();
  for (let d = 1; d <= maxD; d++) {
    if (refVcf(b, A, rule, d, { n: budgetN || 300000 }, memo) >= 0) return d;
  }
  return 0;
}

/**
 * Hand-built VCF "ladder" with exactly k fours: every four is a broken four
 * P _ X X P' (capped behind by a defender stone, so its only five point is the gap) whose
 * new stone P' starts the next one (zig-zag right/down/left/down/...); the last
 * one is a straight four P X X P'. Defender stones are scattered far away.
 */
function ladderPuzzle(k, A, origin, dirs) {
  const D = 3 - A, b = new Array(N).fill(0);
  const segs = dirs || [[0, 1], [1, 0], [0, -1], [1, 0], [0, 1], [1, 0], [0, -1]];
  let r = origin ? origin[0] : 1, c = origin ? origin[1] : 3;
  const used = new Set();
  let bad = false;
  const put = (rr, cc, v) => {
    if (!inb(rr, cc) || used.has(id(rr, cc))) { bad = true; return; }
    used.add(id(rr, cc)); b[id(rr, cc)] = v;
  };
  put(r, c, A);
  const moves = [], blocks = [];
  for (let i = 0; i < k && !bad; i++) {
    const [dr, dc] = segs[i];
    if (i < k - 1 && segs[i][2]) {
      // contiguous variant P X X P' (capped behind), five point right after P'
      put(r - dr, c - dc, D);
      put(r + dr, c + dc, A); put(r + 2 * dr, c + 2 * dc, A);
      put(r + 4 * dr, c + 4 * dc, 0); blocks.push(id(r + 4 * dr, c + 4 * dc));
      r += 3 * dr; c += 3 * dc;
    } else if (i < k - 1) {
      put(r - dr, c - dc, D);                 // cap behind: filling the gap first is only a plain four
      put(r + dr, c + dc, 0); blocks.push(id(r + dr, c + dc));
      put(r + 2 * dr, c + 2 * dc, A); put(r + 3 * dr, c + 3 * dc, A);
      r += 4 * dr; c += 4 * dc;
    } else {
      put(r - dr, c - dc, 0);                 // both ends of the final straight four stay empty
      put(r + dr, c + dc, A); put(r + 2 * dr, c + 2 * dc, A);
      put(r + 4 * dr, c + 4 * dc, 0);
      r += 3 * dr; c += 3 * dc;
    }
    if (bad) break;
    put(r, c, 0); moves.push(id(r, c));
  }
  if (bad) return null;
  // Scatter defender stones on cells far from everything (no threats).
  let placed = 0;
  for (let p = 0; p < N && placed < 2 * k; p += 7) {
    if (used.has(p) || nearStone(b, p, A, 3) || nearStone(b, p, D, 1)) continue;
    b[p] = D; placed++;
  }
  return { board: b, firstMove: moves[0], moves, blocks };
}

// ===================================================================== harness
const tests = [];
function test(tname, fn, opts) { tests.push(Object.assign({ name: tname, fn }, opts || {})); }
function fail(msg) { const e = new Error(msg); e.isFail = true; throw e; }
const cname = c => c === BLACK ? 'black(X)' : 'white(O)';
const RULES = ['freestyle', 'renju'];
const COLORS = [BLACK, WHITE];
const P = (r, c) => id(r, c);

function rowsToBoard(rows) {
  const b = new Array(N).fill(0);
  rows.forEach((s, r) => { const t = s.replace(/\s+/g, ''); for (let c = 0; c < t.length && c < SIZE; c++) b[id(r, c)] = t[c] === 'X' ? BLACK : t[c] === 'O' ? WHITE : 0; });
  return b;
}
function stonesBoard(xs, os) {
  const b = new Array(N).fill(0);
  for (const [r, c] of xs || []) b[id(r, c)] = BLACK;
  for (const [r, c] of os || []) b[id(r, c)] = WHITE;
  return b;
}
/** ASCII board, X black, O white, '*' = mark (engine move). */
function show(b, mark) {
  let s = '      ' + Array.from({ length: SIZE }, (_, i) => String(i % 10)).join(' ') + '\n';
  for (let r = 0; r < SIZE; r++) {
    s += '   ' + String(r).padStart(2) + ' ';
    for (let c = 0; c < SIZE; c++) { const p = id(r, c), v = b[p]; s += (p === mark ? '*' : v === BLACK ? 'X' : v === WHITE ? 'O' : '.') + ' '; }
    s += '\n';
  }
  return s;
}
function newEngine(b, rule, ttBits) { const e = new Engine({ rule, ttBits }); e.setBoard(Array.from(b)); return e; }
function think(b, c, rule, ms, extra) {
  const e = newEngine(b, rule);
  const t0 = Date.now();
  const r = e.think(c, Object.assign({ timeMs: ms || 600 }, extra || {}));
  r.wall = Date.now() - t0;
  return r;
}
function describe(b, c, rule, r, extra) {
  return `rule=${rule} toMove=${cname(c)} engine move=${name(r.move)} reason=${r.reason} score=${r.score}${extra ? ' ' + extra : ''}\n${show(b, r.move)}`;
}
function assertValidMove(b, c, rule, r) {
  if (!(r.move >= 0 && r.move < N)) fail('move out of range: ' + r.move + '\n' + describe(b, c, rule, r));
  if (b[r.move] !== 0) fail('move on occupied cell\n' + describe(b, c, rule, r));
  if (rule === 'renju' && c === BLACK && refForbidden(Uint8Array.from(b), r.move)) {
    const why = []; refForbidden(Uint8Array.from(b), r.move, why);
    fail('engine returned a renju-forbidden point for black (' + why.join(',') + ')\n' + describe(b, c, rule, r));
  }
}
function lineCells(start, d, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const r = start[0] + d[0] * i, c = start[1] + d[1] * i; if (!inb(r, c)) return null; out.push(id(r, c)); }
  return out;
}
function noFiveOnBoard(b) { for (let p = 0; p < N; p++) if (b[p] && makesFive(b, p, b[p], 'freestyle')) return false; return true; }
const SEED = 20261013;
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/**
 * Play out a defence: engine (S) moves, the reference attacker D answers with
 * five > forced block > reference VCF > open-four move; returns null if S
 * survives (or wins), else a failure description.
 */
function defencePlayout(b0, S, rule, ms, maxRounds) {
  const D = 3 - S, b = Array.from(b0), log = [];
  for (let round = 0; round < (maxRounds || 10); round++) {
    const r = think(b, S, rule, ms);
    const ub = Uint8Array.from(b);
    if (!(r.move >= 0 && r.move < N) || b[r.move] !== 0 || (rule === 'renju' && S === BLACK && refForbidden(ub, r.move)))
      return 'engine produced an invalid move ' + name(r.move) + ' after ' + log.join(' ') + '\n' + show(b, r.move);
    b[r.move] = S; log.push(cname(S)[0] + ':' + name(r.move));
    ub[r.move] = S;
    if (makesFive(ub, r.move, S, rule)) return null;
    const fd = fivePoints(ub, D, rule);
    if (fd.length) { const before = show(b0); b[fd[0]] = D; return 'attacker completed five at ' + name(fd[0]) + ' after ' + log.join(' ') + '\n   start position:\n' + before + '   final position:\n' + show(b, fd[0]); }
    const fs = fivePoints(ub, S, rule);
    let dm = -1;
    if (fs.length >= 2) return null;
    if (fs.length === 1) {
      if (rule === 'renju' && D === BLACK && refForbidden(ub, fs[0])) return null;
      dm = fs[0];
    } else {
      try { dm = refVcf(ub, D, rule, 9, { n: 300000 }); } catch (e) { dm = -1; }
      if (dm < 0) { const w = winThreatMoves(ub, D, rule); if (w.length) dm = w[0]; }
      if (dm < 0) return null; // attacker has nothing forcing left
    }
    b[dm] = D; log.push(cname(D)[0] + ':' + name(dm));
  }
  return null;
}

// ===================================================================== (1) tactics
const WIN1_LINES = [
  // [direction, label, start cells of the 5-cell line]
  [[0, 1], 'horizontal', [[7, 5, 'centre'], [0, 4, 'top edge'], [14, 10, 'corner']]],
  [[1, 0], 'vertical', [[5, 7, 'centre'], [3, 0, 'left edge'], [0, 14, 'corner']]],
  [[1, 1], 'diagonal \\', [[5, 5, 'centre'], [0, 6, 'top edge'], [10, 10, 'corner']]],
  [[1, -1], 'diagonal /', [[5, 9, 'centre'], [10, 4, 'corner'], [0, 14, 'corner']]],
];
/** Put an opponent four (exactly one five point) away from `avoid`; returns its five point or -1. */
function addOpponentFour(b, opp, rule, avoid) {
  const tries = [[2, 2], [12, 2], [2, 9], [12, 9], [7, 1], [7, 10], [4, 4], [10, 9]];
  for (const [r, c] of tries) {
    const cells = lineCells([r, c], [0, 1], 5);
    if (!cells || c - 1 < 0) continue;
    const cap = id(r, c - 1);
    if (cells.concat([cap]).some(p => b[p] || avoid.some(q => cheb(p, q) <= 2))) continue;
    const bb = b.slice();
    for (let i = 0; i < 4; i++) bb[cells[i]] = opp;
    bb[cap] = 3 - opp;
    const fp = fivePoints(Uint8Array.from(bb), opp, rule);
    if (fp.length === 1 && fp[0] === cells[4]) { for (let i = 0; i < N; i++) b[i] = bb[i]; return cells[4]; }
  }
  return -1;
}
for (const rule of RULES) for (const me of COLORS) for (const [d, dname, anchors] of WIN1_LINES) {
  test(`tactics/${rule}/${cname(me)}/win-in-1 ${dname} (centre/edge/corner, gap at end or middle, with and without an opponent four)`, () => {
    const errs = [];
    for (const [r0, c0, where] of anchors) for (const gap of [0, 2, 4]) for (const oppFour of [false, true]) {
      const cells = lineCells([r0, c0], d, 5);
      if (!cells) throw new Error('bad anchor');
      const b = new Array(N).fill(0);
      cells.forEach((p, i) => { if (i !== gap) b[p] = me; });
      if (oppFour) { if (addOpponentFour(b, 3 - me, rule, cells) < 0) throw new Error('could not place opponent four'); }
      else { for (const q of [id(13, 1), id(1, 1), id(13, 7)]) if (!b[q] && cells.every(p => cheb(p, q) > 2)) b[q] = 3 - me; }
      const want = fivePoints(Uint8Array.from(b), me, rule);
      if (!want.length) throw new Error('puzzle has no five point');
      const r = think(b, me, rule, 500);
      if (want.indexOf(r.move) < 0) errs.push(`${where} gap=${gap} oppFour=${oppFour}: expected one of ${want.map(name)}\n` + describe(b, me, rule, r));
    }
    if (errs.length) fail(errs.length + ' case(s) failed\n' + errs.join('\n'));
  });
}

// Block a four (plain, broken X X _ X X, X _ X X X), also when we have a tempting open three.
const FOUR_SHAPES = [
  ['XXXX_ (capped)', 'cXXXX_'], ['_XXXX (capped)', '_XXXXc'], ['XX_XX', 'XX_XX'], ['X_XXX', 'X_XXX'], ['XXX_X', 'XXX_X'],
];
function buildShape(b, pattern, start, d, attacker) {
  const cells = lineCells(start, d, pattern.length);
  if (!cells) return null;
  pattern.split('').forEach((ch, i) => {
    if (ch === 'X') b[cells[i]] = attacker;
    else if (ch === 'c') b[cells[i]] = 3 - attacker;
  });
  return cells;
}
for (const rule of RULES) for (const me of COLORS) {
  test(`tactics/${rule}/${cname(me)}/block a four (XXXX_, XX_XX, X_XXX, XXX_X; 4 directions; with own open three as bait)`, () => {
    const opp = 3 - me, errs = [];
    for (const [sname, pat] of FOUR_SHAPES) for (let di = 0; di < 4; di++) for (const bait of [false, true]) {
      const d = DIRS[di];
      const start = di === 3 ? [3, 10] : [3, 3];
      const b = new Array(N).fill(0);
      buildShape(b, pat, start, d, opp);
      if (bait) { b[id(11, 6)] = me; b[id(11, 7)] = me; b[id(11, 8)] = me; } // open three for me
      else { b[id(11, 6)] = me; b[id(12, 9)] = me; }
      b[id(0, 0)] = me;
      const fp = fivePoints(Uint8Array.from(b), opp, rule);
      if (fp.length !== 1) throw new Error('bad four puzzle ' + sname + ' ' + fp.map(name));
      const r = think(b, me, rule, 500);
      if (r.move !== fp[0]) errs.push(`${sname} dir=${di} bait=${bait}: expected ${name(fp[0])}\n` + describe(b, me, rule, r));
    }
    if (errs.length) fail(errs.length + ' case(s) failed\n' + errs.join('\n'));
  });
}

// Respond to an open three: after the engine's move, a reference attacker must not be able to force a win.
const THREE_POSITIONS = [
  { label: '_XXX_ horizontal', opp: [[7, 6], [7, 7], [7, 8]], me: [[6, 7], [8, 9]] },
  { label: '_XXX_ vertical', opp: [[6, 7], [7, 7], [8, 7]], me: [[7, 8], [9, 6]] },
  { label: '_XXX_ diagonal \\', opp: [[6, 6], [7, 7], [8, 8]], me: [[7, 6], [6, 9]] },
  { label: '_XX_X_ diagonal /', opp: [[5, 9], [6, 8], [8, 6]], me: [[7, 6], [9, 9]] },
  { label: '_X_XX_ horizontal near edge', opp: [[1, 3], [1, 5], [1, 6]], me: [[2, 4], [3, 6]] },
  { label: '_XXX_ near corner diagonal', opp: [[2, 2], [3, 3], [4, 4]], me: [[3, 2], [5, 2]] },
];
for (const rule of RULES) for (const me of COLORS) {
  test(`tactics/${rule}/${cname(me)}/respond to an open three (playout vs reference attacker)`, () => {
    const errs = [];
    for (const pos of THREE_POSITIONS) {
      const b = stonesBoard(me === BLACK ? pos.me : pos.opp, me === BLACK ? pos.opp : pos.me);
      if (!winThreatMoves(Uint8Array.from(b), 3 - me, rule).length) throw new Error('not an open three: ' + pos.label);
      const res = defencePlayout(b, me, rule, 500, 6);
      if (res) errs.push(pos.label + ': ' + res);
    }
    if (errs.length) fail(errs.join('\n'));
  });
}

// Make an open four from an open three when the opponent has nothing.
const MAKE4_POSITIONS = [
  { label: 'open three horizontal', me: [[7, 6], [7, 7], [7, 8]], opp: [[6, 7], [8, 5], [3, 3]] },
  { label: 'split three vertical', me: [[5, 7], [6, 7], [8, 7]], opp: [[7, 8], [6, 6], [10, 10]] },
  { label: 'open three diagonal near edge', me: [[1, 1], [2, 2], [3, 3]], opp: [[1, 2], [2, 1], [12, 12]] },
];
for (const rule of RULES) for (const me of COLORS) {
  test(`tactics/${rule}/${cname(me)}/make an open four from an open three`, () => {
    const errs = [];
    for (const pos of MAKE4_POSITIONS) {
      const b = stonesBoard(me === BLACK ? pos.me : pos.opp, me === BLACK ? pos.opp : pos.me);
      const ub = Uint8Array.from(b);
      const want = winThreatMoves(ub, me, rule);
      if (!want.length) throw new Error('bad puzzle ' + pos.label);
      const r = think(b, me, rule, 500);
      if (want.indexOf(r.move) < 0 && !vcfMoveWins(ub, me, r.move, rule, 4)) errs.push(`${pos.label}: expected one of ${want.map(name)}\n` + describe(b, me, rule, r));
    }
    if (errs.length) fail(errs.join('\n'));
  });
}

// ---- VCF puzzles
const LADDERS = [ // [fours, origin, segment directions (third element 1 = contiguous segment)]; lengths verified by the reference solver
  [3, [10, 2], [[-1, 0], [-1, 1, 1], [1, 1]]],
  [4, [11, 11], [[-1, -1, 1], [-1, 0, 1], [-1, -1, 1], [1, -1]]],
  [5, [8, 2], [[1, 0], [-1, 1], [-1, 0], [0, 1], [1, 1, 1]]],
  [6, [11, 10], [[0, 1, 1], [-1, 0], [-1, -1], [1, -1, 1], [1, 0], [0, 1]]],
  [7, [6, 12], [[-1, -1], [1, -1, 1], [1, 0, 1], [0, -1], [-1, 0], [-1, 1, 1], [0, -1]]],
  [7, [2, 3], [[1, 0], [-1, 1], [0, 1, 1], [1, 1, 1], [1, -1], [1, 0], [0, 1]]],
];
// Random positions found by a search with the reference solver; `moves` = attacker moves of the shortest VCF incl. the five.
const RANDOM_VCF = [
  { rule: 'renju', attacker: 2, moves: 3, rows: ['...............', '...............', '...............', '....O....X.O...', '....X..........', '...O.O.........', '....X..........', '...X...O.......', '...........X...', '...XX..X.OO....', '......XOOX.....', '......XXO.O....'] },
  { rule: 'freestyle', attacker: 1, moves: 3, rows: ['...............', '...............', '...............', '....X..........', '...XX..X.......', '.........XXO...', '.......X.......', '.....OX....O...', '....X.O........', '...O.O.....O...', '...X..O....X...', '......O..OO....'] },
  { rule: 'renju', attacker: 2, moves: 4, rows: ['...............', '...............', '...............', '...............', '.....X...O.....', '......XO..X....', '...X...........', '.....O..OXO....', '.......O..OO...', '...............', '...X...X.X.....', '..........O....'] },
  { rule: 'renju', attacker: 1, moves: 4, rows: ['...............', '...............', '...............', '....O....X.....', '.........OO....', '...X.X..O......', '....X..........', '........O..O...', '....X.....X....', '......O....X...', '....X......X...', '...........O...'] },
  { rule: 'renju', attacker: 2, moves: 5, rows: ['...............', '...............', '...............', '.......XX..O...', '...O..OX..X....', '....XO.........', '...O..OO.......', '.....XX.X......', '...X...........', '.....O.O..X....', '...X...........', '.......XO..O...'] },
  { rule: 'freestyle', attacker: 2, moves: 3, rows: ['...............', '...............', '...............', '...O...........', '...X..O.O......', '...XO..X..O....', '.....X..XX.....', '....X..O.X.....', '.....XOO.......', '.....O.XX......', '......X..XO....', '....O.O.OOXX...'] },
  { rule: 'renju', attacker: 1, moves: 3, rows: ['...............', '...............', '...............', '...XO....XX....', '.......O.X.....', '....O......X...', '......X.OO.O...', '....X..OO......', '.......O.XX....', '...........O...', '...O...X..XX...', '...O.O...X.X...'] },
  { rule: 'freestyle', attacker: 2, moves: 4, rows: ['...............', '...............', '...............', '....X...O......', '...O....O......', '...O.OX..OX....', '....X.....XX...', '.....O...OXX...', '........X......', '.....X...O.....', '..........OX...', '....X..O..O....'] },
  { rule: 'renju', attacker: 1, moves: 5, rows: ['...............', '...............', '...............', '....O.O..OXO...', '....O.X..X.X...', '......X.OO.....', '...O.....XO....', '....X..........', '.....X...O.....', '...X.X..XXO....', '...............', '....O....X.....'] },
];
function ladderBoard(fours, origin, dirs, A) { const pz = ladderPuzzle(fours, A, origin, dirs); if (!pz) throw new Error('ladder layout collides'); return pz; }
function checkVcfFound(b, A, rule, minMoves, ms) {
  const ub = Uint8Array.from(b);
  const m = minVcf(ub, A, rule, minMoves, 400000);
  if (m !== minMoves) throw new Error(`puzzle invalid: reference shortest VCF = ${m} attacker moves, expected ${minMoves}`);
  if (fivePoints(ub, 3 - A, rule).length) throw new Error('puzzle invalid: defender has a five point');
  const r = think(b, A, rule, ms || 1000);
  let ok;
  try { ok = vcfMoveWins(ub, A, r.move, rule, minMoves + 6, { n: 2000000 }); } catch (e) { ok = false; }
  if (!ok) fail(`engine move does not start a VCF (reference shortest VCF: ${minMoves - 1} fours + five)\n` + describe(b, A, rule, r));
}
for (const rule of RULES) for (const A of COLORS) for (const [fours, origin, dirs] of LADDERS) {
  test(`tactics/${rule}/${cname(A)}/VCF ladder with ${fours} fours (origin ${origin}) must be found`, () => {
    checkVcfFound(ladderBoard(fours, origin, dirs, A).board, A, rule, fours + 1);
  });
}
RANDOM_VCF.forEach((pz, i) => {
  test(`tactics/${pz.rule}/${cname(pz.attacker)}/VCF random puzzle #${i + 1} (${pz.moves - 1} fours + five) must be found`, () => {
    checkVcfFound(rowsToBoard(pz.rows), pz.attacker, pz.rule, pz.moves);
  });
});
for (const rule of RULES) for (const A of COLORS) {
  test(`tactics/${rule}/${cname(A)}/own VCF beats answering the opponent's open three`, () => {
    const base = ladderBoard(4, LADDERS[1][1], LADDERS[1][2], A).board;
    let b = null;
    // place an opponent open three somewhere it does not interact with the ladder
    for (const [r, c] of [[13, 8], [1, 9], [9, 1], [13, 4], [5, 12]]) {
      const cells = [id(r, c), id(r, c + 1), id(r, c + 2)];
      if (cells.some(q => base[q] || nearStone(Uint8Array.from(base), q, A, 2))) continue;
      const cand = base.slice(); for (const q of cells) cand[q] = 3 - A;
      const uc = Uint8Array.from(cand);
      if (winThreatMoves(uc, 3 - A, rule).length && !fivePoints(uc, 3 - A, rule).length && minVcf(uc, A, rule, 5) === 5) { b = cand; break; }
    }
    if (!b) throw new Error('setup: could not place the opponent open three');
    const ub = Uint8Array.from(b);
    const r = think(b, A, rule, 1000);
    if (!vcfMoveWins(ub, A, r.move, rule, 11, { n: 2000000 })) fail('engine did not play its VCF\n' + describe(b, A, rule, r));
  });
}

// ---- Defend against the opponent's VCF
function killSetExists(b, S, rule, depth) {
  const D = 3 - S, ub = Uint8Array.from(b);
  for (let p = 0; p < N; p++) {
    if (ub[p] || !nearStone(ub, p, D, 2) || !refLegal(ub, p, S, rule)) continue;
    ub[p] = S;
    let still;
    try { still = fivePoints(ub, S, rule).length === 0 && refVcf(ub, D, rule, depth, { n: 200000 }) >= 0; } catch (e) { still = true; }
    ub[p] = 0;
    if (!still) return p;
  }
  return -1;
}
for (const rule of RULES) for (const A of COLORS) for (const li of [0, 1, 2]) {
  const [fours, origin, dirs] = LADDERS[li];
  test(`tactics/${rule}/${cname(3 - A)}/defend against the opponent's VCF (ladder with ${fours} fours, playout)`, () => {
    const pz = ladderBoard(fours, origin, dirs, A);
    const S = 3 - A, ub = Uint8Array.from(pz.board);
    if (minVcf(ub, S, rule, 9) !== 0 || winThreatMoves(ub, S, rule).length) throw new Error('setup: defender has own attack');
    if (killSetExists(pz.board, S, rule, fours + 3) < 0) throw new Error('setup: no defence exists');
    const res = defencePlayout(pz.board, S, rule, 800, 10);
    if (res) fail(res);
  });
}
RANDOM_VCF.forEach((pz, i) => {
  test(`tactics/${pz.rule}/${cname(3 - pz.attacker)}/defend against the VCF of random puzzle #${i + 1} (when a defence exists)`, () => {
    const b = rowsToBoard(pz.rows), S = 3 - pz.attacker, ub = Uint8Array.from(b);
    if (fivePoints(ub, S, pz.rule).length || minVcf(ub, S, pz.rule, 7) || winThreatMoves(ub, S, pz.rule).length) return 'skipped: defender has its own attack';
    if (killSetExists(b, S, pz.rule, pz.moves + 3) < 0) return 'skipped: no single-move defence exists';
    const res = defencePlayout(b, S, pz.rule, 800, 10);
    if (res) fail(res);
  });
});

// ===================================================================== (2) incremental state consistency
function compareWithFresh(e, rule, ctx) {
  const f = newEngine(e.board, rule, 4);
  for (let p = 0; p < N; p++) if (e.board[p] !== f.board[p]) return `${ctx}: board differs at ${name(p)}`;
  // shape[] of occupied cells is never read (stale by design), so only empty cells are compared
  for (let ci = 0; ci < 2; ci++) for (let d = 0; d < 4; d++) for (let p = 0; p < N; p++) {
    if (e.board[p]) continue;
    const k = (ci * 4 + d) * N + p;
    if (e.shape[k] !== f.shape[k]) return `${ctx}: shape[colour ${ci + 1}, dir ${d}] at ${name(p)} incremental=${G.SHAPE_NAMES[e.shape[k]]} fresh=${G.SHAPE_NAMES[f.shape[k]]}`;
  }
  for (let k = 0; k < 2 * N; k++) {
    if (e.score[k] !== f.score[k]) return `${ctx}: score (${name(k % N)} colour ${((k / N) | 0) + 1}) incremental=${e.score[k]} fresh=${f.score[k]}`;
    if (e.cat[k] !== f.cat[k]) return `${ctx}: cat (${name(k % N)} colour ${((k / N) | 0) + 1}) incremental=${e.cat[k]} fresh=${f.cat[k]}`;
  }
  for (let k = 0; k < 10; k++) if (e.catCount[k] !== f.catCount[k]) return `${ctx}: catCount[${k}] incremental=${e.catCount[k]} fresh=${f.catCount[k]}`;
  for (let k = 0; k < 2; k++) if (e.total[k] !== f.total[k]) return `${ctx}: total[${k}] incremental=${e.total[k]} fresh=${f.total[k]}`;
  for (let p = 0; p < N; p++) if (e.nb[p] !== f.nb[p]) return `${ctx}: nb at ${name(p)} incremental=${e.nb[p]} fresh=${f.nb[p]}`;
  if (e.hashLo !== f.hashLo || e.hashHi !== f.hashHi) return `${ctx}: hash differs`;
  if (e.stones !== f.stones) return `${ctx}: stones ${e.stones} vs ${f.stones}`;
  for (let ci = 0; ci < 2; ci++) {
    const cnt = [0, 0, 0, 0, 0];
    for (let p = 0; p < N; p++) cnt[e.cat[ci * N + p]]++;
    for (let k = 0; k < 5; k++) if (cnt[k] !== e.catCount[ci * 5 + k]) return `${ctx}: catCount does not match cat array`;
  }
  return null;
}
function randomNearMove(e, rnd) {
  const cand = [];
  for (let p = 0; p < N; p++) if (e.board[p] === 0 && (e.stones === 0 || e.nb[p] > 0)) cand.push(p);
  if (!cand.length) for (let p = 0; p < N; p++) if (e.board[p] === 0) cand.push(p);
  return cand.length ? cand[Math.floor(rnd() * cand.length)] : -1;
}
for (const rule of RULES) {
  test(`consistency/${rule}/random games: incremental state == fresh setBoard after every move`, () => {
    const rnd = rng(SEED + (rule === 'renju' ? 7 : 3));
    for (let g = 0; g < (QUICK ? 6 : 25); g++) {
      const e = new Engine({ rule, ttBits: 4 });
      const len = 40 + Math.floor(rnd() * 150);
      let c = BLACK;
      for (let i = 0; i < len; i++) {
        const p = randomNearMove(e, rnd);
        if (p < 0) break;
        e.play(p, c); c = 3 - c;
        const err = compareWithFresh(e, rule, `game ${g} move ${i + 1} (${name(p)})`);
        if (err) fail(err + '\n' + show(e.board, p));
      }
    }
  });
  test(`consistency/${rule}/random play/undo sequences: state == fresh setBoard after every step`, () => {
    const rnd = rng(SEED + (rule === 'renju' ? 11 : 13));
    for (let g = 0; g < (QUICK ? 6 : 25); g++) {
      const e = new Engine({ rule, ttBits: 4 });
      let c = BLACK;
      for (let i = 0; i < 200; i++) {
        let what;
        if (e.history.length && rnd() < 0.4) { const p = e.undo(); c = 3 - c; what = 'undo ' + name(p); }
        else { const p = randomNearMove(e, rnd); if (p < 0) break; e.play(p, c); c = 3 - c; what = 'play ' + name(p); }
        const err = compareWithFresh(e, rule, `run ${g} step ${i + 1} (${what})`);
        if (err) fail(err + '\n' + show(e.board));
      }
    }
  });
  test(`consistency/${rule}/think() leaves board, hash and incremental state unchanged`, () => {
    const rnd = rng(SEED + 99);
    for (let g = 0; g < 6; g++) {
      const e = new Engine({ rule, ttBits: 16 });
      let c = BLACK;
      for (let i = 0; i < 20 + g * 6; i++) { e.play(randomNearMove(e, rnd), c); c = 3 - c; }
      const before = { b: Array.from(e.board).join(), lo: e.hashLo, hi: e.hashHi, h: e.history.length };
      e.think(c, { timeMs: 200 });
      if (Array.from(e.board).join() !== before.b || e.hashLo !== before.lo || e.hashHi !== before.hi || e.history.length !== before.h) fail('think() changed the position');
      const err = compareWithFresh(e, rule, 'after think');
      if (err) fail(err);
    }
  });
}

// ===================================================================== (3) renju rules
function forbidCase(label, xs, os, p, expected, opts) {
  test(`renju/isForbidden: ${label}`, () => {
    const b = stonesBoard(xs, os), ub = Uint8Array.from(b);
    if (!noFiveOnBoard(ub)) throw new Error('setup has a five on the board');
    const why = [];
    const ref = refForbidden(ub, p, why);
    if (ref !== expected) throw new Error(`test expectation disagrees with the reference (${ref} ${why})`);
    const e = newEngine(b, 'renju', 4);
    const got = e.isForbidden(p);
    const errs = [];
    if (got !== expected) errs.push(`isForbidden(${name(p)}) = ${got}, expected ${expected}${why.length ? ' (' + why.join(',') + ')' : ''}`);
    if (e.legal(p, BLACK) !== !expected) errs.push(`legal(${name(p)}, BLACK) = ${e.legal(p, BLACK)}, expected ${!expected}`);
    if (e.legal(p, WHITE) !== true) errs.push('white must always be allowed there');
    if (errs.length) fail(errs.join('; ') + '\n' + show(b, p));
  }, opts);
}
const FAR_O = [[0, 0], [0, 2], [0, 4], [14, 14], [14, 0], [0, 14], [14, 7], [12, 12], [2, 12], [12, 2]];
const farO = n => FAR_O.slice(0, n);
forbidCase('classic double-three (row + column)', [[7, 5], [7, 6], [5, 7], [6, 7]], farO(4), P(7, 7), true);
forbidCase('double-three on the two diagonals', [[6, 6], [5, 5], [6, 8], [5, 9]], farO(4), P(7, 7), true);
forbidCase('split double-three (X_X + XX)', [[7, 4], [7, 6], [8, 7], [9, 7]], farO(4), P(7, 7), true);
forbidCase('open three + blocked three is legal', [[7, 5], [7, 6], [5, 7], [6, 7]], [[7, 8]].concat(farO(3)), P(7, 7), false);
forbidCase('double-four (row + column)', [[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]], [[7, 3], [3, 7]].concat(farO(4)), P(7, 7), true);
forbidCase('double-four of broken fours (X_XX + XX_X)', [[7, 3], [7, 5], [7, 6], [4, 7], [5, 7], [8, 7]], [[3, 7], [9, 7], [7, 8]].concat(farO(3)), P(7, 7), true);
forbidCase('four-three is legal', [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7]], [[7, 3]].concat(farO(4)), P(7, 7), false);
forbidCase('overline (XX_XXX)', [[7, 4], [7, 5], [7, 7], [7, 8], [7, 9]], farO(5), P(7, 6), true);
forbidCase('five + double-three is legal (five beats forbidden)', [[7, 3], [7, 4], [7, 5], [7, 6], [5, 9], [6, 8], [9, 9], [8, 8]], farO(8), P(7, 7), false);
forbidCase('five + double-four is legal', [[7, 3], [7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7], [4, 10], [5, 9], [6, 8]], [[3, 7], [3, 11]].concat(farO(8)), P(7, 7), false);
forbidCase('same-line double four X_XXX_X', [[7, 3], [7, 5], [7, 7], [7, 9]], farO(4), P(7, 6), true,
  { known: 'shape table maps X_XXX_X to S_OPEN_FOUR, which isForbidden counts as ONE four (src/engine.js:75, 307)' });
forbidCase('same-line double four XXX_X_XXX', [[7, 2], [7, 3], [7, 4], [7, 8], [7, 9], [7, 10]], farO(6), P(7, 6), true,
  { known: 'same-line double four counted as one open four (src/engine.js:75, 307)' });
forbidCase('same-line double four XX_XX_XX', [[7, 2], [7, 3], [7, 6], [7, 8], [7, 9]], farO(5), P(7, 5), true,
  { known: 'same-line double four counted as one open four (src/engine.js:75, 307)' });
forbidCase('exact five in one direction + overline in another is legal', [[7, 4], [7, 5], [7, 6], [7, 8], [7, 9], [3, 7], [4, 7], [5, 7], [6, 7]], [[2, 7], [8, 7]].concat(farO(8)), P(7, 7), false,
  { known: 'isForbidden returns true at the first overline direction before later directions are checked for an exact five (src/engine.js:304-306)' });
forbidCase('fake three: the row three can only become a straight four on overline points',
  [[7, 5], [7, 6], [4, 4], [5, 4], [6, 4], [8, 4], [9, 4], [4, 8], [5, 8], [6, 8], [8, 8], [9, 8], [9, 9]],
  [[3, 4], [10, 4], [3, 8], [10, 8]].concat(farO(8)), P(7, 7), false,
  { known: 'open-three detection never checks whether the straight-four completion point is itself forbidden (src/engine.js:71-91 table, 308-310)' });
forbidCase('stone just outside the 9-cell window: X . . X X [p] . O is not a three (false double-three)',
  [[7, 2], [7, 5], [7, 6], [8, 8], [9, 9]], [[7, 9]].concat(farO(5)), P(7, 7), false,
  { known: 'shape keys only cover offsets -4..+4; filling c3 would make six with the c2 stone, the table counts it as five (src/engine.js:50-58, 94-97, 109)' });

test('renju/isForbidden matches the reference on random positions (no five on board)', () => {
  const rnd = rng(SEED + 5);
  const cats = {}, ex = {};
  let total = 0, bad = 0, positions = 0;
  for (let t = 0; t < (QUICK ? 80 : 300); t++) {
    const b = new Uint8Array(N); const ns = 10 + Math.floor(rnd() * 40);
    for (let i = 0; i < ns; i++) { const p = id(3 + Math.floor(rnd() * 9), 3 + Math.floor(rnd() * 9)); b[p] = rnd() < 0.55 ? BLACK : WHITE; }
    if (!noFiveOnBoard(b)) continue;
    positions++;
    const e = newEngine(b, 'renju', 4);
    for (let p = 0; p < N; p++) {
      if (b[p]) continue; total++;
      const why = []; const ref = refForbidden(b, p, why); const got = e.isForbidden(p);
      if (ref !== got) { bad++; const k = got ? 'engine=forbidden, reference=legal' : 'engine=legal, reference=' + why[0]; cats[k] = (cats[k] || 0) + 1; if (!ex[k]) ex[k] = '   cell ' + name(p) + '\n' + show(b, p); }
    }
  }
  if (bad) fail(`${bad} of ${total} empty cells in ${positions} positions disagree: ${JSON.stringify(cats)}\n` + Object.keys(ex).map(k => k + ':\n' + ex[k]).join('\n'));
}, { known: 'aggregate of the isForbidden bugs above (fake threes, same-line double four)' });

test('renju/white overline wins: OO_OOO gap is a win for white (think + hasWon)', () => {
  const b = stonesBoard([[3, 3], [3, 5], [10, 10], [11, 2], [2, 12]], [[7, 4], [7, 5], [7, 7], [7, 8], [7, 9]]);
  const r = think(b, WHITE, 'renju', 500);
  if (r.move !== P(7, 6)) fail('white did not play the overline win\n' + describe(b, WHITE, 'renju', r));
  const e = newEngine(b, 'renju', 4); e.play(P(7, 6), WHITE);
  if (!e.hasWon(WHITE)) fail('hasWon(WHITE) false for a white overline in renju');
});
test('renju/black overline is not a win; freestyle overline is', () => {
  const b = stonesBoard([[7, 4], [7, 5], [7, 6], [7, 7], [7, 8], [7, 9]], [[3, 3], [3, 5], [10, 10], [11, 2], [2, 12]]);
  if (newEngine(b, 'renju', 4).hasWon(BLACK)) fail('renju: six black in a row reported as a win');
  if (!newEngine(b, 'freestyle', 4).hasWon(BLACK)) fail('freestyle: six black in a row not reported as a win');
  if (!newEngine(stonesBoard([[7, 4], [7, 5], [7, 6], [7, 7], [7, 8]], [[3, 3]]), 'renju', 4).hasWon(BLACK)) fail('renju: exact five not a win');
});
test('renju/black prefers the exact five over the overline gap; never plays XX_XXX gap', () => {
  const b = stonesBoard([[7, 3], [7, 4], [7, 5], [7, 6], [7, 8]], farO(5)); // c7 -> six, c2 -> exactly five
  const r = think(b, BLACK, 'renju', 500);
  if (r.move !== P(7, 2)) fail('expected the exact five r7c2\n' + describe(b, BLACK, 'renju', r));
  const b2 = stonesBoard([[7, 4], [7, 5], [7, 7], [7, 8], [7, 9]], farO(5));
  const r2 = think(b2, BLACK, 'renju', 500);
  if (r2.move === P(7, 6)) fail('black played the overline (forbidden) point\n' + describe(b2, BLACK, 'renju', r2));
  assertValidMove(b2, BLACK, 'renju', r2);
  const rf = think(b2, BLACK, 'freestyle', 500);
  if (rf.move !== P(7, 6)) fail('freestyle: expected the overline win at r7c6\n' + describe(b2, BLACK, 'freestyle', rf));
});
test('renju/black facing a white four whose only block is forbidden returns a legal move', () => {
  // White four r7c3..c6 (black cap at c2), only five point r7c7, which is a double-three point for black.
  const b = stonesBoard([[7, 2], [8, 7], [9, 7], [8, 8], [9, 9], [12, 1]], [[7, 3], [7, 4], [7, 5], [7, 6], [1, 1], [1, 13]]);
  const ub = Uint8Array.from(b);
  const fp = fivePoints(ub, WHITE, 'renju');
  if (fp.length !== 1 || fp[0] !== P(7, 7) || !refForbidden(ub, P(7, 7))) throw new Error('bad setup');
  assertValidMove(b, BLACK, 'renju', think(b, BLACK, 'renju', 500));
}, { known: "think() 'block-four' falls back to the forbidden five point when no legal block exists (src/engine.js:581)" });
test('renju/black does not play a same-line double-four point (X_XXX_X) as an "open four"', () => {
  // r7: X . X . X . X at c3,c5,c7,c9 -> r7c6 makes X_XXX_X (two fours in one line = forbidden double-four).
  const b = stonesBoard([[7, 3], [7, 5], [7, 7], [7, 9]], [[6, 4], [8, 6], [6, 8], [2, 2], [12, 12]]);
  const ub = Uint8Array.from(b);
  if (!refForbidden(ub, P(7, 6))) throw new Error('bad setup');
  assertValidMove(b, BLACK, 'renju', think(b, BLACK, 'renju', 500));
}, { known: "same-line double four is classified CAT_WIN2 (open four) so think() returns it with reason 'open-four' (src/engine.js:75, 241-247, 584)" });
// Position with a black four-three at p=r7c7 that the engine wrongly treats as a forbidden double-three:
//   Row r7:  X X . . X X [p] . O   (c1, c2, c5, c6 black; c9 white). With p this is NOT a three: c8 gives one
//            five point only (c4); c4 needs c3 for a straight four, which makes an overline with c1-c2.
//            The engine's 9-cell window (c3..c11) cannot see c2/c1, so it scores the row as an open three.
//   Column c7: r4..r6 black, r3 white -> p makes a four.   Diagonal r8c8, r9c9 black -> p makes a real open three.
//   White: r3c11, r4c10, r5c9 on the anti-diagonal whose five point (after r6c8) is p (black cap r2c12).
const FAKE3_X = [[7, 1], [7, 2], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7], [8, 8], [9, 9], [2, 12]];
const FAKE3_O = [[7, 9], [3, 7], [3, 11], [4, 10], [5, 9], [1, 1], [13, 1], [13, 13], [12, 7], [2, 4]];
test('renju/white must stop the black four-three that the engine thinks is a forbidden double-three (playout)', () => {
  const b = stonesBoard(FAKE3_X, FAKE3_O), ub = Uint8Array.from(b), p = P(7, 7);
  if (refForbidden(ub, p) || !vcfMoveWins(ub, BLACK, p, 'renju', 4)) throw new Error('setup: r7c7 is not a legal black win');
  if (minVcf(ub, WHITE, 'renju', 9) !== 0) throw new Error('setup: white has a real VCF');
  if (killSetExists(b, WHITE, 'renju', 7) < 0) throw new Error('setup: no defence exists');
  const e = newEngine(b, 'renju', 4);
  const res = defencePlayout(b, WHITE, 'renju', 1000, 8);
  if (res) fail(`engine.isForbidden(r7c7)=${e.isForbidden(p)} (reference: legal four-three)\n` + res);
}, { known: 'shape window (-4..+4) misses the black stone at offset -5 -> fake open three -> r7c7 judged a forbidden double-three, so white ignores the threat (src/engine.js:50-58, 71-91, 243-246, 308-310)' });
test('renju/engine VCF claims for white are real (block point wrongly judged forbidden for black)', () => {
  const b = stonesBoard(FAKE3_X, FAKE3_O), ub = Uint8Array.from(b);
  const r = think(b, WHITE, 'renju', 1000);
  if ((r.reason === 'vcf' || r.score >= WIN_THRESHOLD) && !vcfMoveWins(ub, WHITE, r.move, 'renju', 12, { n: 2000000 }))
    fail(`engine claims a forced win (reason=${r.reason}, score=${r.score}) but black can legally block; reference finds no white VCF\n` + describe(b, WHITE, 'renju', r));
}, { known: 'vcf() treats a black block on a falsely-forbidden point as impossible (src/engine.js:441 via legal/isForbidden)' });
test('renju/engine never returns a forbidden point for black (random and self-play positions)', () => {
  const rnd = rng(SEED + 21);
  const errs = []; let n = 0;
  for (let t = 0; t < (QUICK ? 20 : 70); t++) {
    const e = new Engine({ rule: 'renju', ttBits: 16 });
    let c = BLACK;
    const len = 8 + Math.floor(rnd() * 50);
    for (let i = 0; i < len; i++) {
      let p = (i < 6 || rnd() < 0.6) ? randomNearMove(e, rnd) : e.think(c, { timeMs: 30, maxDepth: 3 }).move;
      if (p < 0 || e.board[p]) p = randomNearMove(e, rnd);
      if (p < 0) break;
      if (c === BLACK && refForbidden(e.board, p)) continue;
      e.play(p, c); c = 3 - c;
      if (e.hasWon(BLACK) || e.hasWon(WHITE)) break;
    }
    if (e.hasWon(BLACK) || e.hasWon(WHITE)) continue;
    const b = Array.from(e.board), ub = Uint8Array.from(b);
    const wf = fivePoints(ub, WHITE, 'renju');
    if (wf.length && wf.every(q => refForbidden(ub, q))) continue; // no legal block at all: dedicated test above
    const r = think(b, BLACK, 'renju', 120);
    n++;
    if (r.move < 0 || b[r.move] || refForbidden(ub, r.move)) {
      const why = []; if (r.move >= 0) refForbidden(ub, r.move, why);
      errs.push(`position ${t}: ${name(r.move)} ${why.join(',')} engine.isForbidden=${r.move >= 0 && newEngine(b, 'renju', 4).isForbidden(r.move)}\n` + describe(b, BLACK, 'renju', r));
    }
  }
  if (errs.length) fail(`${errs.length}/${n} positions\n` + errs.slice(0, 3).join('\n'));
});

// ===================================================================== (4) think() robustness and timing
for (const rule of RULES) for (const c of COLORS) {
  test(`think/${rule}/${cname(c)}: empty board -> centre`, () => {
    const r = think(new Array(N).fill(0), c, rule, 300);
    if (r.move !== P(7, 7)) fail('expected centre r7c7, got ' + name(r.move));
  });
}
for (const rule of RULES) {
  test(`think/${rule}: never returns an occupied or out-of-range cell (random positions, both colours)`, () => {
    const rnd = rng(SEED + 31 + (rule === 'renju' ? 1 : 0));
    const errs = [];
    for (let t = 0; t < (QUICK ? 15 : 50); t++) {
      const b = new Uint8Array(N);
      const ns = 1 + Math.floor(rnd() * 70);
      for (let i = 0; i < ns; i++) b[Math.floor(rnd() * N)] = i % 2 ? WHITE : BLACK;
      if (!noFiveOnBoard(b)) continue;
      const c = rnd() < 0.5 ? BLACK : WHITE;
      if (rule === 'renju' && c === BLACK) { const fp = fivePoints(b, WHITE, rule); if (fp.length && fp.every(q => refForbidden(b, q))) continue; }
      const r = think(Array.from(b), c, rule, 80);
      try { assertValidMove(Array.from(b), c, rule, r); } catch (e) { errs.push(e.message); }
    }
    if (errs.length) fail(errs.slice(0, 3).join('\n'));
  });
  test(`think/${rule}: nearly full board (1-3 empty cells) and completely full board`, () => {
    const rnd = rng(SEED + 41);
    const errs = [];
    let built = 0;
    // Five-free full board: colour by (r + 2c) mod 4 < 2 gives runs of at most 2 in every direction.
    const pattern = p => (((p / SIZE) | 0) + 2 * (p % SIZE)) % 4 < 2 ? BLACK : WHITE;
    for (let t = 0; t < 12; t++) {
      const b = new Uint8Array(N).map((_, p) => pattern(p));
      const k = 1 + (t % 3), empties = [];
      while (empties.length < k) { const p = Math.floor(rnd() * N); if (b[p]) { b[p] = 0; empties.push(p); } }
      built++;
      for (const c of COLORS) {
        if (rule === 'renju' && c === BLACK && empties.every(p => refForbidden(b, p))) continue;
        let r;
        try { r = think(Array.from(b), c, rule, 200); } catch (e) { errs.push('exception ' + e.stack); continue; }
        if (empties.indexOf(r.move) < 0) errs.push(`expected one of ${empties.map(name)}, got ${name(r.move)}\n` + show(b));
        else try { assertValidMove(Array.from(b), c, rule, r); } catch (e) { errs.push(e.message); }
      }
    }
    if (built < 4) throw new Error('could only build ' + built + ' nearly-full boards');
    const full = new Array(N).fill(0).map((_, p) => pattern(p));
    try { const r = think(full, BLACK, rule, 200); if (r.move !== -1) errs.push('full board: expected move -1, got ' + r.move); }
    catch (e) { errs.push('full board: exception ' + e.message); }
    if (errs.length) fail(errs.slice(0, 5).join('\n'));
  });
}

/** Midgame positions from engine self-play with randomised openings (no immediate tactics). */
function midgamePositions(rule, count, seed) {
  const rnd = rng(seed), out = [];
  let guard = 0;
  while (out.length < count && guard++ < 50) {
    const e = new Engine({ rule, ttBits: 16 });
    let c = BLACK;
    for (let i = 0; i < 4; i++) { const p = id(5 + Math.floor(rnd() * 5), 5 + Math.floor(rnd() * 5)); if (!e.board[p] && !(c === BLACK && rule === 'renju' && e.isForbidden(p))) { e.play(p, c); c = 3 - c; } }
    let ok = true;
    for (let i = 0; i < 8 + Math.floor(rnd() * 8) && ok; i++) {
      const r = e.think(c, { timeMs: 40, maxDepth: 4 });
      if (r.move < 0) { ok = false; break; }
      e.play(r.move, c); c = 3 - c;
      if (e.hasWon(1) || e.hasWon(2)) ok = false;
    }
    if (!ok) continue;
    const probe = e.think(c, { timeMs: 300 });
    if (probe.reason !== 'search' || Math.abs(probe.score) >= WIN_THRESHOLD) continue; // undecided positions only
    out.push({ board: Array.from(e.board), toMove: c });
  }
  return out;
}
const TIMING = [];
const slack = ms => Math.max(150, ms * 0.15);
for (const rule of RULES) {
  test(`think/${rule}: respects timeMs (300/1500/3000ms on midgame positions; slack max(150ms, 15%))`, () => {
    const positions = midgamePositions(rule, QUICK ? 1 : 2, SEED + (rule === 'renju' ? 51 : 52));
    if (!positions.length) throw new Error('could not build midgame positions');
    const errs = [];
    positions.forEach((pos, pi) => {
      for (const ms of [300, 1500, 3000]) {
        const r = think(pos.board, pos.toMove, rule, ms);
        TIMING.push(`${rule} midgame#${pi} (${cname(pos.toMove)} to move) requested=${ms}ms wall=${r.wall}ms reported=${r.timeMs}ms depth=${r.depth} nodes=${r.nodes} score=${r.score} reason=${r.reason}`);
        if (r.wall > ms + slack(ms)) errs.push(`requested ${ms}ms, took ${r.wall}ms\n` + show(pos.board));
        assertValidMove(pos.board, pos.toMove, rule, r);
      }
    });
    if (errs.length) fail(errs.join('\n'));
  });
}
test('think: respects timeMs=300 on tactical positions (both sides have four-making cells; VCF pre-searches)', () => {
  const errs = [];
  for (const pz of RANDOM_VCF) {
    const b = rowsToBoard(pz.rows), D = 3 - pz.attacker;
    const r = think(b, D, pz.rule, 300);
    TIMING.push(`tactical ${pz.rule} ${cname(D)} to move requested=300ms wall=${r.wall}ms reported=${r.timeMs}ms reason=${r.reason}`);
    if (r.wall > 300 + slack(300)) errs.push(`requested 300ms, took ${r.wall}ms (${pz.rule}, ${cname(D)} to move)\n` + show(b));
  }
  if (errs.length) fail(errs.join('\n'));
});

// ===================================================================== runner
module.exports = { ladderPuzzle, runLen, makesFive, fivePoints, fourMoves, winThreatMoves, refForbidden, refVcf, vcfMoveWins, minVcf, refLegal, name, id, tests };
if (require.main === module) main();
function main() {
  const filter = process.argv[2] || '';
  let pass = 0, failed = 0, knownFail = 0, errors = 0, unexpectedPass = 0;
  const t0 = Date.now();
  for (const t of tests) {
    if (filter && t.name.indexOf(filter) < 0) continue;
    const ts = Date.now();
    let status, detail = '';
    try {
      const note = t.fn();
      status = 'PASS'; if (typeof note === 'string') detail = note;
      if (t.known) { unexpectedPass++; detail = (detail ? detail + '; ' : '') + 'NOTE: marked as a known engine bug but passed'; }
      pass++;
    } catch (e) {
      if (e.isFail) { status = t.known ? 'FAIL (KNOWN ENGINE BUG)' : 'FAIL'; if (t.known) knownFail++; else failed++; detail = e.message; }
      else { status = 'ERROR (test setup)'; errors++; detail = e.stack || String(e); }
    }
    console.log(`${status}  ${t.name}  [${Date.now() - ts}ms]` + (t.known && status !== 'PASS' ? '\n      known: ' + t.known : ''));
    if (detail) console.log(detail.split('\n').map(l => '      ' + l).join('\n'));
  }
  if (TIMING.length) { console.log('\nTiming report:'); for (const l of TIMING) console.log('  ' + l); }
  console.log(`\n${pass} passed, ${failed} failed, ${knownFail} failed (known engine bugs), ${errors} test-setup errors, ${unexpectedPass} known-bug tests passed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed || knownFail || errors ? 1 : 0);
}

