// ==UserScript==
// @name         Gomoku AI 助手 (gomoku.com)
// @namespace    https://github.com/local/gomoku-ai-plugin
// @version      1.3.0
// @description  为 gomoku.com 五子棋/连珠提供 AI 落子提示或自动下棋。
// @match        https://gomoku.com/*
// @match        https://www.gomoku.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/*
 * Gomoku AI engine (15x15), self-contained, no dependencies.
 *
 * - Freestyle gomoku (five or more in a row wins) and Renju (black: exactly
 *   five wins; overline / double-four / double-three are forbidden for black,
 *   with the recursive "real three" rule).
 * - Incremental pattern evaluation: for every empty cell and every direction we
 *   keep the shape that a stone of each colour would create there (five, open
 *   four, four, open three, ...).  Shapes come from a 3^10 lookup table (five
 *   cells each side) built at start-up by brute force, so line semantics are
 *   exact, including overlines and same-line double fours.
 * - Iterative-deepening negamax with alpha-beta, transposition table (Zobrist),
 *   threat-based forced-move pruning and a small quiescence on open threes.
 * - Threat-space search for both sides: VCF (victory by continuous fours) and
 *   VCT (victory by continuous threats: fours and open threes), each with a
 *   cache of positions already proven to fail.
 *
 * Everything lives inside createGomokuEngine() so the function can be
 * stringified and shipped into a Web Worker.
 */
