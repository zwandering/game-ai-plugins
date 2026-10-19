#!/usr/bin/env node
/* Builds dist/extension (Chrome/Edge MV3 unpacked extension) and dist/wikirace-helper.user.js (Tampermonkey). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const coreSrc = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'src/ui.js'), 'utf8');

const MATCHES = ['https://wikiracing.org/*', 'https://www.wikiracing.org/*'];
const NAME = 'WikiRace 助手 (wikiracing.org)';
const DESC = '在 wikiracing.org 上提示当前页面该点哪个链接：直达 / 2 步 / 3 步路线和相关度排序。';
const dist = path.join(root, 'dist');
const ext = path.join(dist, 'extension');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(ext, { recursive: true });

// --- Chrome extension (Manifest V3). 隔离环境的 content script 就够了：只读写 DOM，
// Wikipedia API 本身允许跨域（origin=*）。
const manifest = {
  manifest_version: 3,
  name: NAME,
  version,
  description: DESC,
  content_scripts: [{
    matches: MATCHES,
    js: ['core.js', 'ui.js'],
    run_at: 'document_idle',
  }],
};
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(ext, 'core.js'), coreSrc);
fs.writeFileSync(path.join(ext, 'ui.js'), uiSrc);

// --- Userscript (Tampermonkey / Violentmonkey).
const header = [
  '// ==UserScript==',
  `// @name         ${NAME}`,
  '// @namespace    https://github.com/local/wikiracing-helper',
  `// @version      ${version}`,
  `// @description  ${DESC}`,
  ...MATCHES.map(m => `// @match        ${m}`),
  '// @connect      wikipedia.org',
  '// @run-at       document-idle',
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');
fs.writeFileSync(path.join(dist, 'wikirace-helper.user.js'), header + coreSrc + '\n' + uiSrc);

console.log('built', path.relative(root, ext), 'and', path.relative(root, path.join(dist, 'wikirace-helper.user.js')), 'v' + version);
