/* WikiRace 助手 —— 页面端：识别对局、收集当前文章的链接、高亮推荐、显示面板。
 * 只做提示，不会替你点击。依赖 core.js 暴露的 WikiRaceCore。
 */
(function () {
  'use strict';
  if (window.__wikiraceHelper) return;
  window.__wikiraceHelper = true;

  const core = window.WikiRaceCore;
  const SHOW_TOP = 8;
  const SETTINGS_KEY = 'wikiraceHelper.settings.v1';
  const TIER_LABEL = { 0: '直达', 1: '2 步', 2: '3 步' };
  const MATCH_ASKS = 1;   // 比赛模式每局能询问的次数
  const USED_KEY = 'wikiraceHelper.matchUsed.';

  const settings = loadSettings();
  function loadSettings() {
    const d = { highlight: true, collapsed: false, hidden: false, x: null, y: null, mode: 'hint' };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { return d; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 隐私模式等 */ }
  }

  const solver = core.createSolver({
    fetch: url => fetch(url, { credentials: 'omit' }),
    parseHTML: html => new DOMParser().parseFromString(html, 'text/html'),
  });

  // ---------- 对局识别 ----------
  function readGame() {
    const article = document.querySelector('.wiki-content .mw-parser-output') || document.querySelector('.wiki-content');
    if (!article) return null;
    const params = new URLSearchParams(location.search);
    const lang = (params.get('language') || params.get('lang') || 'en').replace(/[^a-z-]/gi, '') || 'en';
    const urlEnd = (params.get('end') || '').trim();
    const goalEl = document.querySelector('.timer-goal-text');
    const goalText = goalEl ? goalEl.textContent.trim() : '';
    let target = '';
    if (urlEnd && goalText.includes(urlEnd)) target = urlEnd;
    else if (goalText) target = goalText.replace(/^\s*(goal|target|destination|ziel|objectif|objetivo|meta|目标|目標|목표)\s*[:：]\s*/i, '');
    else target = urlEnd;
    if (manualTarget) target = manualTarget;
    const h1 = document.querySelector('.wiki-article h1.wiki-title, h1.wiki-title');
    const current = h1 ? h1.textContent.trim() : '';
    return { article, lang, target: core.normTitle(target), current: core.normTitle(current), start: params.get('start') || '' };
  }

  let manualTarget = '';
  try { manualTarget = sessionStorage.getItem('wikiraceHelper.manualTarget') || ''; } catch (e) { /* ignore */ }

  // ---------- 状态 ----------
  let gameKey = '';
  let visited = new Set();
  let pageKey = '';
  let signal = null;
  let lastResult = null;
  let targetState = null;
  let anchorsByTitle = new Map();
  let reevalTimer = null;
  let lastEmitSig = '';
  let revealedPageKey = '';   // 比赛模式下，本页已经用询问揭晓过
  let inGame = false;         // 正在一局里（有文章、还没到达目标）

  // ---------- 比赛模式：每局只能询问 MATCH_ASKS 次 ----------
  // 次数存在 sessionStorage 里，刷新页面不会重置；到达目标后清零。
  const isMatch = () => settings.mode === 'match';
  const revealed = () => !isMatch() || (pageKey !== '' && revealedPageKey === pageKey);
  function usedAsks() {
    try { return +(sessionStorage.getItem(USED_KEY + gameKey) || 0); } catch (e) { return 0; }
  }
  function setUsedAsks(n) {
    try { if (n) sessionStorage.setItem(USED_KEY + gameKey, String(n)); else sessionStorage.removeItem(USED_KEY + gameKey); } catch (e) { /* ignore */ }
  }
  function ask() {
    if (!isMatch() || revealed() || !gameKey || usedAsks() >= MATCH_ASKS) return;
    setUsedAsks(usedAsks() + 1);
    revealedPageKey = pageKey;
    showResult();
  }
  function showResult() {
    renderModes();
    if (!revealed()) { clearHighlights(); renderLocked(); renderStatus(); return; }
    renderList(lastResult);
    highlight(lastResult);
  }

  function onTargetChange(st) {
    renderStatus();
    // 反链 / 第二圈加载完成后，如果当前还没找到 2 步以内的路线，重新算一遍（有缓存，很便宜）。
    const sig = `${st.backlinksDone}|${st.b2Total && st.b2Done >= st.b2Total}`;
    if (sig !== lastEmitSig) {
      lastEmitSig = sig;
      const best = lastResult && lastResult.ranked[0];
      if (lastResult && lastResult.done && (!best || best.tier > 1)) scheduleReeval();
    }
  }

  function scheduleReeval() {
    clearTimeout(reevalTimer);
    reevalTimer = setTimeout(() => { pageKey = ''; tick(); }, 300);
  }

  function tick() {
    const g = readGame();
    if (!g || !g.target) {
      if (inGame) { inGame = false; renderModes(); }
      setVisible(!!g);
      if (g && !g.target) renderNeedTarget();
      return;
    }
    setVisible(true);
    const gk = g.lang + '|' + g.target + '|' + g.start;
    if (gk !== gameKey) {
      gameKey = gk;
      visited = new Set();
      lastEmitSig = '';
      targetState = solver.setTarget(g.lang, g.target, onTargetChange);
      targetState.ready.catch(err => renderError('目标加载失败：' + err.message));
    }
    const reached = !!(targetState && g.current && targetState.R.has(g.current));
    if (reached && usedAsks()) setUsedAsks(0);   // 这一局结束，下一局（哪怕同一条路线）重新计数
    if (inGame !== !reached) { inGame = !reached; renderModes(); }
    const links = core.collectLinks(g.article, a => a.classList.contains('wiki-inert-link') || !!a.closest('.wrh-ignore'));
    const pk = gk + '|' + g.current + '|' + links.size;
    if (pk === pageKey) return;
    pageKey = pk;
    cycle = 0;
    if (g.current) visited.add(g.current);
    indexAnchors(g.article);
    if (signal) signal.aborted = true;
    const mySignal = signal = { aborted: false };
    lastResult = null;
    clearHighlights();
    showResult();
    const list = [...links].map(([title, info]) => Object.assign({ title }, info));
    solver.evaluate(g.lang, g.current, list, {
      signal: mySignal,
      visited,
      onUpdate: res => { if (!mySignal.aborted) { lastResult = res; if (revealed()) { renderList(res); highlight(res); } else renderStatus(); } },
    }).catch(err => { if (!mySignal.aborted) renderError('计算失败：' + err.message); });
  }

  function indexAnchors(article) {
    anchorsByTitle = new Map();
    for (const a of article.querySelectorAll('a[href^="/wiki/"]')) {
      const t = core.hrefToTitle(a.getAttribute('href'));
      if (!t) continue;
      if (!anchorsByTitle.has(t)) anchorsByTitle.set(t, []);
      anchorsByTitle.get(t).push(a);
    }
  }

  // ---------- 文章内高亮 ----------
  const HL_CLASSES = ['wrh-t0', 'wrh-t1', 'wrh-t2', 'wrh-top'];
  function clearHighlights() {
    document.querySelectorAll('.wrh-hl').forEach(a => {
      a.classList.remove('wrh-hl', ...HL_CLASSES);
      a.removeAttribute('data-wrh-badge');
    });
  }

  function highlight(res) {
    clearHighlights();
    if (!settings.highlight || !res) return;
    res.ranked.slice(0, SHOW_TOP).forEach((c, i) => {
      for (const a of anchorsFor(c)) {
        a.classList.add('wrh-hl', c.tier <= 2 ? 'wrh-t' + c.tier : 'wrh-top');
        a.setAttribute('data-wrh-badge', String(i + 1));
      }
    });
  }

  function anchorsFor(c) {
    return [c.title, ...(c.aliases || [])].flatMap(t => anchorsByTitle.get(t) || []);
  }

  function jumpTo(c) {
    const anchors = anchorsFor(c).filter(a => a.isConnected)
      .sort((x, y) => x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    if (!anchors.length) return;
    // 优先跳到当前视口下方最近的一处
    const a = anchors.find(x => x.getBoundingClientRect().top > 80) || anchors[0];
    a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    a.classList.remove('wrh-flash');
    void a.offsetWidth;
    a.classList.add('wrh-flash');
    setTimeout(() => a.classList.remove('wrh-flash'), 2200);
  }

  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
    a.wrh-hl { border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    a.wrh-t0 { background: rgba(250, 204, 21, .45) !important; outline: 2px solid #d97706; }
    a.wrh-t1 { background: rgba(34, 197, 94, .28) !important; outline: 2px solid #16a34a; }
    a.wrh-t2 { background: rgba(59, 130, 246, .22) !important; outline: 1.5px solid #2563eb; }
    a.wrh-top { outline: 1.5px dashed #9333ea; }
    a.wrh-hl[data-wrh-badge]::after {
      content: attr(data-wrh-badge); display: inline-block; margin-left: 2px; padding: 0 4px;
      font: 700 10px/14px system-ui, sans-serif; color: #fff; background: #6b21a8; border-radius: 7px;
      vertical-align: super; text-decoration: none; pointer-events: none;
    }
    a.wrh-t0[data-wrh-badge]::after { background: #b45309; }
    a.wrh-t1[data-wrh-badge]::after { background: #15803d; }
    a.wrh-t2[data-wrh-badge]::after { background: #1d4ed8; }
    @keyframes wrh-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(147, 51, 234, 0); } 30% { box-shadow: 0 0 0 6px rgba(147, 51, 234, .55); } }
    a.wrh-flash { animation: wrh-flash .7s ease-in-out 3; }
  `;
  (document.head || document.documentElement).appendChild(pageStyle);

  // ---------- 面板 ----------
  const host = document.createElement('div');
  host.className = 'wrh-ignore';
  host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { width: 300px; max-width: calc(100vw - 32px); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #1f2937; background: rgba(255, 255, 255, .97); border: 1px solid #d1d5db; border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .18); overflow: hidden; }
      @media (prefers-color-scheme: dark) {
        .panel { color: #e5e7eb; background: rgba(31, 41, 55, .97); border-color: #4b5563; }
        .item:hover { background: rgba(255, 255, 255, .06) !important; }
        .muted { color: #9ca3af !important; }
      }
      .head { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: move; user-select: none;
        background: linear-gradient(90deg, #6b21a8, #2563eb); color: #fff; font-weight: 600; }
      .head .t { flex: 1; }
      .head button { all: unset; cursor: pointer; padding: 0 5px; border-radius: 4px; font-size: 14px; }
      .head button:hover { background: rgba(255, 255, 255, .2); }
      .body { padding: 8px 10px 10px; }
      .collapsed .body { display: none; }
      .target { display: flex; gap: 6px; align-items: baseline; margin-bottom: 4px; }
      .target b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .target button, .foot button { all: unset; cursor: pointer; color: #2563eb; font-size: 12px; }
      .muted { color: #6b7280; font-size: 11.5px; }
      .list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 46vh; overflow: auto; }
      .item { display: grid; grid-template-columns: 20px 1fr auto; gap: 6px; align-items: start; padding: 5px 4px;
        border-radius: 6px; cursor: pointer; }
      .item:hover { background: #f3f4f6; }
      .rank { font-weight: 700; color: #6b21a8; text-align: right; }
      .name { overflow: hidden; }
      .name .anchor, .name .path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 9px; white-space: nowrap; color: #fff; background: #7c3aed; }
      .tag.t0 { background: #d97706; } .tag.t1 { background: #16a34a; } .tag.t2 { background: #2563eb; }
      .tag.maybe { background: #64748b; }
      .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; }
      .foot label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
      input[type=text] { width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid #9ca3af; border-radius: 5px;
        font: inherit; background: transparent; color: inherit; }
      .err { color: #dc2626; }
      .pill { all: unset; display: none; cursor: pointer; width: 38px; height: 38px; border-radius: 50%; text-align: center;
        line-height: 38px; font-size: 20px; background: linear-gradient(135deg, #6b21a8, #2563eb);
        box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
      .pill:hover { filter: brightness(1.15); }
      .hidden .panel { display: none; }
      .hidden .pill { display: block; }
      .modes { display: flex; margin: 2px 0 6px; border: 1px solid #c4b5fd; border-radius: 7px; overflow: hidden; }
      .modes button { all: unset; flex: 1; text-align: center; padding: 3px 0; cursor: pointer; font-size: 12px; }
      .modes button.on { background: #6b21a8; color: #fff; font-weight: 600; }
      .modes button:disabled { cursor: not-allowed; opacity: .45; }
      .locked { padding: 10px 4px 4px; text-align: center; }
      .ask { all: unset; display: inline-block; margin-top: 8px; padding: 6px 16px; border-radius: 7px; cursor: pointer;
        background: linear-gradient(90deg, #6b21a8, #2563eb); color: #fff; font-weight: 600; }
      .ask:disabled { cursor: not-allowed; background: #9ca3af; }
    </style>
    <div class="root">
    <button class="pill" title="显示 WikiRace 助手（Alt+W）">🧭</button>
    <div class="panel">
      <div class="head"><span class="t">🧭 WikiRace 助手</span>
        <button class="collapse" title="折叠">▁</button><button class="close" title="缩成角落里的 🧭 按钮（Alt+W 切换）">✕</button></div>
      <div class="body">
        <div class="target"><span class="muted">目标</span><b class="tname">—</b><button class="edit">改</button></div>
        <div class="modes"><button data-mode="hint">提示</button><button data-mode="match">比赛（每局 1 次）</button></div>
        <div class="editbox" hidden><input type="text" placeholder="输入目标条目名，回车确认（留空恢复自动识别）"></div>
        <div class="status muted">等待对局…</div>
        <ol class="list"></ol>
        <div class="foot">
          <label class="muted"><input type="checkbox" class="hl"> 高亮文章内链接</label>
          <span class="muted">Alt+W 显隐 · Alt+J 下一个</span>
        </div>
      </div>
    </div>
    </div>`;
  const $ = s => shadow.querySelector(s);
  const panel = $('.panel');
  renderModes();
  $('.hl').checked = settings.highlight;
  $('.hl').addEventListener('change', e => { settings.highlight = e.target.checked; saveSettings(); highlight(revealed() ? lastResult : null); });
  $('.modes').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || b.dataset.mode === settings.mode) return;
    settings.mode = b.dataset.mode;
    saveSettings();
    showResult();
  });
  $('.collapse').addEventListener('click', () => { settings.collapsed = !settings.collapsed; saveSettings(); applyLayout(); });
  $('.close').addEventListener('click', () => { settings.hidden = true; saveSettings(); applyLayout(); });
  $('.pill').addEventListener('click', () => { settings.hidden = false; saveSettings(); applyLayout(); });
  $('.edit').addEventListener('click', () => {
    const box = $('.editbox');
    box.hidden = !box.hidden;
    if (!box.hidden) { const i = box.querySelector('input'); i.value = manualTarget; i.focus(); }
  });
  $('.editbox input').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    manualTarget = core.normTitle(e.target.value);
    try { sessionStorage.setItem('wikiraceHelper.manualTarget', manualTarget); } catch (err) { /* ignore */ }
    $('.editbox').hidden = true;
    gameKey = ''; pageKey = '';
    tick();
  });
  $('.list').addEventListener('click', e => {
    if (e.target.closest('.ask')) { ask(); return; }
    const li = e.target.closest('.item');
    if (li && lastResult) jumpTo(lastResult.ranked[+li.dataset.idx]);
  });

  // 拖动
  $('.head').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      settings.x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx));
      settings.y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy));
      applyLayout();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveSettings(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  let visible = false;
  function setVisible(v) { visible = v; applyLayout(); }
  function applyLayout() {
    // 隐藏时不完全消失，留一个 🧭 按钮，否则用户找不回面板
    host.style.display = visible ? '' : 'none';
    $('.root').classList.toggle('hidden', !!settings.hidden);
    panel.classList.toggle('collapsed', settings.collapsed);
    if (settings.x != null && settings.y != null) {
      host.style.left = Math.min(settings.x, window.innerWidth - 60) + 'px';
      host.style.top = Math.min(settings.y, window.innerHeight - 30) + 'px';
      host.style.right = host.style.bottom = 'auto';
    }
  }

  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const fmt = n => n.toLocaleString('en-US');

  function renderStatus() {
    const st = targetState;
    if (!st) return;
    $('.tname').textContent = st.canon;
    $('.tname').title = st.canon;
    const parts = [];
    const total = st.backlinkTotal ? ' / ' + fmt(st.backlinkTotal) : '';
    parts.push(st.backlinksDone ? `反链 ${fmt(st.B1.size)}${st.backlinksTruncated ? '+' : ''}` : `反链加载中 ${fmt(st.B1.size)}${total}`);
    if (st.b2Total) parts.push(st.b2Done < st.b2Total ? `外圈 ${st.b2Done}/${st.b2Total}` : `外圈 ${fmt(st.B2.size)}`);
    if (lastResult && lastResult.budget) parts.push(lastResult.done ? '前瞻完成' : `前瞻 ${lastResult.evaluated}/${lastResult.budget}`);
    const ss = solver.stats();
    if (ss.waitMs > 1000) parts.push(`限速等待 ${Math.ceil(ss.waitMs / 1000)}s`);
    parts.push(`${ss.lastMinute} 请求/分`);
    $('.status').textContent = parts.join(' · ');
    $('.status').classList.remove('err');
  }

  function tagFor(c) {
    if (c.tier <= 2) return `<span class="tag t${c.tier}">${TIER_LABEL[c.tier]}</span>`;
    if (!c.evaluated && targetState && targetState.B1.has(c.canon)) return '<span class="tag maybe">可能 2 步</span>';
    return '<span class="tag">相关</span>';
  }

  function pathFor(c, st) {
    if (c.tier === 0) return '就是目标，点它！';
    if (c.tier === 1) return `→ ${c.canon} → 🎯`;
    if (c.tier === 2) return `→ ${c.canon} → ${c.via[0]} → 🎯`;
    const bits = [];
    if (c.viaCount) bits.push(`链接到 ${c.viaCount} 个能直达目标的页面`);
    else if (c.via2Count) bits.push(`离目标约 4 步`);
    if (st && (st.OT.has(c.title) || st.OT.has(c.canon))) bits.push('目标页也链接它');
    if (c.visited) bits.push('已去过');
    return bits.join('，') || (c.evaluated ? '' : '未前瞻');
  }

  function renderList(res) {
    renderStatus();
    const ol = $('.list');
    if (!res) { ol.innerHTML = '<li class="muted">计算中…</li>'; return; }
    const st = res.st;
    const top = res.ranked.slice(0, SHOW_TOP);
    if (!top.length) { ol.innerHTML = '<li class="muted">这一页没有可点的条目链接</li>'; return; }
    ol.innerHTML = top.map((c, i) => {
      const anchor = c.text && c.text.toLowerCase() !== c.title.toLowerCase() ? `<span class="anchor muted">链接文字：${esc(c.text)}</span>` : '';
      const p = pathFor(c, st);
      return `<li class="item" data-idx="${i}" title="点击滚动到这个链接">
        <span class="rank">${i + 1}</span>
        <span class="name"><b>${esc(c.title)}</b>${anchor}${p ? `<span class="path muted">${esc(p)}</span>` : ''}</span>
        ${tagFor(c)}</li>`;
    }).join('');
  }

  function renderModes() {
    for (const b of shadow.querySelectorAll('.modes button')) {
      b.classList.toggle('on', b.dataset.mode === settings.mode);
      // 比赛进行中不能退回提示模式，到达目标或离开对局后才能切换
      b.disabled = b.dataset.mode === 'hint' && isMatch() && inGame;
      b.title = b.disabled ? '比赛进行中不能切换，到达目标后再切' : '';
    }
  }

  function renderLocked() {
    const left = Math.max(0, MATCH_ASKS - usedAsks());
    $('.list').innerHTML = `<li class="locked muted">比赛模式：推荐已隐藏<br>本局还能询问 <b>${left}</b> / ${MATCH_ASKS} 次<br>
      <button class="ask" ${left ? '' : 'disabled'}>${left ? '询问这一页' : '本局次数已用完'}</button></li>`;
  }

  function renderNeedTarget() {
    $('.tname').textContent = '未识别';
    $('.status').textContent = '没能从页面识别出目标条目，点“改”手动输入。';
    $('.list').innerHTML = '';
  }

  function renderError(msg) {
    $('.status').textContent = msg;
    $('.status').classList.add('err');
  }

  // 快捷键：Alt+W 显示/隐藏面板，Alt+J 依次跳到推荐的链接
  let cycle = 0;
  window.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w' || e.code === 'KeyW') {
      settings.hidden = !settings.hidden; saveSettings(); applyLayout(); e.preventDefault();
    } else if ((k === 'j' || e.code === 'KeyJ') && revealed() && lastResult && lastResult.ranked.length) {
      const n = Math.min(SHOW_TOP, lastResult.ranked.length);
      jumpTo(lastResult.ranked[cycle % n]);
      cycle++;
      e.preventDefault();
    }
  }, true);

  // ---------- 启动 ----------
  const mount = () => { if (!host.isConnected) document.body.appendChild(host); applyLayout(); };
  let tickTimer = null;
  const schedule = () => { if (!tickTimer) tickTimer = setTimeout(() => { tickTimer = null; mount(); tick(); }, 150); };
  new MutationObserver(muts => {
    if (muts.every(m => host.contains(m.target) || m.target === host)) return;
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (targetState && visible) renderStatus(); }, 1000);
  schedule();
})();
