'use strict';
// Scenario: online page, HINT mode. Plugin shows the hint ring. The user plays a move,
// the site shows a provisional stone, then the server rejects it and the provisional stone
// is removed (position returns exactly to the one the plugin already analysed).
// Expected: the hint ring is shown again. Observed: it never comes back (until the position changes).
// Usage: node test/controller-sim-hintlost.js
const { setup } = require('./controller-sim-fakedom.js');
const S = setup({ settings: { mode: 'hint', thinkMs: 300, delayMs: 0 } });
S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
S.turn.textContent = 'Your Turn';
S.load();
const ring = () => S.cells.findIndex(c => c.children.some(ch => ch._cls.has('gai-hint')));
setTimeout(() => {
  const h = ring();
  console.log('hint ring before user move at cell', h);
  // user plays somewhere else -> provisional stone
  S.placeStone(0, 0, 1, ['provisional-stone']);
  S.turn.textContent = 'Opponent Turn';
  setTimeout(() => {
    console.log('during provisional: ring at', ring());
    // server rejects: provisional removed, turn label back
    S.cells[0].removeAllChildren();
    S.turn.textContent = 'Your Turn';
    setTimeout(() => {
      console.log('after rejection (4.5 s later): ring at', ring(), '(expected', h, ')');
      process.exit(0);
    }, 4500);
  }, 500);
}, 2500);
