'use strict';
/*
 * Independent baseline gomoku player (does NOT use src/engine.js code).
 * Classic pattern scoring: every empty cell near stones is scored by the line
 * shapes it creates for itself (attack) and for the opponent (defence), plus a
 * 2-ply threat check: take a win in 1, block the opponent's five, block open-four
 * threats, and reject moves after which the opponent wins immediately.
 *
 * Board: flat array of 225 (0 empty, 1 black, 2 white).
 * opts.rule: 'freestyle' | 'renju'; opts.isForbidden(p, board) optional oracle
 * used to keep black off forbidden points in renju.
 */
const SIZE = 15, N = 225;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Shape ids
const FIVE = 7, OPEN4 = 6, FOUR = 5, OPEN3 = 4, THREE = 3, OPEN2 = 2, TWO = 1, NONE = 0;

// line: array of 11 values for offsets -5..+5 around p (p itself = own stone)
// values: 1 own, 2 blocked (opponent or edge), 0 empty
function runLen(line, i) {
  let l = i, r = i;
  while (l > 0 && line[l - 1] === 1) l--;
  while (r < 10 && line[r + 1] === 1) r++;
  return [l, r];
}
function isFiveAt(line, exact) {
  const [l, r] = runLen(line, 5);
  const len = r - l + 1;
  return exact ? len === 5 : len >= 5;
}
// empty cells that would complete a five containing the centre
function completions(line, exact) {
  const out = [];
  for (let i = 1; i <= 9; i++) {
    if (line[i] !== 0) continue;
    line[i] = 1;
    const [l, r] = runLen(line, i);
    const len = r - l + 1;
    const ok = (exact ? len === 5 : len >= 5) && l <= 5 && r >= 5;
    line[i] = 0;
    if (ok) out.push(i);
  }
  return out;
}
function lineShape(line, exact) {
  if (isFiveAt(line, exact)) return FIVE;
  const c = completions(line, exact);
  if (c.length >= 2) return OPEN4;
  if (c.length === 1) return FOUR;
  let best = NONE;
  for (let i = 1; i <= 9; i++) {
    if (line[i] !== 0) continue;
    line[i] = 1;
    let s = NONE;
    if (!isFiveAt(line, exact)) {
      const c2 = completions(line, exact);
      if (c2.length >= 2) s = OPEN3; else if (c2.length === 1) s = THREE;
    }
    line[i] = 0;
    if (s > best) best = s;
  }
  if (best !== NONE) return best;
  let bestTwo = NONE;
  for (let st = 1; st <= 5; st++) {
    let own = 0, blocked = false;
    for (let k = st; k < st + 5; k++) { if (line[k] === 2) blocked = true; else if (line[k] === 1) own++; }
    if (blocked || own < 2) continue;
    const open = line[st - 1] === 0 && line[st + 5] === 0;
    const s = open ? OPEN2 : TWO;
    if (s > bestTwo) bestTwo = s;
  }
  return bestTwo;
}

function getLine(board, p, d, color) {
  const r0 = (p / SIZE) | 0, c0 = p % SIZE, dr = DIRS[d][0], dc = DIRS[d][1];
  const line = new Array(11);
  for (let k = -5; k <= 5; k++) {
    const r = r0 + dr * k, c = c0 + dc * k;
    let v;
    if (k === 0) v = 1;
    else if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) v = 2;
    else { const b = board[r * SIZE + c]; v = b === 0 ? 0 : (b === color ? 1 : 2); }
    line[k + 5] = v;
  }
  return line;
}

function cellShapes(board, p, color, rule) {
  const exact = rule === 'renju' && color === 1;
  const s = [];
  for (let d = 0; d < 4; d++) s.push(lineShape(getLine(board, p, d, color), exact));
  return s;
}

const VAL = [0, 10, 60, 120, 1200, 2000, 100000, 10000000];
function cellValue(shapes) {
  let v = 0, fours = 0, open3 = 0, five = false, open4 = false;
  for (const s of shapes) {
    v += VAL[s];
    if (s === FIVE) five = true;
    if (s === OPEN4) { open4 = true; fours++; }
    if (s === FOUR) fours++;
    if (s === OPEN3) open3++;
  }
  if (five) return { v: 10000000, cls: 5 };
  if (open4 || fours >= 2) return { v: v + 100000, cls: 4 };
  if (fours >= 1 && open3 >= 1) return { v: v + 50000, cls: 3 };
  if (open3 >= 2) return { v: v + 10000, cls: 2 };
  if (fours >= 1) return { v, cls: 1.5 };
  if (open3 >= 1) return { v, cls: 1 };
  return { v, cls: 0 };
}