function createGomokuEngine() {
  'use strict';

  const SIZE = 15;
  const N = SIZE * SIZE;
  const CENTER = 7 * SIZE + 7;
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // Shapes a stone would create in one direction.
  const S_NONE = 0, S_TWO = 1, S_OPEN_TWO = 2, S_THREE = 3, S_OPEN_THREE = 4,
    S_FOUR = 5, S_OPEN_FOUR = 6, S_FIVE = 7, S_OVERLINE = 8, S_DFOUR_LINE = 9;
  // S_DFOUR_LINE: two fours on the same line (X.XXX.X) for renju black, which is
  // a forbidden double four.  Freestyle/white get S_OPEN_FOUR for that pattern.
  const SHAPE_NAMES = ['none', 'two', 'open-two', 'three', 'open-three', 'four', 'open-four', 'five', 'overline', 'double-four-line'];

  // Per-direction value of a shape (used for move ordering and evaluation).
  const SHAPE_VALUE = [0, 4, 14, 30, 300, 400, 5000, 200000, 0, 5000];
  const BONUS_DOUBLE_FOUR = 5000;   // two fours in different directions
  const BONUS_FOUR_THREE = 2500;    // four + open three
  const BONUS_DOUBLE_THREE = 1500;  // two open threes

  // Cell categories (per colour) used for forced-move logic.
  const CAT_NONE = 0, CAT_OPEN_THREE = 1, CAT_FOUR = 2, CAT_WIN2 = 3, CAT_FIVE = 4;

  const WIN = 1000000;
  const INF = 2000000;
  const MAX_PLY = 48;
  const WIN_THRESHOLD = WIN - 200;

  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const W = 5;            // cells looked at on each side
  const K = 2 * W;        // neighbours per direction
  const LN = K + 1;       // line length including the centre
  const C0 = W;           // index of the centre in the line

  // ------------------------------------------------------------------ tables
  // key = sum(v_i * 3^i), i = 0..4 are offsets -5..-1, i = 5..9 are offsets +1..+5
  // v = 0 empty, 1 own stone, 2 opponent stone or board edge.
  // Only offsets -4..+4 can be filled when looking for fours/threes (a five
  // through the centre never reaches +-5); offsets +-5 only matter as run
  // boundaries, i.e. to tell a five from an overline.
  function buildShapeTable(exactFive) {
    const table = new Uint8Array(Math.pow(3, K));
    const ln = new Uint8Array(LN);
    const pts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    function fiveShape() {
      let l = C0, r = C0;
      while (l > 0 && ln[l - 1] === 1) l--;
      while (r < LN - 1 && ln[r + 1] === 1) r++;
      const len = r - l + 1;
      if (exactFive) return len === 5 ? S_FIVE : (len > 5 ? S_OVERLINE : S_NONE);
      return len >= 5 ? S_FIVE : S_NONE;
    }
    // number of cells that complete a five through the centre (stores them in pts)
    function fourPoints() {
      let c = 0;
      for (let q = 1; q < LN - 1; q++) {
        if (ln[q] !== 0) continue;
        ln[q] = 1;
        if (fiveShape() === S_FIVE) pts[c++] = q;
        ln[q] = 0;
      }
      return c;
    }
    function shapeOf(depth) {
      const f = fiveShape();
      if (f !== S_NONE) return f;
      const fc = fourPoints();
      if (fc >= 2) {
        if (!exactFive) return S_OPEN_FOUR;
        // straight four: exactly two five-points at both ends of one run of four
        if (fc === 2 && pts[1] - pts[0] === 5) {
          let ok = true;
          for (let i = pts[0] + 1; i < pts[1]; i++) if (ln[i] !== 1) { ok = false; break; }
          if (ok) return S_OPEN_FOUR;
        }
        return S_DFOUR_LINE;
      }
      if (fc === 1) return S_FOUR;
      if (depth >= 2) return S_NONE;
      let best = S_NONE;
      for (let q = 1; q < LN - 1; q++) {
        if (ln[q] !== 0) continue;
        ln[q] = 1;
        const s = shapeOf(depth + 1);
        ln[q] = 0;
        let r = S_NONE;
        if (s === S_OPEN_FOUR) r = S_OPEN_THREE;
        else if (s === S_FOUR) r = S_THREE;
        else if (s === S_OPEN_THREE) r = S_OPEN_TWO;
        else if (s === S_THREE) r = S_TWO;
        if (r > best) best = r;
      }
      return best;
    }
    for (let key = 0; key < table.length; key++) {
      let k = key;
      for (let i = 0; i < K; i++) {
        const v = k % 3; k = (k - v) / 3;
        ln[i < W ? i : i + 1] = v;
      }
      ln[C0] = 1;
      table[key] = shapeOf(0);
    }
    return table;
  }

  const TABLE_FREE = buildShapeTable(false);
  const TABLE_RENJU_BLACK = buildShapeTable(true);

  // Neighbour table: NBR[((d * N) + p) * K + i] = cell index, or -1 off-board.
  const NBR = new Int16Array(4 * N * K);
  // Cells within Chebyshev distance 2 (candidate generation).
  const NEAR = new Int16Array(N * 24);
  const NEAR_CNT = new Uint8Array(N);
  (function initGeometry() {
    for (let p = 0; p < N; p++) {
      const r = (p / SIZE) | 0, c = p % SIZE;
      for (let d = 0; d < 4; d++) {
        const dr = DIRS[d][0], dc = DIRS[d][1];
        for (let i = 0; i < K; i++) {
          const off = i < W ? i - W : i - W + 1; // -5..-1, +1..+5
          const rr = r + dr * off, cc = c + dc * off;
          NBR[((d * N) + p) * K + i] = (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) ? -1 : rr * SIZE + cc;
        }
      }
      let n = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
        NEAR[p * 24 + n++] = rr * SIZE + cc;
      }
      NEAR_CNT[p] = n;
    }
  })();

  // Zobrist keys (two independent 32-bit halves).
  const ZOB_LO = new Int32Array(3 * N), ZOB_HI = new Int32Array(3 * N);
  (function initZobrist() {
    let s = 0x2545F491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
    for (let i = 0; i < 3 * N; i++) { ZOB_LO[i] = rnd(); ZOB_HI[i] = rnd(); }
  })();

  const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();

  function sortDesc(buf, n) {
    const sub = buf.subarray(0, n);
    sub.sort();
    for (let i = 0, j = n - 1; i < j; i++, j--) { const t = sub[i]; sub[i] = sub[j]; sub[j] = t; }
  }

  const CACHE_LIMIT = 150000;

  // Score -> win probability, fitted on ~22k positions from 1200 self-play games
  // by test/calibrate-winrate.js (samples in test/data/winrate-samples.csv):
  //   P(side to move wins) = sigmoid(score / K + B * (side to move is black ? +1 : -1))
  // The model is symmetric so the displayed win rate is the same whether it is
  // computed on my turn or on the opponent's next turn (no zigzag).
  const WINRATE_MODEL = {
    freestyle: { K: 3767, B: 0.289 },
    renju: { K: 3171, B: -0.176 },
  };
  // think() reasons whose score is a real evaluation (others, like a forced
  // block or the opening book, return a placeholder 0).
  const REAL_SCORE = { search: 1, vcf: 1, vct: 1, win: 1, 'open-four': 1, lost: 1 };

  // ------------------------------------------------------------------ engine
  class Engine {
    constructor(opts) {
      opts = opts || {};
      this.rule = opts.rule === 'renju' ? 'renju' : 'freestyle';
      this.board = new Uint8Array(N);
      this.shape = new Uint8Array(2 * 4 * N);     // [((c-1)*4+d)*N + p]
      this.score = new Int32Array(2 * N);         // [(c-1)*N + p]
      this.cat = new Uint8Array(2 * N);
      this.catCount = new Int32Array(2 * 5);
      this.total = new Int32Array(2);
      this.nb = new Uint8Array(N);                // stones within distance 2
      // Renju black cells whose only problem is a table double three: they may be
      // legal (one three can be fake), so cat[] treats them as forbidden (keeps all
      // catCount shortcuts conservative) and mfCat[] keeps their would-be category.
      // Threat code uses them only after an exact isForbidden() check.
      this.mfCat = new Uint8Array(N);
      this.mfCount = 0;                           // cells with mfCat >= CAT_FOUR
      this.stones = 0;
      this.hashLo = 0; this.hashHi = 0;
      this.history = [];
      // transposition table
      const bits = opts.ttBits || 20;
      const size = 1 << bits;
      this.ttMask = size - 1;
      this.ttKey = new Int32Array(size);
      this.ttScore = new Int32Array(size);
      this.ttDepth = new Int8Array(size);
      this.ttFlag = new Uint8Array(size);
      this.ttMove = new Int16Array(size);
      this.ttGen = new Uint8Array(size);
      this.gen = 0;
      // threat-search caches: position+attacker -> remaining plies already proven insufficient
      this.vcfFail = new Map();
      this.vctFail = new Map();
      // proven wins: position+attacker -> winningMove * 64 + plies (positions only, so always valid)
      this.vctWin = new Map();
      // search scratch
      this.candBuf = [];
      for (let i = 0; i <= MAX_PLY + 2; i++) this.candBuf.push(new Float64Array(N));
      this.nodes = 0; this.vcfNodes = 0; this.vctNodes = 0;
      this.vcfMove = -1; this.vctMove = -1; this.vctRoot = 0; this.vctDeadline = Infinity; this.vcfDeadline = Infinity;
      this.deadline = Infinity; this.aborted = false;
      this.rootBest = -1; this.rootScore = -INF;
      this.rootFilter = null; this.rootWidth = 24; this.leafVcfNodes = 60;
      this.winning = false; // last think() found a forced win: keep following it with more VCT time
      this.reset();
    }

    reset() {
      this.board.fill(0); this.shape.fill(0); this.score.fill(0); this.cat.fill(0);
      this.catCount.fill(0); this.total.fill(0); this.nb.fill(0); this.mfCat.fill(0); this.mfCount = 0;
      this.stones = 0; this.hashLo = 0; this.hashHi = 0; this.history.length = 0;
      this.catCount[0 * 5 + CAT_NONE] = N; this.catCount[1 * 5 + CAT_NONE] = N;
      // Shapes of an empty board are not all S_NONE near the edges, compute them.
      for (let p = 0; p < N; p++) for (let d = 0; d < 4; d++) {
        this.shape[(0 * 4 + d) * N + p] = this.computeShape(BLACK, d, p);
        this.shape[(1 * 4 + d) * N + p] = this.computeShape(WHITE, d, p);
      }
      for (let p = 0; p < N; p++) this.refreshCell(p);
      this.ttDepth.fill(-1);
    }

    /** Load a full board: flat array of 225 values or 15 rows of 15 (0 empty, 1 black, 2 white). */
    setBoard(arr) {
      const flat = Array.isArray(arr[0]) ? [].concat.apply([], arr) : arr;
      // Threat caches stay valid across positions, but they only help within one
      // game: drop them when the new board is not a continuation of the old one.
      for (let p = 0; p < N; p++) {
        if (this.board[p] !== EMPTY && (flat[p] | 0) !== this.board[p]) { this.clearCaches(); break; }
      }
      this.reset();
      for (let p = 0; p < N; p++) {
        const v = flat[p] | 0;
        if (v === BLACK || v === WHITE) this.play(p, v);
      }
      this.history.length = 0;
    }

    clearCaches() {
      this.vcfFail.clear(); this.vctFail.clear(); this.vctWin.clear();
      this.winning = false;
    }

    tableFor(c) { return (this.rule === 'renju' && c === BLACK) ? TABLE_RENJU_BLACK : TABLE_FREE; }

    computeShape(c, d, q) {
      const base = ((d * N) + q) * K;
      const board = this.board;
      let key = 0, mul = 1;
      for (let i = 0; i < K; i++) {
        const idx = NBR[base + i];
        let v;
        if (idx < 0) v = 2;
        else { const b = board[idx]; v = b === 0 ? 0 : (b === c ? 1 : 2); }
        key += v * mul; mul *= 3;
      }
      return this.tableFor(c)[key];
    }

    /** Recompute score/category of cell q for both colours from its stored shapes. */
    refreshCell(q) {
      const renju = this.rule === 'renju';
      for (let ci = 0; ci < 2; ci++) {
        const sIdx = ci * N + q;
        const oldScore = this.score[sIdx], oldCat = this.cat[sIdx];
        let score = 0, cat = CAT_NONE, mf = 0;
        if (this.board[q] === EMPTY) {
          let fours = 0, openThrees = 0, five = false, openFour = false, overline = false;
          for (let d = 0; d < 4; d++) {
            const s = this.shape[(ci * 4 + d) * N + q];
            score += SHAPE_VALUE[s];
            if (s === S_FIVE) five = true;
            else if (s === S_OVERLINE) overline = true;
            else if (s === S_OPEN_FOUR) { openFour = true; fours++; }
            else if (s === S_DFOUR_LINE) fours += 2;
            else if (s === S_FOUR) fours++;
            else if (s === S_OPEN_THREE) openThrees++;
          }
          if (five) { cat = CAT_FIVE; }
          else if (renju && ci === 0 && (overline || fours >= 2 || openThrees >= 2)) {
            // forbidden for black (a double three is only "maybe": see mfCat)
            if (!overline && fours < 2) mf = openFour ? CAT_WIN2 : (fours >= 1 ? CAT_FOUR : CAT_OPEN_THREE);
            score = 0; cat = CAT_NONE;
          }
          else if (openFour || fours >= 2) { cat = CAT_WIN2; if (fours >= 2) score += BONUS_DOUBLE_FOUR; }
          else if (fours >= 1) { cat = CAT_FOUR; if (openThrees >= 1) score += BONUS_FOUR_THREE; }
          else if (openThrees >= 1) { cat = CAT_OPEN_THREE; if (openThrees >= 2) score += BONUS_DOUBLE_THREE; }
        }
        if (score !== oldScore) { this.total[ci] += score - oldScore; this.score[sIdx] = score; }
        if (cat !== oldCat) { this.catCount[ci * 5 + oldCat]--; this.catCount[ci * 5 + cat]++; this.cat[sIdx] = cat; }
        if (ci === 0) {
          const oldMf = this.mfCat[q];
          if (mf !== oldMf) {
            this.mfCount += (mf >= CAT_FOUR ? 1 : 0) - (oldMf >= CAT_FOUR ? 1 : 0);
            this.mfCat[q] = mf;
          }
        }
      }
    }

    /** Update every empty cell whose line windows (5 each side) include p. */
    updateAround(p) {
      const board = this.board, shape = this.shape;
      for (let d = 0; d < 4; d++) {
        const base = ((d * N) + p) * K;
        for (let i = 0; i < K; i++) {
          const q = NBR[base + i];
          if (q < 0 || board[q] !== EMPTY) continue;
          shape[(0 * 4 + d) * N + q] = this.computeShape(BLACK, d, q);
          shape[(1 * 4 + d) * N + q] = this.computeShape(WHITE, d, q);
          this.refreshCell(q);
        }
      }
    }

    play(p, c) {
      this.board[p] = c;
      this.hashLo ^= ZOB_LO[c * N + p]; this.hashHi ^= ZOB_HI[c * N + p];
      this.stones++;
      this.history.push(p);
      this.refreshCell(p); // occupied: clears p's own score/category
      this.updateAround(p);
      const nb = this.nb, cnt = NEAR_CNT[p], base = p * 24;
      for (let i = 0; i < cnt; i++) nb[NEAR[base + i]]++;
    }

    undo() {
      const p = this.history.pop();
      const c = this.board[p];
      this.board[p] = EMPTY;
      this.hashLo ^= ZOB_LO[c * N + p]; this.hashHi ^= ZOB_HI[c * N + p];
      this.stones--;
      for (let d = 0; d < 4; d++) {
        this.shape[(0 * 4 + d) * N + p] = this.computeShape(BLACK, d, p);
        this.shape[(1 * 4 + d) * N + p] = this.computeShape(WHITE, d, p);
      }
      this.refreshCell(p);
      this.updateAround(p);
      const nb = this.nb, cnt = NEAR_CNT[p], base = p * 24;
      for (let i = 0; i < cnt; i++) nb[NEAR[base + i]]--;
      return p;
    }

    /**
     * Renju: is black forbidden to play at p? (false for occupied cells and in freestyle)
     * An exact five always wins.  Overline, two fours (also on one line) and two
     * real threes are forbidden.  A three only counts if it can become a straight
     * four on a point that is itself not forbidden (checked recursively).
     */
    isForbidden(p, depth) {
      if (this.rule !== 'renju' || p < 0 || p >= N || this.board[p] !== EMPTY) return false;
      depth = depth || 0;
      const shape = this.shape;
      for (let d = 0; d < 4; d++) if (shape[d * N + p] === S_FIVE) return false;
      let fours = 0, threes = 0, threeMask = 0;
      for (let d = 0; d < 4; d++) {
        const s = shape[d * N + p];
        if (s === S_OVERLINE) return true;
        if (s === S_FOUR || s === S_OPEN_FOUR) fours++;
        else if (s === S_DFOUR_LINE) fours += 2;
        else if (s === S_OPEN_THREE) { threes++; threeMask |= 1 << d; }
      }
      if (fours >= 2) return true;
      if (threes < 2) return false;
      if (depth >= 30) return true; // safety bound only: each level adds a stone, so recursion ends anyway
      // Verify each three: after p, some empty point on that line must make a
      // straight four and not be forbidden itself.
      this.play(p, BLACK);
      let real = 0;
      for (let d = 0; d < 4 && real < 2; d++) {
        if (!(threeMask & (1 << d))) continue;
        const base = ((d * N) + p) * K;
        for (let i = 0; i < K; i++) {
          const x = NBR[base + i];
          if (x < 0 || this.board[x] !== EMPTY) continue;
          if (shape[d * N + x] !== S_OPEN_FOUR) continue;
          // the straight four must contain p: every cell strictly between p and x is black
          const off = i < W ? i - W : i - W + 1;
          let contig = true;
          for (let j = 1; j < Math.abs(off); j++) {
            const y = NBR[base + (off < 0 ? W - j : W - 1 + j)];
            if (this.board[y] !== BLACK) { contig = false; break; }
          }
          if (contig && !this.isForbidden(x, depth + 1)) { real++; break; }
        }
      }
      this.undo();
      return real >= 2;
    }

    /** Renju black: a "maybe forbidden" cell that is in fact legal, with category >= minCat. */
    mfLegal(p, minCat) {
      return this.mfCat[p] >= minCat && !this.isForbidden(p);
    }

    /** Can colour c make a four (or better) somewhere, including maybe-forbidden black cells? */
    hasFourMove(c) {
      const ci = c - 1;
      return this.catCount[ci * 5 + CAT_FOUR] > 0 || this.catCount[ci * 5 + CAT_WIN2] > 0 ||
        (c === BLACK && this.rule === 'renju' && this.mfCount > 0);
    }

    legal(p, c) {
      return p >= 0 && p < N && this.board[p] === EMPTY && !(c === BLACK && this.isForbidden(p));
    }

    /** Does colour c have a winning line on the board? */
    hasWon(c) {
      const b = this.board, exact = this.rule === 'renju' && c === BLACK;
      for (let p = 0; p < N; p++) {
        if (b[p] !== c) continue;
        const r = (p / SIZE) | 0, col = p % SIZE;
        for (let d = 0; d < 4; d++) {
          const dr = DIRS[d][0], dc = DIRS[d][1];
          const pr = r - dr, pc = col - dc;
          if (pr >= 0 && pr < SIZE && pc >= 0 && pc < SIZE && b[pr * SIZE + pc] === c) continue; // not run start
          let len = 0, rr = r, cc = col;
          while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && b[rr * SIZE + cc] === c) { len++; rr += dr; cc += dc; }
          if (exact ? len === 5 : len >= 5) return true;
        }
      }
      return false;
    }

    /** Static evaluation from the point of view of `me`, who is to move. */
    evaluate(me) {
      const a = this.total[me - 1], b = this.total[2 - me];
      return ((a * 6 - b * 5) / 5) | 0; // side to move gets a tempo bonus
    }

    firstCellWithCat(c, cat) {
      const base = (c - 1) * N, arr = this.cat;
      for (let p = 0; p < N; p++) if (arr[base + p] === cat) return p;
      return -1;
    }

    /** Best-looking legal move for `me` (fallback), or -1 if there is none. */
    anyLegalMove(me) {
      const mi = me - 1, oi = 2 - me;
      let best = -1, bestS = -1;
      for (let p = 0; p < N; p++) {
        if (this.board[p] !== EMPTY) continue;
        const s = this.score[mi * N + p] + this.score[oi * N + p] + this.nb[p];
        if (s > bestS && this.legal(p, me)) { bestS = s; best = p; }
      }
      return best;
    }

    // ---------------------------------------------------------------- move generation
    /** Opponent threatens an open four (or double four): only blocks and counter-fours make sense. */
    genDefence(me, ply) {
      const buf = this.candBuf[ply];
      const mi = me - 1, oi = 2 - me;
      const renjuBlack = this.rule === 'renju' && me === BLACK;
      // Renju, white defending: black's forbidden points have category NONE, but
      // occupying one can still break a black threat (e.g. the forbidden end of an
      // open three), so also look at black's raw per-direction shapes.
      const renjuWhite = this.rule === 'renju' && me === WHITE;
      const shape = this.shape;
      let n = 0;
      for (let p = 0; p < N; p++) {
        if (this.board[p] !== EMPTY) continue;
        const cm = this.cat[mi * N + p], co = this.cat[oi * N + p];
        let blocks = co >= CAT_FOUR;
        if (!blocks && renjuWhite) {
          for (let d = 0; d < 4; d++) { const sh = shape[d * N + p]; if (sh >= S_FOUR) { blocks = true; break; } }
        }
        if (cm >= CAT_FOUR || blocks || (renjuBlack && this.mfCat[p] >= CAT_FOUR)) {
          if (renjuBlack && cm === CAT_NONE && this.isForbidden(p)) continue;
          buf[n++] = (this.score[mi * N + p] * 11 + this.score[oi * N + p] * 10) * 256 + p;
        }
      }
      if (n > 1) sortDesc(buf, n);
      return n;
    }

    genNormal(me, ply, limit) {
      const buf = this.candBuf[ply];
      const mi = me - 1, oi = 2 - me;
      const renjuBlack = this.rule === 'renju' && me === BLACK;
      let n = 0;
      for (let p = 0; p < N; p++) {
        if (this.board[p] !== EMPTY || this.nb[p] === 0) continue;
        const sm = this.score[mi * N + p], so = this.score[oi * N + p];
        if (renjuBlack && this.isForbidden(p)) continue;
        // small centre bias breaks ties early in the game
        const r = (p / SIZE) | 0, c = p % SIZE;
        const centre = 14 - Math.max(Math.abs(r - 7), Math.abs(c - 7));
        buf[n++] = ((sm * 11 + so * 10) * 16 + centre) * 256 + p;
      }
      if (n === 0) {
        buf[0] = CENTER; // empty board
        return this.board[CENTER] === EMPTY ? 1 : 0;
      }
      sortDesc(buf, n);
      return Math.min(n, limit);
    }

    // ---------------------------------------------------------------- transposition table
    ttProbe(depth, alpha, beta, out) {
      const idx = this.hashLo & this.ttMask;
      if (this.ttKey[idx] !== this.hashHi || this.ttDepth[idx] < 0) return null;
      out.move = this.ttMove[idx];
      if (this.ttDepth[idx] < depth) return null;
      const s = this.ttScore[idx], f = this.ttFlag[idx];
      if (f === 0) return s;
      if (f === 1 && s <= alpha) return s;
      if (f === 2 && s >= beta) return s;
      return null;
    }

    ttStore(depth, score, flag, move) {
      if (depth < 0) depth = 0;
      const idx = this.hashLo & this.ttMask;
      if (this.ttKey[idx] === this.hashHi && this.ttDepth[idx] > depth && this.ttGen[idx] === this.gen) return;
      this.ttKey[idx] = this.hashHi; this.ttScore[idx] = score; this.ttDepth[idx] = depth;
      this.ttFlag[idx] = flag; this.ttMove[idx] = move; this.ttGen[idx] = this.gen;
    }

    /** 53-bit key of the current position plus the attacking colour. */
    posKey(me) {
      return (this.hashHi >>> 0) * 2097152 + (this.hashLo & 0xFFFFF) * 2 + (me - 1);
    }

    // ---------------------------------------------------------------- VCF
    /**
     * Victory by continuous fours for `me` (me to move).
     * Returns the number of plies to win (odd, >0) or 0. When it succeeds at
     * `ply === rootPly`, the first winning move is stored in this.vcfMove.
     */
    vcf(me, ply, maxPly, rootPly) {
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      if (this.catCount[mi * 5 + CAT_FIVE] > 0) {
        if (ply === rootPly) this.vcfMove = this.firstCellWithCat(me, CAT_FIVE);
        return 1;
      }
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) return 0; // opponent's four must be answered first
      if (this.catCount[mi * 5 + CAT_WIN2] > 0) {
        if (ply === rootPly) this.vcfMove = this.firstCellWithCat(me, CAT_WIN2);
        return 3;
      }
      const rem = maxPly - (ply - rootPly);
      if (rem <= 0 || this.vcfNodes <= 0) return 0;
      const mfBlack = me === BLACK && this.rule === 'renju' && this.mfCount > 0;
      if (this.catCount[mi * 5 + CAT_FOUR] === 0 && !mfBlack) return 0;
      const key = this.posKey(me);
      const failed = this.vcfFail.get(key);
      if (failed !== undefined && failed >= rem) return 0;
      // Snapshot the four-making cells first: play() mutates categories.
      const base = mi * N, list = [];
      for (let p = 0; p < N; p++) if (this.cat[base + p] === CAT_FOUR || (mfBlack && this.mfLegal(p, CAT_FOUR))) list.push(p);
      if (list.length > 1) list.sort((a, b) => this.score[base + b] - this.score[base + a]);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (this.vcfNodes-- <= 0) return 0;
        if ((this.vcfNodes & 127) === 0 && now() > this.vcfDeadline) { this.vcfNodes = 0; return 0; }
        this.play(p, me);
        let res = 0;
        if (this.catCount[mi * 5 + CAT_FIVE] >= 2) res = 3;
        else {
          const block = this.firstCellWithCat(me, CAT_FIVE);
          if (block >= 0) {
            if (!this.legal(block, opp)) res = 3; // renju: black cannot block on a forbidden point
            else {
              this.play(block, opp);
              const r = this.vcf(me, ply + 2, maxPly, rootPly);
              this.undo();
              if (r) res = r + 2;
            }
          }
        }
        this.undo();
        if (res) {
          if (ply === rootPly) this.vcfMove = p;
          return res;
        }
      }
      if (this.vcfNodes > 0) {
        if (this.vcfFail.size > CACHE_LIMIT) this.vcfFail.clear();
        this.vcfFail.set(key, rem);
      }
      return 0;
    }

    /** Run a bounded VCF for colour c from the current position (c to move). */
    findVcf(c, nodes, maxPly, deadline) {
      this.vcfNodes = nodes; this.vcfMove = -1;
      this.vcfDeadline = deadline || Infinity;
      const r = this.vcf(c, 0, maxPly, 0);
      return r ? { plies: r, move: this.vcfMove } : null;
    }

    // ---------------------------------------------------------------- VCT
    /**
     * Victory by continuous threats (fours and open threes) for `me`, me to move.
     * The defender may answer an open three with any block or any counter-four
     * (a superset of the real defences, so a reported win is sound).
     * Returns plies to win or 0; at the root the first move is stored in vctMove.
     */
    vctAttack(me, ply, maxPly) {
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      const root = ply === this.vctRoot;
      if (this.catCount[mi * 5 + CAT_FIVE] > 0) {
        if (root) this.vctMove = this.firstCellWithCat(me, CAT_FIVE);
        return 1;
      }
      // Depth, node and time limits apply to every node, including forced blocks
      // (a chain of defender counter-fours must not escape them).
      const rem = maxPly - (ply - this.vctRoot);
      if (rem <= 0 || this.vctNodes <= 0) return 0;
      if (now() > this.vctDeadline) { this.vctNodes = 0; return 0; }
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) {
        // The defender answered with a four: block it, our threat must still stand.
        this.vctNodes--;
        if (root || this.catCount[oi * 5 + CAT_FIVE] >= 2) return 0;
        const b = this.firstCellWithCat(opp, CAT_FIVE);
        if (!this.legal(b, me)) return 0;
        this.play(b, me);
        const r = this.vctDefend(me, ply + 1, maxPly);
        this.undo();
        return r ? r + 1 : 0;
      }
      if (this.catCount[mi * 5 + CAT_WIN2] > 0) {
        if (root) this.vctMove = this.firstCellWithCat(me, CAT_WIN2);
        return 3;
      }
      const key = this.posKey(me);
      const won = this.vctWin.get(key);
      if (won !== undefined && this.board[won >> 6] === EMPTY) {
        if (root) this.vctMove = won >> 6;
        return won & 63;
      }
      const failed = this.vctFail.get(key);
      if (failed !== undefined && failed >= rem) return 0;

      // Continuous fours alone may already win.
      if (this.hasFourMove(me)) {
        this.vcfNodes = 400; this.vcfMove = -1; this.vcfDeadline = this.vctDeadline;
        const f = this.vcf(me, ply, rem, ply);
        if (f) {
          if (root) this.vctMove = this.vcfMove;
          this.rememberWin(key, this.vcfMove, f);
          return f;
        }
      }

      // Attacking moves: fours and open threes, best first.
      const base = mi * N, list = [];
      for (let p = 0; p < N; p++) {
        const c = this.cat[base + p];
        if (c === CAT_FOUR || c === CAT_OPEN_THREE) list.push(p);
        else if (me === BLACK && this.mfCat[p] && this.board[p] === EMPTY && this.mfLegal(p, CAT_OPEN_THREE)) list.push(p);
      }
      if (list.length === 0) return 0;
      list.sort((a, b) => (this.score[base + b] * 2 + this.score[oi * N + b]) - (this.score[base + a] * 2 + this.score[oi * N + a]));
      const limit = Math.min(list.length, root ? 16 : 10);
      for (let i = 0; i < limit; i++) {
        const p = list[i];
        if (this.vctNodes-- <= 0) return 0;
        this.play(p, me);
        const r = this.vctDefend(me, ply + 1, maxPly);
        this.undo();
        if (r) {
          if (root) this.vctMove = p;
          this.rememberWin(key, p, r + 1);
          return r + 1;
        }
        if (this.vctNodes <= 0) return 0;
      }
      if (this.vctNodes > 0) {
        if (this.vctFail.size > CACHE_LIMIT) this.vctFail.clear();
        this.vctFail.set(key, rem);
      }
      return 0;
    }

    rememberWin(key, move, plies) {
      if (move < 0) return;
      if (this.vctWin.size > CACHE_LIMIT) this.vctWin.clear();
      this.vctWin.set(key, move * 64 + Math.min(63, plies));
    }

    /** Defender (3 - me) to move after an attacking move of `me`. */
    vctDefend(me, ply, maxPly) {
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) return 0;          // defender completes five first
      if (this.catCount[mi * 5 + CAT_FIVE] >= 2) return 2;
      if (this.vctNodes <= 0) return 0;
      if (this.catCount[mi * 5 + CAT_FIVE] === 1) {
        const b = this.firstCellWithCat(me, CAT_FIVE);
        if (!this.legal(b, opp)) return 2;
        this.vctNodes--;
        this.play(b, opp);
        const r = this.vctAttack(me, ply + 1, maxPly);
        this.undo();
        return r ? r + 1 : 0;
      }
      if (this.catCount[mi * 5 + CAT_WIN2] === 0) return 0;        // no threat left: initiative lost
      if (ply >= MAX_PLY) return 0;                                 // scratch buffers end here
      const n = this.genDefence(opp, ply);
      if (n === 0) return 4;
      const buf = this.candBuf[ply], moves = new Array(n);
      for (let i = 0; i < n; i++) moves[i] = buf[i] % 256;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        this.vctNodes--;
        this.play(moves[i], opp);
        const r = this.vctAttack(me, ply + 1, maxPly);
        this.undo();
        if (!r) return 0;
        if (r > worst) worst = r;
      }
      return worst + 1;
    }

    /** Bounded VCT for colour c (c to move). */
    findVct(c, nodes, maxPly, deadline) {
      this.vctNodes = nodes; this.vctMove = -1; this.vctRoot = 0;
      this.vctDeadline = deadline || Infinity;
      const r = this.vctAttack(c, 0, maxPly);
      return r ? { plies: r, move: this.vctMove } : null;
    }

    // ---------------------------------------------------------------- search
    negamax(me, depth, alpha, beta, ply, qDepth) {
      this.nodes++;
      if ((this.nodes & 1023) === 0 && now() > this.deadline) this.aborted = true;
      if (this.aborted) return 0;
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      const cc = this.catCount;

      if (cc[mi * 5 + CAT_FIVE] > 0) return WIN - ply - 1;
      if (ply >= MAX_PLY) return this.evaluate(me);

      // Opponent threatens five: block it or lose.
      if (cc[oi * 5 + CAT_FIVE] > 0) {
        if (cc[oi * 5 + CAT_FIVE] >= 2) return -(WIN - ply - 2);
        const block = this.firstCellWithCat(opp, CAT_FIVE);
        if (!this.legal(block, me)) return -(WIN - ply - 2);
        this.play(block, me);
        const s = -this.negamax(opp, depth, -beta, -alpha, ply + 1, qDepth);
        this.undo();
        if (ply === 0 && !this.aborted) { this.rootBest = block; this.rootScore = s; }
        return s;
      }
      if (cc[mi * 5 + CAT_WIN2] > 0) {
        if (ply === 0) { this.rootBest = this.firstCellWithCat(me, CAT_WIN2); this.rootScore = WIN - 3; }
        return WIN - ply - 3;
      }

      const oppThreat = cc[oi * 5 + CAT_WIN2] > 0;
      if (depth <= 0) {
        // Leaf: can the side to move win by continuous fours?
        if (cc[mi * 5 + CAT_FOUR] > 0) {
          this.vcfNodes = this.leafVcfNodes; this.vcfDeadline = this.deadline;
          const w = this.vcf(me, ply, 10, ply);
          if (w) return WIN - ply - w;
        }
        if (!oppThreat || qDepth <= 0) return this.evaluate(me);
        qDepth--; // forced to answer an open three: extend
      }

      const tt = { move: -1 };
      const ttVal = this.ttProbe(depth, alpha, beta, tt);
      if (ttVal !== null && ply > 0) return ttVal;

      let n;
      if (oppThreat) n = this.genDefence(me, ply);
      else n = this.genNormal(me, ply, ply === 0 ? this.rootWidth : (ply < 2 ? 14 : (ply < 6 ? 10 : 8)));
      const buf = this.candBuf[ply];
      if (n === 0) return oppThreat ? -(WIN - ply - 4) : this.evaluate(me);
      // Root: restrict to the moves the caller allows (e.g. moves that stop an opponent threat sequence).
      if (ply === 0 && this.rootFilter) {
        let m = 0;
        for (let i = 0; i < n; i++) if (this.rootFilter.has(buf[i] % 256)) buf[m++] = buf[i];
        if (m > 0) n = m;
      }
      // Transposition move first.
      if (tt.move >= 0) {
        for (let i = 1; i < n; i++) {
          if ((buf[i] % 256) === tt.move) { const t = buf[i]; for (let j = i; j > 0; j--) buf[j] = buf[j - 1]; buf[0] = t; break; }
        }
      }

      let best = -INF, bestMove = -1, flag = 1; // 1 = upper bound
      const nextDepth = (n === 1) ? depth : depth - 1; // single forced reply: do not reduce depth
      for (let i = 0; i < n; i++) {
        const p = buf[i] % 256;
        this.play(p, me);
        const s = -this.negamax(opp, nextDepth, -beta, -alpha, ply + 1, qDepth);
        this.undo();
        if (this.aborted) return best === -INF ? 0 : best;
        if (s > best) {
          best = s; bestMove = p;
          if (ply === 0) { this.rootBest = p; this.rootScore = s; }
          if (s > alpha) {
            alpha = s; flag = 0;
            if (alpha >= beta) { flag = 2; break; }
          }
        }
      }
      this.ttStore(depth, best, flag, bestMove);
      return best;
    }

    /** Does the opponent still have a VCF (or, if checkVct, a VCT) after my move p? */
    /**
     * Does the opponent still have a forced win (VCF, or VCT if checkVct) after my move p?
     * Returns { threat, four, plies }:
     *   threat: the opponent's attack is still there after p (p is not a defence);
     *   four:   p was a four, so the opponent blocked first and it is MY move again —
     *           a remaining threat then means "p only delayed", not "p loses";
     *   plies:  length of the opponent's forced win when four is false (p loses).
     */
    stillThreatened(p, me, checkVct, vctDeadline) {
      const opp = 3 - me, mi = me - 1;
      const out = { threat: false, four: false, plies: 0 };
      this.play(p, me);
      const look = () => this.findVcf(opp, 6000, 24, vctDeadline) || (checkVct ? this.findVct(opp, 1500, 12, vctDeadline) : null);
      if (this.catCount[mi * 5 + CAT_FIVE] >= 2) { /* p wins outright */ }
      else if (this.catCount[mi * 5 + CAT_FIVE] === 1) {
        // p is a four: the opponent must block first, then look again.
        out.four = true;
        const b = this.firstCellWithCat(me, CAT_FIVE);
        if (this.legal(b, opp)) {
          this.play(b, opp);
          const v = look();
          this.undo();
          if (v) out.threat = true;
        }
      } else {
        const v = look();
        if (v) { out.threat = true; out.plies = v.plies; }
      }
      this.undo();
      return out;
    }

    /**
     * Choose a move for colour `me`.
     * opts: { timeMs (default 1500), maxDepth (default 16), vct (default true) }
     * Returns { move, score, depth, nodes, timeMs, pv, reason } with cell indices.
     */
    think(me, opts) {
      opts = opts || {};
      const timeMs = opts.timeMs || 1500;
      const maxDepth = opts.maxDepth || 16;
      const useVct = opts.vct !== false;
      const t0 = now();
      const marks = {}; let tm = t0;
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      this.nodes = 0; this.aborted = false; this.gen = (this.gen + 1) & 255;
      this.rootFilter = null; this.rootWidth = 24; this.leafVcfNodes = 60;
      this.lastUnsafe = new Map(); // move -> plies of the opponent's forced win after it
      this.deadline = Infinity;
      const done = (move, score, reason, depth) => {
        if (move < 0 || !this.legal(move, me)) {
          const alt = this.anyLegalMove(me);
          if (alt >= 0) move = alt;
        }
        return {
          move, score, reason, depth: depth || 0, nodes: this.nodes,
          timeMs: Math.round(now() - t0), pv: this.extractPv(me, move), phases: marks,
        };
      };

      // Opening book (tiny): centre, then a diagonal/adjacent reply.
      if (this.stones === 0) return done(CENTER, 0, 'opening', 0);
      if (this.stones === 1 && this.board[CENTER] !== EMPTY) return done(CENTER - SIZE + 1, 0, 'opening', 0);

      // Immediate tactics.
      if (this.catCount[mi * 5 + CAT_FIVE] > 0) return done(this.firstCellWithCat(me, CAT_FIVE), WIN, 'win', 1);
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) {
        let bestP = -1, bestS = -1;
        for (let p = 0; p < N; p++) {
          if (this.cat[oi * N + p] !== CAT_FIVE || !this.legal(p, me)) continue;
          const s = this.score[mi * N + p];
          if (s > bestS) { bestS = s; bestP = p; }
        }
        if (bestP < 0) return done(this.anyLegalMove(me), -WIN, 'lost', 1); // no legal block (renju)
        return done(bestP, this.catCount[oi * 5 + CAT_FIVE] >= 2 ? -WIN : 0, 'block-four', 1);
      }
      if (this.catCount[mi * 5 + CAT_WIN2] > 0) return done(this.firstCellWithCat(me, CAT_WIN2), WIN - 3, 'open-four', 3);

      // Own VCF at the root (deep, generous budget).
      tm = now();
      const mark = (k) => { const t = now(); marks[k] = Math.round(t - tm); tm = t; };
      // Every threat-search phase has a hard time cap; the main search always
      // keeps at least ~35% of the budget (see the deadline below).
      const own = this.findVcf(me, opts.vcfNodes || 60000, 30, t0 + timeMs * 0.1); mark('ownVcf');
      if (own && own.move >= 0) { this.winning = true; return done(own.move, WIN - own.plies, 'vcf', own.plies); }

      // Own VCT (threes and fours), unless the opponent can win by fours first.
      // When the previous move already found a forced win, spend most of the
      // time re-finding it so the attack is not dropped halfway.
      const wasWinning = this.winning;
      this.winning = false;
      const oppVcf = this.hasFourMove(opp)
        ? this.findVcf(opp, 60000, 30, now() + timeMs * 0.1) : null;
      mark('oppVcf');
      // (Sound even when the opponent has threats of its own: the VCT tree lets the
      // defender answer with counter-fours and open fours.)
      if (useVct) {
        const vct = wasWinning
          ? this.findVct(me, 400000, 20, now() + timeMs * 0.35)
          : this.findVct(me, 40000, 14, now() + timeMs * 0.15);
        if (vct && vct.move >= 0) { this.winning = true; return done(vct.move, WIN - vct.plies, 'vct', vct.plies); }
      }

      // Opponent threat sequences: only consider moves after which they are gone.
      let oppVct = null;
      mark('ownVct');
      if (useVct && opts.oppVct !== false && !oppVcf) oppVct = this.findVct(opp, 20000, 12, now() + timeMs * 0.1);
      mark('oppVct');
      if (oppVcf || oppVct) {
        const safe = new Set();
        const n = this.genNormal(me, 0, 60);
        const cands = [];
        for (let i = 0; i < n; i++) cands.push(this.candBuf[0][i] % 256);
        // also every move that makes a four (forcing replies)
        for (let p = 0; p < N; p++) {
          if (cands.indexOf(p) >= 0 || this.board[p] !== EMPTY) continue;
          if (this.cat[mi * N + p] >= CAT_FOUR || (me === BLACK && this.rule === 'renju' && this.mfLegal(p, CAT_FOUR))) cands.push(p);
        }
        const t1 = now(), budget = timeMs * 0.15;
        this.lastUnsafe = new Map();
        for (let i = 0; i < cands.length && now() - t1 < budget; i++) {
          const t = this.stillThreatened(cands[i], me, useVct && opts.oppVct !== false, t1 + budget);
          if (!t.threat) safe.add(cands[i]);
          // a delaying four is no defence (kept out of the root moves) but is not lost either
          else if (!t.four) this.lastUnsafe.set(cands[i], t.plies);
        }
        if (safe.size > 0) { this.rootFilter = safe; this.rootWidth = 60; }
      }

      // Iterative deepening.
      mark('filter');
      this.deadline = Math.max(t0 + timeMs, now() + timeMs * 0.35);
      const tSearch = now();
      let bestMove = -1, bestScore = 0, bestDepth = 0;
      for (let depth = 2; depth <= maxDepth; depth += 1) {
        this.rootBest = -1; this.rootScore = -INF;
        const tIter = now();
        const s = this.negamax(me, depth, -INF, INF, 0, 3);
        if (this.aborted) {
          // The first root move searched is the previous best (TT move); any root
          // move that beat it within this iteration is a genuine improvement.
          if (this.rootBest >= 0 && (bestMove < 0 || this.rootScore > bestScore)) {
            bestMove = this.rootBest; bestScore = this.rootScore;
          }
          break;
        }
        if (this.rootBest >= 0) { bestMove = this.rootBest; bestScore = s; bestDepth = depth; }
        if (Math.abs(s) >= WIN_THRESHOLD) break;
        const tNow = now();
        if (opts.idStop === 'predict') {
          // Stop if the next iteration (typically ~3x the last one) cannot finish in time.
          if (tNow + (tNow - tIter) * 3 > this.deadline) break;
        } else if (tNow - tSearch > (this.deadline - tSearch) * 0.45) {
          break; // start another iteration only while less than ~half of the search time is used
        }
      }
      if (bestMove < 0 || !this.legal(bestMove, me)) {
        const n = this.genNormal(me, 0, 1);
        bestMove = n > 0 ? this.candBuf[0][0] % 256 : this.anyLegalMove(me);
      }
      this.rootFilter = null;
      if (bestScore >= WIN_THRESHOLD) this.winning = true; // keep pressing on the next move
      return done(bestMove, bestScore, 'search', bestDepth);
    }

    // ---------------------------------------------------------------- analysis
    /** P(colour c wins) in a position where c is to move and c's score is `score`. */
    winRate(score, c) {
      if (score >= WIN_THRESHOLD) return 1;
      if (score <= -WIN_THRESHOLD) return 0;
      const m = WINRATE_MODEL[this.rule];
      return 1 / (1 + Math.exp(-(score / m.K + (c === BLACK ? m.B : -m.B))));
    }

    /**
     * Displayed win rates always apply the fitted model from the point of view
     * of the side whose search produced the score (that is what it was fitted
     * on): on my turn, a candidate move p is worth winRate(score if I choose p,
     * me), so the best move equals the position's win rate; on the opponent's
     * turn, my win rate is 1 - winRate(opponent's score, opponent).
     * (Mixing the two views shifts values by the tempo terms B and C.)
     */
    myWinRate(myScore, me) {
      return this.winRate(myScore, me);
    }

    /**
     * My score after playing p (opponent to move), by iterative deepening with a
     * full window (exact values, not bounds) until `deadline`. Returns
     * { score, depth } or null if not even the first pass finished.
     */
    scoreAfter(me, p, deadline, maxDepth) {
      const opp = 3 - me;
      if (this.cat[(me - 1) * N + p] === CAT_FIVE) return { score: WIN, depth: 0 }; // p completes five
      let result = null;
      this.deadline = deadline; this.aborted = false; this.leafVcfNodes = 60;
      for (let depth = 1; depth <= (maxDepth || 9); depth += 2) {
        this.play(p, me);
        const s = -this.negamax(opp, depth, -INF, INF, 1, 2);
        this.undo();
        if (this.aborted) break;
        result = { score: s, depth };
        if (Math.abs(s) >= WIN_THRESHOLD) break;
      }
      return result;
    }

    /**
     * Full analysis for the side to move: best move (think), my win rate, the
     * win rate after each candidate move, and the expected continuation.
     * opts: { timeMs, analysisMs, maxMoves, pvPlies, pvMs, onProgress(stage, data) }
     */
    analyze(me, opts) {
      opts = opts || {};
      const opp = 3 - me;
      const progress = opts.onProgress || (() => {});
      const best = this.think(me, { timeMs: opts.timeMs || 1500 });
      const unsafe = this.lastUnsafe || new Map();
      progress('best', best);
      if (best.move < 0) return { best, moves: [], pv: { moves: [], winner: 0 } };

      // Candidate moves: the usual move generator, plus the recommended move first.
      const n = this.genNormal(me, 0, opts.maxMoves || 40);
      const cands = [];
      for (let i = 0; i < n; i++) cands.push(this.candBuf[0][i] % 256);
      const bi = cands.indexOf(best.move);
      if (bi >= 0) cands.splice(bi, 1);
      cands.unshift(best.move);

      // Iterative deepening over all candidates (full window, so values are exact).
      const tA = now(), budget = opts.analysisMs || 1200;
      const scores = new Map(), depths = new Map();
      this.deadline = tA + budget; this.aborted = false; this.leafVcfNodes = 60;
      for (let depth = 1; depth <= 9 && !this.aborted; depth += 2) {
        // deeper passes go best-first so the interesting moves get refined first
        const order = depth === 1 ? cands : cands.slice().sort((a, b) => scores.get(b) - scores.get(a));
        for (const p of order) {
          if (unsafe.has(p) && scores.has(p)) continue; // already known to lose
          let v;
          if (this.cat[(me - 1) * N + p] === CAT_FIVE) v = WIN; // p completes five
          else {
            this.play(p, me);
            v = -this.negamax(opp, depth, -INF, INF, 1, 2);
            this.undo();
          }
          if (this.aborted) break;
          // proven loss: my move, then the opponent's forced sequence
          scores.set(p, unsafe.has(p) ? Math.min(v, -(WIN - 1 - unsafe.get(p))) : v);
          depths.set(p, depth);
        }
        if (now() - tA > budget * 0.45) break;
      }

      // The recommended move keeps think()'s value when it is a real evaluation.
      // think()'s root search proved no other root move is better at its depth,
      // so other moves are capped at the recommended move's value.
      let bestScore = REAL_SCORE[best.reason] ? best.score : (scores.has(best.move) ? scores.get(best.move) : 0);
      if (!REAL_SCORE[best.reason]) {
        for (const [, v] of scores) if (v > bestScore) bestScore = v;
      }
      const moves = [];
      for (const [p, v] of scores) {
        let sc = p === best.move ? bestScore : v;
        if (p !== best.move && best.reason === 'search' && sc > bestScore) sc = bestScore;
        moves.push({ move: p, score: sc, win: this.myWinRate(sc, me), depth: depths.get(p) });
      }
      moves.sort((a, b) => b.win - a.win || b.score - a.score);
      const positionWin = this.myWinRate(bestScore, me);
      progress('moves', { moves, positionWin, bestScore });

      // Expected continuation after the recommended move.
      const pv = this.principalLine(me, best.move, opts.pvPlies || 8, opts.pvMs || 120);
      progress('pv', pv);
      return { best, moves, positionWin, bestScore, pv };
    }

    /**
     * Expected continuation: plays `first` for `me`, then lets think() choose for
     * both sides (msPerPly each). The board is restored afterwards.
     * Returns { moves: [cells...], winner: colour that completed five, or 0 }.
     */
    principalLine(me, first, plies, msPerPly) {
      const saved = this.winning;
      const moves = [first];
      let played = 0, winner = 0;
      if (!this.legal(first, me)) return { moves: [], winner: 0 };
      this.play(first, me); played++;
      if (this.hasWon(me)) winner = me;
      let c = 3 - me;
      while (!winner && moves.length < plies && this.stones < N) {
        const r = this.think(c, { timeMs: msPerPly });
        if (r.move < 0 || !this.legal(r.move, c)) break;
        moves.push(r.move);
        this.play(r.move, c); played++;
        if (this.hasWon(c)) winner = c;
        c = 3 - c;
      }
      for (let i = 0; i < played; i++) this.undo();
      this.winning = saved;
      return { moves, winner };
    }

    /** Win rate for `me` after playing cell p (used when hovering a cell). */
    evalMove(me, p, timeMs) {
      if (!this.legal(p, me)) return { move: p, legal: false };
      const ms = timeMs || 300;
      let r = this.scoreAfter(me, p, now() + ms * 0.7, 9);
      if (!r) r = { score: 0, depth: 0 };
      let score = r.score;
      // A forced opponent win that a shallow search misses (VCF/VCT after p).
      // Not for fours: after the forced block it is my move again.
      if (score > -WIN_THRESHOLD && score < WIN_THRESHOLD) {
        const t = this.stillThreatened(p, me, true, now() + Math.max(20, ms * 0.3));
        if (t.threat && !t.four) score = -(WIN - 1 - t.plies);
      }
      return { move: p, legal: true, score, depth: r.depth, win: this.myWinRate(score, me) };
    }

    /**
     * Evaluate the position for the side to move c (used on the opponent's turn).
     * Returns { score (from c's view), move, winBlack } with the same convention
     * as myWinRate (the evaluated position is the one after c's best move).
     */
    evalPosition(c, timeMs) {
      const saved = this.winning;
      const ms = timeMs || 600;
      const r = this.think(c, { timeMs: ms });
      let score = r.score;
      if (!REAL_SCORE[r.reason] && r.move >= 0) {
        const a = this.scoreAfter(c, r.move, now() + Math.max(50, ms * 0.5), 7);
        if (a) score = a.score;
      }
      this.winning = saved;
      const pc = this.winRate(score, c); // P(c wins), c to move
      return { move: r.move, score, reason: r.reason, winBlack: c === BLACK ? pc : 1 - pc };
    }

    firstEmpty() {
      for (let p = 0; p < N; p++) if (this.board[p] === EMPTY) return p;
      return -1;
    }

    extractPv(me, firstMove) {
      const pv = [];
      if (firstMove < 0 || this.board[firstMove] !== EMPTY) return pv;
      pv.push(firstMove);
      let played = 1;
      this.play(firstMove, me);
      let c = 3 - me;
      for (let i = 0; i < 8; i++) {
        const idx = this.hashLo & this.ttMask;
        if (this.ttKey[idx] !== this.hashHi || this.ttDepth[idx] < 0) break;
        const m = this.ttMove[idx];
        if (m < 0 || m >= N || this.board[m] !== EMPTY) break;
        pv.push(m); played++; this.play(m, c); c = 3 - c;
      }
      for (let i = 0; i < played; i++) this.undo();
      return pv;
    }

    toString() {
      let s = '   ' + Array.from({ length: SIZE }, (_, i) => String.fromCharCode(65 + i)).join(' ') + '\n';
      for (let r = 0; r < SIZE; r++) {
        s += String(r).padStart(2) + ' ';
        for (let c = 0; c < SIZE; c++) { const v = this.board[r * SIZE + c]; s += (v === BLACK ? 'X' : v === WHITE ? 'O' : '.') + ' '; }
        s += '\n';
      }
      return s;
    }
  }

  function idx(r, c) { return r * SIZE + c; }
  function rc(p) { return { row: (p / SIZE) | 0, col: p % SIZE }; }

  /** Parse an ASCII board (rows of X/O/. ; whitespace ignored). */
  function parseBoard(text) {
    const rows = text.trim().split('\n').map(l => l.replace(/\s+/g, ''));
    const arr = new Array(N).fill(0);
    for (let r = 0; r < rows.length && r < SIZE; r++)
      for (let c = 0; c < rows[r].length && c < SIZE; c++) {
        const ch = rows[r][c];
        arr[r * SIZE + c] = (ch === 'X' || ch === 'x') ? BLACK : (ch === 'O' || ch === 'o') ? WHITE : 0;
      }
    return arr;
  }

  /**
   * Message handler shared by the Web Worker and the main-thread fallback.
   * Messages: {id, type: 'think'|'analyze'|'evalMove'|'evalPosition'|'ping', board, color, rule, ...}.
   * Replies via post({id, ok, result}) — 'analyze' also posts {id, ok, progress: stage, result}.
   */
  function makeHandler(post) {
    let engine = null, engineRule = null;
    return (msg) => {
      msg = msg || {};
      if (msg.type === 'think') {
        try {
          if (!engine || engineRule !== msg.rule) { engine = new Engine({ rule: msg.rule }); engineRule = msg.rule; }
          engine.setBoard(msg.board);
          const r = engine.think(msg.color, { timeMs: msg.timeMs });
          r.win = REAL_SCORE[r.reason] ? engine.myWinRate(r.score, msg.color) : null;
          r.move = r.move >= 0 ? rc(r.move) : null;
          r.pv = r.pv.map(rc);
          post({ id: msg.id, ok: true, result: r });
        } catch (err) {
          post({ id: msg.id, ok: false, error: String((err && err.stack) || err) });
        }
      } else if (msg.type === 'analyze' || msg.type === 'evalMove' || msg.type === 'evalPosition') {
        try {
          if (!engine || engineRule !== msg.rule) { engine = new Engine({ rule: msg.rule }); engineRule = msg.rule; }
          engine.setBoard(msg.board);
          const cell = (p) => (p >= 0 ? rc(p) : null);
          if (msg.type === 'analyze') {
            const me = msg.color;
            engine.analyze(me, {
              timeMs: msg.timeMs, analysisMs: msg.analysisMs, maxMoves: msg.maxMoves,
              pvPlies: msg.pvPlies, pvMs: msg.pvMs,
              onProgress: (stage, data) => {
                let out;
                if (stage === 'best') {
                  out = Object.assign({}, data, { move: cell(data.move), pv: data.pv.map(rc),
                    win: REAL_SCORE[data.reason] ? engine.myWinRate(data.score, me) : null });
                } else if (stage === 'moves') {
                  out = { positionWin: data.positionWin, bestScore: data.bestScore,
                    moves: data.moves.map(m => ({ row: (m.move / SIZE) | 0, col: m.move % SIZE, score: m.score, win: m.win, depth: m.depth })) };
                } else {
                  out = { moves: data.moves.map(rc), winner: data.winner };
                }
                post({ id: msg.id, ok: true, progress: stage, result: out });
              },
            });
            post({ id: msg.id, ok: true, result: { done: true } });
          } else if (msg.type === 'evalMove') {
            const r = engine.evalMove(msg.color, idx(msg.row, msg.col), msg.timeMs);
            post({ id: msg.id, ok: true, result: Object.assign(r, { move: cell(r.move) }) });
          } else {
            const r = engine.evalPosition(msg.color, msg.timeMs);
            post({ id: msg.id, ok: true, result: Object.assign(r, { move: cell(r.move) }) });
          }
        } catch (err) {
          post({ id: msg.id, ok: false, error: String((err && err.stack) || err) });
        }
      } else if (msg.type === 'ping') {
        post({ id: msg.id, ok: true, result: 'pong' });
      }
    };
  }

  /** Worker entry point. */
  function workerMain() {
    const handle = makeHandler((m) => self.postMessage(m));
    self.onmessage = (e) => handle(e.data);
  }

  return {
    SIZE, N, EMPTY, BLACK, WHITE, WIN, WIN_THRESHOLD, Engine, idx, rc, parseBoard, workerMain, makeHandler, WINRATE_MODEL,
    SHAPE_NAMES, TABLE_FREE, TABLE_RENJU_BLACK,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createGomokuEngine;

/*
 * Gomoku AI assistant for gomoku.com (online battle + single player, gomoku and renju).
 *
 * Runs in the page's main world (needs window.i18n for the turn label).
 * Reads the position from the DOM and asks the engine (in a Web Worker) for:
 *   - the recommended move (hint ring, or an automatic click in auto mode),
 *   - the live win rate, its history over the game, and the win rate after
 *     every candidate move (heat map on the board, values on hover),
 *   - the expected continuation after the recommended move (numbered ghost stones).
 *
 * Expects createGomokuEngine() (src/engine.js) to be defined before this file.
 */
(function () {
  'use strict';
  if (window.__gomokuAI) return;

  const SIZE = 15;
  const COLS = 'ABCDEFGHIJKLMNO';
  const SETTINGS_KEY = 'gomokuAI.settings.v1';
  const DEFAULTS = {
    mode: 'hint', thinkMs: 1500, delayMs: 600, collapsed: false, x: null, y: null,
    showHeat: true, showPv: true, showOpp: true,
  };
  const HEAT_LABELS = 10; // candidate moves that get a number on the board (others get a dot)

  // ------------------------------------------------------------------ settings
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) { /* storage unavailable */ }
    return Object.assign({}, DEFAULTS);
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  const settings = loadSettings();
  if (!['off', 'hint', 'auto'].includes(settings.mode)) settings.mode = 'hint';

  // ------------------------------------------------------------------ engine bridge
  const factory = typeof createGomokuEngine === 'function' ? createGomokuEngine : null;
  if (!factory) { console.error('[GomokuAI] engine not loaded'); return; }

  let worker = null, workerFailed = false, reqId = 0;
  const pending = new Map(); // id -> { resolve, reject, onProgress, type, key }
  let inlineHandler = null;

  function dispatch(m) {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.ok && m.progress) { if (p.onProgress) p.onProgress(m.progress, m.result); return; }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
  }

  function startWorker() {
    if (worker || workerFailed) return;
    try {
      const src = '(' + factory.toString() + ')().workerMain();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => dispatch(e.data || {});
      worker.onerror = (e) => {
        console.warn('[GomokuAI] worker failed, falling back to main thread', e && e.message);
        workerFailed = true; worker = null;
        rejectAll('worker error');
      };
    } catch (e) {
      console.warn('[GomokuAI] cannot create worker (CSP?), using main thread', e);
      workerFailed = true; worker = null;
    }
  }

  function rejectAll(reason) {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  }

  /** Abort everything the worker is doing (used when a long analysis became stale). */
  function restartWorker() {
    if (worker) { worker.terminate(); worker = null; }
    rejectAll('cancelled');
  }

  /** Send a request to the engine; onProgress receives analysis stages. */
  function request(msg, onProgress, timeoutMs) {
    startWorker();
    const id = ++reqId;
    msg = Object.assign({ id }, msg);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, type: msg.type, key: msg.key });
      if (worker) {
        worker.postMessage(msg);
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); }
        }, (timeoutMs || 10000) + 15000);
      } else {
        // main-thread fallback (page forbids workers): same handler, shorter searches
        if (!inlineHandler) inlineHandler = factory().makeHandler(dispatch);
        const m = Object.assign({}, msg);
        for (const k of ['timeMs', 'analysisMs']) if (m[k]) m[k] = Math.min(m[k], 1000);
        setTimeout(() => inlineHandler(m), 0);
      }
    });
  }

  function inFlight(pred) {
    for (const p of pending.values()) if (pred(p)) return true;
    return false;
  }

  // ------------------------------------------------------------------ page adapter
  function isVisible(el) {
    if (!el) return false;
    if (el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findBoard() {
    const candidates = [
      { el: document.getElementById('online-player-board'), kind: 'online' },
      { el: document.getElementById('single-player-board'), kind: 'single' },
    ];
    for (const c of candidates) {
      if (c.el && isVisible(c.el) && c.el.querySelector('.board-intersection')) return c;
    }
    return null;
  }

  function myColorOf(found) {
    if (found.kind === 'online') {
      const ps = document.getElementById('player-stone');
      if (!ps) return 0;
      if (ps.classList.contains('black-stone')) return 1;
      if (ps.classList.contains('white-stone')) return 2;
      return 0;
    }
    const b = found.el;
    if (b.classList.contains('player-black')) return 1;
    if (b.classList.contains('player-white')) return 2;
    return 0;
  }

  function overlayVisible(boardEl, selector) {
    const container = boardEl.closest('.game-board-container') || boardEl.parentElement;
    if (!container) return false;
    const ov = container.querySelector(selector);
    return !!(ov && !ov.classList.contains('hidden') && isVisible(ov));
  }

  function yourTurnLabel() {
    try { if (window.i18n && typeof window.i18n.t === 'function') return window.i18n.t('Your Turn'); } catch (e) { /* ignore */ }
    return null;
  }

  /** Snapshot of everything the controller needs, or null if no active board. */
  function readState() {
    const found = findBoard();
    if (!found) return null;
    const boardEl = found.el;
    const board = [];
    for (let r = 0; r < SIZE; r++) board.push(new Array(SIZE).fill(0));
    const cells = new Map();
    let black = 0, white = 0;
    for (const cell of boardEl.querySelectorAll('.board-intersection')) {
      const r = +cell.dataset.row, c = +cell.dataset.col;
      if (!(r >= 0 && r < SIZE && c >= 0 && c < SIZE)) continue;
      cells.set(r * SIZE + c, cell);
      const st = cell.querySelector('.stone:not(.preview-stone)');
      if (!st) continue;
      if (st.classList.contains('black-stone')) { board[r][c] = 1; black++; }
      else if (st.classList.contains('white-stone')) { board[r][c] = 2; white++; }
    }
    const myColor = myColorOf(found);
    const toMove = black === white ? 1 : (black === white + 1 ? 2 : 0);
    const turnEl = document.getElementById(found.kind === 'online' ? 'online-player-turn' : 'single-player-turn');
    const label = yourTurnLabel();
    const turnText = turnEl ? turnEl.textContent.trim() : '';
    // If the page exposes its translation, require the label to say "your turn";
    // otherwise rely on stone parity alone.
    const labelSaysMine = label ? turnText === label : true;
    const gameOver = overlayVisible(boardEl, '.game-end-overlay');
    const notStarted = found.kind === 'single' && overlayVisible(boardEl, '.game-start-overlay');
    const pendingMove = !!boardEl.querySelector('.provisional-stone');
    const rule = location.pathname.includes('/renju/') ? 'renju' : 'freestyle';
    const myTurn = !!myColor && toMove === myColor && labelSaysMine && !gameOver && !notStarted && !pendingMove;
    return {
      kind: found.kind, boardEl, cells, board, black, white, stones: black + white, myColor, toMove, rule,
      turnText, gameOver, notStarted, pendingMove, myTurn,
      key: board.map(row => row.join('')).join('') + '|' + myColor + '|' + rule,
    };
  }

  function cellName(rc) { return COLS[rc.col] + (SIZE - rc.row); }
  function colorName(c) { return c === 1 ? '黑' : c === 2 ? '白' : '?'; }
  function pct(p) { return Math.round(p * 100) + '%'; }
  /**
   * Text for a forced result (win rate exactly 0 or 1) of a move by `side`
   * ('me' or 'opp'): who makes five and within how many of their own moves.
   */
  function forcedText(score, win, side) {
    const dist = 1000000 - Math.abs(score); // plies until the five, counted from this move
    const mover = side === 'opp' ? '对方' : '我方', other = side === 'opp' ? '我方' : '对方';
    if (win === 0) return mover + '必败：' + other + ' ' + Math.max(1, Math.ceil((dist - 1) / 2)) + ' 步内可强制成五';
    if (win === 1) return mover + '必胜：' + Math.max(1, Math.ceil(dist / 2)) + ' 步内强制成五';
    return '';
  }
  function signedPct(d) {
    const v = Math.round(d * 100);
    return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + '%';
  }

  // ------------------------------------------------------------------ styles
  const STYLE = `
  .gai-ov{pointer-events:none;box-sizing:border-box}
  .gai-hint{position:absolute;left:50%;top:50%;width:78%;height:78%;transform:translate(-50%,-50%);
    border-radius:50%;border:3px solid #e5383b;box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 10px #e5383b;
    z-index:30;animation:gai-pulse 1.1s ease-in-out infinite}
  .gai-hint.gai-auto{border-color:#2b8a3e;box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 10px #2b8a3e}
  .gai-hint.gai-opp{border:3px dashed #7048e8;box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 10px #7048e8}
  .gai-heat.gai-oppv{box-shadow:0 0 0 1.5px #b197fc,0 1px 2px rgba(0,0,0,.4)}
  @keyframes gai-pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .gai-ghost{position:absolute;left:50%;top:50%;width:72%;height:72%;transform:translate(-50%,-50%);border-radius:50%;
    display:flex;align-items:center;justify-content:center;font:700 11px/1 system-ui,sans-serif;z-index:28}
  .gai-ghost.b{background:rgba(20,20,24,.55);color:#fff;border:1px solid rgba(255,255,255,.35)}
  .gai-ghost.w{background:rgba(250,250,250,.6);color:#111;border:1px solid rgba(0,0,0,.35)}
  .gai-ghost.end{box-shadow:0 0 0 2px #fab005}
  .gai-heat{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:19px;height:14px;padding:0 3px;border-radius:7px;
    font:700 9px/14px system-ui,sans-serif;text-align:center;color:#fff;z-index:31;box-shadow:0 1px 2px rgba(0,0,0,.4)}
  .gai-heat.gai-lost{min-width:13px;height:13px;padding:0;font-size:10px;line-height:13px;opacity:.85}
  .gai-dot{position:absolute;left:50%;top:50%;width:26%;height:26%;transform:translate(-50%,-50%);border-radius:50%;
    z-index:27;opacity:.8}
  #gai-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:288px;background:#1f2430;color:#e9edf3;
    border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/1.45 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    user-select:none}
  #gai-panel *{box-sizing:border-box}
  #gai-panel .gai-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;border-bottom:1px solid #313848}
  #gai-panel .gai-title{font-weight:700;flex:1}
  #gai-panel .gai-led{width:9px;height:9px;border-radius:50%;background:#6b7280}
  #gai-panel .gai-led.on{background:#40c057}
  #gai-panel .gai-led.think{background:#fab005}
  #gai-panel button{font:inherit;color:inherit;background:#2c3342;border:1px solid #3a4356;border-radius:6px;padding:3px 8px;cursor:pointer}
  #gai-panel button:hover{background:#364055}
  #gai-panel .gai-body{padding:8px 10px 10px}
  #gai-panel .gai-seg{display:flex;gap:4px;margin-bottom:8px}
  #gai-panel .gai-seg button{flex:1;white-space:nowrap;padding:3px 4px}
  #gai-panel .gai-seg button.active{background:#1c7ed6;border-color:#1c7ed6;color:#fff}
  #gai-panel .gai-row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:4px 0}
  #gai-panel input[type=range]{width:120px}
  #gai-panel label{display:flex;align-items:center;gap:4px;cursor:pointer}
  #gai-panel .gai-stat{font-variant-numeric:tabular-nums;color:#c3cad6;font-size:12px}
  #gai-panel .gai-move{font-size:18px;font-weight:700;color:#fff}
  #gai-panel .gai-warn{color:#ffa94d;font-size:12px;margin-top:4px}
  #gai-panel .gai-alert{color:#ff8787;font-size:12px;margin-top:2px}
  #gai-panel .gai-win{display:flex;align-items:baseline;gap:8px}
  #gai-panel .gai-winnum{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}
  #gai-panel .gai-bar{position:relative;height:10px;border-radius:5px;overflow:hidden;background:#e9ecef;margin:4px 0}
  #gai-panel .gai-bar>div{position:absolute;left:0;top:0;bottom:0;background:#15171c;transition:width .4s}
  #gai-panel .gai-bar>span{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:#e5383b}
  #gai-panel svg{display:block;width:100%;height:46px;background:#262c3a;border-radius:6px}
  #gai-panel .gai-sep{border-top:1px solid #313848;margin:8px 0 6px}
  #gai-panel.collapsed .gai-body{display:none}
  `;

  // ------------------------------------------------------------------ board overlays
  let overlayEls = [];
  function clearOverlays() {
    for (const el of overlayEls) el.remove();
    overlayEls = [];
  }
  function overlaysLost() { return overlayEls.length > 0 && !overlayEls.every(e => e.isConnected); }
  function addOverlay(cell, cls, text, style) {
    const el = document.createElement('div');
    el.className = 'gai-ov ' + cls;
    if (text !== undefined) el.textContent = text;
    if (style) Object.assign(el.style, style);
    cell.appendChild(el);
    overlayEls.push(el);
    return el;
  }
  function heatColor(delta) {
    // delta = win(move) - win(best), <= 0
    if (delta >= -0.02) return '#2b8a3e';
    if (delta >= -0.08) return '#74b816';
    if (delta >= -0.18) return '#f59f00';
    if (delta >= -0.35) return '#e8590c';
    return '#c92a2a';
  }

  /**
   * Draw everything we know about the current position: `a` is my analysis on
   * my turn, or the opponent's (a.side === 'opp') on the opponent's turn.
   */
  function drawOverlays(st, a) {
    clearOverlays();
    if (!a || !a.best || !a.best.move || settings.mode === 'off') return;
    const auto = settings.mode === 'auto';
    const opp = a.side === 'opp';
    const cellAt = (rc) => st.cells.get(rc.row * SIZE + rc.col);
    // continuation (ghost stones), drawn first so the hint ring sits on top
    const ghostCells = new Set();
    if (settings.showPv && !auto && a.pv && a.pv.moves.length > 1) {
      let c = a.color || st.myColor;
      a.pv.moves.forEach((rc, i) => {
        const cell = cellAt(rc);
        if (cell && st.board[rc.row][rc.col] === 0) {
          const last = i === a.pv.moves.length - 1 && a.pv.winner;
          addOverlay(cell, 'gai-ghost ' + (c === 1 ? 'b' : 'w') + (last ? ' end' : ''), String(i + 1));
          ghostCells.add(rc.row * SIZE + rc.col);
        }
        c = 3 - c;
      });
    }
    // heat map: win rate after each candidate move
    if (settings.showHeat && !auto && a.moves) {
      a.moves.forEach((m, i) => {
        const cell = st.cells.get(m.row * SIZE + m.col);
        // cells showing a continuation stone keep only its number (hover shows the value)
        if (!cell || st.board[m.row][m.col] !== 0 || ghostCells.has(m.row * SIZE + m.col)) return;
        const d = m.win - a.positionWin;
        // numbers are the mover's win rate in %; '×' = forced loss, '胜' = forced win
        // (hover for how fast). The opponent's badges get a purple outline.
        const label = m.win === 0 ? '×' : m.win === 1 ? '胜' : String(Math.round(m.win * 100));
        const cls = 'gai-heat' + (m.win === 0 ? ' gai-lost' : '') + (opp ? ' gai-oppv' : '');
        if (i < HEAT_LABELS || m.win === 0 || m.win === 1) addOverlay(cell, cls, label, { background: heatColor(d) });
        else addOverlay(cell, 'gai-dot', undefined, { background: heatColor(d) });
      });
    }
    const ring = cellAt(a.best.move);
    if (ring) addOverlay(ring, 'gai-hint' + (opp ? ' gai-opp' : auto ? ' gai-auto' : ''));
  }

  // ------------------------------------------------------------------ panel UI
  let panel, ui = {};
  function buildPanel() {
    const style = document.createElement('style');
    style.id = 'gai-style';
    style.textContent = STYLE;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'gai-panel';
    panel.innerHTML = `
      <div class="gai-head"><span class="gai-led"></span><span class="gai-title">五子棋 AI 助手</span>
        <button class="gai-collapse" title="折叠/展开">–</button></div>
      <div class="gai-body">
        <div class="gai-seg">
          <button data-mode="off">关闭</button><button data-mode="hint">提示</button><button data-mode="auto">自动下棋</button>
        </div>
        <div class="gai-win"><span>我方胜率</span><span class="gai-winnum">—</span><span class="gai-stat gai-winsplit"></span></div>
        <div class="gai-bar" title="黑方胜率（深色）"><div class="gai-barfill" style="width:50%"></div><span></span></div>
        <svg class="gai-chart" viewBox="0 0 268 46" preserveAspectRatio="none"></svg>
        <div class="gai-stat gai-last">&nbsp;</div>
        <div class="gai-sep"></div>
        <div class="gai-row"><span>建议落子</span><span class="gai-move">—</span></div>
        <div class="gai-stat gai-status">等待对局开始…</div>
        <div class="gai-stat gai-info"></div>
        <div class="gai-stat gai-hover">&nbsp;</div>
        <div class="gai-alert" hidden></div>
        <div class="gai-warn" hidden></div>
        <div class="gai-sep"></div>
        <div class="gai-row">
          <label><input type="checkbox" class="gai-heat-cb">胜率热图</label>
          <label><input type="checkbox" class="gai-pv-cb">后续变化</label>
        </div>
        <div class="gai-row">
          <label title="对方回合时也分析：对方的最佳着法、各点的对方胜率和预计后续（紫色）"><input type="checkbox" class="gai-opp-cb">帮对手计算</label>
        </div>
        <div class="gai-row"><span>思考时间</span><input class="gai-think" type="range" min="300" max="6000" step="100"><span class="gai-think-v gai-stat"></span></div>
        <div class="gai-row gai-delay-row"><span>落子延迟</span><input class="gai-delay" type="range" min="0" max="4000" step="100"><span class="gai-delay-v gai-stat"></span></div>
        <div class="gai-row" style="margin-top:6px"><button class="gai-now">立即计算</button><span class="gai-stat">Alt+A 切换自动</span></div>
      </div>`;
    document.body.appendChild(panel);
    const q = (s) => panel.querySelector(s);
    ui = {
      led: q('.gai-led'), modeBtns: panel.querySelectorAll('[data-mode]'),
      winNum: q('.gai-winnum'), winSplit: q('.gai-winsplit'), barFill: q('.gai-barfill'), chart: q('.gai-chart'), last: q('.gai-last'),
      think: q('.gai-think'), thinkV: q('.gai-think-v'), delay: q('.gai-delay'), delayV: q('.gai-delay-v'), delayRow: q('.gai-delay-row'),
      move: q('.gai-move'), status: q('.gai-status'), info: q('.gai-info'), hover: q('.gai-hover'), warn: q('.gai-warn'), alert: q('.gai-alert'),
      heatCb: q('.gai-heat-cb'), pvCb: q('.gai-pv-cb'), oppCb: q('.gai-opp-cb'), now: q('.gai-now'), collapse: q('.gai-collapse'),
    };
    ui.think.value = settings.thinkMs;
    ui.delay.value = settings.delayMs;
    ui.heatCb.checked = !!settings.showHeat;
    ui.pvCb.checked = !!settings.showPv;
    ui.oppCb.checked = !!settings.showOpp;
    ui.modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    ui.think.addEventListener('input', () => { settings.thinkMs = +ui.think.value; saveSettings(); renderSettings(); });
    ui.think.addEventListener('change', () => { invalidate(); schedule(0); });
    ui.delay.addEventListener('input', () => { settings.delayMs = +ui.delay.value; saveSettings(); renderSettings(); });
    ui.heatCb.addEventListener('change', () => { settings.showHeat = ui.heatCb.checked; saveSettings(); onDisplayToggle(); });
    ui.pvCb.addEventListener('change', () => { settings.showPv = ui.pvCb.checked; saveSettings(); onDisplayToggle(); });
    ui.oppCb.addEventListener('change', () => {
      settings.showOpp = ui.oppCb.checked; saveSettings();
      oppAnalysis = null; evalKey = '';
      onDisplayToggle();
    });
    ui.now.addEventListener('click', () => { invalidate(); schedule(0, true); });
    ui.collapse.addEventListener('click', () => { settings.collapsed = !settings.collapsed; saveSettings(); renderSettings(); });
    makeDraggable(panel, q('.gai-head'));
    if (settings.x !== null && settings.y !== null) placePanel(settings.x, settings.y);
    renderSettings();
  }

  function placePanel(x, y) {
    const w = panel.offsetWidth || 288;
    x = Math.max(0, Math.min(window.innerWidth - w, x));
    y = Math.max(0, Math.min(window.innerHeight - 40, y));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      placePanel(ox + e.clientX - sx, oy + e.clientY - sy);
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const r = el.getBoundingClientRect();
      settings.x = Math.round(r.left); settings.y = Math.round(r.top); saveSettings();
    });
  }

  function renderSettings() {
    ui.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === settings.mode));
    ui.thinkV.textContent = (settings.thinkMs / 1000).toFixed(1) + 's';
    ui.delayV.textContent = (settings.delayMs / 1000).toFixed(1) + 's';
    ui.delayRow.style.opacity = settings.mode === 'auto' ? '1' : '.5';
    ui.led.className = 'gai-led' + (busy ? ' think' : (settings.mode !== 'off' ? ' on' : ''));
    panel.classList.toggle('collapsed', !!settings.collapsed);
    ui.collapse.textContent = settings.collapsed ? '+' : '–';
  }

  function setMode(mode) {
    settings.mode = mode; saveSettings();
    invalidate();
    if (mode === 'off') { clearOverlays(); ui.move.textContent = '—'; }
    renderSettings();
    schedule(0);
  }

  function setStatus(text, info) {
    ui.status.textContent = text;
    if (info !== undefined) ui.info.textContent = info;
  }
  function setAlert(text) {
    ui.alert.hidden = !text; ui.alert.textContent = text || '';
  }
  function setWarn(text) {
    ui.warn.hidden = !text; ui.warn.textContent = text || '';
  }

  // ------------------------------------------------------------------ win-rate display and history
  // history[n] = { key, pMe } : my win rate when n stones are on the board.
  // All values describe a position with the opponent to move (after my best
  // move on my turn, the actual position on the opponent's turn).
  let history = [];
  let historyColor = 0;
  let prevBoard = null;     // board of the previous distinct position (to name the last move)
  let lastMove = null;      // { rc, color } of the most recent stone

  function syncHistory(st) {
    if (st.myColor !== historyColor || st.stones <= 1 && history.length > 3) { history = []; historyColor = st.myColor; }
    if (history.length > st.stones + 1) history.length = st.stones + 1; // undo / new game
    // the page marks the most recent stone; fall back to a board diff
    const marker = st.boardEl.querySelector('.latest-move-marker');
    const mcell = marker && marker.closest('.board-intersection');
    if (mcell) {
      const r = +mcell.dataset.row, c = +mcell.dataset.col;
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && st.board[r][c]) {
        lastMove = { rc: { row: r, col: c }, color: st.board[r][c] };
        prevBoard = st.board;
        return;
      }
    }
    if (prevBoard && st.stones > 0) {
      // find a stone that is new compared with the previous position
      let found = null;
      for (let r = 0; r < SIZE && !found; r++) for (let c = 0; c < SIZE; c++) {
        if (st.board[r][c] && !prevBoard[r][c]) { found = { rc: { row: r, col: c }, color: st.board[r][c] }; break; }
      }
      if (found) lastMove = found;
    }
    prevBoard = st.board;
  }

  function recordWin(stones, key, pMe) {
    history[stones] = { key, pMe };
    renderWin();
  }

  function renderWin() {
    const st = lastState;
    const n = st ? st.stones : 0;
    const cur = history[n];
    const me = historyColor || (st && st.myColor) || 1;
    if (cur) {
      ui.winNum.textContent = pct(cur.pMe);
      ui.winNum.style.color = cur.pMe >= 0.6 ? '#69db7c' : cur.pMe <= 0.4 ? '#ff8787' : '#e9edf3';
      const pBlack = me === 1 ? cur.pMe : 1 - cur.pMe;
      ui.winSplit.textContent = `黑 ${pct(pBlack)} : 白 ${pct(1 - pBlack)}`;
      ui.barFill.style.width = (pBlack * 100).toFixed(1) + '%';
    } else {
      ui.winNum.textContent = '—'; ui.winNum.style.color = '#e9edf3'; ui.winSplit.textContent = '';
    }
    // what did the last move change?
    let text = ' ';
    if (cur && lastMove && n > 0) {
      let prev = null;
      for (let k = n - 1; k >= 0 && k >= n - 2; k--) if (history[k]) { prev = history[k]; break; }
      if (prev) {
        const who = lastMove.color === me ? '我方' : '对方';
        text = `上一手 ${who}(${colorName(lastMove.color)}) ${cellName(lastMove.rc)}：我方胜率 ${signedPct(cur.pMe - prev.pMe)}`;
      }
    }
    ui.last.textContent = text;
    renderChart();
  }

  function renderChart() {
    const W = 268, H = 46;
    const pts = [];
    let maxN = 0;
    history.forEach((h, n) => { if (h) { pts.push([n, h.pMe]); maxN = n; } });
    const span = Math.max(20, maxN);
    const x = (n) => (n / span) * (W - 6) + 3, y = (p) => H - 4 - p * (H - 8);
    let svg = `<line x1="0" x2="${W}" y1="${y(0.5)}" y2="${y(0.5)}" stroke="#4b5568" stroke-dasharray="3 3" stroke-width="1"/>`;
    if (pts.length) {
      const path = pts.map(([n, p], i) => (i ? 'L' : 'M') + x(n).toFixed(1) + ' ' + y(p).toFixed(1)).join(' ');
      const area = path + ` L${x(pts[pts.length - 1][0]).toFixed(1)} ${y(0)} L${x(pts[0][0]).toFixed(1)} ${y(0)} Z`;
      svg += `<path d="${area}" fill="rgba(28,126,214,.18)"/><path d="${path}" fill="none" stroke="#4dabf7" stroke-width="1.8"/>`;
      const [ln, lp] = pts[pts.length - 1];
      svg += `<circle cx="${x(ln).toFixed(1)}" cy="${y(lp).toFixed(1)}" r="2.8" fill="#fff"/>`;
    }
    ui.chart.innerHTML = svg;
  }

  // ------------------------------------------------------------------ hover: win rate of any empty cell
  const hoverCache = new Map(); // key + '|' + cell -> result
  let hoverCell = null, hoverTimer = null, hoverBoardEl = null;

  function attachHover(boardEl) {
    if (hoverBoardEl === boardEl) return;
    hoverBoardEl = boardEl;
    boardEl.addEventListener('mouseover', (e) => {
      const cell = e.target.closest && e.target.closest('.board-intersection');
      if (!cell || cell === hoverCell) return;
      hoverCell = cell;
      showHover(cell);
    });
    boardEl.addEventListener('mouseleave', () => { hoverCell = null; ui.hover.textContent = ' '; });
  }

  function showHover(cell) {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    const st = lastState;
    const r = +cell.dataset.row, c = +cell.dataset.col;
    const name = cellName({ row: r, col: c });
    const a = st && (st.myTurn ? analysis : oppAnalysis);
    if (!st || !a || a.key !== st.key || settings.mode === 'off' || st.board[r][c]) {
      ui.hover.textContent = ' ';
      return;
    }
    const opp = a.side === 'opp';
    const base = a.positionWin;
    const show = (win, note, score) => {
      if (win === null) { ui.hover.textContent = `${opp ? '若对方下' : '若下'} ${name}：${note}`; return; }
      const forced = (win === 0 || win === 1) && score !== undefined ? '，' + forcedText(score, win, a.side) : '';
      const delta = base !== undefined ? '（' + signedPct(win - base) + '）' : '';
      ui.hover.textContent = opp
        ? `若对方下 ${name}：对方胜率 ${pct(win)}${delta}，我方 ${pct(1 - win)}${forced}${note || ''}`
        : `若下 ${name}：我方胜率 ${pct(win)}${delta}${forced}${note || ''}`;
    };
    const m = a.moves && a.moves.find(x => x.row === r && x.col === c);
    if (m) { show(m.win, '', m.score); return; }
    const hk = st.key + '|' + r + ',' + c;
    if (hoverCache.has(hk)) {
      const h = hoverCache.get(hk);
      if (h.legal === false) show(null, '禁手/不可下'); else show(h.win, '', h.score);
      return;
    }
    show(null, '计算中…');
    hoverTimer = setTimeout(() => {
      request({ type: 'evalMove', board: st.board, color: a.color || st.myColor, rule: st.rule, row: r, col: c, timeMs: 350, key: st.key }, null, 350)
        .then((res) => {
          hoverCache.set(hk, res);
          if (hoverCell === cell && lastState && lastState.key === st.key) showHover(cell);
        })
        .catch(() => { /* cancelled */ });
    }, 180);
  }

  // ------------------------------------------------------------------ main loop
  let busy = false;          // a my-turn job (think/analyze) is running
  let lastState = null;
  let analysis = null;       // { key, side: 'me', color, best, moves, positionWin, pv } for my current position
  let oppAnalysis = null;    // the same for the opponent, computed on the opponent's turn
  let lastKey = '';          // position key we already handled
  let clickAttempts = 0;
  let lastClickAt = 0;
  let pendingClickKey = null; // position for which a delayed auto-click is scheduled
  let pendingToken = null;    // identifies the tick that owns pendingClickKey
  let evalKey = '';          // opponent-turn position already evaluated / in progress
  let timer = null;

  function invalidate() { lastKey = ''; analysis = null; clickAttempts = 0; }

  function schedule(ms, force) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tick(!!force); }, ms);
  }

  function onDisplayToggle() {
    const st = readState();
    // the analysis must be redone if it lacks the newly enabled parts
    if (analysis && st && analysis.key === st.key) {
      if ((settings.showHeat && !analysis.moves) || (settings.showPv && !analysis.pv && analysis.done)) invalidate();
      else drawOverlays(st, analysis);
    } else if (st && !st.myTurn) {
      if (oppAnalysis && oppAnalysis.key === st.key) {
        if ((settings.showHeat && !oppAnalysis.moves) || (settings.showPv && !oppAnalysis.pv && oppAnalysis.done)) { oppAnalysis = null; evalKey = ''; }
        else drawOverlays(st, oppAnalysis);
      }
      if (!settings.showOpp) { clearOverlays(); setAlert(''); }
    }
    schedule(0);
  }

  function formatScore(r) {
    const W = 1000000;
    if (r.reason === 'win') return '成五获胜';
    if (r.reason === 'lost') return '对方必胜（无合法防点）';
    if (r.score >= W - 200) return '必胜' + (r.reason === 'vct' ? '（连续冲四/活三）' : r.reason === 'vcf' ? '（连续冲四）' : '') + '，' + Math.max(1, W - r.score) + ' 手内';
    if (r.score <= -(W - 200)) return '对方有杀';
    if (r.reason === 'block-four') return '挡冲四';
    if (r.reason === 'opening') return '开局';
    const s = Math.max(-9999, Math.min(9999, Math.round(r.score / 10)));
    return (s > 0 ? '+' : '') + s;
  }

  async function tick(force) {
    const st = readState();
    lastState = st;
    if (!st) { clearOverlays(); setStatus('未检测到对局棋盘', ''); return; }
    attachHover(st.boardEl);
    if (st.myColor) syncHistory(st);
    renderWin();
    if (busy) return;
    if (settings.mode === 'off') { clearOverlays(); setStatus('已关闭', ''); return; }
    if (st.gameOver) { clearOverlays(); invalidate(); setStatus('对局结束', ''); return; }
    if (st.notStarted) { clearOverlays(); setStatus('请选择难度开始游戏', ''); return; }
    if (!st.myColor) { clearOverlays(); setStatus('无法识别我方棋色', ''); return; }
    if (st.toMove === 0) { setWarn('棋子数量异常（黑' + st.black + ' 白' + st.white + '），等待同步'); return; }
    setWarn('');

    if (!st.myTurn) {
      const oa = oppAnalysis && oppAnalysis.key === st.key ? oppAnalysis : null;
      if (!oa) { if (!analysis || analysis.key !== st.key) { clearOverlays(); setAlert(''); } }
      else if (overlaysLost() || overlayEls.length === 0) drawOverlays(st, oa);
      if (oa && oa.best && oa.best.move) {
        setStatus('对方回合 · 对方最佳 ' + cellName(oa.best.move) + (oa.positionWin !== undefined ? '（对方胜率 ' + pct(oa.positionWin) + '）' : ''));
      } else {
        setStatus('我方执' + colorName(st.myColor) + '，等待对手…' + (settings.showOpp && settings.mode === 'hint' ? '（正在帮对手计算）' : ''), st.pendingMove ? '' : undefined);
      }
      evaluateOpponentTurn(st);
      return;
    }

    if (st.key === lastKey && !force) {
      // Already handled: redraw overlays if the page removed them (e.g. a rejected move).
      if (analysis && analysis.key === st.key && (overlaysLost() || overlayEls.length === 0)) drawOverlays(st, analysis);
      // In auto mode, retry the click if it did not land (but never during the planned delay).
      if (settings.mode === 'auto' && analysis && analysis.key === st.key && analysis.best && clickAttempts < 3 &&
          pendingClickKey !== st.key && Date.now() - lastClickAt > 2500) {
        clickAttempts++;
        await placeMove(st, analysis.best.move);
      }
      return;
    }

    if (inFlight(p => p.key !== st.key && (p.type === 'evalPosition' || p.type === 'analyze'))) {
      // A stale opponent-turn evaluation is still running. Auto mode waits (it is
      // short and keeps the engine's caches); hint mode cancels it.
      if (settings.mode === 'auto') { schedule(100); return; }
      restartWorker();
    }

    const auto = settings.mode === 'auto';
    const wantAnalysis = !auto && (settings.showHeat || settings.showPv);
    busy = true; renderSettings();
    lastKey = st.key; clickAttempts = 0;
    const a = { key: st.key, side: 'me', color: st.myColor, best: null, moves: null, positionWin: undefined, pv: null, done: false };
    analysis = a;
    clearOverlays();
    setAlert('');
    setStatus('思考中…（执' + colorName(st.myColor) + (st.rule === 'renju' ? '，连珠规则' : '') + '）');
    const stillCurrent = () => analysis === a && lastState && lastState.key === a.key;

    const onBest = (res) => {
      a.best = res;
      if (!stillCurrent()) return;
      ui.move.textContent = res.move ? cellName(res.move) : '—';
      const pvText = res.pv && res.pv.length > 1 ? '  主变: ' + res.pv.slice(0, 6).map(cellName).join(' ') : '';
      setStatus('执' + colorName(st.myColor) + ' · 评估 ' + formatScore(res),
        '深度 ' + res.depth + ' · ' + (res.nodes / 1000).toFixed(1) + 'k 节点 · ' + res.timeMs + 'ms' + pvText);
      if (res.win !== null && res.win !== undefined) { a.positionWin = res.win; recordWin(st.stones, st.key, res.win); }
      drawOverlays(lastState, a);
    };

    try {
      if (wantAnalysis) {
        const thinkMs = settings.thinkMs;
        await request({
          type: 'analyze', board: st.board, color: st.myColor, rule: st.rule, key: st.key,
          timeMs: thinkMs, analysisMs: Math.max(600, Math.round(thinkMs * 0.8)), maxMoves: 40,
          pvPlies: settings.showPv ? 9 : 1, pvMs: Math.max(60, Math.min(250, Math.round(thinkMs / 10))),
        }, (stage, res) => {
          if (stage === 'best') onBest(res);
          else if (stage === 'moves') {
            a.moves = res.moves; a.positionWin = res.positionWin;
            recordWin(st.stones, st.key, res.positionWin);
            if (stillCurrent()) {
              drawOverlays(lastState, a);
              // Explain a heat map full of '×': the opponent has a forced attack.
              const alive = res.moves.filter(m => m.win > 0);
              const lost = res.moves.length - alive.length;
              if (alive.length === 0 && lost > 0) setAlert('对方已有强制取胜手段，所有候选着法都挡不住');
              else if (lost >= 5 && alive.length <= 3) {
                setAlert('对方有强制攻势（活三/连续冲四）：只有 ' + alive.map(m => cellName(m)).join('、') + ' 能避免必败，其余标 × 的点都输');
              } else setAlert('');
            }
          } else if (stage === 'pv') {
            a.pv = res;
            if (stillCurrent()) {
              drawOverlays(lastState, a);
              if (res.moves.length > 1) {
                ui.info.textContent = '后续: ' + res.moves.map(cellName).join(' ') + (res.winner ? '（' + colorName(res.winner) + '胜）' : '');
              }
            }
          }
        }, settings.thinkMs * 3);
        a.done = true;
      } else {
        const res = await request({ type: 'think', board: st.board, color: st.myColor, rule: st.rule, key: st.key, timeMs: settings.thinkMs },
          null, settings.thinkMs);
        onBest(res);
        a.done = true;
      }
    } catch (e) {
      busy = false; renderSettings();
      if (e.message !== 'cancelled') { setStatus('计算失败：' + e.message); lastKey = ''; schedule(1500); }
      else schedule(0);
      return;
    }
    busy = false; renderSettings();

    // The position may have changed while we were thinking.
    const now = readState();
    if (!now || now.key !== st.key || !now.myTurn || settings.mode === 'off') { schedule(50); return; }
    if (!a.best || !a.best.move) { setStatus('没有可下的位置'); return; }

    if (settings.mode === 'auto') {
      const myToken = {};
      pendingClickKey = st.key;
      pendingToken = myToken;
      try {
        const delay = settings.delayMs ? settings.delayMs * (0.6 + Math.random() * 0.8) : 0;
        await sleep(delay);
        const again = readState();
        if (!again || again.key !== st.key || !again.myTurn || settings.mode !== 'auto') return;
        clickAttempts = 1;
        await placeMove(again, a.best.move);
      } finally {
        // only clear our own marker: a newer tick may have started its own delay
        if (pendingToken === myToken) { pendingClickKey = null; pendingToken = null; }
      }
    }
  }

  /** Warnings derived from the opponent's analysis (their win rates). */
  function opponentAlert(oa) {
    const alive = oa.moves.filter(m => m.win > 0);
    const lost = oa.moves.length - alive.length;
    if (oa.positionWin === 1 && oa.best && oa.best.move) {
      return '注意：对方有必胜手段，最佳是 ' + cellName(oa.best.move) + '（' + forcedText(oa.bestScore !== undefined ? oa.bestScore : 999999, 1, 'opp') + '）';
    }
    if (alive.length === 0 && lost > 0) return '对方已无法防守：我方有强制取胜手段';
    if (lost >= 5 && alive.length <= 3) return '我方有强制攻势：对方只有 ' + alive.map(m => cellName(m)).join('、') + ' 能防住';
    return '';
  }

  /**
   * On the opponent's turn: in hint mode (with "帮对手计算"), analyse the
   * position for the opponent exactly like my own turn — their best move, their
   * win rate after each candidate move, and their expected continuation. Otherwise
   * (or in auto mode, which must not be delayed) a quick evaluation only.
   */
  function evaluateOpponentTurn(st) {
    if (evalKey === st.key || st.pendingMove) return;
    if (inFlight(() => true)) { schedule(150); return; }
    evalKey = st.key;
    const opp = 3 - st.myColor;
    if (settings.mode === 'hint' && settings.showOpp) {
      const thinkMs = settings.thinkMs;
      const oa = { key: st.key, side: 'opp', color: opp, best: null, moves: null, positionWin: undefined, pv: null, done: false };
      oppAnalysis = oa;
      const current = () => oppAnalysis === oa && lastState && lastState.key === oa.key && !lastState.myTurn;
      request({
        type: 'analyze', board: st.board, color: opp, rule: st.rule, key: st.key,
        timeMs: thinkMs, analysisMs: Math.max(600, Math.round(thinkMs * 0.8)), maxMoves: 40,
        pvPlies: settings.showPv ? 9 : 1, pvMs: Math.max(60, Math.min(250, Math.round(thinkMs / 10))),
      }, (stage, res) => {
        if (stage === 'best') {
          oa.best = res;
          if (res.win !== null && res.win !== undefined) { oa.positionWin = res.win; oa.bestScore = res.score; recordWin(st.stones, st.key, 1 - res.win); }
          if (current()) { drawOverlays(lastState, oa); schedule(0); }
        } else if (stage === 'moves') {
          oa.moves = res.moves; oa.positionWin = res.positionWin; oa.bestScore = res.bestScore;
          recordWin(st.stones, st.key, 1 - res.positionWin);
          if (current()) { drawOverlays(lastState, oa); setAlert(opponentAlert(oa)); schedule(0); }
        } else if (stage === 'pv') {
          oa.pv = res;
          if (current()) {
            drawOverlays(lastState, oa);
            if (res.moves.length > 1) ui.info.textContent = '对方后续: ' + res.moves.map(cellName).join(' ') + (res.winner ? '（' + colorName(res.winner) + '胜）' : '');
          }
        }
      }, thinkMs * 3)
        .then(() => { oa.done = true; schedule(0); })
        .catch(() => { if (evalKey === st.key) evalKey = ''; });
      return;
    }
    request({ type: 'evalPosition', board: st.board, color: opp, rule: st.rule, key: st.key,
      // hint mode: same think time as on my turn, so both turns' estimates are
      // comparable; auto mode: keep it short so it never delays our own move
      timeMs: settings.mode === 'auto' ? Math.min(800, Math.max(300, Math.round(settings.thinkMs / 2))) : Math.min(2500, settings.thinkMs) }, null, 2500)
      .then((res) => {
        const pMe = st.myColor === 1 ? res.winBlack : 1 - res.winBlack;
        recordWin(st.stones, st.key, pMe); // valid for that position even if the game moved on
        if (lastState && lastState.key === st.key && res.move) {
          ui.info.textContent = '对方最佳应对预计: ' + cellName(res.move);
        }
        schedule(0);
      })
      .catch(() => { if (evalKey === st.key) evalKey = ''; });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function placeMove(st, move) {
    const cell = st.cells.get(move.row * SIZE + move.col);
    if (!cell || st.board[move.row][move.col] !== 0) return;
    clearOverlays();
    lastClickAt = Date.now();
    cell.click();
    // Small screens use "tap to preview, tap again to confirm".
    await sleep(120);
    if (cell.querySelector('.preview-stone')) cell.click();
    // If nothing happened (e.g. move rejected), the periodic tick retries.
  }

  // ------------------------------------------------------------------ wiring
  function isOwnNode(n) {
    return n.nodeType === 1 && n.classList && n.classList.contains('gai-ov');
  }

  function init() {
    buildPanel();
    renderChart();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t && t.nodeType === 1 && (t.id === 'gai-panel' || (t.closest && t.closest('#gai-panel')))) continue;
        if (t && t.nodeType === 1 && t.classList && t.classList.contains('gai-ov')) continue;
        if (m.type === 'childList') {
          // ignore our own overlay insertions/removals
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (nodes.length && nodes.every(isOwnNode)) continue;
        }
        // A position change makes a running (long) analysis useless: cancel it
        // (mine or the opponent's).
        if (inFlight(p => p.type === 'analyze')) {
          const st = readState();
          if (st && inFlight(p => p.type === 'analyze' && p.key !== st.key)) {
            if (busy && analysis && !analysis.done && analysis.key !== st.key) { busy = false; analysis = null; lastKey = ''; }
            restartWorker();
          }
        }
        // Throttle: never push back a tick that is already pending, so a page
        // element that changes very often cannot starve the controller.
        if (!timer) schedule(150);
        return;
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], characterData: true });
    setInterval(() => schedule(0), 2000);
    document.addEventListener('keydown', (e) => {
      if (e.repeat || e.isComposing) return;
      const t = (e.composedPath && e.composedPath()[0]) || e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return; // typing (e.g. chat)
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
        e.preventDefault();
        setMode(settings.mode === 'auto' ? 'hint' : 'auto');
      }
    });
    schedule(300);
  }

  window.__gomokuAI = {
    readState, setMode, settings, version: '1.3.0',
    debug: () => ({ analysis, history: history.map(h => h && Math.round(h.pMe * 1000) / 1000), lastKey, busy }),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
