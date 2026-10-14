'use strict';
// Race on pendingClickKey: tick A (position K1) is in its planned delay; the user plays a move by hand,
// the opponent answers -> K2 (our turn). Tick B thinks on K2, sets pendingClickKey=K2 and starts its own
// delay. Then A wakes, sees the position changed, and its `finally { pendingClickKey = null }` wipes B's
// marker. The next periodic tick takes the "already handled" retry branch (lastClickAt is old) and
// clicks for K2 immediately, i.e. B's planned delay is bypassed.
// Usage: node test/review2/sim-pending-clobber.js
const { setup, El } = require('../controller-sim-fakedom.js');
Object.defineProperty(El.prototype, 'isConnected', { get() { let e = this; while (e.parentNode) e = e.parentNode; return e.tagName === 'HTML'; } });
const rnd = [0, 1]; // A: delay*0.6, B: delay*1.4
Math.random = () => (rnd.length ? rnd.shift() : 0.5);
const delayMs = 4000;
const S = setup({ settings: { mode: 'auto', thinkMs: 300, delayMs } });
S.placeStone(7, 7, 1); S.placeStone(6, 8, 2);
const t0 = Date.now(); const T = () => Date.now() - t0;
let k2At = 0, pluginClicks = [];
let userClicking = false;
S.cells.forEach((cell, i) => cell.addEventListener('click', () => {
  if (S.turn.textContent !== 'Your Turn') return;
  const r = (i / 15) | 0, c = i % 15;
  if (!userClicking) pluginClicks.push({ t: T(), cell: [r, c] });
  S.placeStone(r, c, 1);
  S.turn.textContent = 'Opponent Turn';
  if (!userClicking) return;
  setTimeout(() => { S.placeStone(0, 14, 2); S.turn.textContent = 'Your Turn'; k2At = T(); console.log('K2 (our turn) at', k2At); }, 300);
}));
let n = 0; setInterval(() => { S.clock.textContent = String(n++); }, 1000);
S.turn.textContent = 'Your Turn';
S.load();
// user plays by hand 1 s after start (plugin finished thinking ~0.6 s, A sleeps 2.4 s)
setTimeout(() => { console.log('user clicks by hand at', T()); userClicking = true; S.cells[0].click(); userClicking = false; }, 1000);
setTimeout(() => {
  console.log('plugin clicks:', JSON.stringify(pluginClicks));
  const c = pluginClicks[0];
  if (c) console.log('plugin clicked', c.t - k2At, 'ms after K2; B planned delay =', 1.4 * delayMs, 'ms after its search (min allowed 0.6*delay =', 0.6 * delayMs, ')');
  process.exit(0);
}, 12000);
