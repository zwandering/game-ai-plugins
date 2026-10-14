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
  let pendingToken = null;    // identifies the tick that owns pendingClickKey
  let timer = null;

  function invalidate() { lastKey = ''; lastResult = null; clickAttempts = 0; }

  function schedule(ms, force) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tick(!!force); }, ms);
  }

  function colorName(c) { return c === 1 ? '黑' : c === 2 ? '白' : '?'; }

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
      const myToken = {};
      pendingClickKey = st.key;
      pendingToken = myToken;
      try {
        const delay = settings.delayMs ? settings.delayMs * (0.6 + Math.random() * 0.8) : 0;
        await sleep(delay);
        const again = readState();
        if (!again || again.key !== st.key || !again.myTurn || settings.mode !== 'auto') return;
        clickAttempts = 1;
        await placeMove(again, res.move);
      } finally {
        // only clear our own marker: a newer tick may have started its own delay
        if (pendingToken === myToken) { pendingClickKey = null; pendingToken = null; }
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
