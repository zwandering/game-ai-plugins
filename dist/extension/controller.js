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
    ponderMaxMs: 600000, // match mode: keep computing one position for at most this long
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
  if (!['off', 'hint', 'match', 'auto'].includes(settings.mode)) settings.mode = 'hint';

  // ------------------------------------------------------------------ match mode (比赛模式)
  // Each side may ask the AI for a move at most MATCH_LIMIT times per game; the
  // live win rate is always shown, everything else (heat map, hover, previews,
  // opponent analysis, auto play) is off. In online games the plugin announces
  // the mode and every hint it uses in the game chat (prefix MATCH_PREFIX), and
  // reads the opponent's announcements, so both players see each other's count.
  // This is a mutual, transparent agreement: a client-side tool cannot stop a
  // player from cheating with other software.
  const MATCH_LIMIT = 3;
  const MATCH_PREFIX = '【AI助手·比赛】';
  const MATCH_KEY = 'gomokuAI.match.v1';
  function loadMatch() {
    try { const raw = localStorage.getItem(MATCH_KEY); if (raw) return JSON.parse(raw); } catch (e) { /* ignore */ }
    return null;
  }
  let match = Object.assign({ room: '', used: 0, oppUsed: 0, oppMatch: false, announced: false, maxStones: 0 }, loadMatch() || {});
  function saveMatch() { try { localStorage.setItem(MATCH_KEY, JSON.stringify(match)); } catch (e) { /* ignore */ } }
  let matchHint = null;   // { key, best } : the hint shown for the current position
  let matchOffer = false; // the opponent announced match mode and we have not joined yet

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
    if (inlineHandler) inlineHandler({ type: 'cancelAll' });
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
  #gai-panel .gai-match{display:none;margin-top:4px;padding:6px 8px;border:1px solid #5c4bc0;border-radius:8px;background:#272240}
  #gai-panel.mode-match .gai-match{display:block}
  #gai-panel.mode-match .gai-hintonly{display:none}
  #gai-panel .gai-match button{width:100%;margin-top:6px;background:#5f3dc4;border-color:#7048e8;color:#fff}
  #gai-panel .gai-match button:disabled{background:#3a3550;border-color:#4a4466;color:#9a94b8;cursor:not-allowed}
  #gai-panel .gai-offer{display:none;margin-top:6px;padding:6px 8px;border-radius:8px;background:#3b2f12;color:#ffd43b;font-size:12px}
  #gai-panel .gai-offer.show{display:block}
  #gai-panel .gai-offer button{margin-top:4px;width:100%}
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
    // By default only the win-rate preview (heat map) is shown. A continuation is
    // drawn only for the cell under the mouse (and the heat map is hidden then).
    const pre = preview && preview.key === a.key && preview.line && preview.line.moves.length > 1 ? preview.line : null;
    const line = pre;
    // continuation (ghost stones), drawn first so the hint ring sits on top
    const ghostCells = new Set();
    if (!auto && line) {
      let c = a.color || st.myColor;
      line.moves.forEach((rc, i) => {
        const cell = cellAt(rc);
        if (cell && st.board[rc.row][rc.col] === 0) {
          const last = i === line.moves.length - 1 && line.winner;
          addOverlay(cell, 'gai-ghost ' + (c === 1 ? 'b' : 'w') + (last ? ' end' : ''), String(i + 1));
          ghostCells.add(rc.row * SIZE + rc.col);
        }
        c = 3 - c;
      });
    }
    // heat map: win rate after each candidate move
    if (settings.showHeat && !auto && a.moves && !pre) {
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
          <button data-mode="off">关闭</button><button data-mode="hint">提示</button><button data-mode="match" title="每方每局最多 3 次 AI 落子建议，胜率一直显示">比赛</button><button data-mode="auto">自动下棋</button>
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
        <div class="gai-match">
          <div class="gai-stat gai-match-text">比赛模式</div>
          <button class="gai-match-btn">求助 AI（剩 3 次）</button>
        </div>
        <div class="gai-offer"><span class="gai-offer-text">对方开启了比赛模式（每方每局最多 3 次 AI 提示）</span>
          <button class="gai-offer-btn">同意并开启比赛模式</button></div>
        <div class="gai-warn" hidden></div>
        <div class="gai-sep"></div>
        <div class="gai-row gai-hintonly">
          <label><input type="checkbox" class="gai-heat-cb">胜率热图</label>
          <label title="鼠标停在某个点上时，在棋盘上画出下在那里的后续变化"><input type="checkbox" class="gai-pv-cb">悬停显示后续</label>
        </div>
        <div class="gai-row gai-hintonly">
          <label title="对方回合时也分析：对方的最佳着法、各点的对方胜率和预计后续（紫色）"><input type="checkbox" class="gai-opp-cb">帮对手计算</label>
        </div>
        <div class="gai-row"><span>思考时间</span><input class="gai-think" type="range" min="300" max="6000" step="100"><span class="gai-think-v gai-stat"></span></div>
        <div class="gai-row gai-delay-row gai-hintonly"><span>落子延迟</span><input class="gai-delay" type="range" min="0" max="4000" step="100"><span class="gai-delay-v gai-stat"></span></div>
        <div class="gai-row gai-hintonly" style="margin-top:6px"><button class="gai-now">立即计算</button><span class="gai-stat">Alt+A 切换自动</span></div>
      </div>`;
    document.body.appendChild(panel);
    const q = (s) => panel.querySelector(s);
    ui = {
      led: q('.gai-led'), modeBtns: panel.querySelectorAll('[data-mode]'),
      winNum: q('.gai-winnum'), winSplit: q('.gai-winsplit'), barFill: q('.gai-barfill'), chart: q('.gai-chart'), last: q('.gai-last'),
      think: q('.gai-think'), thinkV: q('.gai-think-v'), delay: q('.gai-delay'), delayV: q('.gai-delay-v'), delayRow: q('.gai-delay-row'),
      move: q('.gai-move'), status: q('.gai-status'), info: q('.gai-info'), hover: q('.gai-hover'), warn: q('.gai-warn'), alert: q('.gai-alert'),
      heatCb: q('.gai-heat-cb'), pvCb: q('.gai-pv-cb'), oppCb: q('.gai-opp-cb'), now: q('.gai-now'), collapse: q('.gai-collapse'),
      matchText: q('.gai-match-text'), matchBtn: q('.gai-match-btn'), offer: q('.gai-offer'), offerBtn: q('.gai-offer-btn'),
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
    ui.matchBtn.addEventListener('click', () => requestMatchHint());
    ui.offerBtn.addEventListener('click', () => {
      matchOffer = false;
      setMode('match');
      if (settings.mode === 'match' && sendChat(MATCH_PREFIX + '同意比赛模式：每方每局最多' + MATCH_LIMIT + '次AI提示')) { match.announced = true; saveMatch(); }
      renderMatch();
    });
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
    panel.classList.toggle('mode-match', settings.mode === 'match');
    ui.collapse.textContent = settings.collapsed ? '+' : '–';
    renderMatch();
  }

  /** A game is in progress on the page (stones on the board, not finished). */
  function gameInProgress() {
    const st = lastState;
    return !!(st && st.stones > 0 && !st.gameOver && !st.notStarted);
  }

  function setMode(mode) {
    if (settings.mode === 'match' && mode !== 'match' && gameInProgress()) {
      setWarn('比赛进行中：本局结束后才能退出比赛模式');
      return;
    }
    if (settings.mode === 'match' && mode !== 'match' && ponder) { ponder = null; pendingHintKey = null; restartWorker(); }
    if (mode === 'match' && settings.mode !== 'match') {
      matchHint = null;
      // joining in the middle of a game: hints already seen in another mode are not counted
      if (lastState) syncMatchGame(lastState, true);
    }
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
  const hoverCache = new Map(); // key + '|' + cell -> result (value and continuation)
  let hoverCell = null, hoverTimer = null, hoverBoardEl = null;
  let preview = null;           // { key, rc, line } : continuation shown for the hovered cell

  /** Analysis object for the side to move in the current position, if any. */
  function currentAnalysis() {
    const st = lastState;
    const a = st && (st.myTurn ? analysis : oppAnalysis);
    return a && a.key === st.key ? a : null;
  }
  function setPreview(p) {
    preview = p;
    const a = currentAnalysis();
    if (a && lastState) drawOverlays(lastState, a);
    if (!p && a) ui.info.textContent = a.info || '';
  }

  function attachHover(boardEl) {
    if (hoverBoardEl === boardEl) return;
    hoverBoardEl = boardEl;
    boardEl.addEventListener('mouseover', (e) => {
      const cell = e.target.closest && e.target.closest('.board-intersection');
      if (!cell || cell === hoverCell) return;
      hoverCell = cell;
      showHover(cell);
    });
    boardEl.addEventListener('mouseleave', () => {
      hoverCell = null; ui.hover.textContent = ' ';
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (preview) setPreview(null);
    });
  }

  function showHover(cell) {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    if (settings.mode === 'match') { ui.hover.textContent = '\u00a0'; return; }
    const st = lastState;
    const r = +cell.dataset.row, c = +cell.dataset.col;
    const name = cellName({ row: r, col: c });
    const a = st && (st.myTurn ? analysis : oppAnalysis);
    if (!st || !a || a.key !== st.key || settings.mode === 'off' || st.board[r][c]) {
      ui.hover.textContent = ' ';
      if (preview) setPreview(null);
      return;
    }
    const lineText = (ln) => (ln && ln.moves.length > 1)
      ? (a.side === 'opp' ? '若对方下 ' : '若下 ') + name + ' 后续: ' + ln.moves.map(cellName).join(' ') + (ln.winner ? '（' + colorName(ln.winner) + '胜）' : '')
      : '';
    // the recommended move already has its continuation
    const isBest = a.best && a.best.move && a.best.move.row === r && a.best.move.col === c;
    const showLine = (ln) => {
      if (settings.mode === 'auto' || !settings.showPv) return;
      setPreview(ln ? { key: st.key, rc: { row: r, col: c }, line: ln } : null);
      if (ln && ln.moves.length > 1) ui.info.textContent = lineText(ln);
    };
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
    const hk = st.key + '|' + r + ',' + c;
    const cached = hoverCache.get(hk);
    if (isBest && a.pv) { if (m) show(m.win, '', m.score); showLine(a.pv); return; }
    if (cached) {
      if (cached.legal === false) { show(null, '禁手/不可下'); showLine(null); }
      else { show(m ? m.win : cached.win, '', m ? m.score : cached.score); showLine(cached.line); }
      return;
    }
    if (m) show(m.win, '（正在推演后续…）', m.score); else show(null, '计算中…');
    showLine(null);
    hoverTimer = setTimeout(() => {
      request({ type: 'evalMove', board: st.board, color: a.color || st.myColor, rule: st.rule, row: r, col: c, timeMs: 350, key: st.key,
        line: true, plies: 8, pvMs: Math.max(60, Math.min(150, Math.round(settings.thinkMs / 15))) }, null, 2000)
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

    if (settings.mode === 'match') { matchTick(st); return; }

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

    if (inFlight(p => p.key !== st.key && (p.type === 'evalPosition' || p.type === 'analyze' || p.type === 'ponder'))) {
      // A stale opponent-turn evaluation is still running. Auto mode waits (it is
      // short and keeps the engine's caches); hint mode cancels it.
      if (settings.mode === 'auto') { schedule(100); return; }
      restartWorker();
    }

    const auto = settings.mode === 'auto';
    const wantAnalysis = !auto && (settings.showHeat || settings.showPv);
    busy = true; renderSettings();
    lastKey = st.key; clickAttempts = 0;
    preview = null;
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
      a.info = '深度 ' + res.depth + ' · ' + (res.nodes / 1000).toFixed(1) + 'k 节点 · ' + res.timeMs + 'ms' +
        (settings.showPv && settings.mode !== 'auto' ? ' · 鼠标停在点上可看后续变化' : '');
      setStatus('执' + colorName(st.myColor) + ' · 评估 ' + formatScore(res), preview ? undefined : a.info);
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
            a.pv = res; // kept for an instant preview when the recommended move is hovered
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

  // ------------------------------------------------------------------ match mode logic
  function roomIdOf(st) {
    if (st.kind !== 'online') return 'single';
    const el = document.getElementById('room-id');
    const m = el && /#\s*([\w-]+)/.exec(el.textContent || '');
    return m ? m[1] : 'online';
  }

  /** Post a message in the game chat through the page's own chat box. Returns true if it was sent. */
  function sendChat(text) {
    const st = lastState;
    if (!st || st.kind !== 'online') return false;
    const input = document.getElementById('chat-input'), btn = document.getElementById('send-message');
    if (!input || !btn) return false;
    const draft = input.value;           // keep whatever the user was typing
    input.value = text;
    btn.click();                         // the page sends it (and applies its own mute rules)
    const sent = input.value !== text;   // the page clears the box after sending
    input.value = draft;
    return sent;
  }

  /** Track which game the hint counter belongs to; a new game resets it. */
  function syncMatchGame(st, joining) {
    const room = roomIdOf(st);
    const newGame = match.room !== room || (st.stones <= 1 && match.maxStones > 1) || joining;
    if (newGame) {
      match = { room, used: 0, oppUsed: 0, oppMatch: match.room === room && !(st.stones <= 1) ? match.oppMatch : false,
        announced: false, maxStones: st.stones };
      matchHint = null;
      saveMatch();
    } else if (st.stones > match.maxStones) { match.maxStones = st.stones; saveMatch(); }
  }

  /** Read the opponent's match-mode announcements from the game chat. */
  let chatSocket = null;
  function attachChat() {
    const sock = window.socket;
    if (!sock || sock === chatSocket || typeof sock.on !== 'function') return;
    chatSocket = sock;
    sock.on('chat-message', (data) => {
      if (!data || typeof data.message !== 'string' || !data.message.startsWith(MATCH_PREFIX)) return;
      if (data.playerId && sock.id && data.playerId === sock.id) return; // our own message
      const msg = data.message;
      if (/开启了?比赛模式|同意比赛模式/.test(msg)) {
        match.oppMatch = true;
        if (settings.mode !== 'match' && /开启了?比赛模式/.test(msg)) matchOffer = true;
      }
      const used = /已使用AI提示\s*(\d+)\s*\/\s*(\d+)/.exec(msg);
      if (used) { match.oppMatch = true; match.oppUsed = Math.min(MATCH_LIMIT, +used[1]); }
      saveMatch();
      renderMatch();
    });
  }

  function renderMatch() {
    if (!ui.matchText) return;
    ui.offer.classList.toggle('show', !!matchOffer && settings.mode !== 'match');
    if (settings.mode !== 'match') return;
    const st = lastState;
    const left = MATCH_LIMIT - match.used;
    const online = st && st.kind === 'online';
    const opp = !online ? '' : match.oppMatch ? ' · 对方已用 ' + match.oppUsed + '/' + MATCH_LIMIT : ' · 尚未收到对方的比赛模式确认';
    ui.matchText.textContent = '比赛模式：每方每局最多 ' + MATCH_LIMIT + ' 次 AI 提示 · 我方已用 ' + match.used + '/' + MATCH_LIMIT + opp;
    const shown = matchHint && st && matchHint.key === st.key;
    const waiting = st && pendingHintKey === st.key;
    ui.matchBtn.disabled = !st || !st.myTurn || left <= 0 || busy || shown || waiting || st.gameOver;
    ui.matchBtn.textContent = left <= 0 ? '本局 AI 提示已用完' : shown ? 'AI 建议已显示' : waiting ? 'AI 思考中…' : '求助 AI（剩 ' + left + ' 次）';
  }

  function matchTick(st) {
    attachChat();
    syncMatchGame(st, false);
    if (st.kind === 'online' && !match.announced && st.myColor) {
      if (sendChat(MATCH_PREFIX + '我开启了比赛模式：每方每局最多' + MATCH_LIMIT + '次AI提示，胜率实时显示')) { match.announced = true; saveMatch(); }
    }
    // only the hint that was paid for is drawn, nothing else
    if (matchHint && matchHint.key === st.key) {
      if (overlaysLost() || overlayEls.length === 0) drawOverlays(st, { key: st.key, side: 'me', color: st.myColor, best: matchHint.best, moves: null, pv: null });
    } else { clearOverlays(); setAlert(''); }
    if (!(matchHint && matchHint.key === st.key) && pendingHintKey !== st.key) {
      setStatus(ponderStatus(st), '胜率在下一手落下前持续计算、实时更新；需要时点“求助 AI”');
      ui.move.textContent = '—';
    }
    startPonder(st, st.myTurn ? st.myColor : 3 - st.myColor);
    renderMatch();
  }

  // ------------------------------------------------------------------ continuous computation (match mode)
  // Until the next stone is played, the side to move's position is searched
  // again and again with doubling time budgets; every round refines the live
  // win rate. The move it finds is kept hidden (it serves a paid hint).
  let ponder = null;          // { key, color, latest, done }
  let pendingHintKey = null;  // a hint was requested before the first round finished

  function ponderStatus(st) {
    const base = st.myTurn ? '比赛模式 · 轮到我方' : '比赛模式 · 对方思考中';
    const pd = ponder && ponder.key === st.key ? ponder : null;
    if (!pd || !pd.latest) return base + ' · 计算中…';
    const secs = Math.max(1, Math.round(pd.latest.elapsed / 1000));
    return base + ' · ' + (pd.done ? '已算完' : '已持续计算') + ' ' + secs + ' 秒（深度 ' + pd.latest.depth + '）';
  }

  function startPonder(st, color) {
    if (st.pendingMove) return;
    if (ponder && ponder.key === st.key && ponder.color === color) return;
    startWorker();
    if (workerFailed) { quickEval(st, color); return; }  // no worker: a long search would freeze the page
    // anything still running belongs to an older position
    if (inFlight(p => p.key !== st.key)) restartWorker();
    else if (inFlight(() => true)) { schedule(150); return; }
    const pd = { key: st.key, color, latest: null, done: false };
    ponder = pd;
    const maxMs = Math.max(5000, settings.ponderMaxMs || 600000);
    request({ type: 'ponder', board: st.board, color, rule: st.rule, key: st.key, firstMs: settings.thinkMs, maxMs },
      (stage, res) => {
        if (stage !== 'ponder' || ponder !== pd) return;
        pd.latest = res;
        const pMe = st.myColor === 1 ? res.winBlack : 1 - res.winBlack;
        recordWin(st.stones, st.key, pMe);
        if (pendingHintKey === st.key && color === st.myColor) { pendingHintKey = null; useMatchHint(st, res); }
        if (lastState && lastState.key === st.key && !(matchHint && matchHint.key === st.key)) setStatus(ponderStatus(lastState));
        renderMatch();
      }, maxMs + 60000)
      .then(() => { if (ponder === pd) { pd.done = true; if (lastState && lastState.key === st.key && !(matchHint && matchHint.key === st.key)) setStatus(ponderStatus(lastState)); } })
      .catch(() => { if (ponder === pd) ponder = null; });
  }

  /**
   * Spend one of the hints. The move comes from the continuous computation of
   * this position (the deepest round so far), so the longer you think first,
   * the stronger the hint; if no round has finished yet, the first one is used.
   */
  function requestMatchHint() {
    const st = readState();
    if (!st || !st.myTurn || settings.mode !== 'match') return;
    syncMatchGame(st, false);
    if (match.used >= MATCH_LIMIT || (matchHint && matchHint.key === st.key) || pendingHintKey === st.key) { renderMatch(); return; }
    const pd = ponder && ponder.key === st.key && ponder.color === st.myColor ? ponder : null;
    if (pd && pd.latest && pd.latest.move) { useMatchHint(st, pd.latest); return; }
    pendingHintKey = st.key;
    setStatus('AI 思考中…（比赛模式，第 ' + (match.used + 1) + '/' + MATCH_LIMIT + ' 次）');
    if (workerFailed) {
      // no continuous computation without a worker: one ordinary search
      request({ type: 'think', board: st.board, color: st.myColor, rule: st.rule, key: st.key, timeMs: settings.thinkMs }, null, settings.thinkMs)
        .then((res) => { if (pendingHintKey === st.key) { pendingHintKey = null; useMatchHint(st, res); } renderMatch(); })
        .catch(() => { if (pendingHintKey === st.key) pendingHintKey = null; renderMatch(); });
    } else if (!pd) startPonder(st, st.myColor);
    renderMatch();
  }

  function useMatchHint(st, res) {
    if (!res.move) return;
    const now = readState();
    if (!now || now.key !== st.key || !now.myTurn) return; // the position changed meanwhile: nothing spent
    match.used += 1; saveMatch();
    matchHint = { key: st.key, best: res };
    drawOverlays(now, { key: st.key, side: 'me', color: st.myColor, best: res, moves: null, pv: null });
    ui.move.textContent = cellName(res.move);
    const secs = Math.max(1, Math.round((res.elapsed || 0) / 1000));
    setStatus('AI 建议：' + cellName(res.move) + '（第 ' + match.used + '/' + MATCH_LIMIT + ' 次提示 · 基于 ' + secs + ' 秒计算，深度 ' + res.depth + '）', '');
    sendChat(MATCH_PREFIX + '我已使用AI提示 ' + match.used + '/' + MATCH_LIMIT);
    renderMatch();
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
      preview = null;
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
          oa.info = settings.showPv ? '鼠标停在点上可看对方下在那里的后续变化' : '';
          if (current() && !preview) ui.info.textContent = oa.info;
          if (res.win !== null && res.win !== undefined) { oa.positionWin = res.win; oa.bestScore = res.score; recordWin(st.stones, st.key, 1 - res.win); }
          if (current()) { drawOverlays(lastState, oa); schedule(0); }
        } else if (stage === 'moves') {
          oa.moves = res.moves; oa.positionWin = res.positionWin; oa.bestScore = res.bestScore;
          recordWin(st.stones, st.key, 1 - res.positionWin);
          if (current()) { drawOverlays(lastState, oa); setAlert(opponentAlert(oa)); schedule(0); }
        } else if (stage === 'pv') {
          oa.pv = res; // kept for an instant preview when the opponent's best move is hovered
        }
      }, thinkMs * 3)
        .then(() => { oa.done = true; schedule(0); })
        .catch(() => { if (evalKey === st.key) evalKey = ''; });
      return;
    }
    evalKey = '';
    quickEval(st, opp);
  }

  /**
   * Quick evaluation of the position for the side to move `color`, only for the
   * live win rate (once per position). In match mode the engine's preferred move
   * is never shown.
   */
  function quickEval(st, color) {
    if (evalKey === st.key || st.pendingMove) return;
    if (inFlight(() => true)) { schedule(150); return; }
    evalKey = st.key;
    request({ type: 'evalPosition', board: st.board, color, rule: st.rule, key: st.key,
      // hint/match mode: same think time as on my turn, so both turns' estimates are
      // comparable; auto mode: keep it short so it never delays our own move
      timeMs: settings.mode === 'auto' ? Math.min(800, Math.max(300, Math.round(settings.thinkMs / 2))) : Math.min(2500, settings.thinkMs) }, null, 2500)
      .then((res) => {
        const pMe = st.myColor === 1 ? res.winBlack : 1 - res.winBlack;
        recordWin(st.stones, st.key, pMe); // valid for that position even if the game moved on
        if (settings.mode !== 'match' && color !== st.myColor && lastState && lastState.key === st.key && res.move) {
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
        if (inFlight(p => p.type === 'analyze' || p.type === 'ponder')) {
          const st = readState();
          if (st && inFlight(p => (p.type === 'analyze' || p.type === 'ponder') && p.key !== st.key)) {
            if (ponder && ponder.key !== st.key) ponder = null;
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
        if (settings.mode === 'match') return; // no shortcut out of match mode
        setMode(settings.mode === 'auto' ? 'hint' : 'auto');
      }
    });
    attachChat();
    schedule(300);
  }

  window.__gomokuAI = {
    readState, setMode, settings, version: '1.6.0',
    debug: () => ({ match, matchHint, ponder, analysis, history: history.map(h => h && Math.round(h.pMe * 1000) / 1000), lastKey, busy }),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
