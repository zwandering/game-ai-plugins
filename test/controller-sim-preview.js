'use strict';
// Scenario: hint mode. Hovering an empty cell must show the expected continuation
// if that move were played (ghost 1 on the hovered cell, then the opponent's
// replies), hide the heat map while previewing, and restore the recommended
// continuation when the mouse leaves the board. Also on the opponent's turn.
// Usage: node test/controller-sim-preview.js
const { setup } = require('./controller-sim-fakedom.js');
const S = setup({ settings: { mode: 'hint', thinkMs: 400, delayMs: 0, showHeat: true, showPv: true, showOpp: true } });
S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
S.turn.textContent = 'Your Turn';
S.load();

const board = S.document.getElementById('online-player-board');
const panel = () => S.document.getElementById('gai-panel');
const text = (cls) => panel().querySelector(cls).textContent;
const hover = (i) => (board.listeners.mouseover || []).forEach(f => f({ target: S.cells[i] }));
const leave = () => (board.listeners.mouseleave || []).forEach(f => f({}));
const overlays = () => {
  const out = { ring: [], oppRing: [], heat: 0, ghosts: [] };
  S.cells.forEach((c, i) => c.children.forEach(ch => {
    if (ch._cls.has('gai-hint')) (ch._cls.has('gai-opp') ? out.oppRing : out.ring).push(i);
    if (ch._cls.has('gai-heat')) out.heat++;
    if (ch._cls.has('gai-ghost')) out.ghosts.push({ i, b: ch._cls.has('b'), n: +ch._text });
  }));
  out.ghosts.sort((a, b) => a.n - b.n);
  return out;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };
const isEmpty = i => !S.cells[i].children.some(ch => ch._cls.has('stone'));

(async () => {
  await sleep(3500);
  let o = overlays();
  const best = o.ring[0];
  const recGhost1 = (o.ghosts.find(g => g.n === 1) || {}).i;
  check(o.heat > 0 && o.ghosts.length > 1, `my turn: heat (${o.heat}) and recommended continuation (${o.ghosts.length} stones)`);

  // hover a different empty cell near the stones
  let target = -1;
  for (const i of [7 * 15 + 9, 9 * 15 + 9, 5 * 15 + 7, 9 * 15 + 6, 8 * 15 + 6]) if (i !== best && isEmpty(i)) { target = i; break; }
  hover(target);
  check(/若下 /.test(text('.gai-hover')), 'hover text right away: ' + text('.gai-hover'));
  await sleep(2500);
  o = overlays();
  const g1 = o.ghosts.find(g => g.n === 1), g2 = o.ghosts.find(g => g.n === 2);
  check(g1 && g1.i === target && g1.b === true, `preview: ghost 1 on the hovered cell ${target} (black = my colour)`);
  check(g2 && g2.b === false, 'preview: ghost 2 is the opponent\'s reply (white)');
  check(o.heat === 0, 'preview: heat map hidden while previewing');
  check(o.ring.length === 1 && o.ring[0] === best, 'preview: recommendation ring still shown');
  check(/若下 .* 后续: /.test(text('.gai-info')), 'panel: ' + text('.gai-info'));

  // leave the board -> recommended continuation and heat map are back
  leave();
  await sleep(200);
  o = overlays();
  check((o.ghosts.find(g => g.n === 1) || {}).i === recGhost1 && o.heat > 0, 'after leaving: recommended continuation and heat map restored');

  // hovering the recommended move shows its continuation immediately
  hover(best);
  await sleep(100);
  o = overlays();
  check((o.ghosts.find(g => g.n === 1) || {}).i === best, 'hovering the recommended move: its continuation, no waiting');
  leave();

  // opponent's turn: preview of the opponent's move
  S.placeStone((best / 15) | 0, best % 15, 1);
  S.turn.textContent = 'Opponent Turn';
  await sleep(4500);
  o = overlays();
  const oppBest = o.oppRing[0];
  let t2 = -1;
  for (let i = 0; i < 225; i++) if (isEmpty(i) && i !== oppBest && S.cells[i].children.some(ch => ch._cls.has('gai-heat'))) { t2 = i; break; }
  hover(t2);
  await sleep(2500);
  o = overlays();
  const og1 = o.ghosts.find(g => g.n === 1);
  check(og1 && og1.i === t2 && og1.b === false, `opponent turn: preview starts with the opponent's (white) stone on ${t2}`);
  check(/若对方下 /.test(text('.gai-hover')), 'opponent turn hover: ' + text('.gai-hover'));
  leave();

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
