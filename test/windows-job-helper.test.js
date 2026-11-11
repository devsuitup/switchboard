'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('A4c2a retained termination serializes before observation and release', async t => {
  const f = fixture(t);
  assert.equal(typeof f.helper.terminateWithEvidence, 'function', 'helper must expose bounded retained termination');
  const assign = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\nassigned one\n'); await assign;
  const stopped = f.helper.terminateWithEvidence('one', { deadline: Date.now() + 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'terminate-retained one\n');
  f.child.stdout.emit('data', 'terminated one\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'observe one\n');
  f.child.stdout.emit('data', 'observed one 0\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'release one\n');
  f.child.stdout.emit('data', 'released one\n');
  assert.equal((await stopped).ended, true);
});

function fixture(t, options = {}) {
  const filename = path.join(__dirname, '../src/main/terminals/windows-job-helper.js');
  assert.ok(fs.existsSync(filename), 'a resident helper must replace per-close snapshots');
  const { createWindowsJobHelper } = require(filename);
  const child = new EventEmitter();
  const writes = [], invocations = [], warnings = [];
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = line => writes.push(line);
  child.kill = () => { child.killed = true; };
  const helper = createWindowsJobHelper({ spawn(program, args, opts) { invocations.push({ program, args, opts }); return child; },
    warn: message => warnings.push(message), startupMs: 5000, ...options });
  t.after(() => { child.emit('exit', 0); });
  return { helper, child, writes, invocations, warnings };
}

for (const op of ['release', 'terminate', 'assign']) {
  test(`F1: observation interleaved with ${op} keeps requests and later PTY tracking alive`, async t => {
    const { trackWindowsPty } = require('../src/main/terminals/pty-ops');
    const f = fixture(t);
    const assigned = f.helper.assign('one', 897, 100);
    f.child.stdout.emit('data', 'ready\nassigned one\n');
    assert.equal(await assigned, true);
    const observed = f.helper.observe('one');
    const done = op === 'assign' ? f.helper.assign('one', 898, 101) : f.helper[op]('one');
    f.child.stdout.emit('data', 'observed one 0\n');
    assert.deepEqual(f.warnings, [], 'interleaving must not disable the helper');
    assert.equal((await observed)?.ended, true, 'observation must resolve its own reply');
    assert.match(f.writes.at(-1), new RegExp(`^${op} one(?: |\\n)`));
    f.child.stdout.emit('data', `${{ release: 'released', terminate: 'terminated', assign: 'assigned' }[op]} one\n`);
    assert.equal(await done, true, 'the overlapping request must resolve its own reply');
    const pty = { pid: 899, onExit() {} };
    const later = trackWindowsPty(pty, { jobs: f.helper, platform: 'win32', spawnTime: 102 });
    const laterId = f.writes.at(-1).split(' ')[1];
    f.child.stdout.emit('data', `assigned ${laterId}\n`);
    assert.equal(await later, true, 'later PTYs must still acquire a Windows job');
    assert.deepEqual(f.warnings, []);
  });
}

test('read-only job observation never starts a helper and distinguishes live, ended and unavailable', async t => {
  const f = fixture(t);
  assert.equal(typeof f.helper.observe, 'function', 'job death requires a read-only kernel observation');
  assert.equal(await f.helper.observe('one'), null);
  assert.equal(f.invocations.length, 0, 'status cannot start a helper');
  const assign = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\nassigned one\n'); await assign;
  const live = f.helper.observe('one');
  assert.equal(f.writes.at(-1), 'observe one\n'); f.child.stdout.emit('data', 'observed one 1\n');
  assert.equal((await live).ended, false);
  const ended = f.helper.observe('one'); f.child.stdout.emit('data', 'observed one 0\n');
  assert.equal((await ended).ended, true);
});

test('one hidden helper reads the packaged script and queues assigns until ready', async t => {
  const f = fixture(t);
  let alive = true;
  const a = f.helper.assign('one', 897, 100, () => true);
  const b = f.helper.assign('gone', 898, 100, () => alive);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.writes.length, 0);
  const { program, args, opts } = f.invocations[0];
  assert.equal(program, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = fs.readFileSync(path.join(__dirname, '../src/main/terminals/windows-job-helper.ps1'), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
  assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), script);
  assert.ok([program, ...args].join(' ').length < 32700);
  assert.equal(opts.windowsHide, true);
  alive = false;
  f.child.stdout.emit('data', 'rea'); f.child.stdout.emit('data', 'dy\n');
  assert.deepEqual(f.writes, ['assign one 897 100\n']);
  f.child.stdout.emit('data', 'assigned one\n');
  assert.equal(await a, true); assert.equal(await b, false);
  const terminate = f.helper.terminate('one');
  assert.equal(f.writes.at(-1), 'terminate one\n');
  f.child.stdout.emit('data', 'terminated one\n');
  assert.equal(await terminate, true);
});

