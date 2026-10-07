'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalResizeHandler } = require('../terminal-resize');
const { extractFunction } = require('./app-source');
const { createTmuxAttachAdapter } = require('../remote-attach');

async function promotionFixture(t, { initialCount = 1 } = {}) {
  const events = [];
  const logs = [];
  const listeners = new Map();
  const exits = [];
  const timers = new Map();
  let clients = '9000\t/dev/pts/2\t\n';
  let apply = async () => ({ code: 0, stdout: '' });
  const adapter = createTmuxAttachAdapter({
    profileId: 'fixture', instanceId: 'current', createAttachId: () => 'attach',
    resolveSshPath: () => 'fake-ssh',
    spawnPty: () => ({ onExit(cb) { exits.push(cb); }, resize() {}, kill() {} }),
    setTimeoutFn(cb) { const timer = { unref() {} }; timers.set(timer, cb); return timer; },
    clearTimeoutFn: timer => timers.delete(timer),
    log: { info: message => logs.push(message) },
    runRemoteCommand: async (_alias, command) => {
      if (command.includes('/proc/4242/environ')) {
        return { code: 0, stdout: ['/tmp/tmux-0/fixture', '200x50', 'status on', 'mouse off', 'window-size manual', 'set-titles off', 'set-titles-string plain', initialCount, '1'].join('\u0001') };
      }
      if (command.includes('client_pid')) return { code: 0, stdout: clients };
      if (command.includes('status off')) return apply();
      return { code: 0, stdout: '1\n' };
    },
  });
  const attached = await adapter.attach('fixture', { pid: 4242, tmux: 'main:@0.%0' }, { cols: 120, rows: 40 });
  const subscribe = attached.ptyProcess.onResizeAllowed;
  let notify;
  attached.ptyProcess.onResizeAllowed = cb => { notify = cb; subscribe?.(cb); };
  t.after(() => exits.forEach(cb => cb({ exitCode: 0 })));
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { on(channel, cb) { listeners.set(channel, cb); } },
      webUtils: {},
    }),
  });
  const activeSessions = new Map();
  const context = vm.createContext({
    activeSessions,
    mainWindow: { isDestroyed: () => false, webContents: { send(channel, ...args) {
      events.push({ channel, args });
      listeners.get(channel)?.(null, ...args);
    } } },
    wireSessionPty() {},
  });
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  vm.runInContext(extractFunction(main, 'registerRemoteAttachSession'), context);
  const session = context.registerRemoteAttachSession('promoted-session', {
    alias: 'fixture', projectPath: '/fixture', cwd: '/fixture', ...attached,
  });
  return {
    api, session, activeSessions, events, logs, context, pty: attached.ptyProcess,
    alone() { clients = '4242\t/dev/pts/1\tfixture:current:attach\n'; },
    applyWith(fn) { apply = fn; },
    exit() { exits.forEach(cb => cb({ exitCode: 0 })); },
    notify() { notify?.(); },
  };
}

test('adapter promotion updates main capability and emits one session event through preload', async t => {
  const f = await promotionFixture(t);
  const received = [];
  f.api.onRemoteResizeAllowed?.(id => received.push(id));
  await f.pty.reevaluateMode();
  assert.equal(f.session.remoteResizeAllowed, false);
  assert.deepEqual(f.events, [], 'remaining shared emits no promotion');
  f.alone();
  await f.pty.reevaluateMode();
  assert.equal(f.session.remoteResizeAllowed, true, 'main must learn the adapter is now solo');
  assert.deepEqual(f.events, [{ channel: 'remote-resize-allowed', args: ['promoted-session'] }]);
  assert.deepEqual(received, ['promoted-session'], 'preload forwards the session id');
  await f.pty.reevaluateMode();
  f.notify();
  assert.equal(f.events.length, 1);
  assert.equal(f.logs.filter(message => message.includes('is now solo')).length, 1);
});

test('initial solo and failed or interrupted promotions emit no capability event', async t => {
  const solo = await promotionFixture(t, { initialCount: 0 });
  await solo.pty.reevaluateMode();
  assert.equal(solo.session.remoteResizeAllowed, true);
  assert.deepEqual(solo.events, []);
  const shared = await promotionFixture(t);
  shared.alone();
  shared.applyWith(async () => ({ code: 1 }));
  await shared.pty.reevaluateMode();
  assert.equal(shared.session.remoteResizeAllowed, false);
  assert.deepEqual(shared.events, []);
  let finish;
  shared.applyWith(() => new Promise(resolve => { finish = resolve; }));
  const pending = shared.pty.reevaluateMode();
  await new Promise(resolve => setImmediate(resolve));
  shared.exit();
  finish({ code: 0 });
  await pending;
  assert.equal(shared.session.remoteResizeAllowed, false);
  assert.deepEqual(shared.events, []);
});

