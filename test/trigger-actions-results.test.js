'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const request = '12345678-1234-1234-1234-123456789abc';
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const payload = { version: 1, action: 'open', sessionId: id };

async function rig(t, options = {}) {
  const name = options.name || request;
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v1-results-')));
  const processed = path.join(dir, 'processed');
  fs.mkdirSync(processed);
  const input = path.join(dir, name + '.json');
  const output = path.join(processed, name.toLowerCase() + '.result.json');
  const marker = path.join(processed, name.toLowerCase() + '.action.json');
  if (options.prior) fs.writeFileSync(output, JSON.stringify(options.prior) + '\n');
  if (options.marker) fs.writeFileSync(marker, JSON.stringify(options.marker));
  if (options.readError) fs.writeFileSync(options.errorOnMarker ? marker : output, '{}');
  const body = options.raw ?? JSON.stringify(Object.hasOwn(options, 'payload') ? options.payload : payload);
  const makeInput = () => (options.directoryInput ? fs.mkdirSync(input) : fs.writeFileSync(input, body));
  if (!options.orphan && !options.live) makeInput();
  if (!options.live) options.setup?.({ input, output, marker });
  if (options.stale && !options.orphan && !options.live) fs.utimesSync(input, new Date(0), new Date(0));
  let notify;
  let publications = 0;
  let recoveryReads = 0;
  const descriptors = new Map();
  const events = [];
  const errors = [];
  const filename = path.resolve(__dirname, '../src/main/triggers/trigger-watcher.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const fakeFs = { ...fs,
    readFileSync(file, ...args) {
      if (file === marker || file === output) recoveryReads++;
      if (options.readError && file === (options.errorOnMarker ? marker : output)) throw options.readError;
      return fs.readFileSync(file, ...args);
    },
    openSync(file, ...args) {
      if (file === marker || file === output) recoveryReads++;
      const fd = fs.openSync(file, ...args);
      descriptors.set(fd, file);
      return fd;
    },
    readSync(fd, ...args) {
      if (options.readError && descriptors.get(fd) === (options.errorOnMarker ? marker : output)) throw options.readError;
      return fs.readSync(fd, ...args);
    },
    closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
    watch: (_dir, _opts, callback) => { notify = callback; return { on() {}, close() {} }; },
    lstatSync(file, ...args) {
      if (options.inspectError && file === input) throw options.inspectError;
      return fs.lstatSync(file, ...args);
    },
    unlinkSync(file) {
      events.push(path.basename(file));
      if (options.failUnlink && file === input) throw new Error('unlink denied');
      return fs.unlinkSync(file);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: name => name === 'fs' ? fakeFs : name === '../shared/atomic-write' ? { renameWithRetry(src, dest) {
      if (dest === output) {
        publications++;
        events.push('publication');
        if (options.failPublish) throw new Error('publication denied');
      }
      fs.renameSync(src, dest);
    } } : nativeRequire(name),
    process: { env: { ...process.env, SWITCHBOARD_TRIGGERS_DIR: dir }, platform: process.platform, pid: process.pid },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
  }, { filename });
  const watcher = module.exports.start({ log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    getPtyForSession() { return null; }, isSessionBusy: () => false, ...options.ctx });
  t.after(() => { watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (options.live) {
    options.setup?.({ input, output, marker });
    makeInput();
    if (options.stale) fs.utimesSync(input, new Date(0), new Date(0));
    notify('rename', name + '.json');
  }
  async function settle() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  return { dir, input, output, marker, events, errors, notifyFile: file => notify('rename', file), publications: () => publications, recoveryReads: () => recoveryReads, notify: () => notify('rename', request + '.json'), settle };
}

for (const state of ['marker']) {
  test(`uppercase v1 refuses its filename despite existing ${state}`, async t => {
    const r = await rig(t, { name: request.toUpperCase(), live: true,
      setup({ output, marker }) {
        fs.writeFileSync(state === 'result' ? output : marker, JSON.stringify({ ...payload, mode: 'resume' }));
      },
    });
    assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).reason, 'trigger filename must be a lowercase UUID', 'uppercase v1 must validate instead of recovering canonical state');
    assert.ok(fs.readdirSync(path.dirname(r.output)).includes(request + '.result.json'));
  });
  for (const [live, name] of [true, false].flatMap(live => [request.toUpperCase(), request].map(name => [live, name]))) {
    test(`legacy ${name} runs despite v1 ${state} for its UUID; ${live ? 'live' : 'startup'}`, async t => {
      const written = [];
      const r = await rig(t, { name, live, payload: { sessionId: id, command: 'legacy command' },
        setup({ output, marker }) {
          fs.writeFileSync(state === 'result' ? output : marker, JSON.stringify({ ...payload, mode: 'resume' }));
        },
        ctx: {
          getPtyForSession: () => ({ handle: { isAlive: () => true, write: text => written.push(text) } }),
          getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
          isSessionBusy: () => true,
        },
      });
      const legacyOutput = path.join(path.dirname(r.output), name + '.result.json');
      const deadline = performance.now() + 2500;
      while (fs.existsSync(r.input) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(written, ['legacy command', '\r'], 'legacy input must execute despite unrelated v1 recovery state');
      if (live) assert.equal(r.recoveryReads(), 0, 'legacy input never reads v1 recovery state');
      assert.equal(fs.existsSync(legacyOutput), true, 'legacy client must receive its own result');
      const result = JSON.parse(fs.readFileSync(legacyOutput, 'utf8'));
      assert.equal(result.ok, true);
      assert.equal(Object.hasOwn(result, 'version'), false);
      assert.ok(fs.readdirSync(path.dirname(r.output)).includes(name + '.result.json'), 'legacy publication keeps the original filename spelling');
    });
  }
}

for (const location of ['output', 'marker']) {
  test(`recovery rejects ${location} that grows beyond 64 KiB when read`, t => {
    const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-growth-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, 'output');
    const marker = path.join(dir, 'marker');
    const target = location === 'output' ? output : marker;
    fs.writeFileSync(target, JSON.stringify(payload));
    const large = JSON.stringify(payload) + ' '.repeat(65537);
    let requested = 0;
    let closed = 0;
    const actions = createTriggerActions({ fs: { ...fs,
      readFileSync(file, ...args) {
        fs.writeFileSync(target, large);
        return fs.readFileSync(file, ...args);
      },
      readSync(fd, ...args) {
        fs.writeFileSync(target, large);
        requested += args[2];
        return fs.readSync(fd, ...args);
      },
      closeSync(fd) { closed++; return fs.closeSync(fd); },
    } });
    assert.throws(() => actions.readState(output, marker), /recovery state too large/, 'state that grows during reading must be refused');
    assert.equal(requested, 65537, 'the read budget includes exactly one overflow byte');
    assert.equal(closed, 1, 'overflow must close its descriptor');
  });
}

