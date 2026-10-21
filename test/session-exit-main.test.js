'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { createUnsavedGuard } = require('../unsaved-guard');
const { inventory } = require('../session-exit');
const { applicationMenuTemplate } = require('../window-frame');
const source = fs.readFileSync(require.resolve('../main'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
const startup = ast.body.find(n => n.id?.name === 'startApplication');
const installNode = startup.body.body.find(n => n.expression?.arguments?.[0]?.value === 'updater-install');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(platform = 'win32') {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  const sent = [], calls = [], timers = [];
  const records = new Map([['local', { kind: 'local-pty', pty: {} }]]);
  const wc = new EventEmitter();
  Object.assign(wc, { send: (channel, ...args) => sent.push({ channel, args }), isDestroyed: () => false, isCrashed: () => false });
  const win = new EventEmitter();
  Object.assign(win, { webContents: wc, isDestroyed: () => false, close: () => calls.push('close'), destroy: () => calls.push('destroy') });
  let token = null;
  const guard = createUnsavedGuard({ ipcMain, inventory: () => inventory(records),
    onAttemptReleased: () => context.releaseAttempt?.(),
    quit: value => { token = value; calls.push('quit'); },
    externalFlush: () => context.flushForLogoff(),
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeoutFn: t => { t.cleared = true; },
  });
  guard.attach(win);
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const checks = () => sent.filter(m => m.channel === 'unsaved-check');
  const detail = () => { const m = sent.findLast(m => m.channel === 'unsaved-check' || m.channel === 'unsaved-check-reason'); return m?.args[m.channel === 'unsaved-check' ? 2 : 3]; };
  const answer = (yes, sender = wc, check = checks().at(-1)) => {
    ipcMain.emit('unsaved-check-ack', { sender }, check.args[0]);
    ipcMain.emit('unsaved-check-result', { sender }, check.args[0], yes, check === checks().at(-1) ? detail() : check.args[2]);
    for (const message of sent.filter(m => m.channel === 'unsaved-check-reason')) ipcMain.emit('unsaved-check-reason-done', { sender }, message.args[0], message.args[2]);
  };
  const answerVersion = (yes, version, check = checks().at(-1)) => {
    ipcMain.emit('unsaved-check-ack', { sender: wc }, check.args[0]);
    ipcMain.emit('unsaved-check-result', { sender: wc }, check.args[0], yes, version);
  };
  const menu = () => applicationMenuTemplate('Switchboard', { platform, onQuit: () => guard.requestQuit(win) })[0].submenu.at(-1).click?.();
  const context = vm.createContext({ ipcMain, mainWindow: win, unsavedGuard: guard, quitAttemptToken: null,
    updateInstalling: false, activityFlushedForQuit: false, updateInstallPromise: null, updateWaitTimer: null,
    process: { platform }, app: { quit: () => calls.push('app.quit') },
    autoUpdater: { quitAndInstallCalled: true, quitAndInstall: () => calls.push('install'), install: () => { calls.push('install'); return true; } },
    drainForUpdate: async () => { calls.push('update-drain'); },
    relaunch: async ({ quit }) => quit(), relaunchExecPath: '/app', notifyRelaunchRequired() {},
    log: { error() {} }, setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.cleared = true; },
  });
  const guardInit = ast.body.flatMap(n => n.declarations || []).find(n => n.id.name === 'unsavedGuard').init;
  const release = guardInit.arguments[0].properties.find(p => p.key.name === 'onAttemptReleased');
  if (release) context.releaseAttempt = vm.runInContext(source.slice(...release.value.range), context);
  vm.runInContext(require('./app-source').extractFunction(source, 'resetUpdateAttempt'), context);
  Object.assign(context, { flushProjectsBeforeExit: async () => {}, flushWindowBounds: async () => {},
    sessionTransitions: { drainMetadataWrites: async () => {} }, activityReporter: { flush: async () => {} },
    writer: { drain: async () => { calls.push('drain'); } }, flushForLogoff: null,
    shutdownForExit: async () => { calls.push('stop-pty', 'close-db', 'exit'); } });
  vm.runInContext(require('./app-source').extractFunction(source, 'boundedShutdown'), context);
  vm.runInContext(require('./app-source').extractFunction(source, 'drainForUpdate'), context);
  vm.runInContext(source.split('\n').find(line => line.startsWith('flushForLogoff =')), context);
  context.drainForUpdate = async () => { calls.push('update-drain'); };
  context.pty = { spawn: () => { calls.push('spawn'); return {}; } };
  context.guardPtyInputErrors = value => value;
  context.process.env = {};
  vm.runInContext(require('./app-source').extractFunction(source, 'spawnPty'), context);
  vm.runInContext(source.slice(...installNode.range), context);
  return { guard, win, wc, sent, calls, records, event, checks, detail, answer, answerVersion, menu, timers, context,
    install: () => handlers.get('updater-install')(), token: () => token };
}

test('A4 shipped menu, updater and close wait for consent; Cancel preserves processes and services', async () => {
  for (const intent of ['quit', 'update', 'close']) {
    const t = setup();
    let pending;
    if (intent === 'quit') t.menu();
    else if (intent === 'update') pending = t.install();
    else t.win.emit('close', t.event());
    assert.equal(t.detail()?.action, intent, 'the shipped entry supplies its user intent');
    assert.deepEqual(t.calls, []);
    t.answer(false); await tick(); await pending;
    assert.deepEqual(t.calls, [], 'Cancel does not close, quit, drain or install');
  }
  for (const platform of ['darwin', 'linux', 'win32']) {
    const t = setup(platform);
    t.win.emit('close', t.event()); t.answer(true); await tick();
    assert.deepEqual(t.calls, ['close']);
    assert.ok(t.guard.committedToken(t.win));
    const e = t.event();
    assert.equal(t.guard.beforeQuit(e, t.win, t.guard.committedToken(t.win)), false);
    assert.equal(t.checks().length, 1, 'window-all-closed reentry does not ask again');
    const app = new EventEmitter();
    app.quit = () => app.emit('before-quit', t.event());
    Object.assign(t.context, { app, process: { platform }, mainWindow: t.win, activeSessions: t.records, closedSessions: new Map(),
      killPty: () => t.calls.push('stop-pty'), changesWatchers: { closeAll() {} }, closeAllFileWatchers() {}, unsubscribeBgAgents() {},
      subagentWatchers: new Map(), shutdownComplete: false,
      shutdownForExit: async () => { t.calls.push('shutdown'); t.context.shutdownComplete = true; }, exitOnce: () => t.calls.push('exit') });
    const start = source.indexOf("  mainWindow.on('closed'");
    const end = source.indexOf('\n  });', start) + 6;
    vm.runInContext(source.slice(start, end), t.context);
    const allClosed = startup.body.body.find(n => n.expression?.arguments?.[0]?.value === 'window-all-closed');
    const beforeQuit = startup.body.body.findLast(n => n.expression?.arguments?.[0]?.value === 'before-quit');
    vm.runInContext(source.slice(...allClosed.range), t.context);
    vm.runInContext(source.slice(...beforeQuit.range), t.context);
    t.win.emit('closed'); app.emit('window-all-closed'); await tick();
    assert.equal(t.calls.filter(c => c === 'shutdown').length, platform === 'darwin' ? 0 : 1);
    assert.equal(t.calls.filter(c => c === 'exit').length, platform === 'darwin' ? 0 : 1);
    assert.equal(t.checks().length, 1);
    if (platform === 'darwin') assert.equal(t.guard.launchAllowed(), true, 'Dock app can open another window');
  }
  const t = setup(); t.records.clear(); t.menu();
  assert.equal(t.checks().length, 1, 'zero local PTYs still checks dirty editors');
});

for (const upgrade of ['close to quit', 'quit to update', 'user to external']) {
  test(`B1 a previous-version answer after ${upgrade} renews consent and finishes the exit`, async () => {
    const t = setup();
    if (upgrade === 'close to quit') t.win.emit('close', t.event());
    else t.menu();
    const previous = t.detail();
    let installing;
    if (upgrade === 'close to quit') t.menu();
    else if (upgrade === 'quit to update') installing = t.install();
    else t.guard.beforeQuit(t.event(), t.win);
    t.answerVersion(true, previous);
    for (const m of t.sent.filter(m => m.channel === 'unsaved-check-reason')) {
      t.context.ipcMain.emit('unsaved-check-reason-done', { sender: t.wc }, m.args[0], m.args[2], true);
    }
    await tick();
    assert.equal(t.checks().length, 2, 'a stale answer must send a fresh check instead of hanging');
    assert.deepEqual(t.calls, [], 'previous consent cannot authorize the upgraded exit');
    t.answerVersion(true, t.detail());
    await tick();
    assert.equal(t.calls.filter(c => c === (installing ? 'install' : 'quit')).length, 1, 'the upgraded exit actually progresses');
    await installing;
  });
}

for (const proceed of [true, false]) {
  test(`B1 a detail-less reload answer waits for late quit consent (${proceed})`, async () => {
    const t = setup();
    t.wc.emit('will-prevent-unload', t.event());
    const check = t.checks().at(-1);
    t.menu();
    t.answerVersion(true, null, check);
    await tick();
    assert.deepEqual(t.calls, [], 'the late Stop question is still open');
    const renewed = t.checks().at(-1);
    t.context.ipcMain.emit('unsaved-check-ack', { sender: t.wc }, renewed.args[0]);
    for (const timer of t.timers.filter(timer => !timer.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
    await tick();
    assert.deepEqual(t.calls, [], 'queued timers cannot quit while the Stop question is open');
    assert.equal(t.checks().length, 2, 'the stale reload answer re-sends the current exit check');
    assert.equal(renewed.args[2], t.detail());
    t.answer(proceed);
    await tick();
    if (proceed) assert.deepEqual(t.calls, ['quit'], 'the late quit actually progresses after Stop');
    else {
      t.menu();
      assert.equal(t.checks().length, 3, 'Cancel releases the attempt so Quit can ask again');
      t.answer(true); await tick();
      assert.deepEqual(t.calls, ['quit']);
    }
  });
}

function wireUpdater(t) {
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  Object.assign(updater, t.context.autoUpdater);
  Object.assign(t.context, { SETTING_DEFAULTS: require('../public/setting-defaults').SETTING_DEFAULTS,
    require: name => ({ autoUpdater: name === 'electron' ? nativeUpdater : updater }) });
  t.context.app.isPackaged = true;
  t.context.log.info = () => {};
  const index = ast.body.findIndex(n => n.declarations?.some(d => d.id.name === 'autoUpdater'));
  vm.runInContext(source.slice(ast.body[index].range[0], ast.body[index + 1].range[1]), t.context);
  return { updater, nativeUpdater };
}

for (const intent of ['close', 'quit']) {
  test(`B2 a background updater error preserves the open ${intent} choice`, async () => {
    const t = setup();
    const { updater } = wireUpdater(t);
    if (intent === 'close') t.win.emit('close', t.event());
    else t.menu();
    const original = t.detail();
    updater.emit('error', new Error('offline'));
    await tick();
    assert.equal(t.sent.some(m => m.channel === 'exit-attempt-invalidated'), false, 'offline checking must not dismiss the user choice');
    assert.equal(t.detail(), original);
    t.answer(true); await tick();
    assert.deepEqual(t.calls, [intent], 'the original choice can still close or quit');
  });
}

test('B2 a background updater error with no attempt preserves the exit latch', () => {
  const t = setup();
  const { updater } = wireUpdater(t);
  t.context.quitAttemptToken = 17;
  updater.emit('error', new Error('offline'));
  assert.equal(t.context.quitAttemptToken, 17, 'an unrelated update check does not reset exit state');
});

test('B2 an install error during Linux relaunch releases its update gate', async () => {
  const t = setup('linux');
  const { updater } = wireUpdater(t);
  let resume;
  t.context.relaunch = () => new Promise(resolve => { resume = resolve; });
  const pending = t.install();
  t.answer(true); await tick();
  assert.equal(t.guard.launchAllowed(), false);
  updater.emit('error', new Error('install failed'));
  assert.equal(t.guard.launchAllowed(), true, 'an actual install error releases the committed update');
  assert.equal(t.context.updateInstallPromise, null);
  assert.equal(updater.quitAndInstallCalled, false);
  resume(); await pending;
});

test('B3 cancelling a late macOS native close releases the install bypass for later Cmd+Q', async () => {
  const t = setup('darwin');
  const { nativeUpdater } = wireUpdater(t);
  const installing = t.install();
  t.answer(true); await installing;
  t.timers.find(timer => timer.ms === 30000 && !timer.cleared).fn();
  assert.equal(t.guard.launchAllowed(), true);
  nativeUpdater.emit('before-quit-for-update');
  assert.equal(t.context.updateInstalling, true);
  t.win.emit('close', t.event());
  t.answer(false); await tick();
  assert.equal(t.context.updateInstalling, false, 'a cancelled native close cannot retain the installer bypass');
  t.menu();
  assert.equal(t.detail().action, 'quit');
  assert.equal(t.detail().external, false);
  t.answer(true); await tick();
  const app = new EventEmitter();
  app.quit = () => {};
  Object.assign(t.context, { app, shutdownComplete: false, exitOnce: () => {} });
  const beforeQuit = startup.body.body.findLast(n => n.expression?.arguments?.[0]?.value === 'before-quit');
  vm.runInContext(source.slice(...beforeQuit.range), t.context);
  app.emit('before-quit', t.event()); await tick();
  assert.equal(t.detail().external, true, 'an untagged quit must still enter the edits guard');
  t.answer(false); await tick();
});

test('C2 a committed macOS native install keeps its bypass when the window closes', async () => {
  const t = setup('darwin');
  const { nativeUpdater } = wireUpdater(t);
  const installing = t.install();
  t.answer(true); await installing;
  nativeUpdater.emit('before-quit-for-update');
  assert.equal(t.context.updateInstalling, true);
  const close = t.event();
  t.win.emit('close', close);
  assert.equal(close.prevented, false, 'committed Stop consent permits the native close');
  Object.assign(t.context, { activeSessions: t.records, closedSessions: new Map(),
    killPty: () => t.calls.push('stop-pty'), changesWatchers: { closeAll() {} },
    closeAllFileWatchers() {}, unsubscribeBgAgents() {}, subagentWatchers: new Map() });
  const start = source.indexOf("  mainWindow.on('closed'");
  const end = source.indexOf('\n  });', start) + 6;
  vm.runInContext(source.slice(start, end), t.context);
  t.win.emit('closed');
  assert.equal(t.context.updateInstalling, true, 'releasing a committed window must preserve the native install bypass');
  assert.equal(t.guard.launchAllowed(), true, 'window cleanup still releases the attempt');
  assert.equal(t.checks().length, 1, 'the native close never asks for consent twice');
});

test('A5 upgrades renew consent, generations are revalidated, sender and launch gate remain scoped', async () => {
  const t = setup();
  t.win.emit('close', t.event());
  assert.equal(t.detail()?.action, 'close');
  const old = structuredClone(t.checks().at(-1));
  t.menu(); await tick();
  assert.equal(t.detail().action, 'quit');
  assert.ok(t.detail().version > old.args[2].version);
  t.answer(true, t.wc, old); await tick(); assert.deepEqual(t.calls, []);
  t.answer(true, {}); await tick(); assert.deepEqual(t.calls, []);
  t.records.set('added', { kind: 'local-pty', pty: {} });
  t.answer(true); await tick(); assert.deepEqual(t.calls, []);
  assert.equal(t.detail().snapshot.rows.length, 2);
  t.records.set('added', { kind: 'local-pty', pty: {} });
  t.answer(true); await tick(); assert.deepEqual(t.calls, []);
  const moved = t.records.get('added'); t.records.delete('added'); t.records.set('rekeyed', moved);
  t.answer(true); await tick(); assert.deepEqual(t.calls, []);
  assert.equal(t.detail().snapshot.rows.at(-1).id, 'rekeyed');
  t.records.delete('local');
  t.answer(true); await tick(); assert.deepEqual(t.calls, ['quit']);
  assert.equal(t.guard.launchAllowed(), false);
  assert.throws(() => t.context.spawnPty('shell', [], {}), /closing/);
  const open = startup.body.body.find(n => n.expression?.arguments?.[0]?.value === 'open-terminal');
  let openHandler;
  const openContext = vm.createContext({ mainWindow: t.win, unsavedGuard: t.guard,
    ipcMain: { handle: (_name, fn) => { openHandler = fn; } } });
  vm.runInContext(source.slice(...open.range), openContext);
  assert.equal((await openHandler({}, 'pending', '/work', true)).ok, false);
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  t.guard.invalidate();
  const pending = (async () => { await waiting; return t.context.spawnPty('shell', [], {}); })();
  t.menu(); t.answer(true); await tick();
  resume(); await assert.rejects(pending, /closing/);
  const count = t.checks().length; t.menu(); await tick(); assert.equal(t.checks().length, count);
  t.guard.invalidate(); assert.equal(t.guard.launchAllowed(), true);
  t.menu(); t.answer(false); await tick(); assert.equal(t.guard.launchAllowed(), true);
  const update = setup();
  update.win.emit('close', update.event());
  update.menu(); await tick();
  const installing = update.install(); await tick();
  assert.equal(update.detail().action, 'update');
  assert.equal(update.detail().version, 3);
  assert.deepEqual(update.calls, [], 'upgrading twice does not synthesize Stop consent');
  update.answer(true); await installing;
  await update.install();
  assert.equal(update.calls.filter(c => c === 'install').length, 1);
  assert.equal(update.calls.filter(c => c === 'update-drain').length, 1);
});

test('A7 logoff supersedes a user choice, coalesces non-destructive drains and never grants user consent', async () => {
  const t = setup(); t.win.emit('close', t.event());
  assert.equal(t.detail()?.action, 'close');
  const old = t.checks().at(-1);
  t.win.emit('query-session-end'); t.win.emit('session-end');
  t.answer(true, t.wc, old); await tick();
  assert.deepEqual(t.calls, ['drain']);
  assert.equal(t.sent.filter(m => m.channel === 'exit-flush').length, 2);
  for (const intent of ['quit', 'close', 'update']) {
    let pending;
    if (intent === 'quit') t.menu();
    else if (intent === 'close') t.win.emit('close', t.event());
    else pending = t.install();
    assert.equal(t.detail().action, intent);
    t.answer(false); await tick(); await pending;
  }
  assert.deepEqual(t.calls, ['drain']);
  const finalOnly = setup(); finalOnly.win.emit('session-end'); await tick();
  assert.deepEqual(finalOnly.calls, ['drain']);
  const installing = setup();
  let release;
  installing.context.drainForUpdate = () => new Promise(resolve => { release = resolve; });
  const pending = installing.install();
  installing.answer(true); await tick();
  assert.equal(installing.guard.launchAllowed(), false);
  installing.win.emit('query-session-end');
  release(); await pending;
  assert.equal(installing.calls.includes('install'), false, 'a logoff during the drain cannot install later');
  assert.equal(installing.context.updateInstallPromise, null);
  assert.equal(installing.guard.launchAllowed(), true);
});

test('A8 untagged quit keeps edits checking but skips only the session choice; bare close is user', async () => {
  const t = setup();
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  Object.assign(t.context, { SETTING_DEFAULTS: require('../public/setting-defaults').SETTING_DEFAULTS,
    require: name => ({ autoUpdater: name === 'electron' ? nativeUpdater : updater }) });
  t.context.app.isPackaged = true;
  t.context.log.info = () => {};
  const index = ast.body.findIndex(n => n.declarations?.some(d => d.id.name === 'autoUpdater'));
  vm.runInContext(source.slice(ast.body[index].range[0], ast.body[index + 1].range[1]), t.context);
  updater.emit('update-downloaded', { version: 'next' });
  assert.equal(t.context.updateInstalling, false, 'download alone grants no exit consent');
  t.guard.beforeQuit(t.event(), t.win);
  assert.equal(t.detail()?.external, true);
  t.answer(false); await tick(); assert.deepEqual(t.calls, []);
  t.menu(); assert.equal(t.detail().external, false);
  t.answer(false); await tick();
  t.win.emit('close', t.event()); assert.equal(t.detail().external, false);
  t.answer(false); await tick();
  t.guard.beforeQuit(t.event(), t.win); t.answer(true); await tick();
  const event = t.event(); assert.equal(t.guard.beforeQuit(event, t.win, t.token()), false);
  assert.deepEqual(t.calls, ['quit']);
});
