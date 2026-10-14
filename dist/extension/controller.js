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
    showHeat: true, showPv: true,
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
  @keyframes gai-pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .gai-ghost{position:absolute;left:50%;top:50%;width:72%;height:72%;transform:translate(-50%,-50%);border-radius:50%;
    display:flex;align-items:center;justify-content:center;font:700 11px/1 system-ui,sans-serif;z-index:28}
  .gai-ghost.b{background:rgba(20,20,24,.55);color:#fff;border:1px solid rgba(255,255,255,.35)}
  .gai-ghost.w{background:rgba(250,250,250,.6);color:#111;border:1px solid rgba(0,0,0,.35)}
  .gai-ghost.end{box-shadow:0 0 0 2px #fab005}
  .gai-heat{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:19px;height:14px;padding:0 3px;border-radius:7px;
    font:700 9px/14px system-ui,sans-serif;text-align:center;color:#fff;z-index:31;box-shadow:0 1px 2px rgba(0,0,0,.4)}
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

  /** Draw everything we know about the current (my-turn) position. */
  function drawOverlays(st, a) {
    clearOverlays();
    if (!a || !a.best || !a.best.move || settings.mode === 'off') return;
    const auto = settings.mode === 'auto';
    const cellAt = (rc) => st.cells.get(rc.row * SIZE + rc.col);
    // continuation (ghost stones), drawn first so the hint ring sits on top
    const ghostCells = new Set();
    if (settings.showPv && !auto && a.pv && a.pv.moves.length > 1) {
      let c = st.myColor;
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
        if (i < HEAT_LABELS) addOverlay(cell, 'gai-heat', String(Math.round(m.win * 100)), { background: heatColor(d) });
        else addOverlay(cell, 'gai-dot', undefined, { background: heatColor(d) });
      });
    }
    const ring = cellAt(a.best.move);
    if (ring) addOverlay(ring, 'gai-hint' + (auto ? ' gai-auto' : ''));
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
        <div class="gai-warn" hidden></div>
        <div class="gai-sep"></div>
        <div class="gai-row">
          <label><input type="checkbox" class="gai-heat-cb">胜率热图</label>
          <label><input type="checkbox" class="gai-pv-cb">后续变化</label>
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
      move: q('.gai-move'), status: q('.gai-status'), info: q('.gai-info'), hover: q('.gai-hover'), warn: q('.gai-warn'),
      heatCb: q('.gai-heat-cb'), pvCb: q('.gai-pv-cb'), now: q('.gai-now'), collapse: q('.gai-collapse'),
    };
    ui.think.value = settings.thinkMs;
    ui.delay.value = settings.delayMs;
    ui.heatCb.checked = !!settings.showHeat;
    ui.pvCb.checked = !!settings.showPv;
    ui.modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    ui.think.addEventListener('input', () => { settings.thinkMs = +ui.think.value; saveSettings(); renderSettings(); });
    ui.think.addEventListener('change', () => { invalidate(); schedule(0); });
    ui.delay.addEventListener('input', () => { settings.delayMs = +ui.delay.value; saveSettings(); renderSettings(); });
    ui.heatCb.addEventListener('change', () => { settings.showHeat = ui.heatCb.checked; saveSettings(); onDisplayToggle(); });
    ui.pvCb.addEventListener('change', () => { settings.showPv = ui.pvCb.checked; saveSettings(); onDisplayToggle(); });
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
    if (!st || !st.myTurn || !analysis || analysis.key !== st.key || settings.mode === 'off' || st.board[r][c]) {
      ui.hover.textContent = ' ';
      return;
    }
    const base = analysis.positionWin;
    const show = (win, note) => {
      ui.hover.textContent = win === null ? `若下 ${name}：${note}` :
        `若下 ${name}：我方胜率 ${pct(win)}（${base !== undefined ? signedPct(win - base) : ''}）${note || ''}`;
    };
    const m = analysis.moves && analysis.moves.find(x => x.row === r && x.col === c);
    if (m) { show(m.win, ''); return; }
    const hk = st.key + '|' + r + ',' + c;
    if (hoverCache.has(hk)) {
      const h = hoverCache.get(hk);
      if (h.legal === false) show(null, '禁手/不可下'); else show(h.win, '');
      return;
    }
    show(null, '计算中…');
    hoverTimer = setTimeout(() => {
      request({ type: 'evalMove', board: st.board, color: st.myColor, rule: st.rule, row: r, col: c, timeMs: 350, key: st.key }, null, 350)
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
  let analysis = null;       // { key, best, moves, positionWin, pv } for my current position
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
      if (!analysis || analysis.key !== st.key) clearOverlays();
      setStatus('我方执' + colorName(st.myColor) + '，等待对手…', st.pendingMove ? '' : undefined);
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

    // A stale opponent-turn evaluation may still be running: it is short, so wait for it.
    if (inFlight(p => p.type === 'evalPosition')) { schedule(100); return; }

    const auto = settings.mode === 'auto';
    const wantAnalysis = !auto && (settings.showHeat || settings.showPv);
    busy = true; renderSettings();
    lastKey = st.key; clickAttempts = 0;
    const a = { key: st.key, best: null, moves: null, positionWin: undefined, pv: null, done: false };
    analysis = a;
    clearOverlays();
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
            if (stillCurrent()) drawOverlays(lastState, a);
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

  /** On the opponent's turn: evaluate the position once for the live win rate. */
  function evaluateOpponentTurn(st) {
    if (evalKey === st.key || st.pendingMove) return;
    if (inFlight(() => true)) { schedule(150); return; }
    evalKey = st.key;
    const opp = 3 - st.myColor;
    request({ type: 'evalPosition', board: st.board, color: opp, rule: st.rule, key: st.key,
      timeMs: Math.min(800, Math.max(300, Math.round(settings.thinkMs / 2))) }, null, 800)
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
        // A position change makes a running (long) analysis useless: cancel it.
        if (busy && analysis && !analysis.done) {
          const st = readState();
          if (st && st.key !== analysis.key && inFlight(p => p.type === 'analyze')) {
            busy = false; analysis = null; lastKey = '';
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
    readState, setMode, settings, version: '1.2.0',
    debug: () => ({ analysis, history: history.map(h => h && Math.round(h.pMe * 1000) / 1000), lastKey, busy }),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
