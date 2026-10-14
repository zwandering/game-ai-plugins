'use strict';
/*
 * Engine (src/engine.js) vs independent baseline (test/baseline.js).
 *
 *   node test/match.js --rule freestyle --games 30 [--start 0] [--time 300] [--seed 1000] [--json out.json]
 *   node test/match.js --analyse out.json [--game i] [--deep 2000]
 *
 * Each game: two random opening stones near the centre (black, then white)
 * from a seeded PRNG (seed = baseSeed + gameIndex), then the side to move is
 * black. Engine is black in even games, white in odd games.
 * Rules are checked independently here (win detection + renju forbidden
 * detection); a separate Engine instance is used only as a renju oracle for
 * the baseline's legality and for cross-checking.
 */
const createGomokuEngine = require('../src/engine.js');
const baseline = require('./baseline.js');
const G = createGomokuEngine();
const { Engine } = G;
const SIZE = 15, N = 225;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const coord = p => p < 0 ? '--' : String.fromCharCode(65 + p % SIZE) + ((p / SIZE) | 0);

function runThrough(board, p, d, c) {
  const r0 = (p / SIZE) | 0, c0 = p % SIZE, dr = DIRS[d][0], dc = DIRS[d][1];
  let n = 1;
  for (const s of [1, -1]) {
    let r = r0 + dr * s, cc = c0 + dc * s;
    while (r >= 0 && r < SIZE && cc >= 0 && cc < SIZE && board[r * SIZE + cc] === c) { n++; r += dr * s; cc += dc * s; }
  }
  return n;
}
// independent win check for the stone just played at p
function winsAt(board, p, c, rule) {
  for (let d = 0; d < 4; d++) {
    const len = runThrough(board, p, d, c);
    if (rule === 'renju' && c === 1 ? len === 5 : len >= 5) return true;
  }
  return false;
}

// Independent renju forbidden check (black to play at empty p). Simplified
// (no recursive "false three" analysis), standard RIF fours/threes otherwise.
function fiveIfPlaced(board, q) { // exactly five for black through q
  board[q] = 1;
  let ok = false;
  for (let d = 0; d < 4; d++) if (runThrough(board, q, d, 1) === 5) ok = true;
  board[q] = 0;
  return ok;
}
function lineCells(p, d) {
  const r0 = (p / SIZE) | 0, c0 = p % SIZE, dr = DIRS[d][0], dc = DIRS[d][1];
  const out = [];
  for (let k = -5; k <= 5; k++) {
    const r = r0 + dr * k, c = c0 + dc * k;
    out.push(r < 0 || r >= SIZE || c < 0 || c >= SIZE ? -1 : r * SIZE + c);
  }
  return out;
}
function foursInDir(board, p, d) { // board[p] already 1
  const cells = lineCells(p, d);
  const comp = [];
  for (let k = 0; k < 11; k++) {
    const q = cells[k];
    if (q < 0 || board[q] !== 0) continue;
    board[q] = 1;
    const len = runThrough(board, q, d, 1);
    // five must contain p
    let contains = false;
    if (len === 5) {
      const lo = Math.min(k, 5), hi = Math.max(k, 5);
      contains = true;
      for (let j = lo; j <= hi; j++) if (board[cells[j]] !== 1) contains = false;
    }
    board[q] = 0;
    if (contains) comp.push(k);
  }
  if (comp.length === 2 && comp[1] - comp[0] === 5) return 1; // straight (open) four
  return comp.length;
}
function openThreeInDir(board, p, d) { // board[p] = 1; can one more stone make a straight four?
  const cells = lineCells(p, d);
  for (let k = 1; k < 10; k++) {
    const q = cells[k];
    if (q < 0 || board[q] !== 0) continue;
    board[q] = 1;
    // straight four containing p and q: 4 contiguous with both ends making exact five
    let straight = false;
    const len = runThrough(board, q, d, 1);
    if (len === 4) {
      const comp = [];
      for (let j = 0; j < 11; j++) {
        const x = cells[j];
        if (x < 0 || board[x] !== 0) continue;
        board[x] = 1;
        if (runThrough(board, x, d, 1) === 5) {
          // contains p?
          const lo = Math.min(j, 5), hi = Math.max(j, 5);
          let c = true; for (let t = lo; t <= hi; t++) if (board[cells[t]] !== 1) c = false;
          if (c) comp.push(j);
        }
        board[x] = 0;
      }
      if (comp.length === 2 && comp[1] - comp[0] === 5 && !isForbiddenInd(board, q, 1)) straight = true;
    }
    board[q] = 0;
    if (straight) return true;
  }
  return false;
}
function isForbiddenInd(board, p, depth) {
  depth = depth || 0;
  if (board[p] !== 0) return false;
  board[p] = 1;
  let five = false, over = false, fours = 0, threes = 0;
  for (let d = 0; d < 4; d++) {
    const len = runThrough(board, p, d, 1);
    if (len === 5) five = true; else if (len > 5) over = true;
  }
  if (!five && !over) {
    for (let d = 0; d < 4; d++) {
      const f = foursInDir(board, p, d);
      fours += f;
      if (!f && depth < 1 && openThreeInDir(board, p, d)) threes++;
    }
  }
  board[p] = 0;
  if (five) return false;
  if (over) return true;
  return fours >= 2 || (depth < 1 && threes >= 2);
}

