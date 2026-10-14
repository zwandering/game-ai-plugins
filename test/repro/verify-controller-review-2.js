'use strict';
// Verifies the hint-ring-lost finding and the proposed fix (patched in memory; src untouched).
// Usage: node test/verify-controller-review-2.js [patched]
const fs = require('fs');
const PATCH = process.argv[2] === 'patched';
const orig = fs.readFileSync;
fs.readFileSync = function (p, ...a) {
  let s = orig.call(this, p, ...a);
  if (PATCH && String(p).endsWith('src/controller.js')) {
    const needle = "      // Already handled this position. In auto mode, retry the click if it did not land.\n";
    if (!s.includes(needle)) throw new Error('patch anchor missing');
    s = s.replace(needle, needle +
      "      if (lastResult && lastResult.key === st.key && !hintEls.some(e => e.parentNode /* isConnected in browser */))\n" +
      "        showHint(st, lastResult.result.move, lastResult.result.pv, settings.mode === 'auto');\n");
  }
  return s;
};
const { setup } = require('../controller-sim-fakedom.js');
const S = setup({ settings: { mode: 'hint', thinkMs: 300, delayMs: 0 } });
S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
S.turn.textContent = 'Your Turn';
S.load();
const ring = () => S.cells.findIndex(c => c.children.some(ch => ch._cls.has('gai-hint')));
setTimeout(() => {
  const h = ring();
  console.log(PATCH ? '[patched]' : '[original]', 'ring before move', h);
  S.placeStone(0, 0, 1, ['provisional-stone']); S.turn.textContent = 'Opponent Turn';
  setTimeout(() => {
    console.log('during provisional', ring());
    S.cells[0].removeAllChildren(); S.turn.textContent = 'Your Turn';
    setTimeout(() => {
      console.log('after rejection', ring(), 'expected', h);
      S.placeStone(h / 15 | 0, h % 15, 1); S.turn.textContent = 'Opponent Turn';
      setTimeout(() => { console.log('after real move, ring at', ring(), '(expected -1)'); process.exit(0); }, 1000);
    }, 3000);
  }, 500);
}, 2500);
