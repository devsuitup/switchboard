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
  const resizes = [];
  const ctx = setupTerminalDom({ proposeDimensions: () => ({ cols: 120, rows: 40 }), ...opts,
    api: { resizeTerminal(id, cols, rows, options) {
      resizes.push({ id, cols, rows });
      if (options?.refresh) refreshes.push({ id, cols, rows });
      opts.resizeTerminal?.(id, cols, rows, options);
    } } });
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
    Object.defineProperty(e.element, 'clientHeight', { value: 800, configurable: true });
    if (remote) e.remoteResizeAllowed = true;
    ctx.window.sessionMap.set(id, e.session);
    return e;
  };
  return { ...ctx, entry, refreshes, resizes, advance, pendingTimers: () => timers.size };
}

async function flush(ctx) {
  ctx.advance(160);
}

function promotionReceiver(ctx) {
  const listeners = new Map();
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { on(channel, cb) { listeners.set(channel, cb); } },
      webUtils: {},
    }),
  });
  ctx.window.api.onRemoteResizeAllowed = api.onRemoteResizeAllowed;
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = app.indexOf('window.api.onRemoteResizeAllowed(');
  if (start !== -1) {
    const end = app.indexOf('\n});', start) + 4;
    vm.runInContext(app.slice(start, end), ctx.context);
  }
  return id => listeners.get('remote-resize-allowed')?.(null, id);
}

for (const changed of [false, true]) {
  test(`promotion event enables fitted resize and later refresh on return (${changed ? 'changed' : 'unchanged'} dimensions)`, () => {
    let dims = { cols: 120, rows: 40 };
    const ctx = setup({ proposeDimensions: () => dims });
    try {
      const receive = promotionReceiver(ctx);
      const e = ctx.entry('shared', true);
      e.remoteResizeAllowed = false;
      ctx.entry('local');
      ctx.window.showSession('shared');
      ctx.advance(160);
      assert.deepEqual(ctx.resizes, []);
      if (changed) dims = { cols: 150, rows: 35 };
      receive('shared');
      receive('shared');
      ctx.spies.resizeObservers[0].trigger();
      assert.equal(e.remoteResizeAllowed, true, 'renderer must learn the attachment is solo');
      ctx.advance(79);
      assert.deepEqual(ctx.resizes, [], 'promotion uses the debounced fit path');
      ctx.advance(1);
      assert.deepEqual(ctx.resizes, [{ id: 'shared', ...dims }], 'promotion sends one current fitted size');
      receive('shared');
      ctx.advance(80);
      assert.equal(ctx.resizes.length, 1, 'a repeated notification cannot resynchronize a solo entry');
      dims = { cols: 160, rows: 45 };
      ctx.spies.resizeObservers[0].trigger();
      ctx.advance(80);
      assert.deepEqual(ctx.resizes.at(-1), { id: 'shared', ...dims });
      assert.equal(ctx.resizes.length, 2, 'later geometry changes reach IPC');
      ctx.window.showSession('local');
      ctx.window.showSession('shared');
      ctx.advance(160);
      assert.deepEqual(ctx.refreshes, [{ id: 'shared', ...dims }], 'return now refreshes the solo terminal');
    } finally { ctx.destroy(); }
  });
}

test('promotion events ignore unknown, closed and local entries', () => {
  const ctx = setup();
  try {
    const receive = promotionReceiver(ctx);
    const closed = ctx.entry('closed', true);
    closed.remoteResizeAllowed = false;
    closed.closed = true;
    const local = ctx.entry('local');
    receive('unknown');
    receive('closed');
    receive('local');
    ctx.advance(160);
    assert.equal(closed.remoteResizeAllowed, false);
    assert.notEqual(local.remoteResizeAllowed, true);
    assert.deepEqual(ctx.resizes, []);
  } finally { ctx.destroy(); }
});

test('promotion schedules a fitted resize without a geometry observer callback', () => {
  const ctx = setup();
  try {
    const receive = promotionReceiver(ctx);
    const e = ctx.entry('shared', true);
    e.remoteResizeAllowed = false;
    ctx.window.showSession('shared');
    ctx.advance(160);
    receive('shared');
    assert.deepEqual(ctx.resizes, []);
    ctx.advance(80);
    assert.deepEqual(ctx.resizes, [{ id: 'shared', cols: 120, rows: 40 }]);
  } finally { ctx.destroy(); }
});

test('a background promotion keeps selection and sends the fitted size when revealed', () => {
  const ctx = setup();
  try {
    const receive = promotionReceiver(ctx);
    const e = ctx.entry('shared', true);
    e.remoteResizeAllowed = false;
    ctx.entry('local');
    ctx.window.showSession('local');
    ctx.advance(160);
    ctx.resizes.length = 0;
    Object.defineProperty(e.element, 'clientHeight', { value: 0, configurable: true });
    receive('shared');
    ctx.advance(160);
    assert.equal(e.remoteResizeAllowed, true);
    assert.equal(ctx.window.activeSessionId, 'local');
    assert.deepEqual(ctx.resizes, []);
    Object.defineProperty(e.element, 'clientHeight', { value: 800, configurable: true });
    ctx.window.showSession('shared');
    ctx.advance(160);
    assert.deepEqual(ctx.refreshes, [{ id: 'shared', cols: 120, rows: 40 }]);
  } finally { ctx.destroy(); }
});

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

