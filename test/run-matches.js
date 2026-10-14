#!/usr/bin/env node
/* Runs many test/match.js games in parallel child processes and prints a summary.
 * Usage: node test/run-matches.js --rule freestyle --games 200 --procs 10 --out DIR
 *        [--time 300] [--opp v1:300] [--open 4] [--seed 5000] [--engopts '{}'] [--tag name] */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const rule = arg('rule', 'freestyle'), games = +arg('games', 100), procs = +arg('procs', 8);
const out = arg('out', '/tmp'), tag = arg('tag', 'm'), per = Math.ceil(games / procs);
fs.mkdirSync(out, { recursive: true });
const pass = ['time', 'opp', 'open', 'seed', 'engopts', 'engine'].flatMap(k => arg(k) !== undefined ? ['--' + k, arg(k)] : []);
const files = [];
const jobs = [];
for (let k = 0; k < procs; k++) {
  const start = k * per, n = Math.min(per, games - start);
  if (n <= 0) break;
  const f = path.join(out, `${tag}-${rule}-${k}.json`);
  files.push(f);
  jobs.push(new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'match.js'), '--rule', rule, '--games', String(n), '--start', String(start), '--json', f, ...pass], { stdio: 'ignore' });
    c.on('exit', resolve);
  }));
}
Promise.all(jobs).then(() => {
  const s = { b: [0, 0, 0], w: [0, 0, 0] };
  let falseWins = 0, violations = 0;
  for (const f of files) {
    for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const k = g.engineColor === 1 ? 'b' : 'w';
      s[k][g.draw ? 2 : g.engineWon ? 0 : 1]++;
      if (!g.engineWon && g.moves.some(m => m.who === 'engine' && m.info && m.info.score >= 999800)) falseWins++;
      violations += g.violations.filter(v => v.by === 'engine').length;
    }
  }
  const W = s.b[0] + s.w[0], L = s.b[1] + s.w[1], D = s.b[2] + s.w[2];
  console.log(`${tag} ${rule}: W ${W} L ${L} D ${D} score ${((W + D / 2) / (W + L + D) * 100).toFixed(1)}%` +
    ` | as black ${s.b.join('/')} | as white ${s.w.join('/')} | lost after claiming a win: ${falseWins} | engine forbidden moves: ${violations}`);
});
