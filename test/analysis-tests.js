#!/usr/bin/env node
/* Tests for the analysis features: win-rate model, analyze(), principalLine(),
 * evalMove(), evalPosition(). Plain node, exits 1 on failure.
 *   node test/analysis-tests.js */
'use strict';
const G = require('../src/engine.js')();
const { Engine, BLACK, WHITE, SIZE, WIN_THRESHOLD } = G;
const N = SIZE * SIZE;

let passed = 0, failed = 0;
function test(name, fn) {
  const t = Date.now();
  try { fn(); passed++; console.log(`PASS  ${name}  [${Date.now() - t}ms]`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e && e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
const id = (r, c) => r * SIZE + c;
const name = p => String.fromCharCode(65 + p % SIZE) + ((p / SIZE) | 0);

/** Board from {X: [[r,c]...], O: [[r,c]...]} */
function board(spec) {
  const b = new Array(N).fill(0);
  for (const [r, c] of spec.X || []) b[id(r, c)] = BLACK;
  for (const [r, c] of spec.O || []) b[id(r, c)] = WHITE;
  return b;
}
function snapshot(e) { return [e.hashLo, e.hashHi, e.stones, e.history.length, Array.from(e.board).join(''), Array.from(e.catCount).join(',')].join('|'); }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function randomMidgame(seed, stones, rule) {
  const rnd = mulberry32(seed), e = new Engine({ rule });
  let c = BLACK;
  for (let i = 0; i < stones; i++) {
    let p, guard = 0;
    do { p = id(4 + Math.floor(rnd() * 7), 4 + Math.floor(rnd() * 7)); guard++; }
    while ((e.board[p] || !e.legal(p, c) || e.cat[(c - 1) * N + p] === 4) && guard < 500);
    if (guard >= 500) break;
    e.play(p, c); c = 3 - c;
  }
  if (e.hasWon(BLACK) || e.hasWon(WHITE)) return null;
  return { b: Array.from(e.board), toMove: c };
}

/** Realistic quiet position: a few random opening stones, then fast engine self-play. */
function selfPlayPosition(seed, plies, rule) {
  const rnd = mulberry32(seed), e = new Engine({ rule });
  let c = BLACK;
  for (let i = 0; i < 3; i++) {
    let p; do { p = id(6 + Math.floor(rnd() * 3), 6 + Math.floor(rnd() * 3)); } while (e.board[p] || !e.legal(p, c));
    e.play(p, c); c = 3 - c;
  }
  for (let i = 3; i < plies; i++) {
    const r = e.think(c, { timeMs: 30 });
    e.play(r.move, c);
    if (e.hasWon(c)) return null;
    c = 3 - c;
  }
  const f = new Engine({ rule });
  f.setBoard(Array.from(e.board));
  if (f.findVcf(c, 20000, 24)) return null; // keep only undecided positions
  return { b: Array.from(e.board), toMove: c };
}

// ---------------------------------------------------------------- win-rate model
test('winRate: bounds, monotone in score, forced scores are 0/1', () => {
  for (const rule of ['freestyle', 'renju']) {
    const e = new Engine({ rule });
    let prev = -1;
    for (let s = -20000; s <= 20000; s += 500) {
      const p = e.winRate(s, BLACK);
      assert(p > 0 && p < 1, `${rule} winRate(${s}) = ${p}`);
      assert(p > prev, `${rule} not monotone at ${s}`);
      prev = p;
    }
    assert(e.winRate(WIN_THRESHOLD + 1, WHITE) === 1 && e.winRate(-WIN_THRESHOLD - 1, WHITE) === 0, 'forced');
    assert(e.myWinRate(WIN_THRESHOLD + 5, BLACK) === 1 && e.myWinRate(-WIN_THRESHOLD - 5, BLACK) === 0, 'myWinRate forced');
  }
});

test('win rate is consistent across turns (no sawtooth between my turn and the opponent\'s)', () => {
  // My-turn value (my search score, me to move) vs. the value the opponent's
  // search gives right after I play the recommended move: same quantity, so the
  // two estimates should agree on average. The old convention was off by ~10%.
  for (const rule of ['freestyle', 'renju']) {
    let n = 0, sumNew = 0, sumOld = 0;
    for (let seed = 300; seed < 340 && n < 16; seed++) {
      const pos = selfPlayPosition(seed, 10 + (seed % 6), rule);
      if (!pos) continue;
      const e = new Engine({ rule });
      e.setBoard(pos.b);
      const me = pos.toMove, opp = 3 - me;
      const r1 = e.think(me, { timeMs: 200 });
      if (r1.reason !== 'search') continue;
      const mine = e.winRate(r1.score, me);
      const old = 1 - e.winRate(-r1.score, opp);
      e.play(r1.move, me);
      const r2 = e.think(opp, { timeMs: 200 });
      if (r2.reason !== 'search') continue;
      const after = 1 - e.winRate(r2.score, opp);
      sumNew += mine - after; sumOld += old - after; n++;
    }
    assert(n >= 6, rule + ': too few quiet positions (' + n + ')');
    const biasNew = sumNew / n, biasOld = sumOld / n;
    console.log(`      ${rule}: mean jump new ${(biasNew * 100).toFixed(1)}%  old ${(biasOld * 100).toFixed(1)}%  (n=${n})`);
    assert(Math.abs(biasNew) < 0.06, `${rule}: systematic jump ${(biasNew * 100).toFixed(1)}%`);
  }
});

// ---------------------------------------------------------------- analyze
function runAnalyze(b, me, rule, extra) {
  const e = new Engine({ rule });
  e.setBoard(b);
  const before = snapshot(e);
  const stages = [];
  const res = e.analyze(me, Object.assign({ timeMs: 300, analysisMs: 400, pvPlies: 6, pvMs: 60, onProgress: (st) => stages.push(st) }, extra || {}));
  assert(snapshot(e) === before, 'analyze changed the engine position');
  assert(stages.join(',') === 'best,moves,pv', 'progress stages ' + stages.join(','));
  return { e, res };
}

test('analyze: must block a four — the block keeps the win rate, other moves lose', () => {
  // white four on row 7 (c3..c6), black to move; block cells r7c2 / r7c7 (only one is open)
  const b = board({ O: [[7, 3], [7, 4], [7, 5], [7, 6]], X: [[7, 2], [6, 6], [8, 8], [9, 9]] });
  const { res } = runAnalyze(b, BLACK, 'freestyle');
  assert(res.best.move === id(7, 7), 'best ' + name(res.best.move));
  const top = res.moves[0];
  assert(top.move === id(7, 7), 'top analysed move ' + name(top.move));
  const others = res.moves.filter(m => m.move !== id(7, 7));
  assert(others.length > 3, 'few candidates analysed');
  assert(others.every(m => m.win === 0), 'a non-blocking move did not lose: ' + others.filter(m => m.win !== 0).map(m => name(m.move) + '=' + m.win).join(' '));
});

test('analyze: completing five is 100% and recommended', () => {
  const b = board({ X: [[7, 3], [7, 4], [7, 5], [7, 6]], O: [[8, 3], [8, 4], [8, 5], [2, 2]] });
  const { res } = runAnalyze(b, BLACK, 'freestyle');
  assert([id(7, 2), id(7, 7)].includes(res.best.move), 'best ' + name(res.best.move));
  assert(res.positionWin === 1, 'position win ' + res.positionWin);
  const five = res.moves.find(m => m.move === res.best.move);
  assert(five && five.win === 1, 'five move win ' + (five && five.win));
});

test('analyze: recommended move has the highest win rate (capped), all values in [0,1], deltas <= 0', () => {
  let n = 0;
  for (let seed = 1; seed <= 12 && n < 6; seed++) {
    const pos = seed % 2 ? selfPlayPosition(seed, 14, 'freestyle') : randomMidgame(seed, 14, 'freestyle');
    n++;
    if (!pos) continue;
    const { res } = runAnalyze(pos.b, pos.toMove, 'freestyle');
    const rec = res.moves.find(m => m.move === res.best.move);
    assert(rec, 'recommended move missing from analysis');
    for (const m of res.moves) {
      assert(m.win >= 0 && m.win <= 1, 'win out of range');
      if (res.best.reason === 'search') assert(m.win <= rec.win + 1e-12, `seed ${seed}: ${name(m.move)} ${m.win} > recommended ${rec.win}`);
    }
    assert(Math.abs(res.positionWin - rec.win) < 1e-12, 'position win != recommended move win');
  }
});

test('analyze (renju): never lists a forbidden black move', () => {
  let checked = 0;
  for (let seed = 11; seed <= 30 && checked < 6; seed++) {
    const pos = randomMidgame(seed, 16, 'renju');
    if (!pos || pos.toMove !== BLACK) continue;
    const { e, res } = runAnalyze(pos.b, BLACK, 'renju');
    for (const m of res.moves) assert(!e.isForbidden(m.move), 'forbidden move listed: ' + name(m.move));
    checked++;
  }
  assert(checked > 0, 'no renju black positions generated');
});

test('analyze: a delaying four is not shown as lost; ignoring an open three is, with its length', () => {
  // white open three on row 4; black can make a (delaying) four on row 11
  const b = board({ O: [[4, 5], [4, 6], [4, 7], [11, 4], [9, 9]], X: [[11, 5], [11, 6], [11, 7], [8, 8], [2, 12]] });
  const { e, res } = runAnalyze(b, BLACK, 'freestyle', { timeMs: 500, analysisMs: 600 });
  const four = res.moves.find(m => m.move === id(11, 8));
  assert(four, 'the four move was not analysed');
  assert(four.win > 0, 'delaying four shown as lost: ' + four.win + ' (score ' + four.score + ')');
  const block = res.moves.find(m => m.move === res.best.move);
  assert([id(4, 4), id(4, 8)].includes(res.best.move), 'best should block the open three, got ' + name(res.best.move));
  assert(block.win >= four.win, 'block should be at least as good as the delaying four');
  const far = e.evalMove(BLACK, id(0, 0), 300);
  assert(far.win === 0, 'ignoring the open three should lose: ' + far.win);
  const dist = 1000000 - Math.abs(far.score);
  assert(dist >= 2 && dist <= 8, 'loss length not reported sensibly: ' + dist + ' plies');
  const ev4 = e.evalMove(BLACK, id(11, 8), 300);
  assert(ev4.win > 0, 'evalMove marks the delaying four as lost');
});

// ---------------------------------------------------------------- continuation
test('principalLine: legal alternating moves, board restored, winner really wins', () => {
  for (let seed = 40; seed <= 45; seed++) {
    for (const rule of ['freestyle', 'renju']) {
      const pos = randomMidgame(seed, 12, rule);
      if (!pos) continue;
      const e = new Engine({ rule });
      e.setBoard(pos.b);
      const r = e.think(pos.toMove, { timeMs: 200 });
      const before = snapshot(e);
      const line = e.principalLine(pos.toMove, r.move, 8, 60);
      assert(snapshot(e) === before, 'board not restored');
      assert(line.moves[0] === r.move, 'line does not start with the recommended move');
      const chk = new Engine({ rule });
      chk.setBoard(pos.b);
      let c = pos.toMove;
      for (const p of line.moves) {
        assert(chk.legal(p, c), `${rule} seed ${seed}: illegal ${name(p)} for ${c}`);
        chk.play(p, c);
        c = 3 - c;
      }
      if (line.winner) assert(chk.hasWon(line.winner), 'claimed winner has no five');
      else assert(!chk.hasWon(BLACK) && !chk.hasWon(WHITE), 'unreported win');
    }
  }
});

test('principalLine: a forced win is played out to five', () => {
  // black open three plus a four-three setup: black to move wins quickly
  const b = board({ X: [[7, 4], [7, 5], [7, 6], [8, 7], [9, 7]], O: [[6, 6], [6, 8], [10, 10], [2, 2]] });
  const e = new Engine({ rule: 'freestyle' });
  e.setBoard(b);
  const r = e.think(BLACK, { timeMs: 300 });
  assert(r.score >= WIN_THRESHOLD, 'expected a forced win, got ' + r.reason + ' ' + r.score);
  const line = e.principalLine(BLACK, r.move, 12, 80);
  assert(line.winner === BLACK, 'line did not end in a black five: ' + line.moves.map(name).join(' '));
});

// ---------------------------------------------------------------- hover evaluation
test('evalMove: occupied/forbidden cells are illegal; a losing move scores 0', () => {
  const b = board({ O: [[7, 3], [7, 4], [7, 5], [7, 6]], X: [[7, 2], [6, 6], [8, 8], [9, 9]] });
  const e = new Engine({ rule: 'freestyle' });
  e.setBoard(b);
  const before = snapshot(e);
  assert(e.evalMove(BLACK, id(7, 3), 200).legal === false, 'occupied cell legal');
  const lose = e.evalMove(BLACK, id(0, 0), 200);
  assert(lose.legal && lose.win === 0, 'ignoring the four should lose: ' + lose.win);
  const block = e.evalMove(BLACK, id(7, 7), 300);
  assert(block.win > 0, 'blocking move should not be lost');
  assert(snapshot(e) === before, 'evalMove changed the position');
});

test('evalPosition: open four for the side to move is a sure win; board unchanged', () => {
  const b = board({ X: [[7, 4], [7, 5], [7, 6], [7, 7]], O: [[8, 4], [8, 5], [8, 6], [2, 2]] });
  const e = new Engine({ rule: 'freestyle' });
  e.setBoard(b);
  const before = snapshot(e);
  const r = e.evalPosition(BLACK, 300);
  assert(r.winBlack === 1, 'winBlack ' + r.winBlack);
  const r2 = e.evalPosition(WHITE, 300); // white to move cannot stop the open four (has no four)
  assert(r2.winBlack === 1, 'white to move: winBlack ' + r2.winBlack);
  assert(snapshot(e) === before, 'evalPosition changed the position');
});

test('timing: analyze stays within its budgets', () => {
  let n = 0;
  for (let seed = 200; seed < 230 && n < 4; seed++) {
    const pos = selfPlayPosition(seed, 16, seed % 2 ? 'renju' : 'freestyle');
    if (!pos) continue;
    const e = new Engine({ rule: seed % 2 ? 'renju' : 'freestyle' });
    e.setBoard(pos.b);
    const t = Date.now();
    const r = e.analyze(pos.toMove, { timeMs: 400, analysisMs: 500, pvPlies: 8, pvMs: 80 });
    const el = Date.now() - t, limit = (400 + 500 + 8 * 80) * 1.35 + 150;
    console.log(`      seed ${seed}: ${el} ms, best ${r.best.reason}, ${r.moves.length} moves analysed, depth ${Math.max(...r.moves.map(m => m.depth))}, pv ${r.pv.moves.length}`);
    assert(el <= limit, `took ${el} ms > ${limit}`);
    n++;
  }
  assert(n > 0, 'no quiet positions generated');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