for (const kind of ['directory', 'oversize']) {
  test(`recovery rechecks opened descriptor after path becomes ${kind}`, t => {
    const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-fstat-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'state');
    fs.writeFileSync(target, JSON.stringify(payload));
    let reads = 0;
    let closed = 0;
    const actions = createTriggerActions({ fs: { ...fs,
      fstatSync: () => ({ isFile: () => kind !== 'directory', size: kind === 'oversize' ? 65537 : 0 }),
      readSync() { reads++; return 0; },
      closeSync(fd) { closed++; return fs.closeSync(fd); },
    } });
    assert.throws(() => actions.readState(target, path.join(dir, 'missing')), kind === 'directory' ? /regular file/ : /too large/);
    assert.equal(reads, 0, 'unsafe opened state must not be read');
    assert.equal(closed, 1, 'fstat refusal must close the opened descriptor');
  });
}

test('recovery reads a complete 64 KiB state through short descriptor reads', t => {
  const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-short-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'state');
  const data = JSON.stringify(payload);
  fs.writeFileSync(target, data + ' '.repeat(65536 - Buffer.byteLength(data)));
  let closed = 0;
  let reads = 0;
  const actions = createTriggerActions({ fs: { ...fs,
    readFileSync() { assert.fail('recovery must read the opened descriptor'); },
    openSync(file, flags) {
      const expected = process.platform === 'win32' ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
      assert.equal(flags, expected, 'recovery must use the platform-safe open flags');
      return fs.openSync(file, flags);
    },
    readSync(fd, buffer, offset, length, position) {
      reads++;
      assert.ok(offset + length <= 65537, 'descriptor read stays within the overflow sentinel');
      return fs.readSync(fd, buffer, offset, Math.min(length, 1024), position);
    },
    closeSync(fd) { closed++; return fs.closeSync(fd); },
  } });
  assert.deepEqual(actions.readState(target, path.join(dir, 'missing')), { result: payload, committed: true });
  assert.ok(reads > 1, 'short reads must be continued until EOF or the byte ceiling');
  assert.equal(closed, 1);
});

