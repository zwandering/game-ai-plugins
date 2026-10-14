// Exhaustive-defender verification of findVct/findVcf win claims.
// For each sampled position and attacker, take the engine's claim, then verify it:
//  - defender nodes: EVERY legal defender move is tried (no genDefence filter);
//    a move is an immediate attacker win if afterwards the defender has no five
//    point and the attacker has a five point or a legal open-four/double-four point;
//  - attacker nodes: the attacker must re-find a win (fresh caches) with findVct/findVcf;
//    if it cannot, the node is "unproven" (maybe budget) and is re-checked deeper.
// A defender move that makes five (or reaches a node where the defender has a five
// point the attacker cannot stop) is a REFUTATION.
// Usage: node test/review2/verify-claims.js <pos.json> [samples=60] [mode=think|deep] [start=0] [both=1]
'use strict';
const fs = require('fs');
const G = require('../../src/engine.js')();
const [file, sArg = '60', mode = 'think', startArg = '0', bothArg = '1'] = process.argv.slice(2);
const pos = JSON.parse(fs.readFileSync(file, 'utf8'));
const N = 225, FIVE = 4, WIN2 = 3;
const name = p => String.fromCharCode(65 + p % 15) + ((p / 15) | 0);

function verifier(rule) {
  const V = new G.Engine({ rule, ttBits: 12 });
  let budget = 0, memo = new Map(), unproven = 0;
  const key = (att, side) => `${V.hashHi},${V.hashLo},${att},${side}`;
  function prove(att) {
    V.clearCaches();
    let r = V.findVcf(att, 60000, 30);
    if (r && r.move >= 0) return r.move;
    V.clearCaches();
    r = V.findVct(att, 60000, 16, Infinity);
    if (r && r.move >= 0) return r.move;
    V.clearCaches();
    r = V.findVct(att, 600000, 24, Infinity);
    if (r && r.move >= 0) return r.move;
    return -1;
  }
  // attacker to move. returns {ok:true} | {ok:false, line, why}
  function att(a, line) {
    const d = 3 - a, ai = a - 1, di = d - 1;
    if (V.catCount[ai * 5 + FIVE] > 0) return { ok: true };
    const k = key(a, 0);
    if (memo.has(k)) return memo.get(k);
    let res;
    if (V.catCount[di * 5 + FIVE] > 0) {
      // must block (only one block point is useful)
      const blocks = [];
      for (let p = 0; p < N; p++) if (V.cat[di * N + p] === FIVE) blocks.push(p);
      if (blocks.length > 1 || !V.legal(blocks[0], a)) res = { ok: false, line, why: 'attacker cannot stop defender five' };
      else { V.play(blocks[0], a); res = def(a, line.concat('+' + name(blocks[0]) + '(forced)')); V.undo(); }
    } else {
      let m = -1;
      for (let p = 0; p < N; p++) if (V.cat[ai * N + p] === WIN2 && V.legal(p, a)) { m = p; break; }
      if (m >= 0) res = { ok: true };
      else {
        if (--budget < 0) return { ok: null, line, why: 'budget' };
        m = prove(a);
        if (m < 0) { unproven++; res = { ok: null, line, why: 'attacker cannot re-prove' }; }
        else if (!V.legal(m, a)) res = { ok: false, line, why: 'proof move illegal ' + name(m) };
        else { V.play(m, a); res = def(a, line.concat('+' + name(m))); V.undo(); }
      }
    }
    memo.set(k, res);
    return res;
  }
  function def(a, line) {
    const d = 3 - a, di = d - 1;
    if (V.catCount[di * 5 + FIVE] > 0) return { ok: false, line, why: 'defender has a five point' };
    const k = key(a, 1);
    if (memo.has(k)) return memo.get(k);
    let res = { ok: true };
    for (let p = 0; p < N; p++) {
      if (V.board[p] !== 0 || !V.legal(p, d)) continue;
      V.play(p, d);
      let r;
      if (V.hasWon(d)) r = { ok: false, line: line.concat('-' + name(p)), why: 'defender made five' };
      else r = att(a, line.concat('-' + name(p)));
      V.undo();
      if (r.ok !== true) { res = r; if (r.ok === false) break; }
    }
    memo.set(k, res);
    return res;
  }
  return {
    V,
    run(board, a, firstMove) {
      V.setBoard(board); memo = new Map(); budget = +(process.env.BUDGET || 400); unproven = 0;
      if (!V.legal(firstMove, a)) return { ok: false, line: [], why: 'claimed move illegal ' + name(firstMove) };
      V.play(firstMove, a);
      const r = def(a, ['+' + name(firstMove)]);
      V.undo();
      return r;
    },
  };
}

const S = +sArg, start = +startArg;
const step = Math.max(1, Math.floor(pos.length / S));
const ver = verifier(pos[0].rule);
const E = new G.Engine({ rule: pos[0].rule });
let claims = 0, ok = 0, bad = 0, unk = 0;
const t0 = Date.now();
for (let i = start; i < pos.length && Date.now() - t0 < 250000; i += step) {
  const P = pos[i];
  for (const a of (+bothArg ? [P.toMove, 3 - P.toMove] : [P.toMove])) {
    E.setBoard(P.board);
    const ai = a - 1, di = 2 - a;
    if (E.catCount[ai * 5 + FIVE] || E.catCount[di * 5 + FIVE] || E.catCount[ai * 5 + WIN2]) continue;
    // simulate a game continuation: caches warm from the previous position
    let r;
    if (mode === 'deep') r = E.findVct(a, 400000, 20, Infinity);
    else r = E.findVct(a, 40000, 14, Infinity);
    if (!r) continue;
    claims++;
    const v = ver.run(P.board, a, r.move);
    if (v.ok === true) ok++;
    else if (v.ok === null) { unk++; console.log(`UNPROVEN pos#${i} att ${a === 1 ? 'X' : 'O'} claim ${r.plies} via ${name(r.move)}: ${v.why} at ${v.line.join(' ')}`); }
    else { bad++; console.log(`REFUTED pos#${i} att ${a === 1 ? 'X' : 'O'} (toMove ${a === P.toMove}) claim ${r.plies} via ${name(r.move)}: ${v.why}; line ${v.line.join(' ')}`); }
  }
}
console.log(`${file} mode=${mode}: claims ${claims}, verified ${ok}, refuted ${bad}, unproven ${unk}, ${Math.round((Date.now() - t0) / 1000)}s`);