function hasNeighbour(board, p, dist) {
  const r0 = (p / SIZE) | 0, c0 = p % SIZE;
  for (let dr = -dist; dr <= dist; dr++) for (let dc = -dist; dc <= dist; dc++) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
    if (board[r * SIZE + c]) return true;
  }
  return false;
}

function candidates(board) {
  const out = [];
  for (let p = 0; p < N; p++) if (!board[p] && hasNeighbour(board, p, 2)) out.push(p);
  return out;
}

function analyse(board, color, rule, isForbidden) {
  const opp = 3 - color;
  const list = [];
  for (const p of candidates(board)) {
    if (rule === 'renju' && color === 1 && isForbidden && isForbidden(p, board)) continue;
    const me = cellValue(cellShapes(board, p, color, rule));
    let op = cellValue(cellShapes(board, p, opp, rule));
    if (rule === 'renju' && opp === 1 && isForbidden && op.cls < 5 && isForbidden(p, board)) op = { v: 0, cls: 0 };
    const r = (p / SIZE) | 0, c = p % SIZE;
    const centre = 7 - Math.max(Math.abs(r - 7), Math.abs(c - 7));
    list.push({ p, me, op, score: me.v * 1.1 + op.v + centre * 0.01 });
  }
  return list;
}

function opponentFiveNext(board, color, rule, isForbidden) {
  const opp = 3 - color;
  for (const p of candidates(board)) {
    if (rule === 'renju' && opp === 1 && isForbidden && isForbidden(p, board)) continue;
    if (cellShapes(board, p, opp, rule).includes(FIVE)) return true;
  }
  return false;
}

function chooseMove(board, color, opts) {
  opts = opts || {};
  const rule = opts.rule || 'freestyle';
  const isForbidden = opts.isForbidden;
  board = Array.from(board);
  if (board.every(v => v === 0)) return 7 * SIZE + 7;
  const list = analyse(board, color, rule, isForbidden);
  if (!list.length) { for (let p = 0; p < N; p++) if (!board[p]) return p; return -1; }
  // 1. win in one
  const win = list.find(x => x.me.cls === 5);
  if (win) return win.p;
  // 2. block opponent five
  const block = list.filter(x => x.op.cls === 5);
  if (block.length) { block.sort((a, b) => b.me.v - a.me.v); return block[0].p; }
  // 3. own open four / double four
  const w2 = list.filter(x => x.me.cls === 4);
  if (w2.length) { w2.sort((a, b) => b.me.v - a.me.v); return w2[0].p; }
  list.sort((a, b) => b.score - a.score);
  // 4. opponent threatens an open four: block it (or make a four of our own)
  if (list.some(x => x.op.cls >= 4)) {
    const defs = list.filter(x => x.op.cls >= 1.5 || x.me.cls >= 1.5);
    let best = null, bestScore = -Infinity;
    for (const x of defs) {
      board[x.p] = color;
      let still = false;
      if (x.me.cls < 1.5) {
        for (const q of candidates(board)) {
          if (rule === 'renju' && color === 2 && isForbidden && isForbidden(q, board)) continue;
          if (cellValue(cellShapes(board, q, 3 - color, rule)).cls >= 4) { still = true; break; }
        }
      }
      board[x.p] = 0;
      const sc = x.score + (still ? -1e7 : 0);
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
    if (best) return best.p;
  }
  // 5. 2-ply sanity: avoid moves after which the opponent has a five
  for (const x of list.slice(0, 8)) {
    board[x.p] = color;
    const bad = opponentFiveNext(board, color, rule, isForbidden);
    board[x.p] = 0;
    if (!bad) return x.p;
  }
  return list[0].p;
}

module.exports = { chooseMove, cellShapes, cellValue, SHAPES: { FIVE, OPEN4, FOUR, OPEN3, THREE, OPEN2, TWO, NONE } };