for (const location of ['output', 'marker']) {
  for (const kind of ['oversize', 'directory', 'symlink']) {
    test(`recovery rejects ${kind} ${location} before reading`, () => {
      const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
      let reads = 0;
      const stat = { isFile: () => kind === 'oversize', size: kind === 'oversize' ? 65537 : 0 };
      const actions = createTriggerActions({ fs: { ...fs,
        lstatSync(file) {
          if (file !== location) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return stat;
        },
        openSync() { return 42; },
        fstatSync() { return stat; },
        readSync() { reads++; throw new Error('unsafe read attempted'); },
        closeSync() {},
        readFileSync() { reads++; throw new Error('unsafe read attempted'); },
      } });
      assert.throws(() => actions.readState('output', 'marker'), kind === 'oversize' ? /too large/ : /regular file/);
      assert.equal(reads, 0, 'unsafe recovery state must never be read');
    });
  }
}

test('recovery rejects an actual FIFO without opening it', { skip: process.platform !== 'linux' && 'mkfifo requires Linux; Windows has no POSIX FIFO' }, t => {
  const { spawnSync } = require('node:child_process');
  const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-fifo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  let reads = 0;
  let opens = 0;
  const actions = createTriggerActions({ fs: { ...fs,
    openSync(...args) { opens++; return fs.openSync(...args); },
    readSync() { reads++; throw new Error('FIFO read attempted'); },
    readFileSync() { reads++; throw new Error('FIFO read attempted'); },
  } });
  assert.throws(() => actions.readState(fifo, path.join(dir, 'missing')));
  assert.equal(opens, 0, 'FIFO must be rejected by lstat without opening it');
  assert.equal(reads, 0, 'FIFO must be rejected by lstat without opening it');
});

for (const errorOnMarker of [false, true]) {
  for (const failure of ['SyntaxError', 'EISDIR', 'EBUSY']) {
    for (const legacy of [true, false]) {
      test(`recovery ${failure} on ${errorOnMarker ? 'marker' : 'result'} lets legacy=${legacy} finish`, async t => {
        const readError = failure === 'SyntaxError' ? new SyntaxError('corrupt JSON') : Object.assign(new Error(failure), { code: failure });
        const r = await rig(t, { readError, errorOnMarker, payload: legacy ? {} : payload });
        if (!errorOnMarker) {
          assert.equal(fs.existsSync(r.input), true, 'an uninspectable result keeps its input untouched');
          assert.equal(fs.readFileSync(r.output, 'utf8'), '{}', 'an uninspectable result is never overwritten');
          assert.equal(r.publications(), 0);
          assert.ok(r.errors.length);
          return;
        }
        assert.equal(fs.existsSync(r.input), false, 'recovery errors must not strand a readable trigger');
        const result = JSON.parse(fs.readFileSync(r.output, 'utf8'));
        if (legacy) assert.deepEqual(result, { ok: false, error: 'missing required field: sessionId', sessionId: null, submitted: 'no', wrote: false, steps_total: 0 });
        else {
          assert.equal(result.reason, 'trigger recovery state unavailable');
          assert.equal(result.outcome, 'refused');
          assert.equal(result.error, readError.message);
        }
      });
    }
  }
}

