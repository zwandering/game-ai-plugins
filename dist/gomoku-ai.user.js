// ==UserScript==
// @name         Gomoku AI 助手 (gomoku.com)
// @namespace    https://github.com/local/gomoku-ai-plugin
// @version      1.1.0
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

  const CACHE_LIMIT = 400000;

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
      // search scratch
      this.candBuf = [];
      for (let i = 0; i <= MAX_PLY + 2; i++) this.candBuf.push(new Float64Array(N));
      this.nodes = 0; this.vcfNodes = 0; this.vctNodes = 0;
      this.vcfMove = -1; this.vctMove = -1; this.vctRoot = 0; this.vctDeadline = Infinity;
      this.deadline = Infinity; this.aborted = false;
      this.rootBest = -1; this.rootScore = -INF;
      this.rootFilter = null; this.rootWidth = 24; this.leafVcfNodes = 60;
      this.reset();
    }

    reset() {
      this.board.fill(0); this.shape.fill(0); this.score.fill(0); this.cat.fill(0);
      this.catCount.fill(0); this.total.fill(0); this.nb.fill(0);
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
      this.reset();
      const flat = Array.isArray(arr[0]) ? [].concat.apply([], arr) : arr;
      for (let p = 0; p < N; p++) {
        const v = flat[p] | 0;
        if (v === BLACK || v === WHITE) this.play(p, v);
      }
      this.history.length = 0;
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
        let score = 0, cat = CAT_NONE;
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
          else if (renju && ci === 0 && (overline || fours >= 2 || openThrees >= 2)) { score = 0; cat = CAT_NONE; } // forbidden for black (double three re-checked exactly in isForbidden)
          else if (openFour || fours >= 2) { cat = CAT_WIN2; if (fours >= 2) score += BONUS_DOUBLE_FOUR; }
          else if (fours >= 1) { cat = CAT_FOUR; if (openThrees >= 1) score += BONUS_FOUR_THREE; }
          else if (openThrees >= 1) { cat = CAT_OPEN_THREE; if (openThrees >= 2) score += BONUS_DOUBLE_THREE; }
        }
        if (score !== oldScore) { this.total[ci] += score - oldScore; this.score[sIdx] = score; }
        if (cat !== oldCat) { this.catCount[ci * 5 + oldCat]--; this.catCount[ci * 5 + cat]++; this.cat[sIdx] = cat; }
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
      if (depth >= 2) return true; // deep enough: treat threes as real
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
          if (shape[d * N + x] === S_OPEN_FOUR && !this.isForbidden(x, depth + 1)) { real++; break; }
        }
      }
      this.undo();
      return real >= 2;
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
      let n = 0;
      for (let p = 0; p < N; p++) {
        if (this.board[p] !== EMPTY) continue;
        const cm = this.cat[mi * N + p], co = this.cat[oi * N + p];
        if (cm >= CAT_FOUR || co >= CAT_FOUR) {
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
      if (this.catCount[mi * 5 + CAT_FOUR] === 0) return 0;
      const key = this.posKey(me);
      const failed = this.vcfFail.get(key);
      if (failed !== undefined && failed >= rem) return 0;
      // Snapshot the four-making cells first: play() mutates categories.
      const base = mi * N, list = [];
      for (let p = 0; p < N; p++) if (this.cat[base + p] === CAT_FOUR) list.push(p);
      if (list.length > 1) list.sort((a, b) => this.score[base + b] - this.score[base + a]);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (this.vcfNodes-- <= 0) return 0;
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
    findVcf(c, nodes, maxPly) {
      this.vcfNodes = nodes; this.vcfMove = -1;
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
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) {
        // The defender answered with a four: block it, our threat must still stand.
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
      const rem = maxPly - (ply - this.vctRoot);
      if (rem <= 0 || this.vctNodes <= 0) return 0;
      if ((this.vctNodes & 63) === 0 && now() > this.vctDeadline) { this.vctNodes = 0; return 0; }
      const key = this.posKey(me);
      const failed = this.vctFail.get(key);
      if (failed !== undefined && failed >= rem) return 0;

      // Continuous fours alone may already win.
      if (this.catCount[mi * 5 + CAT_FOUR] > 0) {
        this.vcfNodes = 400; this.vcfMove = -1;
        const f = this.vcf(me, ply, rem, ply);
        if (f) { if (root) this.vctMove = this.vcfMove; return f; }
      }

      // Attacking moves: fours and open threes, best first.
      const base = mi * N, list = [];
      for (let p = 0; p < N; p++) {
        const c = this.cat[base + p];
        if (c === CAT_FOUR || c === CAT_OPEN_THREE) list.push(p);
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

    /** Defender (3 - me) to move after an attacking move of `me`. */
    vctDefend(me, ply, maxPly) {
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      if (this.catCount[oi * 5 + CAT_FIVE] > 0) return 0;          // defender completes five first
      if (this.catCount[mi * 5 + CAT_FIVE] >= 2) return 2;
      if (this.catCount[mi * 5 + CAT_FIVE] === 1) {
        const b = this.firstCellWithCat(me, CAT_FIVE);
        if (!this.legal(b, opp)) return 2;
        this.play(b, opp);
        const r = this.vctAttack(me, ply + 1, maxPly);
        this.undo();
        return r ? r + 1 : 0;
      }
      if (this.catCount[mi * 5 + CAT_WIN2] === 0) return 0;        // no threat left: initiative lost
      if (this.vctNodes <= 0) return 0;
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
          this.vcfNodes = this.leafVcfNodes;
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
    stillThreatened(p, me, checkVct, vctDeadline) {
      const opp = 3 - me, mi = me - 1;
      this.play(p, me);
      let threatened;
      if (this.catCount[mi * 5 + CAT_FIVE] >= 2) threatened = false;       // p wins outright
      else if (this.catCount[mi * 5 + CAT_FIVE] === 1) {
        // p is a four: the opponent must block first, then look again.
        const b = this.firstCellWithCat(me, CAT_FIVE);
        if (!this.legal(b, opp)) threatened = false;
        else {
          this.play(b, opp);
          threatened = !!this.findVcf(opp, 6000, 24) || (checkVct && !!this.findVct(opp, 1500, 12, vctDeadline));
          this.undo();
        }
      } else {
        threatened = !!this.findVcf(opp, 6000, 24) || (checkVct && !!this.findVct(opp, 1500, 12, vctDeadline));
      }
      this.undo();
      return threatened;
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
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      this.nodes = 0; this.aborted = false; this.gen = (this.gen + 1) & 255;
      this.rootFilter = null; this.rootWidth = 24; this.leafVcfNodes = 60;
      this.deadline = Infinity;
      const done = (move, score, reason, depth) => {
        if (move < 0 || !this.legal(move, me)) {
          const alt = this.anyLegalMove(me);
          if (alt >= 0) move = alt;
        }
        return {
          move, score, reason, depth: depth || 0, nodes: this.nodes,
          timeMs: Math.round(now() - t0), pv: this.extractPv(me, move),
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
      const own = this.findVcf(me, opts.vcfNodes || 60000, 30);
      if (own && own.move >= 0) return done(own.move, WIN - own.plies, 'vcf', own.plies);

      // Own VCT (threes and fours), unless the opponent can win by fours first.
      const oppVcf = (this.catCount[oi * 5 + CAT_FOUR] > 0 || this.catCount[oi * 5 + CAT_WIN2] > 0)
        ? this.findVcf(opp, 60000, 30) : null;
      if (useVct && !oppVcf && this.catCount[oi * 5 + CAT_WIN2] === 0) {
        const vct = this.findVct(me, 40000, 14, t0 + timeMs * 0.2);
        if (vct && vct.move >= 0) return done(vct.move, WIN - vct.plies, 'vct', vct.plies);
      }

      // Opponent threat sequences: only consider moves after which they are gone.
      let oppVct = null;
      if (useVct && !oppVcf) oppVct = this.findVct(opp, 20000, 12, t0 + timeMs * 0.35);
      if (oppVcf || oppVct) {
        const safe = new Set();
        const n = this.genNormal(me, 0, 60);
        const cands = [];
        for (let i = 0; i < n; i++) cands.push(this.candBuf[0][i] % 256);
        // also every move that makes a four (forcing replies)
        for (let p = 0; p < N; p++) if (this.cat[mi * N + p] >= CAT_FOUR && cands.indexOf(p) < 0) cands.push(p);
        const t1 = now(), budget = timeMs * 0.3;
        for (let i = 0; i < cands.length && now() - t1 < budget; i++) {
          if (!this.stillThreatened(cands[i], me, useVct, t1 + budget)) safe.add(cands[i]);
        }
        if (safe.size > 0) { this.rootFilter = safe; this.rootWidth = 60; }
      }

      // Iterative deepening.
      this.deadline = t0 + timeMs;
      let bestMove = -1, bestScore = 0, bestDepth = 0;
      for (let depth = 2; depth <= maxDepth; depth += 1) {
        this.rootBest = -1; this.rootScore = -INF;
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
        if (now() - t0 > timeMs * 0.4) break; // next iteration would not finish
      }
      if (bestMove < 0 || !this.legal(bestMove, me)) {
        const n = this.genNormal(me, 0, 1);
        bestMove = n > 0 ? this.candBuf[0][0] % 256 : this.anyLegalMove(me);
      }
      this.rootFilter = null;
      return done(bestMove, bestScore, 'search', bestDepth);
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

  /** Worker entry point: handles {id, type:'think', board, color, rule, timeMs}. */
  function workerMain() {
    let engine = null, engineRule = null;
    self.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'think') {
        try {
          if (!engine || engineRule !== msg.rule) { engine = new Engine({ rule: msg.rule }); engineRule = msg.rule; }
          engine.setBoard(msg.board);
          const r = engine.think(msg.color, { timeMs: msg.timeMs });
          r.move = r.move >= 0 ? rc(r.move) : null;
          r.pv = r.pv.map(rc);
          self.postMessage({ id: msg.id, ok: true, result: r });
        } catch (err) {
          self.postMessage({ id: msg.id, ok: false, error: String((err && err.stack) || err) });
        }
      } else if (msg.type === 'ping') {
        self.postMessage({ id: msg.id, ok: true, result: 'pong' });
      }
    };
  }

  return {
    SIZE, N, EMPTY, BLACK, WHITE, WIN, WIN_THRESHOLD, Engine, idx, rc, parseBoard, workerMain,
    SHAPE_NAMES, TABLE_FREE, TABLE_RENJU_BLACK,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createGomokuEngine;

/*
 * Gomoku AI assistant for gomoku.com (online battle + single player, gomoku and renju).
 *
 * Runs in the page's main world (needs window.i18n for the turn label).
 * Reads the position from the DOM, computes a move with the engine in a
 * Web Worker, then either shows a hint on the board or clicks the cell.
 *
 * Expects createGomokuEngine() (src/engine.js) to be defined before this file.
 */
(function () {
  'use strict';
  if (window.__gomokuAI) return;

  const SIZE = 15;
  const COLS = 'ABCDEFGHIJKLMNO';
  const SETTINGS_KEY = 'gomokuAI.settings.v1';
  const DEFAULTS = { mode: 'hint', thinkMs: 1500, delayMs: 600, collapsed: false, x: null, y: null };

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
  const pending = new Map();
  let inlineEngine = null, inlineLib = null;

  function startWorker() {
    if (worker || workerFailed) return;
    try {
      const src = '(' + factory.toString() + ')().workerMain();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const m = e.data || {};
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      };
      worker.onerror = (e) => {
        console.warn('[GomokuAI] worker failed, falling back to main thread', e && e.message);
        workerFailed = true; worker = null;
        for (const p of pending.values()) p.reject(new Error('worker error'));
        pending.clear();
      };
    } catch (e) {
      console.warn('[GomokuAI] cannot create worker (CSP?), using main thread', e);
      workerFailed = true; worker = null;
    }
  }

  function thinkInline(board, color, rule, timeMs) {
    if (!inlineLib) inlineLib = factory();
    if (!inlineEngine || inlineEngine.rule !== rule) inlineEngine = new inlineLib.Engine({ rule, ttBits: 18 });
    inlineEngine.setBoard(board);
    const r = inlineEngine.think(color, { timeMs: Math.min(timeMs, 1200) });
    r.move = r.move >= 0 ? inlineLib.rc(r.move) : null;
    r.pv = r.pv.map(inlineLib.rc);
    return r;
  }

  function think(board, color, rule, timeMs) {
    startWorker();
    if (worker) {
      return new Promise((resolve, reject) => {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type: 'think', board, color, rule, timeMs });
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); }
        }, timeMs + 15000);
      }).catch((err) => {
        if (workerFailed) return thinkInline(board, color, rule, timeMs);
        throw err;
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve(thinkInline(board, color, rule, timeMs)), 0));
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
      kind: found.kind, boardEl, cells, board, black, white, myColor, toMove, rule,
      turnText, gameOver, notStarted, pendingMove, myTurn,
      key: board.map(row => row.join('')).join('') + '|' + myColor + '|' + rule,
    };
  }

  function cellName(rc) { return COLS[rc.col] + (SIZE - rc.row); }

  // ------------------------------------------------------------------ board overlay (hint)
  const STYLE = `
  .gai-hint{position:absolute;left:50%;top:50%;width:78%;height:78%;transform:translate(-50%,-50%);
    border-radius:50%;border:3px solid #e5383b;box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 10px #e5383b;
    pointer-events:none;z-index:30;animation:gai-pulse 1.1s ease-in-out infinite;box-sizing:border-box}
  .gai-hint.gai-auto{border-color:#2b8a3e;box-shadow:0 0 0 2px rgba(255,255,255,.75),0 0 10px #2b8a3e}
  .gai-hint-pv{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 11px/1 system-ui,sans-serif;
    color:#fff;background:rgba(0,0,0,.55);border-radius:8px;padding:2px 4px;pointer-events:none;z-index:29}
  @keyframes gai-pulse{0%,100%{opacity:1}50%{opacity:.45}}
  #gai-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:264px;background:#1f2430;color:#e9edf3;
    border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/1.45 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    user-select:none}
  #gai-panel *{box-sizing:border-box}
  #gai-panel .gai-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;border-bottom:1px solid #313848}
  #gai-panel .gai-title{font-weight:700;flex:1}
  #gai-panel .gai-dot{width:9px;height:9px;border-radius:50%;background:#6b7280}
  #gai-panel .gai-dot.on{background:#40c057}
  #gai-panel .gai-dot.think{background:#fab005}
  #gai-panel button{font:inherit;color:inherit;background:#2c3342;border:1px solid #3a4356;border-radius:6px;padding:3px 8px;cursor:pointer}
  #gai-panel button:hover{background:#364055}
  #gai-panel .gai-body{padding:8px 10px 10px}
  #gai-panel .gai-seg{display:flex;gap:4px;margin-bottom:8px}
  #gai-panel .gai-seg button{flex:1;white-space:nowrap;padding:3px 4px}
  #gai-panel .gai-seg button.active{background:#1c7ed6;border-color:#1c7ed6;color:#fff}
  #gai-panel .gai-row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:4px 0}
  #gai-panel input[type=range]{width:120px}
  #gai-panel .gai-stat{font-variant-numeric:tabular-nums;color:#c3cad6;font-size:12px}
  #gai-panel .gai-move{font-size:18px;font-weight:700;color:#fff}
  #gai-panel .gai-warn{color:#ffa94d;font-size:12px;margin-top:4px}
  #gai-panel.collapsed .gai-body{display:none}
  `;

  let hintEls = [];
  function clearHint() {
    for (const el of hintEls) el.remove();
    hintEls = [];
  }
  function showHint(state, move, pv, auto) {
    clearHint();
    if (!move) return;
    const cell = state.cells.get(move.row * SIZE + move.col);
    if (!cell) return;
    const ring = document.createElement('div');
    ring.className = 'gai-hint' + (auto ? ' gai-auto' : '');
    cell.appendChild(ring);
    hintEls.push(ring);
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
      <div class="gai-head"><span class="gai-dot"></span><span class="gai-title">五子棋 AI 助手</span>
        <button class="gai-collapse" title="折叠/展开">–</button></div>
      <div class="gai-body">
        <div class="gai-seg">
          <button data-mode="off">关闭</button><button data-mode="hint">提示</button><button data-mode="auto">自动下棋</button>
        </div>
        <div class="gai-row"><span>思考时间</span><input class="gai-think" type="range" min="300" max="6000" step="100"><span class="gai-think-v gai-stat"></span></div>
        <div class="gai-row gai-delay-row"><span>落子延迟</span><input class="gai-delay" type="range" min="0" max="4000" step="100"><span class="gai-delay-v gai-stat"></span></div>
        <div class="gai-row"><span>建议落子</span><span class="gai-move">—</span></div>
        <div class="gai-stat gai-status">等待对局开始…</div>
        <div class="gai-stat gai-info"></div>
        <div class="gai-warn" hidden></div>
        <div class="gai-row" style="margin-top:6px"><button class="gai-now">立即计算</button><span class="gai-stat">Alt+A 切换自动</span></div>
      </div>`;
    document.body.appendChild(panel);
    ui = {
      dot: panel.querySelector('.gai-dot'), modeBtns: panel.querySelectorAll('[data-mode]'),
      think: panel.querySelector('.gai-think'), thinkV: panel.querySelector('.gai-think-v'),
      delay: panel.querySelector('.gai-delay'), delayV: panel.querySelector('.gai-delay-v'),
      delayRow: panel.querySelector('.gai-delay-row'),
      move: panel.querySelector('.gai-move'), status: panel.querySelector('.gai-status'),
      info: panel.querySelector('.gai-info'), warn: panel.querySelector('.gai-warn'),
      now: panel.querySelector('.gai-now'), collapse: panel.querySelector('.gai-collapse'),
    };
    ui.think.value = settings.thinkMs;
    ui.delay.value = settings.delayMs;
    ui.modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    ui.think.addEventListener('input', () => { settings.thinkMs = +ui.think.value; saveSettings(); renderSettings(); invalidate(); });
    ui.delay.addEventListener('input', () => { settings.delayMs = +ui.delay.value; saveSettings(); renderSettings(); });
    ui.now.addEventListener('click', () => { invalidate(); schedule(0, true); });
    ui.collapse.addEventListener('click', () => { settings.collapsed = !settings.collapsed; saveSettings(); renderSettings(); });
    makeDraggable(panel, panel.querySelector('.gai-head'));
    if (settings.x !== null && settings.y !== null) placePanel(settings.x, settings.y);
    renderSettings();
  }

  function placePanel(x, y) {
    const w = panel.offsetWidth || 264, h = panel.offsetHeight || 200;
    x = Math.max(0, Math.min(window.innerWidth - w, x));
    y = Math.max(0, Math.min(window.innerHeight - 40, y));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    void h;
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
    ui.dot.className = 'gai-dot' + (busy ? ' think' : (settings.mode !== 'off' ? ' on' : ''));
    panel.classList.toggle('collapsed', !!settings.collapsed);
    ui.collapse.textContent = settings.collapsed ? '+' : '–';
  }

  function setMode(mode) {
    settings.mode = mode; saveSettings();
    invalidate();
    if (mode === 'off') { clearHint(); ui.move.textContent = '—'; }
    renderSettings();
    schedule(0);
  }

  function setStatus(text, info) {
    ui.status.textContent = text;
    if (info !== undefined) ui.info.textContent = info;
  }
  function setWarn(text) {
    ui.warn.hidden = !text; ui.warn.textContent = text || '';
  }

  // ------------------------------------------------------------------ main loop
  let busy = false;          // a search is running
  let lastKey = '';          // position key we already handled
  let lastResult = null;     // { key, result }
  let clickAttempts = 0;
  let lastClickAt = 0;
  let pendingClickKey = null; // position for which a delayed auto-click is scheduled
  let timer = null;

  function invalidate() { lastKey = ''; lastResult = null; clickAttempts = 0; }

  function schedule(ms, force) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tick(!!force); }, ms);
  }

  function colorName(c) { return c === 1 ? '黑' : c === 2 ? '白' : '?'; }

  function formatScore(r) {
    const W = 1000000;
    if (r.score >= W - 200) return '必胜' + (r.reason === 'vct' ? '（连续冲四/活三）' : r.reason === 'vcf' ? '（连续冲四）' : '') + '，' + (W - r.score) + ' 手内';
    if (r.score <= -(W - 200)) return '对方有杀';
    if (r.reason === 'lost') return '对方必胜（无合法防点）';
    if (r.reason === 'block-four') return '挡冲四';
    if (r.reason === 'opening') return '开局';
    const s = Math.max(-9999, Math.min(9999, Math.round(r.score / 10)));
    return (s > 0 ? '+' : '') + s;
  }

  async function tick(force) {
    if (busy) return;
    const st = readState();
    if (!st) { clearHint(); setStatus('未检测到对局棋盘', ''); return; }
    if (settings.mode === 'off') { clearHint(); setStatus('已关闭', ''); return; }
    if (st.gameOver) { clearHint(); invalidate(); setStatus('对局结束', ''); return; }
    if (st.notStarted) { clearHint(); setStatus('请选择难度开始游戏', ''); return; }
    if (!st.myColor) { clearHint(); setStatus('无法识别我方棋色', ''); return; }
    if (st.toMove === 0) { setWarn('棋子数量异常（黑' + st.black + ' 白' + st.white + '），等待同步'); return; }
    setWarn('');
    if (!st.myTurn) {
      if (!lastResult || lastResult.key !== st.key) clearHint();
      setStatus('我方执' + colorName(st.myColor) + '，等待对手…', '');
      return;
    }
    if (st.key === lastKey && !force) {
      // Already handled this position: redraw the hint if it got lost (e.g. a rejected move).
      if (lastResult && lastResult.key === st.key && !hintEls.some(e => e.isConnected)) {
        showHint(st, lastResult.result.move, lastResult.result.pv, settings.mode === 'auto');
      }
      // In auto mode, retry the click if it did not land (but never during the planned delay).
      if (settings.mode === 'auto' && lastResult && lastResult.key === st.key && clickAttempts < 3 &&
          pendingClickKey !== st.key && Date.now() - lastClickAt > 2500) {
        clickAttempts++;
        await placeMove(st, lastResult.result.move);
      }
      return;
    }

    busy = true; renderSettings();
    setStatus('思考中…（执' + colorName(st.myColor) + (st.rule === 'renju' ? '，连珠规则' : '') + '）');
    let res;
    try {
      res = await think(st.board, st.myColor, st.rule, settings.thinkMs);
    } catch (e) {
      busy = false; renderSettings();
      setStatus('计算失败：' + e.message);
      schedule(1500);
      return;
    }
    busy = false; renderSettings();

    // The position may have changed while we were thinking.
    const now = readState();
    if (!now || now.key !== st.key || !now.myTurn || settings.mode === 'off') { schedule(50); return; }
    if (!res.move) { setStatus('没有可下的位置'); return; }

    lastKey = st.key; lastResult = { key: st.key, result: res }; clickAttempts = 0;
    ui.move.textContent = cellName(res.move);
    const pvText = res.pv && res.pv.length > 1 ? '  主变: ' + res.pv.slice(0, 6).map(cellName).join(' ') : '';
    setStatus('执' + colorName(st.myColor) + ' · 评估 ' + formatScore(res),
      '深度 ' + res.depth + ' · ' + (res.nodes / 1000).toFixed(1) + 'k 节点 · ' + res.timeMs + 'ms' + pvText);
    showHint(now, res.move, res.pv, settings.mode === 'auto');

    if (settings.mode === 'auto') {
      pendingClickKey = st.key;
      try {
        const delay = settings.delayMs ? settings.delayMs * (0.6 + Math.random() * 0.8) : 0;
        await sleep(delay);
        const again = readState();
        if (!again || again.key !== st.key || !again.myTurn || settings.mode !== 'auto') return;
        clickAttempts = 1;
        await placeMove(again, res.move);
      } finally {
        pendingClickKey = null;
      }
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function placeMove(st, move) {
    const cell = st.cells.get(move.row * SIZE + move.col);
    if (!cell || st.board[move.row][move.col] !== 0) return;
    clearHint();
    lastClickAt = Date.now();
    cell.click();
    // Small screens use "tap to preview, tap again to confirm".
    await sleep(120);
    if (cell.querySelector('.preview-stone')) cell.click();
    // If nothing happened (e.g. move rejected), the periodic tick retries.
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    buildPanel();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t && t.nodeType === 1 && (t.id === 'gai-panel' || (t.closest && t.closest('#gai-panel')))) continue;
        if (m.type === 'childList') {
          // ignore our own hint ring insertions/removals
          const own = [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.classList && n.classList.contains('gai-hint'));
          if (own) continue;
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

  window.__gomokuAI = { readState, think, setMode, settings, version: '1.1.0' };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
