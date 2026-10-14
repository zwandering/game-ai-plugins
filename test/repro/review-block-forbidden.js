// Review: think() 'block-four' path when black's only block is a forbidden point:
// returns the forbidden cell with score 0 (should be reported as a loss, -WIN).
// Position captured from renju self-play (test/review-time.js 200 3).
const G = require('../../src/engine.js')();
const { Engine, rc, BLACK, WHITE } = G;
const s = '000000000000000000000000000000000000000000000000000000000000000000001000000000002020000000000000200000000000012110200000002122211112000000102210100000000001020010000000000000002000000000000000000000000000000000000000000000000';
const e = new Engine({ rule: 'renju' });
e.setBoard(s.split('').map(Number));
console.log(e.toString());
const r = e.think(BLACK, { timeMs: 300 });
console.log('think ->', r.reason, JSON.stringify(rc(r.move)), 'score', r.score, 'isForbidden(move)=', e.isForbidden(r.move), 'legal=', e.legal(r.move, BLACK));
