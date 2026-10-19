'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const espree = require('espree');
const { extractFunction } = require('./app-source');

const source = fs.readFileSync(require.resolve('../main'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
const startup = ast.body.find(n => n.id?.name === 'startApplication');
const install = startup.body.body.find(n => n.expression?.arguments?.[0]?.value === 'updater-install');

function installContext(platform, installed = true) {
  const calls = [];
  let handler;
  const updater = {
    autoRunAppAfterInstall: true,
    quitAndInstall(...args) { calls.push(['native', ...args]); if (this.autoRunAppAfterInstall) calls.push(['app.relaunch']); },
    install(...args) { calls.push(['install', ...args]); return installed; },
  };
  const context = vm.createContext({
    autoUpdater: updater, process: { platform, execPath: '/opt/Switchboard/switchboard', argv: ['switchboard'], env: {} },
    mainWindow: null, unsavedGuard: {}, drainForUpdate: async () => calls.push(['drain']),
    relaunchExecPath: '/opt/Switchboard/switchboard',
    relaunch: async opts => { calls.push(['helper']); opts.quit(); },
    app: { quit: () => calls.push(['quit']), relaunch: () => calls.push(['app.relaunch']) },
    notifyRelaunchRequired: async () => {}, updateInstalling: false, activityFlushedForQuit: true,
    log: { error() {} }, ipcMain: { handle: (_name, fn) => { handler = fn; } },
  });
  vm.runInContext(source.slice(...install.range), context);
  return { calls, context, updater, run: () => handler() };
}

test('Linux install disables updater relaunch and calls the helper only after successful installation', async () => {
  const ctx = installContext('linux');
  await ctx.run();
  assert.deepEqual(ctx.calls, [['drain'], ['install', false, false], ['helper'], ['quit']]);
  assert.equal(ctx.context.updateInstalling, true);
});

test('Linux failed install resets the install latch without quitting or relaunching', async () => {
  const ctx = installContext('linux', false);
  ctx.updater.quitAndInstallCalled = true;
  await ctx.run();
  assert.deepEqual(ctx.calls, [['drain'], ['install', false, false]]);
  assert.equal(ctx.updater.quitAndInstallCalled, false);
  assert.equal(ctx.context.activityFlushedForQuit, false);
});

for (const platform of ['win32', 'darwin']) test(`${platform} keeps the native updater invocation unchanged`, async () => {
  const ctx = installContext(platform);
  await ctx.run();
  assert.deepEqual(ctx.calls, [['drain'], ['native'], ['app.relaunch']]);
});

test('helper submits a transient service with literal argv, then quits', async () => {
  const relaunch = require('../relaunch');
  const calls = [];
  await relaunch({ platform: 'linux', execPath: '/opt/a b/switchboard', argv: ['--example=a b'], cwd: '/work', now: () => 123,
    spawnSync: (...args) => { calls.push(args); return { status: 0 }; }, quit: () => calls.push('quit'), notify: () => assert.fail('unexpected fallback') });
  const [cmd, args, opts] = calls[0];
  assert.equal(cmd, 'systemd-run');
  assert.ok(args.includes('--user') && args.includes('--collect'));
  assert.ok(args.some(a => a.startsWith('--unit=switchboard-relaunch-123')));
  assert.ok(!args.includes('--scope'));
  assert.deepEqual(args.slice(-3), ['/opt/a b/switchboard', '--example=a b', '--switchboard-relaunch']);
  assert.equal(opts.shell, false);
  assert.equal(calls[1], 'quit');
});

test('service argv escapes dollar expansion and requires executable startup acknowledgement', async () => {
  const relaunch = require('../relaunch');
  let submitted;
  await relaunch({ execPath: '/opt/Switchboard/switchboard', argv: ['--example=${HOME}', '$PATH', '$$'],
    spawnSync: (_cmd, args) => { submitted = args; return { status: 0 }; }, quit() {}, notify: () => assert.fail('unexpected fallback') });
  assert.deepEqual(submitted.slice(-4), ['--example=$${HOME}', '$$PATH', '$$$$', '--switchboard-relaunch']);
  assert.ok(submitted.includes('--service-type=exec'));
});

for (const result of [{ error: new Error('ENOENT') }, { status: 1, stderr: 'no user bus' }, { status: null }]) {
  test(`helper waits for visible fallback acknowledgement before quit (${result.status ?? result.error?.message ?? 'signal'})`, async () => {
    const relaunch = require('../relaunch');
    const calls = [];
    let acknowledge;
    const done = relaunch({ platform: 'linux', execPath: '/opt/switchboard', argv: [], spawnSync: () => result,
      log: { warn() {} }, notify: message => { calls.push(message); return new Promise(resolve => { acknowledge = resolve; }); },
      quit: () => calls.push('quit') });
    assert.deepEqual(calls, ['Switchboard will close; start it again from the application menu.']);
    acknowledge();
    await done;
    assert.equal(calls[1], 'quit');
  });
}

test('a thrown spawn error also uses quit-only fallback', async () => {
  const relaunch = require('../relaunch');
  const calls = [];
  await relaunch({ platform: 'linux', spawnSync: () => { throw new Error('spawn refused'); }, log: { warn() {} },
    notify: async message => calls.push(message), quit: () => calls.push('quit') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'quit');
});

for (const marked of [false, true]) test(`lock retries are bounded and reserved for helper launches (${marked})`, async () => {
  const { acquireInstanceLock } = require('../linux-startup');
  let calls = 0;
  let elapsed = 0;
  const app = { requestSingleInstanceLock: () => ++calls >= 3 };
  const got = await acquireInstanceLock(app, { platform: 'linux', argv: marked ? ['--switchboard-relaunch'] : [],
    now: () => elapsed, delay: async ms => { elapsed += ms; } });
  assert.equal(got, marked);
  assert.equal(calls, marked ? 3 : 1);
  calls = 0; elapsed = 0;
  assert.equal(await acquireInstanceLock({ requestSingleInstanceLock: () => { calls++; return false; } }, {
    platform: 'linux', argv: marked ? ['--switchboard-relaunch'] : [], now: () => elapsed, delay: async ms => { elapsed += ms; },
  }), false);
  assert.ok(elapsed <= 10000);
  assert.equal(elapsed, marked ? 10000 : 0);
});

test('non-Linux ignores the helper lock marker', async () => {
  const { acquireInstanceLock } = require('../linux-startup');
  assert.equal(await acquireInstanceLock({ requestSingleInstanceLock: () => false }, {
    platform: 'win32', argv: ['--switchboard-relaunch'], delay: () => assert.fail('unexpected retry'),
  }), false);
});

for (const value of ['0', '1', 'unreadable']) test(`Linux startup reports NoNewPrivs=${value}`, () => {
  const { readNoNewPrivs } = require('../linux-startup');
  const logs = [];
  const notice = readNoNewPrivs({ platform: 'linux', log: { info: text => logs.push(text) }, readFileSync: file => {
    assert.equal(file, '/proc/self/status');
    if (value === 'unreadable') throw new Error('EACCES');
    return `Name:\tswitchboard\nNoNewPrivs:\t${value}\n`;
  } });
  assert.ok(logs[0].includes(`NoNewPrivs=${value === 'unreadable' ? 'unknown' : value}`));
  assert.equal(Boolean(notice), value === '1');
  if (notice) assert.match(notice.message, /snap.*updates.*application menu/i);
});

test('non-Linux does not read procfs', () => {
  const { readNoNewPrivs } = require('../linux-startup');
  assert.equal(readNoNewPrivs({ platform: 'darwin', readFileSync: () => assert.fail('procfs read') }), null);
});

test('installed BaseUpdater honors install(false, false), whereas non-silent quitAndInstall overrides its argument', () => {
  const mod = { exports: {} };
  const baseSource = fs.readFileSync(require.resolve('electron-updater/out/BaseUpdater'), 'utf8');
  vm.runInNewContext(baseSource, { exports: mod.exports, require: name => name === './AppUpdater'
    ? { AppUpdater: class extends EventEmitter {} } : require(name), setImmediate: () => {} });
  const updater = new mod.exports.BaseUpdater();
  const options = [];
  updater._logger = { info() {}, warn() {} };
  updater.downloadedUpdateHelper = { file: '/tmp/update.deb', downloadedFileInfo: {} };
  updater.autoRunAppAfterInstall = true;
  updater.doInstall = opts => { options.push(opts.isForceRunAfter); return true; };
  updater.quitAndInstall(false, false);
  updater.quitAndInstallCalled = false;
  assert.equal(updater.install(false, false), true);
  assert.deepEqual(options, [true, false]);
  updater.quitAndInstallCalled = false;
  updater.autoInstallOnAppQuit = true;
  let onQuit;
  updater.app = { onQuit: fn => { onQuit = fn; } };
  updater.addQuitHandler();
  onQuit(0);
  assert.deepEqual(options, [true, false, false]);
});

test('fallback notice uses updater IPC and waits for the owning renderer or closed window', async () => {
  const win = new EventEmitter();
  const ipcMain = new EventEmitter();
  const sent = [];
  win.isDestroyed = () => false;
  win.webContents = { send: (...args) => sent.push(args) };
  const context = vm.createContext({ mainWindow: win, ipcMain, log: { warn() {} } });
  vm.runInContext(extractFunction(source, 'notifyRelaunchRequired'), context);
  let finished = false;
  const done = context.notifyRelaunchRequired('manual restart').then(() => { finished = true; });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['updater-event', 'relaunch-required', { message: 'manual restart' }]]);
  ipcMain.emit('updater-close', { sender: {} });
  await Promise.resolve();
  assert.equal(finished, false);
  ipcMain.emit('updater-close', { sender: win.webContents });
  await done;
  assert.equal(finished, true);
  assert.equal(ipcMain.listenerCount('updater-close'), 0);
  assert.equal(win.listenerCount('closed'), 0);
});

test('renderer uses a persistent app notice and close action for fallback and startup warning', () => {
  const renderer = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const from = renderer.indexOf('const updaterHandler =');
  const to = renderer.indexOf('window.api.onUpdaterEvent(updaterHandler)', from);
  const notices = [];
  let closed = 0;
  const context = vm.createContext({ showAppNotice: opts => notices.push(opts), window: { api: { updaterClose: () => { closed++; } } } });
  vm.runInContext(renderer.slice(from, to) + '\nthis.handle = updaterHandler;', context);
  context.handle('startup-notice', { id: 'nnp', kind: 'error', message: 'restricted' });
  context.handle('relaunch-required', { message: 'manual restart' });
  assert.equal(notices[0].message, 'restricted');
  assert.equal(notices[1].kind, 'error');
  assert.equal(notices[1].actionLabel, 'Close Switchboard');
  notices[1].onAction();
  assert.equal(closed, 1);
});

test('main wires the startup lock, diagnostic delivery, and disables native auto-run only on Linux', () => {
  assert.match(source, /if \(!await acquireInstanceLock\(app\)\)/);
  assert.match(source, /const privilegeNotice = readNoNewPrivs\(\{ log \}\)/);
  assert.match(source, /if \(privilegeNotice\) mainWindow\.webContents\.send\('updater-event', 'startup-notice', privilegeNotice\)/);
  const updaterIndex = ast.body.findIndex(n => n.declarations?.some(d => d.id.name === 'autoUpdater'));
  for (const platform of ['linux', 'darwin', 'win32']) {
    const updater = new EventEmitter();
    updater.autoRunAppAfterInstall = true;
    const context = vm.createContext({
      app: { isPackaged: true }, process: { platform, env: {} }, log: {}, SETTING_DEFAULTS: {},
      require: () => ({ autoUpdater: updater }), mainWindow: null,
    });
    vm.runInContext(source.slice(ast.body[updaterIndex].range[0], ast.body[updaterIndex + 1].range[1]), context);
    assert.equal(updater.autoRunAppAfterInstall, platform !== 'linux');
  }
});