test('terminate sends validated roster PIDs after an in-flight assign and bounds roster I/O', async t => {
  const f = fixture(t);
  const assign = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\n');
  const done = f.helper.terminate('one', [{ pid: 901, procStart: '133000000000000000' }, { pid: 902, procStart: '133000000000000001' },
    { pid: 901, procStart: '133000000000000000' }, { pid: -1, procStart: '133000000000000000' }, 903,
    { pid: 904 }, { pid: 905, procStart: 'broken' }]);
  f.child.stdout.emit('data', 'assigned one\n');
  await assign;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'terminate one 901:133000000000000000,902:133000000000000001\n');
  f.child.stdout.emit('data', 'terminated one\n');
  assert.equal(await done, true);
});

test('best-effort roster reads are asynchronous, bounded and never strand termination', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { protectedPids: () => new Promise(() => {}) });
  f.helper.start(); f.child.stdout.emit('data', 'ready\n');
  const done = f.helper.terminate('one');
  t.mock.timers.tick(50);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'terminate one\n');
  f.child.stdout.emit('data', 'terminated one\n');
  assert.equal(await done, true);
});

test('termination uses asynchronously read roster PIDs and ignores roster read errors', async t => {
  for (const fails of [false, true]) {
    const f = fixture(t, { protectedPids: async () => { if (fails) throw new Error('missing roster'); return [{ pid: 901, procStart: '133000000000000000' }]; } });
    f.helper.start(); f.child.stdout.emit('data', 'ready\n');
    const done = f.helper.terminate('one');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.writes.at(-1), fails ? 'terminate one\n' : 'terminate one 901:133000000000000000\n');
    f.child.stdout.emit('data', 'terminated one\n');
    assert.equal(await done, true);
  }
});

test('release cancels an assign queued before ready and never sends it later', async t => {
  const f = fixture(t);
  const assign = f.helper.assign('one', 897, 100);
  assert.equal(await f.helper.release('one'), true);
  f.child.stdout.emit('data', 'ready\n');
  assert.equal(await assign, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.warnings, []);
});

test('closing before ready cancels assignments and warns once about plain ConPTY cleanup', async t => {
  const f = fixture(t);
  const first = f.helper.assign('one', 897, 100);
  const second = f.helper.assign('two', 898, 100);
  assert.equal(await f.helper.terminate('one'), true);
  assert.equal(await f.helper.terminate('two'), true);
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(f.warnings.length, 1, 'early closes must emit one warning per helper lifetime');
  assert.match(f.warnings[0], /before.*ready.*plain ConPTY/i);
  f.child.stdout.emit('data', 'ready\n');
  assert.deepEqual(f.writes, []);
  const later = f.helper.assign('later', 899, 100);
  f.child.stdout.emit('data', 'assigned later\n');
  assert.equal(await later, true);
});

test('close before helper readiness warns even before the PTY has submitted its PID', async t => {
  const f = fixture(t);
  f.helper.start();
  const done = f.helper.terminate('pending-pid');
  assert.equal(f.warnings.length, 1, 'a close with no queued assignment still needs the startup warning');
  f.child.stdout.emit('data', 'ready\nterminated pending-pid\n');
  assert.equal(await done, true);
});

