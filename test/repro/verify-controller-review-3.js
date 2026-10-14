// Extracts the keydown handler body from src/controller.js:448-453 and feeds a macOS Option+A event from an <input>.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/controller.js', 'utf8');
const m = src.match(/document\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n    \}\);/);
if (!m) throw new Error('handler not found');
let mode = 'hint', prevented = 0;
const settings = { get mode() { return mode; } };
const setMode = (x) => { mode = x; };
const handler = new Function('settings', 'setMode', 'e', m[1]);
const mk = (o) => Object.assign({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: 'å', code: 'KeyA', repeat: false,
  target: { tagName: 'INPUT', isContentEditable: false }, preventDefault() { prevented++; } }, o);
handler(settings, setMode, mk({}));
console.log('after Option+A in INPUT: mode =', mode, 'preventDefault calls =', prevented, '(expected: hint, 0)');
handler(settings, setMode, mk({ repeat: true }));
handler(settings, setMode, mk({ repeat: true }));
console.log('after 2 auto-repeat events: mode =', mode, '(flips each repeat)');
