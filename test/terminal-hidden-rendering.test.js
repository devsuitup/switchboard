// Regression/behavior tests for WebGL context suspend-on-switch in single
// view. This is one of two mechanisms scoped to !gridViewActive that reduce
// hidden-session render/GPU cost — the other (full write suspension via
// accumulate-while-hidden + replay-on-show, superseding an earlier ~1fps
// flush-throttle design) lives in test/terminal-hidden-suspend.test.js.
//
// showSession() keeps the outgoing session's GL context while it is among the
// most recently shown (WEBGL_WARM_CAP; test/terminal-webgl-warm.test.js covers
// the cap) and gives the incoming one a context in its reveal frame.
// hideGridView() suspends every session on the way out of grid mode so single
// view never inherits more than the contexts it is about to show.
//
// Uses the shared jsdom + vm.runInContext harness (test/terminal-manager-harness.js).

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

test('session switch in single view keeps the outgoing session warm and gives the incoming one a live context', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const s1 = window.createTerminalEntry({ sessionId: 's1' });
    const s2 = window.createTerminalEntry({ sessionId: 's2' });
    window.activeSessionId = 's1'; // s1 is the session currently shown
    window.gridViewActive = false;

    window.showSession('s2');

    assert.ok(s1.webglAddon, 'outgoing session is among the most recently shown — keeps its context');
    assert.ok(s2.webglAddon, 'incoming session has a live GL context');
  } finally {
    destroy();
  }
});

test('re-showing the already-active session does not suspend or reload its own WebGL', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.activeSessionId = 's1';
    window.gridViewActive = false;

    window.showSession('s1');

    assert.strictEqual(spies.webglDispose, 0, 'no suspend when incoming === outgoing session');
    assert.ok(entry.webglAddon, 'GL context still live');
  } finally {
    destroy();
  }
});

test('opening a new session while one is already shown keeps the previous one warm (mirrors session-restore reopening several sessions)', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const s1 = window.createTerminalEntry({ sessionId: 's1' });
    window.activeSessionId = 's1';
    window.gridViewActive = false;
    window.showSession('s1');
    assert.ok(s1.webglAddon, 's1 has a live GL context while shown');

    // A second session opens in the background (as runRestore's staggered
    // openSession() calls do) and is immediately shown, exactly like the real
    // openSession()/showSession() sequence in app.js.
    const s2 = window.createTerminalEntry({ sessionId: 's2' });
    window.activeSessionId = 's1'; // showSession captures the OUTGOING id before switching
    window.showSession('s2');

    assert.ok(s1.webglAddon, 's1 stays within the warm cap once s2 becomes the visible session');
    assert.ok(s2.webglAddon, 's2 has a live GL context');
  } finally {
    destroy();
  }
});

test('grid close suspends every open session; the subsequent showSession restores exactly the one being shown', async () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const a = window.createTerminalEntry({ sessionId: 'a' });
    const b = window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = true;

    window.hideGridView();
    assert.strictEqual(a.webglAddon, null, 'a suspended on grid close');
    assert.strictEqual(b.webglAddon, null, 'b suspended on grid close');
    const disposesAfterHide = spies.webglDispose;

    window.showSession('a');
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

    assert.ok(a.webglAddon, 'a restored — it is the one being shown in single view');
    assert.strictEqual(b.webglAddon, null, 'b stays suspended — hidden in single view');
    assert.strictEqual(spies.webglDispose, disposesAfterHide,
      'no extra dispose calls — restoring a never re-suspends it (no double-suspend)');
  } finally {
    destroy();
  }
});
