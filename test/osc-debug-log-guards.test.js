// The debug lines on the PTY data path must cost nothing when debug logging
// is off.
//
// `log.debug` decides at the transport whether to write, but its argument is
// built by the caller either way: a template literal interpolating
// `codePoints(payload, 1)` is rendered, handed to electron-log, walked through
// the transports and dropped. A packaged build sets both transports to `info`
// (main.js), so every one of these lines is discarded work there, and the CLI
// emits an OSC title per spinner frame. `LOG_DEBUG_ON` is the guard, the same
// shape as the `if (TRACE.on)` guard the probes on those lines already carry.
//
// This is a source scan, the house pattern for main.js (see
// read-file-for-panel-bounds.test.js): main.js needs an Electron host, so the
// only thing standing between the codebase and an unguarded hot-path debug
// line is a read of the text.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Normalised: core.autocrlf=true and no .gitattributes means a fresh clone can
// hand these tests CRLF while CI stays LF.
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function ptyDataHandler() {
  const start = MAIN.indexOf('function wireSessionPty(');
  assert.notEqual(start, -1, 'wireSessionPty not found in main.js');
  const end = MAIN.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'end of wireSessionPty not found');
  return MAIN.slice(start, end);
}

test('LOG_DEBUG_ON follows the transports rather than restating their condition', () => {
  const m = MAIN.match(/^const LOG_DEBUG_ON = (.+);$/m);
  assert.ok(m, 'LOG_DEBUG_ON must be declared');
  assert.match(m[1], /transports\.file\.level/);
  assert.match(m[1], /transports\.console\.level/);
  assert.ok(
    MAIN.indexOf('const LOG_DEBUG_ON') > MAIN.indexOf('log.transports.console.level ='),
    'the flag must be read after the levels are set',
  );
});

test('every debug line on the PTY data path is guarded', () => {
  const lines = ptyDataHandler().split('\n');
  const calls = lines.filter(l => l.includes('log.debug('));
  assert.ok(calls.length >= 5, `expected the OSC debug lines to still be there, found ${calls.length}`);
  for (const line of calls) {
    assert.match(
      line.trim(), /^if \(LOG_DEBUG_ON\) log\.debug\(/,
      `an unguarded log.debug on the PTY data path builds its message on every frame: ${line.trim()}`,
    );
  }
});

test('the OSC 0 title line renders code points only under the guard', () => {
  const line = ptyDataHandler().split('\n').find(l => l.includes('codePoints(payload, 1)'));
  assert.ok(line, 'the OSC 0 debug line must still report the title code point');
  assert.match(line.trim(), /^if \(LOG_DEBUG_ON\) log\.debug\(/);
});
