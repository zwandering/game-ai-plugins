#!/usr/bin/env node
/* Builds dist/extension (Chrome/Edge MV3 unpacked extension) and dist/gomoku-ai.user.js (Tampermonkey). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/controller.js'), 'utf8');

const MATCHES = ['https://gomoku.com/*', 'https://www.gomoku.com/*'];
const dist = path.join(root, 'dist');
const ext = path.join(dist, 'extension');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(ext, { recursive: true });

// --- Chrome extension (Manifest V3). Scripts run in the page's main world so
// the controller can read window.i18n (turn label) and create a blob Worker.
const manifest = {
  manifest_version: 3,
  name: 'Gomoku AI 助手 (gomoku.com)',
  version,
  description: '为 gomoku.com 五子棋/连珠提供 AI 落子提示或自动下棋。',
  content_scripts: [{
    matches: MATCHES,
    js: ['engine.js', 'controller.js'],
    run_at: 'document_idle',
    world: 'MAIN',
  }],
  icons: { 128: 'icon128.png' },
};
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(ext, 'engine.js'), engine);
fs.writeFileSync(path.join(ext, 'controller.js'), controller);
fs.copyFileSync(path.join(root, 'assets/icon128.png'), path.join(ext, 'icon128.png'));

// --- Userscript (Tampermonkey / Violentmonkey). @grant none => page context.
const header = [
  '// ==UserScript==',
  '// @name         Gomoku AI 助手 (gomoku.com)',
  '// @namespace    https://github.com/local/gomoku-ai-plugin',
  `// @version      ${version}`,
  '// @description  为 gomoku.com 五子棋/连珠提供 AI 落子提示或自动下棋。',
  ...MATCHES.map(m => `// @match        ${m}`),
  '// @run-at       document-idle',
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');
fs.writeFileSync(path.join(dist, 'gomoku-ai.user.js'), header + engine + '\n' + controller);

console.log('built', path.relative(root, ext), 'and', path.relative(root, path.join(dist, 'gomoku-ai.user.js')), 'v' + version);
