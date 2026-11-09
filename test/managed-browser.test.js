'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function api() {
  const file = path.join(__dirname, '../src/main/browser/managed-browser.js');
  assert.ok(fs.existsSync(file), 'Electron-free lifecycle manager must exist');
  return require('../src/main/browser/managed-browser');
}

function setup(t, extra = {}) {
  const { createManager } = api();
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-812-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [], processes = new Map();
  const self = { pid: 80, startTime: '800', boot: 'boot' };
  let pid = 100, port = 41000, time = 1000, liveLock = false;
  const proc = {
    self: () => self,
    identity: n => processes.get(n)?.identity || (n === 80 ? self : null),
    alive: identity => !!identity && proc.identity(identity.pid)?.startTime === identity.startTime && proc.identity(identity.pid)?.boot === identity.boot,
    verify: state => proc.alive(state) && processes.get(state.pid)?.profile === state.profile && processes.get(state.pid)?.binary === state.binary,
    listener: state => proc.verify(state) && processes.get(state.pid)?.port === state.port ? 'owned' : processes.get(state.pid)?.conflict ? 'foreign' : 'missing',
    listenerPid: state => [...processes].find(([, p]) => p.port === state.port && p.profile === state.profile)?.[0],
    descendants: () => [],
    signal: (n, signal) => { calls.push(['signal', n, signal]); processes.delete(n); },
  };
  const options = { dataDir, platform: 'linux', isPackaged: false, proc,
    discover: () => ({ binary: '/fake/chrome $literal', source: 'configured' }),
    allocatePort: async () => ++port, portFree: async () => true,
    lock: { acquire: async () => { if (liveLock) return { role: 'follower' }; liveLock = true; return { role: 'owner', release: async () => { liveLock = false; } }; } },
    request: async (_port, route) => { calls.push(['http', route]); return route === '/json/version'
      ? { Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${_port}/devtools/browser/fake` }
      : route === '/json/list' ? [{ id: 'page' }] : {}; },
    closeBrowser: async state => { calls.push(['close', state.pid]); processes.delete(state.pid); },
    spawn: (file, args, opts) => {
      calls.push(['spawn', file, args, opts]);
      const child = new EventEmitter(); child.pid = ++pid; child.unref = () => calls.push(['unref']);
      const profile = args.find(a => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      const assignedPort = Number(args.find(a => a.startsWith('--remote-debugging-port='))?.split('=')[1]);
      processes.set(pid, { identity: { pid, startTime: String(pid * 10), boot: 'boot' }, profile, port: assignedPort, binary: '/fake/chrome $literal' });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    now: () => time, sleep: async ms => { time += ms; }, env: { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'bus', APPIMAGE: 'bad', ELECTRON_BAD: 'bad', CLAUDECODE: 'bad' },
    ...extra,
  };
  const manager = createManager(options);
  t.after(() => manager.dispose());
  return { manager, options, dataDir, calls, processes, proc, self, advance: ms => { time += ms; } };
}

test('construction is inert and unsupported Windows operations refuse without spawn', async t => {
  const f = setup(t, { platform: 'win32', spawn: () => assert.fail('Windows must not spawn') });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'managed-browser')), false);
  assert.equal((await f.manager.open()).supported, false);
  assert.equal((await f.manager.stop()).supported, false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'managed-browser')), false);
});

test('source child start is serialized, private and preserves a stable port across Stop/Open', async t => {
  const f = setup(t);
  const [a, b] = await Promise.all([f.manager.ensureStarted(), f.manager.ensureStarted()]);
  assert.equal(a.status, 'running'); assert.equal(b.port, a.port);
  assert.equal(f.calls.filter(c => c[0] === 'spawn').length, 1);
  assert.equal(a.mode, 'child'); assert.equal(a.survivesRestart, false);
  const launch = f.calls.find(c => c[0] === 'spawn');
  assert.ok(launch[2].includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launch[2].includes(`--user-data-dir=${path.join(f.dataDir, 'managed-browser/profile')}`));
  assert.equal(launch[3].shell, false);
  assert.equal(launch[3].env.DISPLAY, ':1'); assert.equal(launch[3].env.DBUS_SESSION_BUS_ADDRESS, 'bus');
  for (const key of ['APPIMAGE', 'ELECTRON_BAD', 'CLAUDECODE']) assert.equal(launch[3].env[key], undefined);
  assert.ok(!launch[2].some(a => /no-sandbox|disable-web-security|remote-allow-origins|headless/.test(a)));
  await f.manager.stop();
  assert.equal((await f.manager.open()).port, a.port);
});

test('Stop queued during a start finishes stopped and Open activates the existing page', async t => {
  const f = setup(t);
  const starting = f.manager.ensureStarted(), stopping = f.manager.stop();
  await starting;
  assert.equal((await stopping).status, 'stopped');
  await f.manager.open();
  assert.ok(f.calls.some(c => c[1] === '/json/activate/page'));
});

test('packaged scope escapes dollars, detaches/unrefs and survives synchronous quit', async t => {
  const f = setup(t, { isPackaged: true });
  const result = await f.manager.open();
  assert.equal(result.mode, 'scope'); assert.equal(result.survivesRestart, true);
  const launch = f.calls.find(c => c[0] === 'spawn');
  assert.equal(launch[1], 'systemd-run'); assert.ok(launch[2].includes('--scope'));
  assert.ok(launch[2].includes('/fake/chrome $$literal')); assert.equal(launch[3].detached, true);
  assert.ok(f.calls.some(c => c[0] === 'unref'));
  f.manager.stopForQuit();
  assert.equal(f.calls.filter(c => c[0] === 'signal').length, 0);
});

test('missing binary reserves a persistent endpoint before resolution and memo clears on path change or Open', async t => {
  let attempts = 0;
  const f = setup(t, { discover: () => { attempts++; throw new Error('Install Chromium or configure an absolute executable'); } });
  const first = await f.manager.ensureStarted({ binaryPath: '/one' });
  assert.equal(first.status, 'error'); assert.ok(first.port > 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'managed-browser/state.json'))).port, first.port);
  await f.manager.ensureStarted({ binaryPath: '/one' }); assert.equal(attempts, 1);
  await f.manager.ensureStarted({ binaryPath: '/two' }); assert.equal(attempts, 2);
  await f.manager.open({ binaryPath: '/two' }); assert.equal(attempts, 3);
});

test('changed discovered cache inputs clear automatic failure memo', async t => {
  let attempts = 0;
  const f = setup(t, { discover: () => { attempts++; throw new Error('missing browser'); } });
  const root = path.join(f.dataDir, 'cache'); fs.mkdirSync(root); f.options.env.PLAYWRIGHT_BROWSERS_PATH = root;
  await f.manager.ensureStarted(); await f.manager.ensureStarted(); assert.equal(attempts, 1);
  fs.mkdirSync(path.join(root, 'chromium-1234'));
  await f.manager.ensureStarted(); assert.equal(attempts, 2);
});

test('foreign persisted port is replaced with a restart notice and never closed or signalled', async t => {
  const f = setup(t);
  const first = await f.manager.open(); await f.manager.stop();
  f.options.portFree = async () => false;
  const second = api().createManager(f.options); await f.manager.dispose();
  t.after(() => second.dispose());
  const result = await second.open();
  assert.notEqual(result.port, first.port); assert.match(result.notice, /restart/i);
});

test('bind/spawn collision cleans only its own launch and retries on a new port', async t => {
  const f = setup(t); const realSpawn = f.options.spawn;
  let count = 0;
  const manager = api().createManager({ ...f.options, spawn: (...args) => {
    const child = realSpawn(...args);
    if (++count === 1) { const record = f.processes.get(child.pid); record.port = 1; record.conflict = true; }
    return child;
  } });
  t.after(() => manager.dispose());
  const running = await manager.open();
  assert.equal(running.status, 'running'); assert.equal(count, 2);
  assert.match(running.notice, /restart/i);
  assert.deepEqual(f.calls.filter(c => c[0] === 'signal'), [['signal', 101, 'SIGTERM']]);
});

test('foreign identity cannot be adopted from a successful version response', async t => {
  const f = setup(t); const start = await f.manager.open();
  f.processes.get(start.pid).profile += '-old';
  const calls = f.calls.length;
  assert.equal((await f.manager.ensureStarted()).status, 'foreign');
  assert.equal((await f.manager.stop()).status, 'foreign');
  assert.equal(f.calls.slice(calls).some(c => ['signal', 'close'].includes(c[0])), false);
});

test('source quit sends verified positive PID TERM synchronously only for its own spawner', async t => {
  const f = setup(t); const state = await f.manager.open();
  const result = f.manager.stopForQuit();
  assert.equal(result, true);
  assert.deepEqual(f.calls.at(-1), ['signal', state.pid, 'SIGTERM']);
});

test('quit refuses reused browser PID and a changed spawner identity', async t => {
  for (const changed of ['browser', 'spawner']) {
    const f = setup(t); const state = await f.manager.open();
    if (changed === 'browser') f.processes.get(state.pid).identity.startTime = 'reused';
    else f.self.startTime = 'changed';
    assert.equal(f.manager.stopForQuit(), false);
    assert.equal(f.calls.some(c => c[0] === 'signal'), false);
  }
});

test('Browser.close precedes TERM and KILL, each escalation rechecks PID identity', async t => {
  const f = setup(t, { closeBrowser: async state => { f.calls.push(['close', state.pid]); } });
  await f.manager.open();
  f.proc.signal = (pid, signal) => {
    f.calls.push(['signal', pid, signal]);
    f.processes.get(pid).identity.startTime = 'reused';
  };
  const stopped = await f.manager.stop();
  assert.equal(stopped.status, 'foreign');
  assert.deepEqual(f.calls.filter(c => c[0] === 'signal').map(c => c[2]), ['SIGTERM']);
  assert.ok(f.calls.findIndex(c => c[0] === 'close') < f.calls.findIndex(c => c[0] === 'signal'));
});

test('a second manager is follower, never spawns/stops/prunes, then takes over after owner disposal', async t => {
  const f = setup(t); await f.manager.open();
  const follower = api().createManager(f.options); t.after(() => follower.dispose());
  assert.equal((await follower.open()).role, 'follower');
  const count = f.calls.length;
  assert.equal((await follower.stop()).role, 'follower');
  assert.equal(f.calls.length, count);
  await f.manager.dispose();
  const taken = await follower.ensureStarted();
  assert.equal(taken.role, 'owner', JSON.stringify(taken));
  assert.equal(f.calls.filter(c => c[0] === 'spawn').length, 1);
});

test('storage refuses hostile state symlinks and errors remain recoverable status', async t => {
  const f = setup(t); await f.manager.open(); await f.manager.stop();
  const state = path.join(f.dataDir, 'managed-browser/state.json');
  fs.unlinkSync(state);
  const outside = path.join(f.dataDir, 'outside'); fs.writeFileSync(outside, 'untouched');
  try { fs.symlinkSync(outside, state); } catch (e) { if (e.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; } throw e; }
  assert.equal((await f.manager.open()).status, 'error');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('Linux discovery sorts revisions numerically and honors explicit roots and invalid paths', t => {
  const f = setup(t);
  const { discoverBrowser } = require('../src/main/browser/discovery');
  const root = path.join(f.dataDir, 'cache');
  for (const rev of [999, 1234]) {
    const binary = path.join(root, `chromium-${rev}`, 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fake');
  }
  const result = discoverBrowser({ fs, home: f.dataDir, env: { PLAYWRIGHT_BROWSERS_PATH: root } });
  assert.ok(result.binary.includes('1234'));
  assert.throws(() => discoverBrowser({ fs, binaryPath: 'relative', home: f.dataDir, env: {} }), /absolute/);
  assert.throws(() => discoverBrowser({ fs, binaryPath: path.join(root, 'missing'), home: f.dataDir, env: { PLAYWRIGHT_BROWSERS_PATH: root } }), /executable/);
  assert.throws(() => discoverBrowser({ fs, home: f.dataDir, env: { PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'absent') } }), /Install/);
});

test('proc identity validates stat field 22, exact profile, executable, boot, listener inode and address', t => {
  setup(t);
  const { parseStat, matchesArgv, createProc } = require('../src/main/browser/linux-process');
  assert.equal(parseStat('100 (name with ) parens) S ' + Array.from({ length: 20 }, (_, i) => i + 4).join(' ')).startTime, '22');
  for (const sep of ['\0', ' ']) {
    assert.equal(matchesArgv(['/chrome', '--user-data-dir=/data/profile', '--remote-debugging-port=41000'].join(sep), '/chrome', '/data/profile', 41000), true);
    assert.equal(matchesArgv(['/chrome', '--user-data-dir=/data/profile-old', '--remote-debugging-port=41000'].join(sep), '/chrome', '/data/profile', 41000), false);
    assert.equal(matchesArgv(['/chrome', '--user-data-dir=/data/profile', '--user-data-dir=/other', '--remote-debugging-port=41000'].join(sep), '/chrome', '/data/profile', 41000), false);
  }
  const state = { pid: 100, startTime: '22', boot: 'b', binary: '/chrome', profile: '/data/profile', port: 41000 };
  let address = '0100007F', inode = '99', start = '22', boot = 'b';
  const procFs = { readFileSync: file => {
    if (file.endsWith('boot_id')) return boot;
    if (file.endsWith('/stat')) return '100 (chrome) S ' + [...Array.from({ length: 18 }, (_, i) => i + 4), start].join(' ');
    if (file.endsWith('/cmdline')) return '/chrome\0--user-data-dir=/data/profile\0--remote-debugging-port=41000\0';
    if (file.endsWith('/tcp')) return ` 0: ${address}:A028 00000000:0000 0A 0:0 0:0 0 0 0 99`;
    if (file.endsWith('/tcp6')) return '';
    throw new Error(file);
  }, readlinkSync: file => file.endsWith('/exe') ? '/chrome' : `socket:[${inode}]`, readdirSync: () => ['1'], realpathSync: file => file.endsWith('/exe') ? '/chrome' : file };
  const proc = createProc({ fs: procFs });
  assert.equal(proc.verify(state), true); assert.equal(proc.listener(state), 'owned');
  inode = '98'; assert.equal(proc.listener(state), 'foreign');
  inode = '99'; address = '00000000'; assert.equal(proc.listener(state), 'foreign');
  start = '23'; assert.equal(proc.verify(state), false);
  start = '22'; boot = 'other'; assert.equal(proc.verify(state), false);
});

test('a verified missing user bus falls back once; Chromium FATAL never falls back', async t => {
  for (const fatal of [false, true]) {
    const f = setup(t, { isPackaged: true });
    const realSpawn = f.options.spawn;
    const manager = api().createManager({ ...f.options, spawn: (file, args, options) => {
      if (file !== 'systemd-run') return realSpawn(file, args, options);
      f.calls.push(['spawn', file, args, options]);
      fs.writeSync(options.stdio[1], fatal ? 'FATAL sandbox initialization failed' : 'Failed to connect to bus: No medium found');
      const child = new EventEmitter(); child.pid = 77; child.unref = () => {};
      queueMicrotask(() => child.emit('exit', 1)); return child;
    } });
    t.after(() => manager.dispose());
    const result = await manager.open();
    if (!fatal) assert.equal(result.mode, 'detached');
    assert.equal(result.status, fatal ? 'error' : 'running');
    assert.equal(f.calls.filter(c => c[0] === 'spawn').length, fatal ? 1 : 2);
    assert.equal(result.survivesRestart, false);
  }
});

test('ambiguous scope timeout retains pending launch and cleanup cannot delete its profile', async t => {
  const f = setup(t, { isPackaged: true, spawn: () => {
    const child = new EventEmitter(); child.pid = 200; child.unref = () => {}; return child;
  } });
  const result = await f.manager.open();
  assert.equal(result.status, 'error');
  const stored = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'managed-browser/state.json')));
  assert.equal(stored.launchPending, true);
  assert.equal((await f.manager.stop()).status, 'error');
  assert.equal((await f.manager.open()).status, 'error');
});

test('an unavailable or overlong owner lock never becomes an unlocked writer', async t => {
  const f = setup(t, { lock: { acquire: async () => { throw new Error('owner socket path too long'); } } });
  const status = await f.manager.open();
  assert.equal(status.status, 'error'); assert.match(status.error, /socket/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'managed-browser/state.json')), false);
});

test('existing directories are hardened and atomic state writes leave no temporary files', async t => {
  const f = setup(t);
  const { createStorage } = require('../src/main/browser/storage');
  const modes = [];
  const storage = createStorage({ dataDir: f.dataDir, fs: { ...fs, chmodSync: (file, mode) => { modes.push([file, mode]); fs.chmodSync(file, mode); } } });
  const base = storage.init(); storage.write('state.json', { port: 1 });
  storage.write('state.json', { port: 2 });
  assert.ok(modes.filter(([, mode]) => mode === 0o700).length >= 3);
  assert.deepEqual(storage.read('state.json'), { port: 2 });
  assert.equal(fs.readdirSync(base).some(file => file.endsWith('.tmp')), false);
  if (process.platform === 'linux') assert.equal(fs.statSync(path.join(base, 'state.json')).mode & 0o777, 0o600);
});

test('interleaved state publishers use unique temporary names and preserve complete JSON', t => {
  const f = setup(t);
  const { createStorage } = require('../src/main/browser/storage');
  let interleave = false, storage;
  const proxy = { ...fs, openSync: (file, ...args) => {
    const fd = fs.openSync(file, ...args);
    if (interleave && file.endsWith('.tmp')) { interleave = false; storage.write('state.json', { writer: 'inner' }); }
    return fd;
  } };
  storage = createStorage({ dataDir: f.dataDir, fs: proxy }); const base = storage.init();
  interleave = true;
  assert.doesNotThrow(() => storage.write('state.json', { writer: 'outer' }));
  assert.deepEqual(storage.read('state.json'), { writer: 'outer' });
  assert.equal(fs.readdirSync(base).some(name => name.endsWith('.tmp')), false);
});

test('quit cannot signal after loss of listener ownership, and followers never signal on quit', async t => {
  const f = setup(t); const running = await f.manager.open();
  f.processes.get(running.pid).port = 42;
  assert.equal(f.manager.stopForQuit(), false);
  assert.equal(f.calls.some(c => c[0] === 'signal'), false);
  const follower = api().createManager(f.options); t.after(() => follower.dispose());
  await follower.ensureStarted(); assert.equal(follower.stopForQuit(), false);
});

test('a follower of a running source browser cannot signal it on quit', async t => {
  const f = setup(t); await f.manager.open();
  const follower = api().createManager(f.options); t.after(() => follower.dispose());
  assert.equal((await follower.ensureStarted()).status, 'running');
  assert.equal(follower.stopForQuit(), false);
  assert.equal(f.calls.some(c => c[0] === 'signal'), false);
});

test('failed state publication returns an error and never spawns', async t => {
  const f = setup(t);
  const manager = api().createManager({ ...f.options, fs: { ...fs, renameSync: () => { throw new Error('write failed'); } } });
  t.after(() => manager.dispose());
  let status;
  await assert.doesNotReject(async () => { status = await manager.open(); });
  assert.match(status.error, /write failed/);
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
});

test('publication failure after spawn cleans the verified launch before returning an error', async t => {
  const f = setup(t); let publications = 0;
  const manager = api().createManager({ ...f.options, fs: { ...fs, renameSync: (...args) => {
    if (++publications === 3) throw new Error('publication failed after spawn');
    return fs.renameSync(...args);
  } } });
  t.after(() => manager.dispose());
  let result; await assert.doesNotReject(async () => { result = await manager.open(); });
  assert.equal(result.status, 'error');
  assert.equal(f.processes.size, 0);
  assert.deepEqual(f.calls.filter(c => c[0] === 'signal'), [['signal', 101, 'SIGTERM']]);
});

test('a synchronous spawn refusal clears pending launch so explicit Open can retry', async t => {
  const f = setup(t); let failed = false;
  const manager = api().createManager({ ...f.options, spawn: (...args) => {
    if (!failed) { failed = true; throw new Error('spawn refused'); }
    return f.options.spawn(...args);
  } });
  t.after(() => manager.dispose());
  assert.match((await manager.open()).error, /spawn refused/);
  assert.equal((await manager.open()).status, 'running');
});

test('pruning removes only ordinary old output files and retains recent files and profile', async t => {
  const f = setup(t);
  const { createStorage } = require('../src/main/browser/storage');
  const storage = createStorage({ dataDir: f.dataDir }); const base = storage.init();
  for (const name of ['old', 'recent']) fs.writeFileSync(path.join(base, 'output', name), 'keep');
  const old = new Date(Date.now() - 8 * 86400000); fs.utimesSync(path.join(base, 'output', 'old'), old, old);
  fs.writeFileSync(path.join(base, 'profile', 'login'), 'keep');
  storage.prune();
  assert.equal(fs.existsSync(path.join(base, 'output', 'old')), false);
  assert.equal(fs.existsSync(path.join(base, 'output', 'recent')), true);
  assert.equal(fs.readFileSync(path.join(base, 'profile', 'login'), 'utf8'), 'keep');
});

test('source orphan adoption requires dead spawner and records new spawner before quit', async t => {
  const f = setup(t); const running = await f.manager.open();
  await f.manager.dispose();
  const file = path.join(f.dataDir, 'managed-browser/state.json');
  const stored = JSON.parse(fs.readFileSync(file)); stored.spawnedBy = { pid: 300, startTime: '3000', boot: 'boot' };
  fs.writeFileSync(file, JSON.stringify(stored));
  f.processes.set(300, { identity: stored.spawnedBy });
  const manager = api().createManager(f.options); t.after(() => manager.dispose());
  assert.equal((await manager.ensureStarted()).status, 'foreign');
  f.processes.delete(300);
  assert.equal((await manager.ensureStarted()).status, 'running');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).spawnedBy, f.self);
  assert.equal(manager.stopForQuit(), true);
  assert.deepEqual(f.calls.at(-1), ['signal', running.pid, 'SIGTERM']);
});

test('Linux procfs parser agrees with independent uptime oracle', { skip: process.platform !== 'linux' && 'real Linux procfs is unavailable on Windows' }, () => {
  const { createProc } = require('../src/main/browser/linux-process');
  const identity = createProc().self();
  const { execFileSync } = require('node:child_process');
  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
  const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const age = uptime - Number(identity.startTime) / hz;
  assert.ok(Math.abs(age - process.uptime()) < 5);
});
