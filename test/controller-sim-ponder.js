'use strict';
// Scenario: 比赛模式 continuous computation, with a stub Worker that runs the
// real engine handler (asynchronously, like a worker; terminate() cancels it).
// Checks: rounds keep refining the live win rate (depth grows, status says how
// long it has been computing), a hint is served instantly from the latest round,
// a hint asked before the first round waits for it, the opponent's turn is
// computed too, a new position cancels the old computation, and the time cap.
// Usage: node test/controller-sim-ponder.js
const { setup, El } = require('./controller-sim-fakedom.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };

const S = setup({ settings: { mode: 'match', thinkMs: 300, delayMs: 0, ponderMaxMs: 5000 } });
let workers = 0, liveWorkers = 0;
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL: () => 'blob:sim' };
globalThis.Worker = class {
  constructor() {
    workers++; liveWorkers++;
    this.dead = false;
    this.handler = createGomokuEngine().makeHandler((m) => { if (!this.dead && this.onmessage) this.onmessage({ data: m }); });
  }
  // the stub shares the test's thread: a search blocks timers, so requests start a little late
  postMessage(m) { setTimeout(() => { if (!this.dead) this.handler(m); }, m.type === 'ponder' ? 400 : 0); }
  terminate() { if (this.dead) return; this.dead = true; liveWorkers--; this.handler({ type: 'cancelAll' }); }
};

(async () => {
  const room = new El('span'); room.id = 'room-id'; room.textContent = '房间: #R1'; S.container.appendChild(room);
  S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
  S.turn.textContent = 'Your Turn';
  S.load();
  const panel = S.document.getElementById('gai-panel');
  const q = c => panel.querySelector(c);
  const dbg = () => window.__gomokuAI.debug();
  const rings = () => { const r = []; S.cells.forEach((c, i) => c.children.forEach(ch => { if (ch._cls.has('gai-hint')) r.push(i); })); return r; };
  const free = () => { for (let i = 0; i < 225; i++) if (!S.cells[i].children.some(ch => ch._cls.has('stone'))) return i; };

  await sleep(1500);
  const p1 = dbg().ponder;
  check(p1 && p1.latest && p1.color === 1, 'my turn: continuous computation running (round ' + (p1 && p1.latest && p1.latest.round) + ')');
  check(/已持续计算 \d+ 秒（深度 \d+）/.test(q('.gai-status').textContent), 'status: ' + q('.gai-status').textContent);
  check(/%/.test(q('.gai-winnum').textContent), 'win rate shown: ' + q('.gai-winnum').textContent);
  check(rings().length === 0, 'the move found is not shown');
  const d1 = p1.latest.depth, r1 = p1.latest.round;
  await sleep(2000);
  const p2 = dbg().ponder;
  check(p2 === p1 && p2.latest.round > r1 && p2.latest.depth >= d1, `later rounds refine it (round ${r1}→${p2.latest.round}, depth ${d1}→${p2.latest.depth})`);

  // a hint is served from the latest round, immediately
  q('.gai-match-btn').click();
  check(rings().length === 1 && dbg().match.used === 1, 'hint shown instantly from the computation (ring ' + rings() + ')');
  check(/基于 \d+ 秒计算，深度 \d+/.test(q('.gai-status').textContent), 'hint status: ' + q('.gai-status').textContent);

  // cap: after ~5 s the computation stops
  await sleep(3500);
  check(dbg().ponder.done, 'stops at the time cap (done)');

  window.__gomokuAI.settings.ponderMaxMs = 60000;
  // I play; the opponent's turn is computed too, the old computation is gone
  S.placeStone((rings()[0] / 15) | 0, rings()[0] % 15, 1);
  S.turn.textContent = 'Opponent Turn';
  await sleep(1500);
  const p3 = dbg().ponder;
  check(p3 && p3 !== p1 && p3.color === 2 && p3.latest, 'opponent turn: computing for the opponent');
  check(/对方思考中 · 已持续计算/.test(q('.gai-status').textContent), 'status: ' + q('.gai-status').textContent);
  check(rings().length === 0, 'old hint cleared');

  // opponent replies mid-computation: it is cancelled, mine starts
  const wBefore = workers;
  const c = free(); S.placeStone((c / 15) | 0, c % 15, 2);
  S.turn.textContent = 'Your Turn';
  // ask for a hint before the first round can finish
  await sleep(250);
  q('.gai-match-btn').click();
  check(/AI 思考中/.test(q('.gai-match-btn').textContent) && q('.gai-match-btn').disabled, 'early hint waits: ' + q('.gai-match-btn').textContent);
  check(workers > wBefore && liveWorkers === 1, `stale computation cancelled (workers created ${workers}, alive ${liveWorkers})`);
  await sleep(2000);
  check(rings().length === 1 && dbg().match.used === 2, 'early hint delivered by the first round (used ' + dbg().match.used + ')');

  // leaving match mode between games stops the computation
  S.endOverlay.classList.remove('hidden');
  S.cells.forEach(x => x.removeAllChildren());
  S.turn.textContent = '';
  await sleep(800);
  window.__gomokuAI.setMode('hint');
  check(window.__gomokuAI.settings.mode === 'hint' && !dbg().ponder, 'leaving match mode clears the computation');

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