function boardText(board, mark) {
  let s = '   ' + Array.from({ length: SIZE }, (_, i) => String.fromCharCode(65 + i)).join(' ') + '\n';
  for (let r = 0; r < SIZE; r++) {
    s += String(r).padStart(2) + ' ';
    for (let c = 0; c < SIZE; c++) {
      const p = r * SIZE + c, v = board[p];
      let ch = v === 1 ? 'X' : v === 2 ? 'O' : '.';
      if (mark && mark[p]) ch = mark[p];
      s += ch + ' ';
    }
    s += '\n';
  }
  return s;
}

// --opp engine:<ms> replaces the baseline by a second engine instance with a longer think time (to expose horizon blunders)
const OPP_MS = (() => { const o = arg("opp", "baseline"); return o.startsWith("engine:") ? +o.slice(7) : 0; })();
let oppEngine = null;
function playGame(gi, rule, timeMs, baseSeed, engine, oracle) {
  if (OPP_MS > 0 && (!oppEngine || oppEngine.rule !== rule)) oppEngine = new Engine({ rule });
  const seed = baseSeed + gi;
  const rnd = mulberry32(seed);
  const engineColor = gi % 2 === 0 ? 1 : 2;
  const board = new Array(N).fill(0);
  const moves = [];
  // opening: black within 1 of centre, white within 2 of black stone
  const pick = (cr, cc, rad) => {
    for (;;) {
      const r = cr + Math.floor(rnd() * (2 * rad + 1)) - rad, c = cc + Math.floor(rnd() * (2 * rad + 1)) - rad;
      const p = r * SIZE + c;
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && !board[p]) return p;
    }
  };
  const b0 = pick(7, 7, 1); board[b0] = 1; moves.push({ p: b0, c: 1, who: 'open' });
  const w0 = pick((b0 / SIZE) | 0, b0 % SIZE, 2); board[w0] = 2; moves.push({ p: w0, c: 2, who: 'open' });
  let color = 1, result = null, engTimes = [], violations = [];
  const isForbOracle = (p, b) => { oracle.setBoard(b); return oracle.isForbidden(p); };
  while (!result) {
    if (moves.length >= N) { result = { winner: 0, why: 'board-full' }; break; }
    let p, info = null;
    if (color === engineColor) {
      engine.setBoard(board);
      const r = engine.think(color, { timeMs });
      p = r.move; info = { score: r.score, depth: r.depth, reason: r.reason, timeMs: r.timeMs, nodes: r.nodes };
      engTimes.push(r.timeMs);
    } else {
      if (OPP_MS > 0) { oppEngine.setBoard(board); p = oppEngine.think(color, { timeMs: OPP_MS }).move; }
      else p = baseline.chooseMove(board, color, { rule, isForbidden: rule === "renju" ? isForbOracle : null });
    }
    if (p < 0 || p >= N || board[p]) { result = { winner: 3 - color, why: 'illegal-occupied ' + coord(p) + ' by ' + (color === engineColor ? 'engine' : 'baseline') }; break; }
    if (rule === 'renju' && color === 1) {
      oracle.setBoard(board);
      const fo = oracle.isForbidden(p), fi = isForbiddenInd(board, p);
      if (fo || fi) {
        violations.push({ ply: moves.length, p: coord(p), oracle: fo, independent: fi, by: color === engineColor ? 'engine' : 'baseline' });
        if (fo && fi) { board[p] = 1; moves.push({ p, c: color, who: color === engineColor ? 'engine' : 'baseline', info }); result = { winner: 2, why: 'forbidden ' + coord(p) + ' by ' + (color === engineColor ? 'engine' : 'baseline') }; break; }
      }
    }
    board[p] = color;
    moves.push({ p, c: color, who: color === engineColor ? 'engine' : 'baseline', info });
    if (winsAt(board, p, color, rule)) { result = { winner: color, why: 'five' }; break; }
    color = 3 - color;
  }
  return { gi, seed, rule, engineColor, result, engineWon: result.winner === engineColor, draw: result.winner === 0,
    plies: moves.length, moves: moves.map(m => ({ p: m.p, c: m.c, who: m.who, info: m.info })), engTimes, violations };
}

