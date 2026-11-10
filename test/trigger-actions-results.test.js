'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const { createHash } = require('node:crypto');

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
  const body = JSON.stringify(Object.hasOwn(options, 'payload') ? options.payload : payload);
  if (!options.orphan && !options.live) fs.writeFileSync(input, body);
  if (!options.live) options.setup?.({ input, output, marker });
  if (options.stale && !options.orphan) fs.utimesSync(input, new Date(0), new Date(0));
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
  const watcher = module.exports.start({ sessionRequests: createJournal(), log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    getPtyForSession() { return null; }, isSessionBusy: () => false, ...options.ctx });
  t.after(() => { watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (options.live) {
    options.setup?.({ input, output, marker });
    fs.writeFileSync(input, body);
    notify('rename', name + '.json');
  }
  async function settle() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  return { input, output, marker, body, events, errors, publications: () => publications, recoveryReads: () => recoveryReads, notify: () => notify('rename', request + '.json'), settle };
}

for (const state of ['result', 'marker']) {
  test(`uppercase v1 preserves an unjournalled ${state} and archives the colliding input`, async t => {
    const r = await rig(t, { name: request.toUpperCase(), live: true,
      setup({ output, marker }) {
        fs.writeFileSync(state === 'result' ? output : marker, JSON.stringify({ ...payload, mode: 'resume' }));
      },
    });
    assert.equal(fs.existsSync(r.input), false);
    assert.ok(fs.readdirSync(path.dirname(r.output)).some(name => name.endsWith('.request')), 'unknown pre-upgrade identity cannot authorize ordinary publication');
    if (state === 'result') assert.deepEqual(JSON.parse(fs.readFileSync(r.output, 'utf8')), { ...payload, mode: 'resume' });
    else assert.equal(JSON.parse(fs.readFileSync(r.output, 'utf8')).reason, 'interrupted by restart');
    assert.ok(fs.readdirSync(path.dirname(r.output)).includes(request + '.result.json'));
  });
  for (const [live, name] of [true, false].flatMap(live => [request.toUpperCase(), request].map(name => [live, name]))) {
    test(`legacy ${name} preserves pre-upgrade v1 ${state}; ${live ? 'live' : 'startup'}`, async t => {
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
      assert.deepEqual(written, [], 'an occupied namespace must prevent legacy delivery');
      assert.ok(fs.existsSync(r.output), 'pre-upgrade state is preserved or reconciled');
      assert.ok(fs.readdirSync(path.dirname(legacyOutput)).some(file => file.startsWith(name + '.conflict-') && file.endsWith('.request')));
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
      test(`unreadable pre-upgrade ${failure} on ${errorOnMarker ? 'marker' : 'result'} retains legacy=${legacy}`, async t => {
        const readError = failure === 'SyntaxError' ? new SyntaxError('corrupt JSON') : Object.assign(new Error(failure), { code: failure });
        const r = await rig(t, { readError, errorOnMarker, payload: legacy ? {} : payload });
        assert.deepEqual(fs.readFileSync(r.input, 'utf8'), r.body, 'unreadable ownership cannot authorize cleanup');
        assert.equal(r.publications(), 0, 'guard failure cannot publish a generic fallback');
      });
    }
  }
}

test('a real oversized marker retains input without a fallback result', async t => {
  const r = await rig(t, { setup: ({ marker }) => fs.writeFileSync(marker, ' '.repeat(65537)) });
  assert.equal(fs.existsSync(r.input), true);
  assert.equal(fs.existsSync(r.output), false);
});

test('a real corrupt marker prevents legacy validation from publishing over uncertain ownership', async t => {
  const r = await rig(t, { payload: {}, setup: ({ marker }) => fs.writeFileSync(marker, '{broken') });
  assert.equal(fs.existsSync(r.input), true);
  assert.equal(fs.existsSync(r.output), false);
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
  assert.equal(fs.existsSync(r.output), false);
  assert.equal(fs.existsSync(r.input), true);
});

test('a legacy result without version still owns its pre-upgrade namespace', async t => {
  const r = await rig(t, { prior: { ok: true, sessionId: id, submitted: 'confirmed' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.output, 'utf8')), { ok: true, sessionId: id, submitted: 'confirmed' });
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

test('v1 publishes once and archives a different action reusing the UUID without changing the result', async t => {
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
  const raw = JSON.stringify({ ...payload, action: 'stop' });
  const base = request + '.conflict-' + createHash('sha256').update(raw).digest('hex');
  assert.equal(fs.readFileSync(path.join(path.dirname(r.output), base + '.request'), 'utf8'), raw);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(r.output), base + '.result.json'), 'utf8')).reason, 'request id conflict');
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
  assert.equal(fs.existsSync(r.marker), true, 'unknown pre-upgrade input identity cannot clean an unrelated marker');
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
    assert.equal(fs.existsSync(r.marker), !orphan, 'a colliding input cannot clean the pre-upgrade marker');
  });
}

test('v1 input deletion failure retains immutable result and suppresses extra publication', async t => {
  const r = await rig(t, { failUnlink: true });
  assert.equal(fs.existsSync(r.input), true);
  r.notify();
  await r.settle();
  assert.equal(r.publications(), 1);
});
