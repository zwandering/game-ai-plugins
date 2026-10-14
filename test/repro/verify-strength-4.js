const G = require('../../src/engine.js')();
const { isForbiddenInd } = require('../match.js');
// Case A: reviewer's case
{
  const b = new Array(225).fill(0);
  for (const [r, c] of [[4,3],[5,3],[6,3],[7,4],[7,5],[7,6],[7,8],[7,9]]) b[r*15+c] = 1;
  for (const [r, c] of [[7,2],[2,3],[0,0],[0,14],[14,0],[14,14],[0,7],[14,7]]) b[r*15+c] = 2;
  const e = new G.Engine({ rule: 'renju' }); e.setBoard(b); const p = 7*15+3;
  console.log('A shapes', [0,1,2,3].map(d => G.SHAPE_NAMES[e.shape[d*225+p]]),
    'engine forbidden', e.isForbidden(p), 'legal', e.legal(p,1), 'indep forbidden', isForbiddenInd(b, p));
}