function summarise(games) {
  const by = { 1: { w: 0, l: 0, d: 0 }, 2: { w: 0, l: 0, d: 0 } };
  let tsum = 0, tn = 0, tmax = 0, over = 0;
  for (const g of games) {
    const s = by[g.engineColor];
    if (g.draw) s.d++; else if (g.engineWon) s.w++; else s.l++;
    for (const t of g.engTimes) { tsum += t; tn++; tmax = Math.max(tmax, t); if (t > 330) over++; }
  }
  return { engineAsBlack: by[1], engineAsWhite: by[2], avgThinkMs: +(tsum / Math.max(1, tn)).toFixed(1), maxThinkMs: tmax, movesOver110pct: over, engineMoves: tn };
}

function mainPlay() {
  const rule = arg('rule', 'freestyle');
  const games = +arg('games', 30), start = +arg('start', 0), timeMs = +arg('time', 300), baseSeed = +arg('seed', 1000);
  const engine = new Engine({ rule }), oracle = new Engine({ rule });
  const out = [];
  for (let gi = start; gi < start + games; gi++) {
    const g = playGame(gi, rule, timeMs, baseSeed, engine, oracle);
    out.push(g);
    const who = g.draw ? 'DRAW' : (g.engineWon ? 'engine' : 'BASELINE');
    console.log(`game ${gi} seed ${g.seed} ${rule} engine=${g.engineColor === 1 ? 'black' : 'white'} winner=${who} (${g.result.why}) plies=${g.plies}` +
      (g.violations.length ? ' VIOLATIONS ' + JSON.stringify(g.violations) : ''));
  }
  console.log('SUMMARY', JSON.stringify(summarise(out)));
  const jf = arg('json', null);
  if (jf) require('fs').writeFileSync(jf, JSON.stringify(out));
}

// ---------------------------------------------------------------- analysis
function boardAt(g, ply) { const b = new Array(N).fill(0); for (let i = 0; i < ply; i++) b[g.moves[i].p] = g.moves[i].c; return b; }

