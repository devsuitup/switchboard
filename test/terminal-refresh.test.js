'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(opts = {}) {
  const refreshes = [];
  const ctx = setupTerminalDom({ proposeDimensions: () => ({ cols: 120, rows: 40 }), ...opts,
    api: { resizeTerminal(id, cols, rows, options) { if (options?.refresh) refreshes.push({ id, cols, rows }); } } });
  let now = 0;
  let token = 0;
  const timers = new Map();
  ctx.window.setTimeout = (cb, delay) => { timers.set(++token, { cb, at: now + delay }); return token; };
  ctx.window.clearTimeout = (id) => timers.delete(id);
  ctx.window.requestAnimationFrame = (cb) => ctx.window.setTimeout(cb, 16);
  ctx.window.cancelAnimationFrame = ctx.window.clearTimeout;
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].cb();
    }
    now = end;
  };
  ctx.window.setActiveSession = (id) => { ctx.window.activeSessionId = id; };
  const entry = (id, remote = false) => {
    const e = ctx.window.createTerminalEntry({ sessionId: id, ...(remote ? { remoteAlias: 'fixture' } : {}) });
    Object.defineProperty(e.element, 'clientHeight', { value: 800 });
    ctx.window.sessionMap.set(id, e.session);
    return e;
  };
  return { ...ctx, entry, refreshes, advance, pendingTimers: () => timers.size };
}

async function flush(ctx) {
  ctx.advance(160);
}

test('returning to a tmux terminal refreshes once; returning to a local terminal does not', async () => {
  const ctx = setup();
  try {
    ctx.entry('remote', true);
    ctx.entry('local');
    ctx.window.showSession('local');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 0);
    ctx.window.showSession('remote');
    await flush(ctx);
    assert.deepEqual(ctx.refreshes, [{ id: 'remote', cols: 120, rows: 40 }]);
    ctx.window.showSession('remote');
    ctx.window.showSession('local');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 1);
  } finally { ctx.destroy(); }
});

test('restore refreshes a new remote terminal once even when its saved id is already active', async () => {
  const ctx = setup();
  try {
    ctx.entry('remote', true);
    ctx.window.activeSessionId = 'remote';
    const guardPath = path.join(__dirname, '../public/resume-guard.js');
    vm.runInContext(fs.readFileSync(guardPath, 'utf8'), ctx.context, { filename: guardPath });
    const { runRestore } = loadAppFunctions(ctx.context, { functions: ['runRestore'] });
    await runRestore([{ sessionId: 'remote', active: true }]);
    await flush(ctx);
    assert.deepEqual(ctx.refreshes, [{ id: 'remote', cols: 120, rows: 40 }]);
    ctx.window.showSession('remote');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 1);
  } finally { ctx.destroy(); }
});

test('quick remote returns and container resizes coalesce into one fitted refresh', async () => {
  let dims = { cols: 120, rows: 40 };
  const ctx = setup({ proposeDimensions: () => dims });
  try {
    const e = ctx.entry('remote', true);
    ctx.entry('local');
    for (let i = 0; i < 4; i++) {
      ctx.window.showSession('local');
      ctx.window.showSession('remote');
    }
    dims = { cols: 150, rows: 35 };
    ctx.spies.resizeObservers[0].trigger();
    assert.equal(ctx.refreshes.length, 0, 'no immediate refresh during WebGL activation');
    await flush(ctx);
    assert.deepEqual(ctx.refreshes, [{ id: 'remote', cols: 150, rows: 35 }]);
    assert.equal(e.terminal.cols, 150);
    assert.equal(e.terminal.rows, 35);
  } finally { ctx.destroy(); }
});

test('refresh bursts and the resize observer share one delayed geometry measurement', () => {
  let measurements = 0;
  const ctx = setup({ proposeDimensions: () => { measurements++; return { cols: 120, rows: 40 }; } });
  try {
    ctx.entry('local');
    measurements = 0;
    for (let i = 0; i < 5; i++) ctx.window.requestTerminalRefresh('local');
    ctx.spies.resizeObservers[0].trigger();
    ctx.advance(79);
    assert.equal(measurements, 0);
    ctx.advance(1);
    assert.equal(measurements, 1);
    assert.equal(ctx.refreshes.length, 1);
  } finally { ctx.destroy(); }
});

