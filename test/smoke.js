const G = require('../src/engine.js')();
const { Engine, parseBoard, rc } = G;
function solve(txt, color, rule, ms) {
  const e = new Engine({ rule: rule || 'freestyle' });
  e.setBoard(parseBoard(txt));
  const r = e.think(color, { timeMs: ms || 800 });
  return Object.assign(r, { rc: rc(r.move) });
}
const pad = s => s.split('\n').map(l => (l.trim() + '.'.repeat(15)).slice(0, 15)).join('\n');
const B = rows => { const a = rows.slice(); while (a.length < 15) a.push(''); return pad(a.join('\n')); };
let r = solve(B(['', '', '', '', '', '', '', '...XXXX', '', 'OOO']), 1);
console.log('win1', r.reason, r.rc);
r = solve(B(['', '', '', '', '', '', '', '...XXXX', '', 'OO']), 2);
console.log('block4', r.reason, r.rc);
r = solve(B(['', '', '', '', '', '', '', '....XXX', '', '......O']), 2);
console.log('block3', r.reason, r.rc, r.score);
const t0 = Date.now();
const e = new Engine();
let c = 1, moves = 0;
while (moves < 120) {
  const res = e.think(c, { timeMs: 300 });
  if (res.move < 0) break;
  e.play(res.move, c); moves++;
  if (e.hasWon(c)) { console.log('selfplay winner', c === 1 ? 'black' : 'white', 'after', moves); break; }
  c = 3 - c;
}
console.log(e.toString());
console.log('selfplay ms', Date.now() - t0);
