#!/usr/bin/env node
/* 检查某个目标的反链能不能完整加载：node test/backlinks-probe.js Music */
'use strict';
const { parseHTML } = require('linkedom');
const core = require('../src/core.js');

const title = process.argv[2] || 'Music';
let n = 0;
const errs = [];
const s = core.createSolver({
  fetch: async u => {
    n++;
    const r = await fetch(u, { headers: { 'User-Agent': 'wikiracing-helper-test/0.1 (+https://github.com/zwandering/game-ai-plugins)' } });
    if (!r.ok) errs.push(r.status);
    return r;
  },
  parseHTML: h => parseHTML(h).document,
});
const st = s.setTarget('en', title);
const t0 = Date.now();
const iv = setInterval(() => {
  if (!st.backlinksDone) return;
  clearInterval(iv);
  console.log({ B1: st.B1.size, truncated: st.backlinksTruncated, error: st.backlinksError || null,
    total: st.backlinkTotal, requests: n, errs, sec: (Date.now() - t0) / 1000 });
  process.exit(0);
}, 200);
