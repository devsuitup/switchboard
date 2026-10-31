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
    mainWindow: null, quitAttemptToken: null, updateInstallPromise: null, updateWaitTimer: null,
    setTimeout, clearTimeout, unsavedGuard: { invalidate() {} }, drainForUpdate: async () => calls.push(['drain']),
    relaunchExecPath: '/opt/Switchboard/switchboard',
    relaunch: async opts => { calls.push(['helper']); opts.quit(); },
    app: { quit: () => calls.push(['quit']), relaunch: () => calls.push(['app.relaunch']) },
    notifyRelaunchRequired: async () => {}, updateInstalling: false, activityFlushedForQuit: true,
    log: { error() {} }, ipcMain: { handle: (_name, fn) => { handler = fn; } },
  });
  vm.runInContext(extractFunction(source, 'resetUpdateAttempt'), context);
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
  const relaunch = require('../src/main/app/relaunch');
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
  assert.equal(opts.timeout, 5000);
  assert.ok(args.includes('--working-directory=/work'));
  assert.equal(calls[1], 'quit');
});

test('service argv escapes dollar expansion and requires executable startup acknowledgement', async () => {
  const relaunch = require('../src/main/app/relaunch');
  let submitted;
  await relaunch({ execPath: '/opt/Switchboard/switchboard', argv: ['--example=${HOME}', '$PATH', '$$'],
    spawnSync: (_cmd, args) => { submitted = args; return { status: 0 }; }, quit() {}, notify: () => assert.fail('unexpected fallback') });
  assert.deepEqual(submitted.slice(-4), ['--example=$${HOME}', '$$PATH', '$$$$', '--switchboard-relaunch']);
  assert.ok(submitted.includes('--service-type=exec'));
});