function analyseGame(g, deepMs) {
  const rule = g.rule, ec = g.engineColor, oc = 3 - ec;
  const e = new Engine({ rule });
  const lines = [];
  lines.push(`=== game ${g.gi} seed ${g.seed} ${rule} engine=${ec === 1 ? 'black(X)' : 'white(O)'} result=${g.result.why} winner=${g.result.winner} plies=${g.plies}`);
  lines.push('moves: ' + g.moves.map((m, i) => `${i + 1}.${m.c === 1 ? 'X' : 'O'}${coord(m.p)}${m.who === 'engine' ? '*' : ''}`).join(' '));
  // walk engine moves; find first one after which the opponent has a VCF (forced win by fours)
  let firstBad = -1;
  for (let i = 0; i < g.moves.length; i++) {
    const m = g.moves[i];
    if (m.who !== 'engine') continue;
    const b = boardAt(g, i + 1);
    e.setBoard(b);
    const v = e.findVcf(oc, 200000, 40);
    // also immediate checks before the move
    const pre = boardAt(g, i);
    e.setBoard(pre);
    const ownFives = [];
    for (let p = 0; p < N; p++) { if (pre[p]) continue; pre[p] = ec; if (winsAt(pre, p, ec, rule)) ownFives.push(p); pre[p] = 0; }
    if (ownFives.length && !ownFives.includes(m.p)) lines.push(`  ply ${i + 1}: MISSED WIN-IN-1 at ${coord(ownFives[0])}, played ${coord(m.p)}`);
    const oppFives = [];
    for (let p = 0; p < N; p++) { if (pre[p]) continue; pre[p] = oc; if (winsAt(pre, p, oc, rule)) oppFives.push(p); pre[p] = 0; }
    if (oppFives.length === 1 && oppFives[0] !== m.p) {
      pre[m.p] = ec; const won = winsAt(pre, m.p, ec, rule); pre[m.p] = 0;
      if (!won) { lines.push(`  ply ${i + 1}: MISSED BLOCK of five at ${coord(oppFives[0])}, played ${coord(m.p)} (reason ${m.info && m.info.reason})`); }
    }
    if (v && firstBad < 0) {
      // was there a VCF already before this move (i.e. position already lost)?
      e.setBoard(boardAt(g, i));
      firstBad = i;
      lines.push(`  first engine move after which opponent has VCF: ply ${i + 1} ${coord(m.p)} (opp VCF ${v.plies} plies starting ${coord(v.move)}); engine info ${JSON.stringify(m.info)}`);
    }
  }
  // deep re-think on the last few engine moves before the loss
  const engIdx = g.moves.map((m, i) => m.who === 'engine' ? i : -1).filter(i => i >= 0);
  const tail = deepMs > 0 ? engIdx.slice(-6) : [];
  for (const i of tail) {
    const pre = boardAt(g, i);
    const e2 = new Engine({ rule });
    e2.setBoard(pre);
    const r = e2.think(ec, { timeMs: deepMs });
    const m = g.moves[i];
    // evaluate both choices: after the move, does opponent have a VCF?
    const vcfAfter = (mv) => { const b = pre.slice(); b[mv] = ec; e2.setBoard(b); const v = e2.findVcf(oc, 200000, 40); return v ? v.plies : 0; };
    const a = vcfAfter(m.p), bb = r.move >= 0 ? vcfAfter(r.move) : -1;
    lines.push(`  ply ${i + 1}: played ${coord(m.p)} (s=${m.info.score} d=${m.info.depth} ${m.info.reason}) oppVCFafter=${a} | deep ${deepMs}ms -> ${coord(r.move)} (s=${r.score} d=${r.depth} ${r.reason}) oppVCFafter=${bb}`);
  }
  if (firstBad >= 0) {
    lines.push('position before first bad engine move (ply ' + (firstBad + 1) + '), ' + (ec === 1 ? 'X' : 'O') + ' (engine) to move, engine played * :');
    const mark = {}; mark[g.moves[firstBad].p] = '*';
    lines.push(boardText(boardAt(g, firstBad), mark));
  }
  return lines.join('\n');
}