test('a grid card return refreshes a remote terminal once, even through showSession', async () => {
  const ctx = setup();
  try {
    ctx.entry('remote', true);
    ctx.entry('local');
    ctx.window.gridViewActive = true;
    ctx.window.sortedOrder = [];
    ctx.window.terminalsEl.classList.add('grid-layout');
    ctx.window.HTMLElement.prototype.scrollIntoView = () => {};
    ctx.window.showSession('local');
    ctx.window.showSession('remote');
    await flush(ctx);
    assert.deepEqual(ctx.refreshes, [{ id: 'remote', cols: 120, rows: 40 }]);
    ctx.window.focusGridCard('local');
    ctx.window.focusGridCard('remote');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 2);
  } finally { ctx.destroy(); }
});

test('Refresh header control uses the shipped markup and issues one local refresh', async () => {
  const ctx = setup();
  try {
    ctx.entry('local');
    ctx.window.activeSessionId = 'local';
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const holder = ctx.window.document.createElement('div');
    holder.innerHTML = html;
    const button = holder.querySelector('#terminal-refresh-btn');
    assert.ok(button, 'the running-app header offers Refresh');
    const stop = holder.querySelector('#terminal-stop-btn');
    assert.equal(button.nextElementSibling, stop, 'Refresh sits next to Stop');
    ctx.window.document.querySelector('#terminal-header-controls').append(button);
    const { initTerminalRefreshControl } = loadAppFunctions(ctx.context, { functions: ['initTerminalRefreshControl'] });
    initTerminalRefreshControl();
    button.click();
    await flush(ctx);
    assert.deepEqual(ctx.refreshes, [{ id: 'local', cols: 120, rows: 40 }]);
  } finally { ctx.destroy(); }
});

test('the sidebar context menu offers one refresh for each open local or remote session', () => {
  const ctx = setupSidebarDom();
  try {
    const calls = [];
    ctx.window.requestTerminalRefresh = (id) => calls.push(id);
    for (const remote of [false, true]) {
      const id = remote ? 'remote' : 'local';
      const session = { sessionId: id, projectPath: '/fixture', modified: new Date().toISOString(), ...(remote ? { remoteAlias: 'fixture' } : {}) };
      ctx.window.openSessions.set(id, { session, closed: false });
      ctx.window.sessionMap.set(id, session);
      ctx.sidebar.renderProjects([{ projectPath: '/fixture', sessions: [session] }]);
      const item = ctx.document.querySelector(`[data-session-id="${id}"]`);
      item.dispatchEvent(new ctx.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const button = ctx.document.querySelector('.session-context-menu .session-refresh-btn');
      assert.ok(button, 'session context menu offers Refresh');
      button.click();
      assert.deepEqual(calls, remote ? ['local', 'remote'] : ['local']);
      assert.equal(ctx.document.querySelector('.session-context-menu'), null);
    }
  } finally { ctx.destroy(); }
});

test('destroying or hiding a terminal prevents a pending refresh', async () => {
  const ctx = setup();
  try {
    const e = ctx.entry('local');
    ctx.window.requestTerminalRefresh('local');
    ctx.window.destroySession('local');
    assert.equal(ctx.pendingTimers(), 0, 'destruction cancels scheduled fits');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 0);
    ctx.window.requestTerminalRefresh('missing');
    e.closed = true;
    ctx.window.openSessions.set('closed', e);
    ctx.window.requestTerminalRefresh('closed');
    assert.equal(ctx.pendingTimers(), 0, 'closed terminals schedule no fit');
    await flush(ctx);
    assert.equal(ctx.refreshes.length, 0);
  } finally { ctx.destroy(); }
});