test('shared attach return skips refresh in single and grid views, including unknown sizing', () => {
  let dims = { cols: 120, rows: 40 };
  const ctx = setup({ proposeDimensions: () => dims });
  try {
    const e = ctx.entry('shared', true);
    ctx.entry('local');
    e.remoteResizeAllowed = false;
    dims = { cols: 150, rows: 35 };
    const requests = [];
    const request = ctx.window.requestTerminalRefresh;
    ctx.window.requestTerminalRefresh = (id) => { requests.push(id); request(id); };
    ctx.window.showSession('local');
    ctx.window.showSession('shared');
    ctx.advance(160);
    ctx.window.gridViewActive = true;
    ctx.window.HTMLElement.prototype.scrollIntoView = () => {};
    ctx.window.focusGridCard('local');
    ctx.window.focusGridCard('shared');
    ctx.advance(160);
    delete e.remoteResizeAllowed;
    ctx.window.focusGridCard('local');
    ctx.window.focusGridCard('shared');
    ctx.advance(160);
    assert.deepEqual(requests, []);
    assert.deepEqual(ctx.refreshes, []);
    assert.deepEqual(ctx.resizes.filter(({ id }) => id === 'shared'), []);
  } finally { ctx.destroy(); }
});

test('shared explicit Refresh redraws locally without fitting, IPC, raw resize or ssh commands', async () => {
  const { createTmuxAttachAdapter } = require('../remote-attach');
  const { createTerminalResizeHandler } = require('../terminal-resize');
  const rawResizes = [];
  const commands = [];
  const tasks = [];
  const adapter = createTmuxAttachAdapter({
    spawnPty: () => ({ resize: (...args) => rawResizes.push(args), onExit() {}, onData() {}, write() {}, kill() {} }),
    runRemoteCommand: async (_alias, command) => {
      commands.push(command);
      return { code: 0, stdout: ['/tmp/tmux-0/fixture', '200x50', 'status off', '', '', '', '', '1', '1'].join('\u0001') };
    },
  });
  const attached = await adapter.attach('fixture', { pid: 42, tmux: 'main:@0.%0' }, { cols: 120, rows: 40 });
  assert.equal(attached.ok, true);
  const resize = createTerminalResizeHandler(new Map([['shared', { pty: attached.ptyProcess }]]), {
    setTimeout(cb) { tasks.push(cb); return tasks.length; }, clearTimeout() {},
  });
  const ctx = setup({ proposeDimensions: () => ({ cols: 150, rows: 35 }), resizeTerminal: (id, cols, rows, options) => resize(id, cols, rows, options?.refresh) });
  try {
    const e = ctx.entry('shared', true);
    ctx.window.syncPtySizeAfterOpen(e, attached);
    ctx.resizes.length = 0;
    commands.length = 0;
    const paints = [];
    let atlases = 0;
    e.terminal.refresh = (...args) => paints.push(args);
    e.webglAddon.clearTextureAtlas = () => { atlases++; };
    ctx.window.requestTerminalRefresh('shared');
    ctx.advance(160);
    while (tasks.length) tasks.shift()();
    assert.deepEqual(paints, [[0, e.terminal.rows - 1]]);
    assert.equal(atlases, 1);
    assert.deepEqual(ctx.resizes, []);
    assert.deepEqual(rawResizes, []);
    assert.deepEqual(commands, []);
  } finally { ctx.destroy(); }
});

test('remote sizing capability from open results gates return refresh and fails closed', () => {
  const ctx = setup();
  try {
    const e = ctx.entry('remote', true);
    ctx.entry('local');
    for (const result of [{ remoteResizeAllowed: false }, {}, { remoteResizeAllowed: true }]) {
      const previousResizes = ctx.resizes.length;
      ctx.window.syncPtySizeAfterOpen(e, result);
      assert.equal(ctx.resizes.length - previousResizes, result.remoteResizeAllowed === true ? 1 : 0);
      ctx.window.showSession('local');
      ctx.window.showSession('remote');
      ctx.advance(160);
      assert.equal(ctx.refreshes.length, result.remoteResizeAllowed === true ? 1 : 0);
    }
  } finally { ctx.destroy(); }
});

test('a hidden or disconnected fit discards refresh before a later unrelated geometry fit', () => {
  for (const hidden of [true, false]) {
    const ctx = setup();
    try {
      const e = ctx.entry('local');
      const parent = e.element.parentElement;
      ctx.window.requestTerminalRefresh('local');
      if (hidden) Object.defineProperty(e.element, 'clientHeight', { value: 0, configurable: true });
      else e.element.remove();
      ctx.advance(80);
      if (hidden) Object.defineProperty(e.element, 'clientHeight', { value: 800, configurable: true });
      else parent.append(e.element);
      ctx.spies.resizeObservers[0].trigger();
      ctx.advance(80);
      assert.deepEqual(ctx.refreshes, [], hidden ? 'hidden terminal' : 'disconnected terminal');
    } finally { ctx.destroy(); }
  }
});