function mainAnalyse() {
  const games = JSON.parse(require('fs').readFileSync(arg('analyse'), 'utf8'));
  const deep = +arg('deep', 2000);
  const only = arg('game', null);
  for (const g of games) {
    if (only !== null && g.gi !== +only) continue;
    if (only === null && g.engineWon && !arg('all', null)) continue;
    console.log(analyseGame(g, deep));
  }
}

/*
 * Blunder finder: node test/match.js --blunders file.json --game i [--probe 1500] [--deep 3000]
 * Walks the losing engine's moves backwards; after each engine move asks a fresh
 * engine (opponent side, --probe ms) whether the opponent now has a proven win.
 * The earliest engine move after which the opponent is proven winning, while the
 * position before it was not proven lost, is the blunder. The position before it
 * is re-thought with --deep ms and the alternative is verified the same way.
 */
function mainBlunders() {
  const games = JSON.parse(require('fs').readFileSync(arg('blunders'), 'utf8'));
  const probe = +arg('probe', 1500), deep = +arg('deep', 3000);
  const g = games.find(x => x.gi === +arg('game'));
  const ec = g.engineColor, oc = 3 - ec, rule = g.rule;
  const T = G.WIN_THRESHOLD;
  const oppWinsAfter = (b) => { const e = new Engine({ rule }); e.setBoard(b); const r = e.think(oc, { timeMs: probe }); return r; };
  const eng = g.moves.map((m, i) => m.who === 'engine' ? i : -1).filter(i => i >= 0);
  let blunder = -1;
  if (arg('first-lost', null)) {
    // candidate = engine move just before the first engine move whose own 300ms score says "lost"
    const k = eng.findIndex(i => g.moves[i].info && g.moves[i].info.score <= -T);
    if (k > 0) blunder = eng[k - 1];
  } else for (let k = eng.length - 1; k >= 0; k--) {
    const i = eng[k];
    const r = oppWinsAfter(boardAt(g, i + 1));
    if (r.score >= T) blunder = i; else break;
  }
  console.log(`game ${g.gi} seed ${g.seed} ${rule} engine=${ec === 1 ? 'X' : 'O'} result=${g.result.why}`);
  if (blunder < 0) { console.log('  no proven-lost position found after engine moves (loss beyond probe horizon)'); return; }
  const m = g.moves[blunder];
  const pre = boardAt(g, blunder);
  const e = new Engine({ rule }); e.setBoard(pre);
  const before = e.think(ec, { timeMs: deep }); // engine side re-think
  let alt = null;
  if (before.move >= 0 && before.move !== m.p) { const b = pre.slice(); b[before.move] = ec; alt = oppWinsAfter(b); }
  const after = oppWinsAfter(boardAt(g, blunder + 1));
  console.log(`  blunder ply ${blunder + 1}: engine(${ec === 1 ? 'X' : 'O'}) played ${coord(m.p)} [300ms info ${JSON.stringify(m.info)}]`);
  console.log(`  after it opponent proves win: ${coord(after.move)} score ${after.score} reason ${after.reason} pv ${after.pv.map(coord).join(' ')}`);
  console.log(`  deep ${deep}ms engine re-think: ${coord(before.move)} score ${before.score} d${before.depth} ${before.reason}` +
    (alt ? ` -> opponent after alternative: score ${alt.score} (${alt.score >= T ? 'STILL LOST' : 'not proven lost'})` : ' (same move)'));
  const mark = {}; mark[m.p] = '*'; if (before.move >= 0 && before.move !== m.p) mark[before.move] = '+';
  console.log(`  position before ply ${blunder + 1}, ${ec === 1 ? 'X' : 'O'} to move (* = played, + = deep choice):`);
  console.log(boardText(pre, mark));
  console.log('  moves: ' + g.moves.slice(0, blunder + 1).map(x => coord(x.p)).join(' '));
}

module.exports = { isForbiddenInd, winsAt, boardText, coord, mulberry32 };
if (require.main === module) {
  if (arg('blunders', null)) mainBlunders(); else if (arg('analyse', null)) mainAnalyse(); else mainPlay();
}