test('a real oversized state file refuses v1 without stranding input', async t => {
  const r = await rig(t, { setup: ({ marker }) => fs.writeFileSync(marker, ' '.repeat(65537)) });
  assert.equal(fs.existsSync(r.input), false, 'oversized state must yield a terminal refusal');
  assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).reason, 'trigger recovery state unavailable');
});

test('a real corrupt marker lets legacy validation publish its normal result', async t => {
  const r = await rig(t, { payload: {}, setup: ({ marker }) => fs.writeFileSync(marker, '{broken') });
  assert.equal(fs.existsSync(r.input), false, 'corrupt state must not suppress legacy validation');
  assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).error, 'missing required field: sessionId');
});

test('a real state symlink is refused before its target is read', async t => {
  let supported = true;
  const r = await rig(t, { setup: ({ marker }) => {
    const target = path.join(path.dirname(marker), 'symlink-target');
    fs.writeFileSync(target, JSON.stringify({ ...payload, mode: 'resume' }));
    try { fs.symlinkSync(target, marker, 'file'); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      supported = false;
      t.skip('Windows account lacks file-symlink privilege; injected lstat symlink cases still run');
    }
  } });
  if (!supported) return;
  const result = JSON.parse(fs.readFileSync(r.output, 'utf8'));
  assert.equal(result.reason, 'trigger recovery state unavailable');
  assert.equal(result.error, 'recovery state must be a regular file');
});

test('a legacy result without version is not recovery state', async t => {
  const r = await rig(t, { prior: { ok: true, sessionId: id, submitted: 'confirmed' } });
  assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).reason, 'session action not implemented in this build');
  assert.equal(fs.existsSync(r.input), false);
});

for (const value of [[], null, 7, 'legacy']) {
  test(`non-object ${JSON.stringify(value)} under a UUID keeps its legacy result`, async t => {
    const r = await rig(t, { payload: value });
    const legacy = await rig(t, { payload: value, name: 'legacy-non-object' });
    const result = JSON.parse(fs.readFileSync(r.output, 'utf8'));
    assert.deepEqual(result, JSON.parse(fs.readFileSync(legacy.output, 'utf8')), 'UUID and ordinary filenames must produce identical legacy results');
    if (value === null) {
      assert.equal(result.internal, true);
      assert.match(result.error, /^internal error: /);
      assert.equal(r.errors.length, 1);
    } else assert.deepEqual(result, { ok: false, error: 'missing required field: sessionId', sessionId: null, submitted: 'no', wrote: false, steps_total: 0 });
  });
}

for (const [name, value, reason] of [
  [request.toUpperCase(), payload, 'trigger filename must be a lowercase UUID'],
  [request, { ...payload, version: 2 }, 'unsupported version'],
]) {
  test(`stale v1 validates ${name} version ${value.version} before age`, async t => {
    const r = await rig(t, { name, payload: value, stale: true });
    assert.equal(fs.existsSync(r.output), true, 'stale v1 results use canonical lowercase spelling');
    assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).reason, reason);
    assert.deepEqual(fs.readdirSync(path.dirname(r.output)), [request + '.result.json'], 'publication must preserve lowercase spelling even on case-insensitive filesystems');
  });
}

test('v1 publishes once before removing input and never overwrites a result on duplicate UUID', async t => {
  const r = await rig(t);
  assert.equal(r.publications(), 1);
  const original = fs.readFileSync(r.output, 'utf8');
  assert.equal(JSON.parse(original).outcome, 'refused');
  assert.deepEqual(r.events.slice(0, 2), ['publication', request + '.json']);
  fs.writeFileSync(r.input, JSON.stringify({ ...payload, action: 'stop' }));
  r.notify();
  await r.settle();
  assert.equal(r.publications(), 1, 'a duplicate UUID must reuse its first result');
  assert.equal(fs.readFileSync(r.output, 'utf8'), original);
  assert.equal(fs.existsSync(r.input), false);
});

