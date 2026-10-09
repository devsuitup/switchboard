'use strict';

// The IDE Emulation badge shows the state that holds for the session — off,
// failed to start, listening with no CLI attached, or connected — not whether
// a server object exists (#320).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <div id="terminal-area"><div id="terminals"></div></div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-session"><button id="terminal-stop-btn"></button></div>
    </div>
  </body>
</html>`;

function setup() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { status: null };
  window.api = new Proxy({
    onMcpStatus: (cb) => { calls.status = cb; },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });
  for (const f of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'file-panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC_DIR, f) });
  }
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  const switchPanel = window.switchPanel;
  window.switchPanel = id => {
    if (id) window.openSessions.set(id, { terminal: { focus() {} } });
    switchPanel(id);
  };
  const badge = () => window.document.getElementById('ide-emulation-indicator');
  return { window, calls, badge, destroy: () => window.close() };
}

test('a session with no IDE emulation shows no badge', () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.setSessionMcpState('s1', 'off');
    assert.equal(ctx.badge().style.display, 'none');
  } finally { ctx.destroy(); }
});

test('a listening server whose CLI has not attached says it is waiting, not that IDE emulation works', () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.setSessionMcpState('s1', 'listening');
    assert.notEqual(ctx.badge().style.display, 'none');
    assert.equal(ctx.badge().textContent, 'IDE Emulation: waiting for CLI');
    assert.match(ctx.badge().title, /not connected/i);
  } finally { ctx.destroy(); }
});

test('a connected CLI shows the plain IDE Emulation badge', () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.setSessionMcpState('s1', 'connected');
    assert.notEqual(ctx.badge().style.display, 'none');
    assert.equal(ctx.badge().textContent, 'IDE Emulation');
  } finally { ctx.destroy(); }
});

test('a server that could not start shows the failure and its reason', () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.setSessionMcpState('s1', 'failed', 'EADDRINUSE');
    assert.notEqual(ctx.badge().style.display, 'none');
    assert.equal(ctx.badge().textContent, 'IDE Emulation: failed');
    assert.match(ctx.badge().title, /EADDRINUSE/);
  } finally { ctx.destroy(); }
});

test('a status pushed from main updates the badge of the session it names, and only that one', () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.setSessionMcpState('s1', 'listening');
    ctx.window.setSessionMcpState('s2', 'listening');

    ctx.calls.status('s1', 'connected');
    assert.equal(ctx.badge().textContent, 'IDE Emulation');

    ctx.calls.status('s2', 'connected');
    ctx.calls.status('s1', 'listening');
    assert.equal(ctx.badge().textContent, 'IDE Emulation: waiting for CLI', 'a disconnect puts the badge back to waiting');

    ctx.window.switchPanel('s2');
    assert.equal(ctx.badge().textContent, 'IDE Emulation', 'the other session kept its own state');
  } finally { ctx.destroy(); }
});
