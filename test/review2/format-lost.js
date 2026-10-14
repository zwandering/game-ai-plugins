'use strict';
// formatScore(): is the new 'lost' text ever reachable? Engine returns reason 'lost' with score -WIN.
// Usage: node test/review2/format-lost.js
const fs = require('fs'), path = require('path');
const lib = require('../../src/engine.js')();
const src = fs.readFileSync(path.join(__dirname, '../../src/controller.js'), 'utf8');
const fsrc = /function formatScore\(r\) \{[\s\S]*?\n  \}/.exec(src)[0];
const formatScore = eval('(' + fsrc + ')');
const e = new lib.Engine({ rule: 'renju' });
const b = []; for (let r = 0; r < 15; r++) b.push(new Array(15).fill(0));
// black overline point at (7,3); white four (3..6,3) whose only completion is (7,3)
[[7, 0], [7, 1], [7, 2], [7, 4], [7, 5], [2, 3]].forEach(([r, c]) => { b[r][c] = 1; });
[[3, 3], [4, 3], [5, 3], [6, 3], [14, 14], [12, 10]].forEach(([r, c]) => { b[r][c] = 2; });
e.setBoard(b);
console.log('isForbidden(7,3) =', e.isForbidden(7 * 15 + 3));
const r = e.think(1, { timeMs: 300 });
console.log('engine: reason', r.reason, 'score', r.score);
console.log('formatScore ->', formatScore(r), '(expected the new text 对方必胜（无合法防点）)');
console.log('immediate five: formatScore({score:1e6,reason:"win"}) ->', formatScore({ score: 1e6, reason: 'win' }));