for (const result of [{ error: new Error('ENOENT') }, { status: 1, stderr: 'no user bus' }, { status: null }]) {
  test(`helper waits for visible fallback acknowledgement before quit (${result.status ?? result.error?.message ?? 'signal'})`, async () => {
    const relaunch = require('../src/main/app/relaunch');
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
  const relaunch = require('../src/main/app/relaunch');
  const calls = [];
  await relaunch({ platform: 'linux', spawnSync: () => { throw new Error('spawn refused'); }, log: { warn() {} },
    notify: async message => calls.push(message), quit: () => calls.push('quit') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'quit');
});

for (const marked of [false, true]) test(`lock retries are bounded and reserved for helper launches (${marked})`, async () => {
  const { acquireInstanceLock } = require('../src/main/app/linux-startup');
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
  const { acquireInstanceLock } = require('../src/main/app/linux-startup');
  assert.equal(await acquireInstanceLock({ requestSingleInstanceLock: () => false }, {
    platform: 'win32', argv: ['--switchboard-relaunch'], delay: () => assert.fail('unexpected retry'),
  }), false);
});

for (const value of ['0', '1', 'unreadable']) test(`Linux startup reports NoNewPrivs=${value}`, () => {
  const { readNoNewPrivs } = require('../src/main/app/linux-startup');
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
  const { readNoNewPrivs } = require('../src/main/app/linux-startup');
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
  assert.equal(notices[1].dismissible, false);
  notices[1].onAction();
  assert.equal(closed, 1);
});

test('service stop leaves independently surviving children alone', async () => {
  let submitted;
  await require('../src/main/app/relaunch')({ env: {}, spawnSync: (_cmd, args) => {
    submitted = args;
    return { status: 0 };
  }, quit() {}, notify: () => assert.fail('unexpected fallback') });
  assert.ok(submitted.includes('--property=KillMode=process'));
});

test('relaunch forwards caller configuration without exposing values in argv or retaining runtime identities', async () => {
  const keep = { HOME: '/isolated/home', CLAUDE_CONFIG_DIR: '/isolated/claude', SWITCHBOARD_TRIGGERS_DIR: '/isolated/triggers',
    SWITCHBOARD_DATA_DIR: '/isolated/data', PATH: '/custom/bin', SSH_AUTH_SOCK: '/run/ssh', LANG: 'fr_FR.UTF-8',
    LC_CTYPE: 'fr_FR.UTF-8', XDG_CONFIG_HOME: '/isolated/config', XDG_RUNTIME_DIR: '/run/user/1000',
    DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-1', XAUTHORITY: '/isolated/authority', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
    CUSTOM_SECRET: 'sentinel=$secret with spaces', EMPTY: '' };
  const denied = [...require('../src/main/shared/clean-env').SESSION_MARKERS, 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS',
    'GOOGLE_API_KEY', 'ORIGINAL_XDG_CURRENT_DESKTOP', 'WT_SESSION', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_RESTART',
    'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'WATCHDOG_PID', 'WATCHDOG_USEC', 'SWITCHBOARD_RELAUNCH'];
  const env = { ...keep, ...Object.fromEntries(denied.map(key => [key, 'stale-runtime'])) };
  let submitted;
  await require('../src/main/app/relaunch')({ env, spawnSync: (_cmd, args, opts) => {
    submitted = { args, opts };
    return { status: 0 };
  }, quit() {}, notify: () => assert.fail('unexpected fallback') });
  const { args, opts } = submitted;
  assert.deepEqual(args.filter(a => a.startsWith('--setenv=')).sort(), Object.keys(keep).map(k => `--setenv=${k}`).sort());
  assert.deepEqual(opts.env, keep);
  assert.ok(!args.some(a => a.includes('sentinel=') || a.includes('stale-runtime')));
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'stale-runtime');
});

test('relaunch skips names systemd rejects, keeps the Ozone hint, and logs what it skipped', async () => {
  const env = { HOME: '/home/u', 'BASH_FUNC_x%%': '() { :; }', 'dotted.name': 'v', 'dash-name': 'v',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ELECTRON_RUN_AS_NODE: '1' };
  let submitted;
  const warnings = [];
  await require('../src/main/app/relaunch')({ env, spawnSync: (_cmd, args, opts) => {
    submitted = { args, opts };
    return { status: 0 };
  }, quit() {}, notify: () => assert.fail('unexpected fallback'), log: { warn: (...a) => warnings.push(a.join(' ')) } });
  assert.deepEqual(submitted.args.filter(a => a.startsWith('--setenv=')).sort(),
    ['--setenv=ELECTRON_OZONE_PLATFORM_HINT', '--setenv=HOME']);
  assert.deepEqual(submitted.opts.env, { HOME: '/home/u', ELECTRON_OZONE_PLATFORM_HINT: 'wayland' });
  assert.ok(warnings.some(w => w.includes('BASH_FUNC_x%%') && w.includes('dotted.name') && w.includes('dash-name')));
});

test('a relaunch of a relaunched instance strips the old marker before adding one', async () => {
  let submitted;
  await require('../src/main/app/relaunch')({ env: {}, argv: ['--switchboard-relaunch', 'document', '--switchboard-relaunch'],
    spawnSync: (_cmd, args) => {
      submitted = args;
      return { status: 0 };
    }, quit() {}, notify: () => assert.fail('unexpected fallback') });
  assert.deepEqual(submitted.slice(submitted.indexOf('--') + 2), ['document', '--switchboard-relaunch']);
});

test('second-instance focuses ordinary launches but ignores an instance quitting for an update', () => {
  let node;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'CallExpression' && value.callee?.object?.name === 'app' && value.arguments?.[0]?.value === 'second-instance') node = value;
    for (const child of Object.values(value)) if (typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(ast);
  let handler;
  const calls = [];
  const context = vm.createContext({ updateInstalling: false, app: { on: (_event, cb) => { handler = cb; } },
    mainWindow: { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push('restore'), focus: () => calls.push('focus') } });
  vm.runInContext(source.slice(...node.range), context);
  handler();
  assert.deepEqual(calls, ['restore', 'focus']);
  calls.length = 0;
  context.updateInstalling = true;
  handler();
  assert.deepEqual(calls, []);
});

test('a marked lock retry reports exhaustion clearly before returning false', async () => {
  const warnings = [];
  let elapsed = 0;
  assert.equal(await require('../src/main/app/linux-startup').acquireInstanceLock({ requestSingleInstanceLock: () => false }, {
    platform: 'linux', argv: ['--switchboard-relaunch'], now: () => elapsed, delay: async ms => { elapsed += ms; },
    log: { warn: text => warnings.push(text) },
  }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /relaunch.*lock.*10000.*exiting/i);
});

test('installed DebUpdater executes its force-run branch only when requested; version is pinned', () => {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('electron-updater/out/DebUpdater'), 'utf8'), {
    exports: mod.exports, require: name => name === './LinuxUpdater' ? { LinuxUpdater: class {} } : {},
  });
  const updater = new mod.exports.DebUpdater();
  const calls = [];
  Object.assign(updater, { installerPath: '/tmp/update.deb', hasCommand: () => true, detectPackageManager: () => 'dpkg',
    runCommandWithSudoIfNeeded: args => calls.push([...args]), _logger: { warn() {} },
    app: { relaunch: () => calls.push('app.relaunch') }, dispatchError: err => { throw err; } });
  assert.equal(updater.doInstall({ isForceRunAfter: false }), true);
  assert.deepEqual(calls, [['dpkg', '-i', '/tmp/update.deb']]);
  calls.length = 0;
  assert.equal(updater.doInstall({ isForceRunAfter: true }), true);
  assert.deepEqual(calls, [['dpkg', '-i', '/tmp/update.deb'], 'app.relaunch']);
  assert.equal(require('../package.json').dependencies['electron-updater'], '6.8.9');
  assert.equal(require('electron-updater/package.json').version, '6.8.9');
  assert.equal(require('../package-lock.json').packages['node_modules/electron-updater'].version, '6.8.9');
});

for (const state of ['active', 'inactive', 'query-timeout']) test(`submission timeout checks the same service before fallback (${state})`, async () => {
  const calls = [];
  let unit;
  await require('../src/main/app/relaunch')({ env: { HOME: '/isolated' }, spawnSync: (cmd, args, opts) => {
    calls.push(cmd);
    if (cmd === 'systemd-run') {
      unit = args.find(a => a.startsWith('--unit=')).slice(7);
      return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null };
    }
    assert.equal(cmd, 'systemctl');
    assert.deepEqual(args, ['--user', 'is-active', '--quiet', unit]);
    assert.equal(opts.timeout, 2000);
    assert.equal(opts.shell, false);
    assert.equal(opts.env.HOME, '/isolated');
    return state === 'query-timeout' ? { error: new Error('query timeout') } : { status: state === 'active' ? 0 : 3 };
  }, log: { warn() {} }, quit: () => calls.push('quit'), notify: async () => calls.push('notice') });
  assert.deepEqual(calls, ['systemd-run', 'systemctl', ...(state === 'active' ? [] : ['notice']), 'quit']);
});

test('manual restart notice stays visible until its sole Close Switchboard action', t => {
  const { window, document, destroy } = require('./dom-setup').setupSidebarDom();
  t.after(destroy);
  const renderer = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const from = renderer.indexOf('const updaterHandler =');
  const to = renderer.indexOf('window.api.onUpdaterEvent(updaterHandler)', from);
  let closed = 0;
  window.api = { updaterClose: () => { closed++; } };
  window.eval(renderer.slice(from, to) + '\nwindow.handleUpdate = updaterHandler;');
  window.handleUpdate('relaunch-required', { message: 'manual restart' });
  const notice = document.querySelector('[data-notice-id="updater-relaunch"]');
  assert.ok(notice);
  assert.equal(notice.querySelector('.app-notice-dismiss'), null);
  assert.equal(notice.querySelectorAll('button').length, 1);
  notice.querySelector('.app-notice-action').click();
  assert.equal(closed, 1);
  assert.ok(notice.isConnected);
});

test('main wires the startup lock, diagnostic delivery, and disables native auto-run only on Linux', () => {
  assert.match(source, /if \(!await acquireInstanceLock\(app, \{ log \}\)\)/);
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
