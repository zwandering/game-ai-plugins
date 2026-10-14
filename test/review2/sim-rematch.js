'use strict';
// Rematch scenarios (online page, auto mode).
//  same   : game 1 as black (plugin opens at centre), game ends, rematch as black on an empty board.
//  swap   : game 1 as black, rematch as white (opponent opens at centre).
//  during : game 1 ends while the plugin's delayed click is pending; rematch with the identical
//           first position starts before the delay expires.
//  hint   : same as "same" but hint mode: is the hint ring shown in game 2?
// Usage: node test/review2/sim-rematch.js same|swap|during|hint
const { setup, El } = require('../controller-sim-fakedom.js');
Object.defineProperty(El.prototype, 'isConnected', { get() { let e = this; while (e.parentNode) e = e.parentNode; return e.tagName === 'HTML'; } });
const sc = process.argv[2] || 'same';
const delayMs = sc === 'during' ? 3000 : 0;
const S = setup({ settings: { mode: sc === 'hint' ? 'hint' : 'auto', thinkMs: 300, delayMs } });
const t0 = Date.now(); const T = () => Date.now() - t0;
const log = (...a) => console.log(String(T()).padStart(5), ...a);
let game = 1, myColor = 1;
const clicks = [];
const stoneCount = () => S.cells.filter(c => c.children.some(ch => ch._cls && ch._cls.has('stone'))).length;
S.cells.forEach((cell, i) => cell.addEventListener('click', () => {
  if (S.turn.textContent !== 'Your Turn') { log('click ignored (not my turn)', i); return; }
  const r = (i / 15) | 0, c = i % 15;
  clicks.push({ game, t: T(), r, c }); log('plugin click game', game, [r, c]);
  S.placeStone(r, c, myColor);
  S.turn.textContent = 'Opponent Turn';
  setTimeout(() => { let p = 0; while (S.cells[p].children.some(ch => ch._cls.has('stone'))) p++; S.placeStone((p / 15) | 0, p % 15, 3 - myColor); S.turn.textContent = 'Your Turn'; }, 200);
}));
let n = 0; setInterval(() => { S.clock.textContent = String(n++); }, 1000);
function newGame(color) {
  game = 2; myColor = color;
  S.cells.forEach(c => c.removeAllChildren());
  S.pstone.classList.remove('black-stone', 'white-stone'); S.pstone.classList.add(color === 1 ? 'black-stone' : 'white-stone');
  S.endOverlay.classList.add('hidden');
  if (color === 2) { S.placeStone(7, 7, 1); }
  S.turn.textContent = 'Your Turn';
  log('game 2 started, my colour', color);
}
S.turn.textContent = 'Your Turn';
S.load();
const ring = () => S.cells.findIndex(c => c.children.some(ch => ch._cls.has('gai-hint')));
if (sc === 'during') {
  // plugin thinks ~0.45 s then waits 1.8..4.2 s; end the game at 0.8 s, rematch at 1.2 s
  setTimeout(() => { log('game over'); S.endOverlay.classList.remove('hidden'); S.turn.textContent = 'Game Over'; }, 800);
  setTimeout(() => newGame(1), 1200);
} else {
  setTimeout(() => {
    if (sc === 'hint') { log('game 1 ring at', ring()); S.placeStone(7, 7, 1); S.placeStone(0, 0, 2); }
    log('game over (stones', stoneCount() + ')'); S.endOverlay.classList.remove('hidden'); S.turn.textContent = 'Game Over';
  }, 3000);
  setTimeout(() => newGame(sc === 'swap' ? 2 : 1), 4500);
}
setTimeout(() => {
  const g2 = clicks.filter(c => c.game === 2);
  console.log('game-1 clicks', clicks.filter(c => c.game === 1).length, 'game-2 clicks', g2.length, g2.length ? 'first at ' + JSON.stringify(g2[0]) : '');
  if (sc === 'hint') console.log('game-2 hint ring at cell', ring(), '(expected 112 = centre)');
  console.log('stones on board', stoneCount());
  process.exit(0);
}, 9000);