test('v1 failed publication retains input and suppresses replay in this watcher', async t => {
  const r = await rig(t, { failPublish: true });
  assert.equal(fs.existsSync(r.input), true, 'input must survive failed publication');
  assert.equal(fs.existsSync(r.output), false);
  r.notify();
  await r.settle();
  assert.equal(r.publications(), 1);
  assert.ok(r.errors.length);
});

test('v1 committed result wins over stale input and marker after restart', async t => {
  const prior = { version: 1, action: 'open', ok: false, outcome: 'refused', reason: 'prior result', sessionId: id,
    resumed: false, submitted: 'no', wrote: false, steps_total: 0 };
  const r = await rig(t, { prior, marker: { ...payload, steps_total: 0 }, stale: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.output, 'utf8')), prior);
  assert.equal(r.publications(), 0);
  assert.equal(fs.existsSync(r.input), false);
  assert.equal(fs.existsSync(r.marker), false);
});

for (const orphan of [false, true]) {
  test(`v1 recovers interrupted marker without replay; orphan=${orphan}`, async t => {
    const r = await rig(t, { orphan, stale: true, marker: { version: 1, action: 'open', mode: 'new', sessionId: id,
      deadline: 5, created: true, submitted: 'assumed', wrote: true, steps_total: 1, text_written: true, enter_written: true } });
    assert.equal(fs.existsSync(r.output), true, 'orphan and stale markers must produce a terminal result');
    const result = JSON.parse(fs.readFileSync(r.output, 'utf8'));
    assert.equal(result.reason, 'interrupted by restart');
    assert.equal(result.uncertain, true);
    assert.equal(result.created, true);
    assert.equal(result.sessionId, id);
    assert.equal(result.submitted, 'assumed');
    assert.equal(result.wrote, true);
    assert.equal(result.enter_written, true);
    assert.equal(fs.existsSync(r.marker), false);
  });
}

test('v1 input deletion failure retains immutable result and suppresses extra publication', async t => {
  const r = await rig(t, { failUnlink: true });
  assert.equal(fs.existsSync(r.input), true);
  r.notify();
  await r.settle();
  assert.equal(r.publications(), 1);
});

const other = '11234567-89ab-cdef-0123-456789abcdef';
const committed = { version: 1, action: 'open', ok: true, outcome: 'opened', sessionId: id, resumed: true,
  submitted: 'no', wrote: false, steps_total: 0 };
const committedBytes = JSON.stringify(committed) + '\n';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, label) {
  const end = performance.now() + 3000;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
}
function spies() {
  const s = { lookups: [], writes: [], effects: 0, dispatches: 0, gate: null, onDispatch: null };
  const lifecycle = {
    launchAllowed: () => true, activeSessions: new Map(),
    remoteTarget: async () => { s.effects++; return false; },
    liveElsewhere: async () => { s.effects++; return { known: true, live: null }; },
    resolveTarget: async () => { s.effects++; return { ok: true, cwd: '/p', project: '/p', transcript: 't', transcriptIdentity: 'i' }; },
    saveName: async () => { s.effects++; return { name: 'n' }; },
    broker: { request: async (_operation, beforeSpawn) => {
      await beforeSpawn();
      s.dispatches++;
      s.onDispatch?.();
      await s.gate;
      return { ok: false, reason: 'renderer refused' };
    } },
  };
  s.ctx = { getPtyForSession: sessionId => { s.lookups.push(sessionId); return null; },
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }), isSessionBusy: () => false, lifecycle };
  return s;
}
function assertNoDuplicateEffects(s) {
  assert.deepEqual(s.writes, []);
  assert.equal(s.dispatches, 0);
  assert.equal(s.effects, 0);
  assert.deepEqual(s.lookups, [], 'no target lookup is attributable to a duplicate');
}

