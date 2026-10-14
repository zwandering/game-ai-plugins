/*
 * Gomoku AI engine (15x15), self-contained, no dependencies.
 *
 * - Freestyle gomoku (five or more in a row wins) and Renju (black: exactly
 *   five wins; overline / double-four / double-three are forbidden for black).
 * - Incremental pattern evaluation: for every empty cell and every direction we
 *   keep the shape that a stone of each colour would create there (five, open
 *   four, four, open three, ...).  Shapes come from a 3^8 lookup table built at
 *   start-up by brute force, so the threat semantics are exact per line.
 * - Iterative-deepening negamax with alpha-beta, transposition table (Zobrist),
 *   threat-based forced-move pruning, a small quiescence on open-three threats,
 *   and VCF (victory by continuous fours) search at the root and at leaves,
 *   for both sides.
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

  // Shapes a stone would create in one direction, weakest to strongest.
  const S_NONE = 0, S_TWO = 1, S_OPEN_TWO = 2, S_THREE = 3, S_OPEN_THREE = 4,
    S_FOUR = 5, S_OPEN_FOUR = 6, S_FIVE = 7, S_OVERLINE = 8;
  const SHAPE_NAMES = ['none', 'two', 'open-two', 'three', 'open-three', 'four', 'open-four', 'five', 'overline'];

  // Per-direction value of a shape (used for move ordering and evaluation).
  const SHAPE_VALUE = [0, 4, 14, 30, 300, 400, 5000, 200000, 0];
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

  // ------------------------------------------------------------------ tables
  // key = sum(v_i * 3^i), i = 0..3 are offsets -4..-1, i = 4..7 are offsets +1..+4
  // v = 0 empty, 1 own stone, 2 opponent stone or board edge.
  function buildShapeTable(exactFive) {
    const table = new Uint8Array(6561);
    const ln = new Uint8Array(9);
    function fiveShape() {
      let l = 4, r = 4;
      while (l > 0 && ln[l - 1] === 1) l--;
      while (r < 8 && ln[r + 1] === 1) r++;
      const len = r - l + 1;
      if (exactFive) return len === 5 ? S_FIVE : (len > 5 ? S_OVERLINE : S_NONE);
      return len >= 5 ? S_FIVE : S_NONE;
    }
    function fourCount() {
      let c = 0;
      for (let q = 0; q < 9; q++) {
        if (ln[q] !== 0) continue;
        ln[q] = 1;
        if (fiveShape() === S_FIVE) c++;
        ln[q] = 0;
      }
      return c;
    }
    function shapeOf(depth) {
      const f = fiveShape();
      if (f !== S_NONE) return f;
      const fc = fourCount();
      if (fc >= 2) return S_OPEN_FOUR;
      if (fc === 1) return S_FOUR;
      if (depth >= 2) return S_NONE;
      let best = S_NONE;
      for (let q = 0; q < 9; q++) {
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
    for (let key = 0; key < 6561; key++) {
      let k = key;
      for (let i = 0; i < 8; i++) {
        const v = k % 3; k = (k - v) / 3;
        ln[i < 4 ? i : i + 1] = v;
      }
      ln[4] = 1;
      table[key] = shapeOf(0);
    }
    return table;
  }

  const TABLE_FREE = buildShapeTable(false);
  const TABLE_RENJU_BLACK = buildShapeTable(true);

  // Neighbour table: NBR[((d * N) + p) * 8 + i] = cell index, or -1 off-board.
  const NBR = new Int16Array(4 * N * 8);
  // Cells within Chebyshev distance 2 (candidate generation).
  const NEAR = new Int16Array(N * 24);
  const NEAR_CNT = new Uint8Array(N);
  (function initGeometry() {
    for (let p = 0; p < N; p++) {
      const r = (p / SIZE) | 0, c = p % SIZE;
      for (let d = 0; d < 4; d++) {
        const dr = DIRS[d][0], dc = DIRS[d][1];
        for (let i = 0; i < 8; i++) {
          const off = i < 4 ? i - 4 : i - 3; // -4..-1, +1..+4
          const rr = r + dr * off, cc = c + dc * off;
          NBR[((d * N) + p) * 8 + i] = (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) ? -1 : rr * SIZE + cc;
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
      // search scratch
      this.candBuf = [];
      for (let i = 0; i <= MAX_PLY + 2; i++) this.candBuf.push(new Float64Array(N));
      this.nodes = 0; this.vcfNodes = 0;
      this.deadline = Infinity; this.aborted = false;
      this.rootBest = -1; this.rootScore = -INF;
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
      const base = ((d * N) + q) * 8;
      const board = this.board;
      let key = 0, mul = 1;
      for (let i = 0; i < 8; i++) {
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
            else if (s === S_FOUR) fours++;
            else if (s === S_OPEN_THREE) openThrees++;
          }
          if (five) { cat = CAT_FIVE; }
          else if (renju && ci === 0 && (overline || fours >= 2 || openThrees >= 2)) { score = 0; cat = CAT_NONE; } // forbidden for black
          else if (openFour || fours >= 2) { cat = CAT_WIN2; if (fours >= 2) score += BONUS_DOUBLE_FOUR; }
          else if (fours >= 1) { cat = CAT_FOUR; if (openThrees >= 1) score += BONUS_FOUR_THREE; }
          else if (openThrees >= 1) { cat = CAT_OPEN_THREE; if (openThrees >= 2) score += BONUS_DOUBLE_THREE; }
        }
        if (score !== oldScore) { this.total[ci] += score - oldScore; this.score[sIdx] = score; }
        if (cat !== oldCat) { this.catCount[ci * 5 + oldCat]--; this.catCount[ci * 5 + cat]++; this.cat[sIdx] = cat; }
      }
    }

    /** Update every empty cell whose line windows include p. */
    updateAround(p) {
      const board = this.board, shape = this.shape;
      for (let d = 0; d < 4; d++) {
        const base = ((d * N) + p) * 8;
        for (let i = 0; i < 8; i++) {
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

    /** Renju: is black forbidden to play at p? (false for occupied cells and in freestyle) */
    isForbidden(p) {
      if (this.rule !== 'renju' || this.board[p] !== EMPTY) return false;
      let fours = 0, openThrees = 0;
      for (let d = 0; d < 4; d++) {
        const s = this.shape[d * N + p];
        if (s === S_FIVE) return false;
        if (s === S_OVERLINE) return true;
        if (s === S_FOUR || s === S_OPEN_FOUR) fours++;
        else if (s === S_OPEN_THREE) openThrees++;
      }
      return fours >= 2 || openThrees >= 2;
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
      if (ply - rootPly >= maxPly || this.vcfNodes <= 0) return 0;
      if (this.catCount[mi * 5 + CAT_FOUR] === 0) return 0;
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
              // If the block makes a five for the opponent... impossible (no prior four). Continue.
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
      return 0;
    }

    /** Run a bounded VCF for colour c from the current position (c to move). */
    findVcf(c, nodes, maxPly) {
      this.vcfNodes = nodes; this.vcfMove = -1;
      const r = this.vcf(c, 0, maxPly, 0);
      return r ? { plies: r, move: this.vcfMove } : null;
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
      // Root: restrict to the moves the caller allows (e.g. moves that stop an opponent VCF).
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

    /**
     * Choose a move for colour `me`.
     * opts: { timeMs (default 1500), maxDepth (default 16) }
     * Returns { move, score, depth, nodes, timeMs, pv, reason } with cell indices.
     */
    think(me, opts) {
      opts = opts || {};
      const timeMs = opts.timeMs || 1500;
      const maxDepth = opts.maxDepth || 16;
      const t0 = now();
      const opp = 3 - me, mi = me - 1, oi = opp - 1;
      this.nodes = 0; this.aborted = false; this.gen = (this.gen + 1) & 255;
      this.rootFilter = null; this.rootWidth = 24; this.leafVcfNodes = 60;
      this.deadline = Infinity;
      const done = (move, score, reason, depth) => ({
        move, score, reason, depth: depth || 0, nodes: this.nodes,
        timeMs: Math.round(now() - t0), pv: this.extractPv(me, move),
      });

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
        if (bestP < 0) bestP = this.firstCellWithCat(opp, CAT_FIVE);
        return done(bestP, this.catCount[oi * 5 + CAT_FIVE] >= 2 ? -WIN : 0, 'block-four', 1);
      }
      if (this.catCount[mi * 5 + CAT_WIN2] > 0) return done(this.firstCellWithCat(me, CAT_WIN2), WIN - 3, 'open-four', 3);

      // Own VCF at the root (deep, generous budget).
      const own = this.findVcf(me, opts.vcfNodes || 40000, 30);
      if (own && own.move >= 0) return done(own.move, WIN - own.plies, 'vcf', own.plies);

      // Opponent VCF threat: only consider moves after which it disappears.
      // Checked if the opponent has any four-making cell (a VCF needs one).
      if (this.catCount[oi * 5 + CAT_FOUR] > 0 || this.catCount[oi * 5 + CAT_WIN2] > 0) {
        const threat = this.findVcf(opp, 20000, 24);
        if (threat) {
          const safe = new Set();
          const n = this.genNormal(me, 0, 60);
          const t1 = now();
          for (let i = 0; i < n && now() - t1 < timeMs * 0.3; i++) {
            const p = this.candBuf[0][i] % 256;
            this.play(p, me);
            const still = this.findVcf(opp, 6000, 24);
            this.undo();
            if (!still) safe.add(p);
          }
          if (safe.size > 0) { this.rootFilter = safe; this.rootWidth = 60; }
        }
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
      if (bestMove < 0 || this.board[bestMove] !== EMPTY) {
        const n = this.genNormal(me, 0, 1);
        bestMove = n > 0 ? this.candBuf[0][0] % 256 : this.firstEmpty();
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
