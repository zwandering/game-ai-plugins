'use strict';
// Scenario: 比赛模式 (match mode) on the online page, with a stub of the site's chat
// box (#chat-input + #send-message) and socket ('chat-message' events).
// Checks: announcement in chat, live win rate without any suggestion, exactly 3
// hints per game (each announced), the opponent's announcements parsed, mode
// locked during a game, hover disabled, counter reset for a new game, and the
// "join" offer when the opponent turns match mode on.
// Usage: node test/controller-sim-match.js
const { setup, El } = require('./controller-sim-fakedom.js');

function makeChat(S) {
  const sent = [];
  const input = new El('input'); input.id = 'chat-input'; input.value = '';
  const btn = new El('button'); btn.id = 'send-message';
  btn.addEventListener('click', () => { const m = input.value.trim(); if (!m) return; sent.push(m); input.value = ''; });
  const room = new El('span'); room.id = 'room-id'; room.textContent = '房间: #ROOM42';
  S.container.appendChild(input); S.container.appendChild(btn); S.container.appendChild(room);
  const handlers = {};
  window.socket = { id: 'me', on: (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); }, emit() {} };
  const oppSays = (message) => (handlers['chat-message'] || []).forEach(f => f({ playerId: 'opp', message }));
  window.__simOppSays = oppSays;
  window.__simSent = sent;
  return { sent, input, oppSays };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };

