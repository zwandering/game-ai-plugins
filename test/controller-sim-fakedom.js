'use strict';
// Minimal fake DOM + gomoku.com online-page stub, enough to run src/controller.js in node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const observers = [];
function record(rec) {
  for (const o of observers) {
    o.q.push(rec);
    if (!o.sched) {
      o.sched = true;
      queueMicrotask(() => { o.sched = false; const q = o.q; o.q = []; if (q.length) o.cb(q); });
    }
  }
}
function parseSimple(sel) {
  let s = sel.trim();
  const m = { id: null, cls: [], not: [], attr: null };
  const notRe = /:not\(\.([\w-]+)\)/g; let mm;
  while ((mm = notRe.exec(s))) m.not.push(mm[1]);
  s = s.replace(notRe, '');
  const attr = /\[([\w-]+)\]/.exec(s); if (attr) { m.attr = attr[1]; s = s.replace(attr[0], ''); }
  const id = /#([\w-]+)/.exec(s); if (id) { m.id = id[1]; s = s.replace(id[0], ''); }
  s.replace(/\.([\w-]+)/g, (_, c) => { m.cls.push(c); return ''; });
  return m;
}
function matches(el, sel) {
  if (el.nodeType !== 1) return false;
  const m = parseSimple(sel);
  if (m.id && el.id !== m.id) return false;
  for (const c of m.cls) if (!el._cls.has(c)) return false;
  for (const c of m.not) if (el._cls.has(c)) return false;
  if (m.attr) {
    const k = m.attr.replace(/^data-/, '').replace(/-(\w)/g, (_, x) => x.toUpperCase());
    if (!(k in el.dataset)) return false;
  }
  return true;
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.id = ''; this._cls = new Set(); this.dataset = {};
    this.children = []; this.parentNode = null; this._text = ''; this.listeners = {}; this.style = {}; this.hidden = false; this.value = '';
    const self = this;
    const rec = () => record({ type: 'attributes', target: self, addedNodes: [], removedNodes: [] });
    this.classList = {
      add: (...c) => { c.forEach(x => self._cls.add(x)); rec(); },
      remove: (...c) => { c.forEach(x => self._cls.delete(x)); rec(); },
      contains: c => self._cls.has(c),
      toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : !!f; if (on) self._cls.add(c); else self._cls.delete(c); rec(); return on; },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); record({ type: 'attributes', target: this, addedNodes: [], removedNodes: [] }); }
  appendChild(ch) { if (ch.parentNode) ch.remove(); ch.parentNode = this; this.children.push(ch); record({ type: 'childList', target: this, addedNodes: [ch], removedNodes: [] }); return ch; }
  remove() { const p = this.parentNode; if (!p) return; p.children = p.children.filter(x => x !== this); this.parentNode = null; record({ type: 'childList', target: p, addedNodes: [], removedNodes: [this] }); }
  removeAllChildren() { const old = this.children; this.children = []; old.forEach(c => { c.parentNode = null; }); if (old.length) record({ type: 'childList', target: this, addedNodes: [], removedNodes: old }); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { const old = this.children; this.children = []; this._text = String(v); record({ type: 'childList', target: this, addedNodes: [{ nodeType: 3 }], removedNodes: old.length ? old : [{ nodeType: 3 }] }); }
  set innerHTML(v) { this._stub = true; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) {
    if (this._stub && sel === '[data-mode]') {
      if (!this._modes) this._modes = ['off', 'hint', 'auto'].map(m => { const b = new El('button'); b.dataset.mode = m; this.appendChild(b); return b; });
      return this._modes;
    }
    return [...this.walk()].filter(e => matches(e, sel));
  }
  querySelector(sel) {
    const r = this.querySelectorAll(sel)[0];
    if (r || !this._stub) return r || null;
    const e = new El('div'); parseSimple(sel).cls.forEach(c => e._cls.add(c)); this.appendChild(e); return e;
  }
  closest(sel) { let e = this; while (e && e.nodeType === 1) { if (matches(e, sel)) return e; e = e.parentNode; } return null; }
  getBoundingClientRect() { return { width: 10, height: 10, left: 0, top: 0 }; }
  get offsetWidth() { return 10; }
  get offsetHeight() { return 10; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { (this.listeners.click || []).forEach(f => f({ type: 'click', target: this })); }
  setPointerCapture() {}
}

function setup(opts) {
  opts = opts || {};
  const html = new El('html'); const head = new El('head'); const body = new El('body');
  html.appendChild(head); html.appendChild(body);
  const document = {
    head, body, readyState: 'complete', documentElement: html, listeners: {},
    createElement: t => new El(t),
    getElementById: id => { for (const e of html.walk()) if (e.id === id) return e; return null; },
    addEventListener: (t, f) => { (document.listeners[t] = document.listeners[t] || []).push(f); },
  };
  class MO { constructor(cb) { this.cb = cb; this.q = []; } observe() { observers.push(this); } disconnect() {} }
  const store = {};
  Object.assign(globalThis, {
    window: globalThis, document, MutationObserver: MO, innerWidth: opts.innerWidth || 1200, innerHeight: 800,
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    location: { pathname: opts.pathname || '/zh-cn/online-battle/' },
    i18n: { t: k => k },
  });
  store['gomokuAI.settings.v1'] = JSON.stringify(opts.settings || {});
  const mk = (tag, cls, id, parent) => {
    const e = new El(tag); (cls || '').split(' ').filter(Boolean).forEach(c => e._cls.add(c));
    if (id) e.id = id; parent.appendChild(e); return e;
  };
  const container = mk('div', '', 'online-game-container', body);
  const pstone = mk('div', 'stone black-stone', 'player-stone', container);
  const turn = mk('div', '', 'online-player-turn', container);
  const clock = mk('div', '', 'clock', container);
  const gbc = mk('div', 'game-board-container', '', container);
  const board = mk('div', 'game-board', 'online-player-board', gbc);
  const grid = mk('div', 'board-grid-container', '', board);
  const endOverlay = mk('div', 'game-end-overlay hidden', '', gbc);
  const cells = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const x = mk('div', 'board-intersection', '', grid); x.dataset.row = String(r); x.dataset.col = String(c); cells.push(x);
  }
  function placeStone(r, c, color, extraCls) {
    const x = cells[r * 15 + c]; x.removeAllChildren();
    const s = new El('div'); s._cls = new Set(['stone', color === 1 ? 'black-stone' : 'white-stone'].concat(extraCls || []));
    x.appendChild(s);
  }
  globalThis.createGomokuEngine = require(path.join(__dirname, '../src/engine.js'));
  return {
    document, cells, turn, clock, pstone, placeStone, endOverlay, container,
    load() {
      const src = fs.readFileSync(path.join(__dirname, '../src/controller.js'), 'utf8');
      vm.runInThisContext(src, { filename: 'controller.js' });
    },
  };
}
module.exports = { setup, El };
