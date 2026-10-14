// When the opponent threatens a VCF (or VCT), does think() pick a move that leaves the
// opponent's VCF intact although some legal move stops it (checked with a big VCF budget)?
// Usage: node test/review2/defence-check.js <pos.json> [timeMs=300] [samples=400]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, tArg = '300', sArg = '400'] = process.argv.slice(2);
const pos = JSON.parse(fs.readFileSync(file, 'utf8'));
const T = +tArg, S = +sArg;
const step = Math.max(1, Math.floor(pos.length / S));
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);
const E = new G.Engine({ rule: pos[0].rule });
const C = new G.Engine({ rule: pos[0].rule, ttBits: 10 });
// me to move on C: can me avoid an opponent VCF (fours by me are followed through, depth-limited)?
function canHold(me, depth) {
  const opp = 3 - me;
  const n = C.genNormal(me, 50, 40);
  const cands = []; for (let i = 0; i < n; i++) cands.push(C.candBuf[50][i] % 256);
  for (let p = 0; p < 225; p++) if (C.cat[(me - 1) * 225 + p] >= 2 && cands.indexOf(p) < 0) cands.push(p);
  for (const q of cands) if (!afterLoses(me, q, depth)) return true;
  return false;
}
// does me playing p (on C) lose to an opponent VCF?
function afterLoses(me, p, depth) {
  const opp = 3 - me;
  if (C.board[p] || !C.legal(p, me)) return true;
  C.play(p, me);
  let res;
  if (C.hasWon(me) || C.catCount[(me - 1) * 5 + 4] >= 2) res = false;
  else if (C.catCount[(me - 1) * 5 + 4] === 1) {
    const b = C.firstCellWithCat(me, 4);
    if (!C.legal(b, opp)) res = false;
    else if (depth <= 0) res = true;
    else { C.play(b, opp); res = C.hasWon(opp) || !canHold(me, depth - 1); C.undo(); }
  } else {
    C.clearCaches();
    res = !!C.findVcf(opp, 300000, 40);
  }
  C.undo();
  return res;
}
function oppWinsAfter(board, me, p) { C.setBoard(board); return afterLoses(me, p, 2); }
let tested = 0, bad = 0;
const t0 = Date.now();
for (let i = 0; i < pos.length && Date.now() - t0 < 240000; i += step) {
  const P = pos[i], me = P.toMove, opp = 3 - me;
  E.setBoard(P.board);
  const mi = me - 1, oi = opp - 1;
  if (E.catCount[mi * 5 + 4] || E.catCount[oi * 5 + 4] || E.catCount[mi * 5 + 3]) continue;
  if (E.findVcf(me, 60000, 30)) continue;
  C.setBoard(P.board); C.clearCaches();
  if (!C.findVcf(opp, 300000, 40)) continue; // opponent has no VCF threat
  E.setBoard(P.board);
  const r = E.think(me, { timeMs: T });
  if (r.reason === 'vct' || r.reason === 'vcf') continue;
  tested++;
  if (!oppWinsAfter(P.board, me, r.move)) continue;
  // is there any defence?
  const safe = [];
  for (let p = 0; p < 225; p++) {
    if (P.board[p] || !E.legal(p, me)) continue;
    if (!oppWinsAfter(P.board, me, p)) { safe.push(name(p)); if (safe.length >= 5) break; }
  }
  if (safe.length) {
    bad++;
    console.log(`pos#${i} ${P.rule} me ${me}: think(${T}) -> ${name(r.move)} (${r.reason}, phases ${JSON.stringify(r.phases)}) leaves opp VCF; defences exist e.g. ${safe.join(' ')}`);
  }
}
console.log(`${file} T=${T}: tested ${tested}, missed defence ${bad}`);