async function scenarioMatch() {
  const S = setup({ settings: { mode: 'match', thinkMs: 300, delayMs: 0 } });
  const chat = makeChat(S);
  S.placeStone(7, 7, 1); S.placeStone(6, 8, 2); S.placeStone(8, 8, 1); S.placeStone(6, 6, 2);
  S.turn.textContent = 'Your Turn';
  chat.input.value = '我正在打字';
  S.load();
  const panel = S.document.getElementById('gai-panel');
  const q = (c) => panel.querySelector(c);
  const ov = () => { let ring = [], heat = 0, ghosts = 0; S.cells.forEach((c, i) => c.children.forEach(ch => { if (ch._cls.has('gai-hint')) ring.push(i); if (ch._cls.has('gai-heat') || ch._cls.has('gai-dot')) heat++; if (ch._cls.has('gai-ghost')) ghosts++; })); return { ring, heat, ghosts }; };
  const board = S.document.getElementById('online-player-board');
  await sleep(2500);

  check(chat.sent.filter(m => /开启了?比赛模式/.test(m)).length === 1, 'announced match mode in chat once: ' + JSON.stringify(chat.sent));
  check(chat.input.value === '我正在打字', 'the user\'s chat draft was restored after sending');
  let o = ov();
  check(o.ring.length === 0 && o.heat === 0 && o.ghosts === 0, 'no suggestion of any kind is drawn by default');
  check(/%/.test(q('.gai-winnum').textContent), 'live win rate shown: ' + q('.gai-winnum').textContent);
  check(/我方已用 0\/3/.test(q('.gai-match-text').textContent) && /尚未收到对方/.test(q('.gai-match-text').textContent), 'match box: ' + q('.gai-match-text').textContent);
  check(!/最佳|建议：/.test(q('.gai-info').textContent + q('.gai-status').textContent), 'no move named in the panel: ' + q('.gai-status').textContent + ' | ' + q('.gai-info').textContent);

  // hover gives nothing in match mode
  (board.listeners.mouseover || []).forEach(f => f({ target: S.cells[0] }));
  await sleep(600);
  check(!/若下/.test(q('.gai-hover').textContent), 'hover shows nothing in match mode');

  // the opponent announces a hint
  chat.oppSays('【AI助手·比赛】我已使用AI提示 1/3');
  check(/对方已用 1\/3/.test(q('.gai-match-text').textContent), 'opponent count parsed: ' + q('.gai-match-text').textContent);

  // mode is locked during the game
  window.__gomokuAI.setMode('hint');
  check(window.__gomokuAI.settings.mode === 'match', 'cannot leave match mode during the game');

  // spend hints
  const useHint = async () => { q('.gai-match-btn').click(); await sleep(900); };
  const play = async (cell, color) => { S.placeStone((cell / 15) | 0, cell % 15, color); };
  await useHint();
  o = ov();
  check(o.ring.length === 1 && o.heat === 0, `hint 1: one ring (${o.ring}), nothing else`);
  check(chat.sent.some(m => /已使用AI提示 1\/3/.test(m)), 'hint 1 announced in chat');
  check(/AI 建议：.*第 1\/3 次/.test(q('.gai-status').textContent), 'status: ' + q('.gai-status').textContent);
  await useHint(); // same position: must not cost another hint
  check(window.__gomokuAI.debug().match.used === 1, 'asking again for the same position does not use another hint');

  let free = () => { for (let i = 0; i < 225; i++) if (!S.cells[i].children.some(ch => ch._cls.has('stone'))) return i; };
  for (let k = 2; k <= 4; k++) {
    await play(o.ring[0] !== undefined ? o.ring[0] : free(), 1);   // I play
    S.turn.textContent = 'Opponent Turn';
    await sleep(900);
    await play(free(), 2);                                           // opponent replies
    S.turn.textContent = 'Your Turn';
    await sleep(1600);
    o = ov();
    if (k <= 3) {
      check(o.ring.length === 0, `new position ${k}: previous hint cleared`);
      await useHint();
      o = ov();
      check(o.ring.length === 1 && window.__gomokuAI.debug().match.used === k, `hint ${k} used (${window.__gomokuAI.debug().match.used}/3)`);
    } else {
      await useHint();
      o = ov();
      check(o.ring.length === 0 && window.__gomokuAI.debug().match.used === 3, 'a 4th hint is refused');
      check(/已用完/.test(q('.gai-match-btn').textContent), 'button: ' + q('.gai-match-btn').textContent);
    }
  }
  check(chat.sent.filter(m => /已使用AI提示/.test(m)).length === 3, 'exactly 3 hint announcements: ' + chat.sent.filter(m => /已使用AI提示/.test(m)).join(' | '));

  // a new game in the same room: counter reset, announced again
  S.cells.forEach(c => c.removeAllChildren());
  S.turn.textContent = 'Your Turn';
  await sleep(2500);
  check(window.__gomokuAI.debug().match.used === 0, 'new game: hint counter reset to 0');
  check(chat.sent.filter(m => /开启了?比赛模式/.test(m)).length === 2, 'new game: match mode announced again: ' + JSON.stringify(chat.sent.filter(m => /开启/.test(m))));
}

async function scenarioOffer() {
  // fresh module state: a second controller instance in the same process is not possible,
  // so reuse the running one: switch to hint mode (allowed between games) and receive an offer
  window.__gomokuAI.setMode('hint');
  check(window.__gomokuAI.settings.mode === 'hint', 'between games: may leave match mode');
  const panel = document.getElementById('gai-panel');
  const handlers = window.socket;
  // the opponent turns match mode on
  const sentBefore = window.__simSent;
  window.__simOppSays('【AI助手·比赛】我开启了比赛模式：每方每局最多3次AI提示，胜率实时显示');
  check(panel.querySelector('.gai-offer').classList.contains('show'), 'offer shown when the opponent announces match mode (mode ' + window.__gomokuAI.settings.mode + ', classes ' + panel.querySelector('.gai-offer').className + ')');
  panel.querySelector('.gai-offer-btn').click();
  await sleep(300);
  check(window.__gomokuAI.settings.mode === 'match', 'accepting switches to match mode');
  check(sentBefore.some(m => /同意比赛模式/.test(m)), 'agreement sent in chat');
  void handlers;
}

(async () => {
  await scenarioMatch();
  await scenarioOffer();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