const duplicates = {
  'legacy input for the same target': { payload: { sessionId: id, command: 'replay', wait: 'none', timeout_ms: 500 } },
  'legacy input for another target': { payload: { sessionId: other, command: 'replay to B', wait: 'none' } },
  'valid versioned input': { payload: { version: 1, action: 'open', sessionId: other } },
  'invalid versioned input': { payload: { version: 1, action: 'open' } },
  'stale legacy input': { payload: { sessionId: id, command: 'replay' }, stale: true },
  'stale versioned input': { payload, stale: true },
  'oversized input': { payload: { version: 1, action: 'open', sessionId: id, prompt: 'x'.repeat(70000) } },
  'malformed JSON': { raw: '{not json' },
  'null JSON': { payload: null },
  'nonregular input': { directoryInput: true },
  'input inspection failure': { inspectError: Object.assign(new Error('denied'), { code: 'EACCES' }) },
};
for (const [kind, extra] of Object.entries(duplicates)) {
  for (const live of [false, true]) {
    for (const name of [request, request.toUpperCase()]) {
      test(`a committed result survives a ${kind} (${live ? 'live' : 'startup'}, ${name === request ? 'lowercase' : 'uppercase'} UUID)`, async t => {
        const s = spies();
        const r = await rig(t, { ...extra, name, live, prior: committed, ctx: s.ctx });
        assert.equal(fs.readFileSync(r.output, 'utf8'), committedBytes);
        assert.equal(r.publications(), 0);
        assert.deepEqual(fs.readdirSync(path.dirname(r.output)), [request + '.result.json'], 'no other result file is published');
        assertNoDuplicateEffects(s);
        assert.equal(fs.existsSync(r.input), Boolean(extra.directoryInput), 'removable duplicates are cleaned, nonregular ones are never deleted recursively');
        r.notifyFile(name + '.json');
        await r.settle();
        assert.equal(fs.readFileSync(r.output, 'utf8'), committedBytes);
        assertNoDuplicateEffects(s);
        if (extra.directoryInput) assert.equal(r.events.filter(event => event === name + '.json').length, 1, 'a retained input is not processed again');
      });
    }
  }
}
test('a committed result keeps its bytes and a retained duplicate is not retried after an unlink failure', async t => {
  const s = spies();
  const r = await rig(t, { prior: committed, failUnlink: true, payload: { sessionId: other, command: 'replay' }, ctx: s.ctx });
  assert.equal(fs.readFileSync(r.output, 'utf8'), committedBytes);
  r.notify();
  await r.settle();
  assert.equal(r.events.filter(event => event === request + '.json').length, 1);
  assert.equal(fs.existsSync(r.input), true);
  assertNoDuplicateEffects(s);
  assert.ok(r.errors.length);
});
test('an unreadable committed result is never overwritten and its duplicate input is retained', async t => {
  const s = spies();
  const r = await rig(t, { readError: Object.assign(new Error('EBUSY'), { code: 'EBUSY' }), payload: { sessionId: other, command: 'replay' }, ctx: s.ctx });
  assert.equal(fs.readFileSync(r.output, 'utf8'), '{}');
  assert.equal(fs.existsSync(r.input), true);
  r.notify();
  await r.settle();
  assert.equal(r.publications(), 0);
  assertNoDuplicateEffects(s);
});

