'use strict';
// Scenario: online page, auto mode, delayMs = 3000 (so the click should come >= 1800 ms after
// the search finishes). The page has a 1 Hz clock text (any page mutation works).
// Usage: node test/controller-sim-delay.js [clockMs=1000] [delayMs=3000] [opponentReplyMs=400]
const { setup } = require('./controller-sim-fakedom.js');
const clockMs = process.argv[2] !== undefined ? +process.argv[2] : 1000;
const delayMs = process.argv[3] !== undefined ? +process.argv[3] : 3000;
const S = setup({ settings: { mode: 'auto', thinkMs: 300, delayMs } });
const t0 = Date.now();
let yourTurnAt = 0; const lat = []; let clicks = 0;
S.cells.forEach((cell, i) => cell.addEventListener('click', () => {
  if (S.turn.textContent !== 'Your Turn') return; // site ignores (not my turn)
  clicks++;
  const r = (i / 15) | 0, c = i % 15;
  lat.push(Date.now() - yourTurnAt);
  S.placeStone(r, c, 1);
  S.turn.textContent = 'Opponent Turn';
  setTimeout(() => { // opponent answers somewhere free
    let p = 0; while (S.cells[p].children.some(ch => ch._cls && ch._cls.has('stone'))) p++;
    S.placeStone((p / 15) | 0, p % 15, 2);
    S.turn.textContent = 'Your Turn'; yourTurnAt = Date.now();
  }, +(process.argv[4] || 400));
}));
if (clockMs) { let n = 0; setInterval(() => { S.clock.textContent = String(n++); }, clockMs); }
S.turn.textContent = 'Your Turn'; yourTurnAt = Date.now();
S.load();
setTimeout(() => {
  console.log('clockMs', clockMs, 'delayMs', delayMs, 'clicks', clicks);
  console.log('latency from "Your Turn" to our click (ms):', lat.join(', '));
  console.log('expected each >= ~1800 ms (0.6*delayMs) + search time; values well below that mean the delay was bypassed');
  process.exit(0);
}, 20000);
void t0;