test('main ignores a promotion from an exited or replaced session and tolerates a destroyed window', async t => {
  for (const state of ['exited', 'replaced', 'removed', 'destroyed-window', 'missing-window']) {
    const f = await promotionFixture(t);
    f.alone();
    if (state === 'exited') f.session.exited = true;
    if (state === 'replaced') f.activeSessions.set('promoted-session', {});
    if (state === 'removed') f.activeSessions.delete('promoted-session');
    if (state === 'destroyed-window') f.context.mainWindow.isDestroyed = () => true;
    if (state === 'missing-window') f.context.mainWindow = null;
    await f.pty.reevaluateMode();
    assert.equal(f.session.remoteResizeAllowed, state.endsWith('window'));
    assert.deepEqual(f.events, []);
  }
});

test('remote open, reattach and launch preserve the adapter sizing capability in IPC results', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  for (const remoteResizeAllowed of [false, true]) {
    const activeSessions = new Map();
    const handlers = new Map();
    const descriptor = { sessionId: 'fixture', cwd: '/fixture' };
    const attachResult = { ok: true, ptyProcess: {}, remoteResizeAllowed };
    const context = vm.createContext({
      activeSessions,
      mainWindow: { webContents: { send() {} } },
      ipcMain: { handle: (name, cb) => handlers.set(name, cb) },
      getCachedFolder: () => 'remote-folder',
      isRemoteFolder: () => true,
      parseFolderKey: () => ({ alias: 'fixture' }),
      remoteIndexer: { getRemoteSessions: () => ({ sessions: [descriptor] }), refreshHostNow: async () => {} },
      normalizePtySize: require('../pty-size').normalizePtySize,
      remoteAttachAdapter: { attach: async () => attachResult },
      remoteLaunchAdapter: {},
      handleLaunchRequest: async () => ({ ok: true, descriptor, attachResult }),
      wireSessionPty() {},
      getMcpState: () => null,
    });
    vm.runInContext(extractFunction(main, 'registerRemoteAttachSession'), context);
    for (const channel of ['open-terminal', 'remote-launch-session']) {
      const start = main.indexOf(`ipcMain.handle('${channel}'`);
      const end = main.indexOf('\n});', start) + 4;
      assert.ok(start >= 0 && end > start);
      vm.runInContext(main.slice(start, end), context);
    }
    const open = handlers.get('open-terminal');
    const result = await open(null, 'fixture', '/fixture', false, {}, { cols: 120, rows: 40 });
    assert.equal(result.remoteResizeAllowed, remoteResizeAllowed, 'new attach');
    assert.equal((await open(null, 'fixture', '/fixture', false)).remoteResizeAllowed, remoteResizeAllowed, 'renderer reattach');
    activeSessions.clear();
    const launched = await handlers.get('remote-launch-session')(null, { alias: 'fixture', sessionId: 'fixture' });
    assert.equal(launched.remoteResizeAllowed, remoteResizeAllowed, 'launch attach');
  }
});

test('the shipped preload and main resize registration forward one refresh and restore its size', () => {
  const calls = [];
  const pending = [];
  const session = { pty: { resize(cols, rows) { calls.push({ cols, rows }); } } };
  const activeSessions = new Map([['fixture', session]]);
  let registered;
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('const handleTerminalResize =');
  const end = main.indexOf('// --- IPC: close-terminal ---', start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(main.slice(start, end), {
    activeSessions,
    createTerminalResizeHandler: (sessions) => createTerminalResizeHandler(sessions, {
      setTimeout(cb) { pending.push(cb); return pending.length; }, clearTimeout() {},
    }),
    ipcMain: { on(channel, cb) { assert.equal(channel, 'terminal-resize'); registered = cb; } },
    setTimeout(cb) { pending.push(cb); },
  });
  let api;
  let sends = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { send(channel, ...args) { sends++; assert.equal(channel, 'terminal-resize'); registered(null, ...args); } },
      webUtils: {},
    }),
  });
  api.resizeTerminal('fixture', 120, 40, { refresh: true });
  assert.equal(sends, 1);
  assert.deepEqual(calls, [{ cols: 120, rows: 40 }, { cols: 119, rows: 40 }]);
  pending.shift()();
  assert.deepEqual(calls.at(-1), { cols: 120, rows: 40 });
  calls.length = 0;
  api.resizeTerminal('fixture', 130, 40);
  assert.deepEqual(calls, [{ cols: 130, rows: 40 }]);
});