for (const [kind, variant] of [['versioned', payload], ['legacy for another target', { sessionId: other, command: 'replay to B' }]]) {
  test(`an uppercase ${kind} duplicate queues behind the active owner and cannot touch its result`, async t => {
    const s = spies();
    const gate = deferred();
    const reached = deferred();
    s.gate = gate.promise;
    s.onDispatch = reached.resolve;
    const r = await rig(t, { live: true, ctx: s.ctx });
    await reached.promise;
    const upper = path.join(r.dir, request.toUpperCase() + '.json');
    fs.writeFileSync(upper, JSON.stringify(variant));
    r.notifyFile(request.toUpperCase() + '.json');
    r.notifyFile(request.toUpperCase() + '.json');
    await r.settle();
    assert.equal(s.dispatches, 1, 'the variant is not a second owner');
    assert.equal(fs.existsSync(upper), true, 'the variant stays queued');
    assert.equal(fs.existsSync(r.output), false, 'the variant publishes no filename refusal while the owner is active');
    assert.equal(fs.existsSync(r.marker), true, "the active owner's marker is untouched");
    assert.equal(s.lookups.includes(other), false);

    const unrelated = '99999999-9999-4999-8999-999999999999';
    fs.writeFileSync(path.join(r.dir, unrelated + '.json'), JSON.stringify({ version: 1, action: 'open' }));
    r.notifyFile(unrelated + '.json');
    await until(() => fs.existsSync(path.join(r.dir, 'processed', unrelated + '.result.json')), 'an unrelated UUID progresses while the first ACK is held');
    assert.equal(fs.existsSync(upper), true);

    gate.resolve();
    await until(() => fs.existsSync(r.output), 'the owner commits its result');
    const first = fs.readFileSync(r.output);
    assert.equal(JSON.parse(first).reason, 'renderer refused');
    await until(() => !fs.existsSync(upper), 'the queued variant drains after release');
    fs.writeFileSync(r.input, JSON.stringify({ sessionId: other, command: 'late legacy duplicate' }));
    r.notify();
    r.notify();
    await until(() => !fs.existsSync(r.input), 'the late duplicate is removed');
    await r.settle();
    assert.deepEqual(fs.readFileSync(r.output), first);
    assert.equal(r.publications(), 1, 'exactly one terminal commit');
    assert.equal(s.dispatches, 1);
    assert.deepEqual(s.writes, []);
    assert.equal(s.lookups.includes(other), false);
  });
}
test('a committed result that appears while the owner waits is preserved at publication', async t => {
  const s = spies();
  const gate = deferred();
  const reached = deferred();
  s.gate = gate.promise;
  s.onDispatch = reached.resolve;
  const r = await rig(t, { live: true, ctx: s.ctx });
  await reached.promise;
  const external = JSON.stringify({ version: 1, action: 'open', ok: false, outcome: 'refused', reason: 'external', sessionId: id }) + '\n';
  fs.writeFileSync(r.output, external);
  gate.resolve();
  await until(() => !fs.existsSync(r.input), 'the owner finishes');
  await r.settle();
  assert.equal(fs.readFileSync(r.output, 'utf8'), external);
  assert.equal(r.publications(), 0);
  assert.equal(fs.existsSync(r.marker), false);
});
for (const failure of ['failPublish', 'failUnlink']) {
  test(`ownership is released after ${failure}: the queued variant is drained`, async t => {
    const s = spies();
    const gate = deferred();
    const reached = deferred();
    s.gate = gate.promise;
    s.onDispatch = reached.resolve;
    const r = await rig(t, { live: true, ctx: s.ctx, [failure]: true });
    await reached.promise;
    const upper = path.join(r.dir, request.toUpperCase() + '.json');
    fs.writeFileSync(upper, JSON.stringify(payload));
    r.notifyFile(request.toUpperCase() + '.json');
    await r.settle();
    assert.equal(fs.existsSync(upper), true);
    gate.resolve();
    if (failure === 'failUnlink') await until(() => !fs.existsSync(upper), 'the variant sees the committed result and is cleaned');
    else await until(() => r.errors.filter(entry => /publication failed/.test(entry[0])).length >= 2, 'the variant is processed once the owner released');
    assert.equal(s.dispatches, 1);
  });
}
test('startup scanning serializes case variants of one UUID into a single terminal commit', async t => {
  const s = spies();
  const r = await rig(t, { ctx: s.ctx, setup: ({ input }) => fs.writeFileSync(path.join(path.dirname(input), request.toUpperCase() + '.json'), JSON.stringify(payload)) });
  await until(() => !fs.existsSync(r.input) && !fs.existsSync(path.join(r.dir, request.toUpperCase() + '.json')), 'both variants are consumed');
  assert.equal(r.publications(), 1, 'one terminal commit for the canonical UUID');
  const first = fs.readFileSync(r.output);
  r.notifyFile(request.toUpperCase() + '.json');
  r.notify();
  await r.settle();
  assert.deepEqual(fs.readFileSync(r.output), first);
});
