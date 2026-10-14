'use strict';
// Scenario: hint mode with "帮对手计算". My turn -> my analysis; I play the hint;
// on the opponent's turn the plugin must show the OPPONENT's analysis (purple
// dashed ring, purple-outlined badges, continuation starting with the opponent's
// colour, status "对方回合 · 对方最佳 ..."), record my win rate, and switch back to
// my own analysis after the opponent moves. Then: a quick opponent reply cancels
// the opponent analysis cleanly, and with the option off nothing is drawn.
// Usage: node test/controller-sim-opponent.js
const { setup } = require('./controller-sim-fakedom.js');
const S = setup({ settings: { mode: 'hint', thinkMs: 400, delayMs: 0, showHeat: true, showPv: true, showOpp: true } });
S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
S.turn.textContent = 'Your Turn';
S.load();

const panel = () => S.document.getElementById('gai-panel');
const text = (cls) => panel().querySelector(cls).textContent;
const overlays = () => {
  const out = { ring: [], oppRing: [], heat: 0, oppHeat: 0, ghosts: [] };
  S.cells.forEach((c, i) => c.children.forEach(ch => {
    if (ch._cls.has('gai-hint')) (ch._cls.has('gai-opp') ? out.oppRing : out.ring).push(i);
    if (ch._cls.has('gai-heat')) { out.heat++; if (ch._cls.has('gai-oppv')) out.oppHeat++; }
    if (ch._cls.has('gai-ghost')) out.ghosts.push({ i, b: ch._cls.has('b'), n: ch._text });
  }));
  return out;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };

(async () => {
  await sleep(3500);
  let o = overlays();
  check(o.ring.length === 1 && o.oppRing.length === 0, `my turn: my ring shown (${o.ring}), no opponent ring`);
  check(o.heat > 0 && o.oppHeat === 0, `my turn: my heat badges (${o.heat}), none purple`);
  const mine = o.ring[0];

  // I play the hint; it is now the opponent's turn (they think for a while)
  S.placeStone((mine / 15) | 0, mine % 15, 1);
  S.turn.textContent = 'Opponent Turn';
  await sleep(4500);
  o = overlays();
  check(o.oppRing.length === 1 && o.ring.length === 0, `opponent turn: purple opponent ring at ${o.oppRing}`);
  check(o.oppHeat > 0 && o.oppHeat === o.heat, `opponent turn: badges are the opponent's (${o.oppHeat}/${o.heat})`);
  const firstGhost = o.ghosts.find(g => g.n === '1');
  check(!firstGhost || firstGhost.b === false, 'opponent continuation starts with a white (opponent) stone');
  check(/对方回合 · 对方最佳/.test(text('.gai-status')), 'status: ' + text('.gai-status'));
  check(/%/.test(text('.gai-winnum')), 'live win rate shown on the opponent\'s turn: ' + text('.gai-winnum'));
  const oppBest = o.oppRing[0];

  // the opponent plays its best move -> my turn again
  S.placeStone((oppBest / 15) | 0, oppBest % 15, 2);
  S.turn.textContent = 'Your Turn';
  await sleep(3500);
  o = overlays();
  check(o.ring.length === 1 && o.oppRing.length === 0 && o.oppHeat === 0, `back to my turn: my ring at ${o.ring}, opponent overlays gone`);
  check(/上一手 对方\(白\)/.test(text('.gai-last')), 'last-move line names the opponent: ' + text('.gai-last'));

  // quick opponent reply while the opponent analysis is still running
  const m2 = o.ring[0];
  S.placeStone((m2 / 15) | 0, m2 % 15, 1);
  S.turn.textContent = 'Opponent Turn';
  await sleep(300);
  let free = -1; for (let i = 0; i < 225; i++) if (!S.cells[i].children.some(ch => ch._cls.has('stone'))) { free = i; break; }
  S.placeStone((free / 15) | 0, free % 15, 2);
  S.turn.textContent = 'Your Turn';
  await sleep(4000);
  o = overlays();
  check(o.ring.length === 1 && o.oppRing.length === 0, 'after a quick opponent reply: my analysis shown, no stale opponent ring');

  // option off: nothing drawn on the opponent's turn
  window.__gomokuAI.settings.showOpp = false;
  const m3 = o.ring[0];
  S.placeStone((m3 / 15) | 0, m3 % 15, 1);
  S.turn.textContent = 'Opponent Turn';
  await sleep(3000);
  o = overlays();
  check(o.oppRing.length === 0 && o.oppHeat === 0, 'with 帮对手计算 off: no opponent overlays');
  check(/%/.test(text('.gai-winnum')), 'with it off the live win rate still updates: ' + text('.gai-winnum'));

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