test('helper death, protocol failure and startup timeout settle requests, log once, never restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of ['death', 'error', 'timeout', 'stdin', 'protocol']) {
    const f = fixture(t);
    const assign = f.helper.assign('one', 897, 100);
    if (failure === 'death') f.child.emit('exit', 1);
    if (failure === 'error') f.child.emit('error', new Error('denied'));
    if (failure === 'timeout') t.mock.timers.tick(5000);
    if (failure === 'stdin') f.child.stdin.emit('error', new Error('EPIPE'));
    if (failure === 'protocol') f.child.stdout.emit('data', 'invalid\n');
    assert.equal(await assign, false);
    assert.equal(await f.helper.assign('two', 898, 100), false);
    assert.equal(await f.helper.terminate('one'), false);
    f.child.emit('exit', 1);
    assert.equal(f.invocations.length, 1);
    assert.equal(f.warnings.length, 1);
  }
});

test('per-request native errors do not disable other jobs; release is acknowledged', async t => {
  const f = fixture(t);
  const a = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\nerror one 5\n');
  assert.equal(await a, false);
  const b = f.helper.assign('two', 898, 100);
  f.child.stdout.emit('data', 'assigned two\n');
  assert.equal(await b, true);
  const r = f.helper.release('two');
  assert.equal(f.writes.at(-1), 'release two\n');
  f.child.stdout.emit('data', 'released two\n');
  assert.equal(await r, true);
});

test('release waits for an in-flight assign acknowledgement and then clears that job', async t => {
  const f = fixture(t);
  const assign = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\n');
  const release = f.helper.release('one');
  assert.deepEqual(f.writes, ['assign one 897 100\n']);
  f.child.stdout.emit('data', 'assigned one\n');
  assert.equal(await assign, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.at(-1), 'release one\n');
  f.child.stdout.emit('data', 'released one\n');
  assert.equal(await release, true);
});

test('a silent ready helper has a request deadline and cannot strand close/release promises', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const assign = f.helper.assign('one', 897, 100);
  f.child.stdout.emit('data', 'ready\n');
  const release = f.helper.release('one');
  t.mock.timers.tick(3000);
  assert.equal(await assign, false); assert.equal(await release, false);
  assert.equal(f.child.killed, true); assert.equal(f.warnings.length, 1);
});

test('synchronous helper spawn failure and invalid process identity return failure without throwing', async () => {
  const { createWindowsJobHelper } = require('../src/main/terminals/windows-job-helper');
  let spawns = 0, warnings = 0;
  const helper = createWindowsJobHelper({ spawn() { spawns++; throw new Error('denied'); }, warn() { warnings++; } });
  for (const pid of [0, -1, process.pid, NaN]) assert.equal(await helper.assign('bad', pid, 100), false);
  assert.equal(spawns, 0);
  assert.equal(await helper.assign('one', 897, 100), false);
  assert.equal(await helper.assign('two', 898, 100), false);
  assert.equal(spawns, 1); assert.equal(warnings, 1);
});

test('singleton is configured once and rejects different bindings instead of silently ignoring them', () => {
  const vm = require('node:vm');
  const filename = require.resolve('../src/main/terminals/windows-job-helper');
  const context = vm.createContext({ require: require('node:module').createRequire(filename), module: { exports: {} } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports;
  const warn = () => {}, protectedPids = () => [];
  assert.equal(typeof api.configureWindowsJobHelper, 'function', 'configuration must be explicit');
  api.configureWindowsJobHelper(warn, protectedPids);
  const helper = api.windowsJobHelper();
  api.configureWindowsJobHelper(warn, protectedPids);
  assert.equal(api.windowsJobHelper(), helper);
  assert.throws(() => api.configureWindowsJobHelper(() => {}, protectedPids), /already configured/);
  assert.throws(() => api.configureWindowsJobHelper(warn, () => []), /already configured/);
});
