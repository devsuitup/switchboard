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
  if (!options.orphan) fs.writeFileSync(input, JSON.stringify(Object.hasOwn(options, 'payload') ? options.payload : payload));
  options.setup?.({ input, output, marker });
  if (options.stale && !options.orphan) fs.utimesSync(input, new Date(0), new Date(0));
  let notify;
  let publications = 0;
  const events = [];
  const errors = [];
  const filename = path.resolve(__dirname, '../src/main/triggers/trigger-watcher.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const fakeFs = { ...fs,
    readFileSync(file, ...args) {
      if (options.readError && file === (options.errorOnMarker ? marker : output)) throw options.readError;
      return fs.readFileSync(file, ...args);
    },
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
  const watcher = module.exports.start({ log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    getPtyForSession() { return null; }, isSessionBusy: () => false });
  t.after(() => { watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function settle() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  return { input, output, marker, events, errors, publications: () => publications, notify: () => notify('rename', request + '.json'), settle };
}

for (const location of ['output', 'marker']) {
  for (const kind of ['oversize', 'directory', 'symlink']) {
    test(`recovery rejects ${kind} ${location} before reading`, () => {
      const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
      let reads = 0;
      const actions = createTriggerActions({ fs: {
        lstatSync(file) {
          if (file !== location) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return { isFile: () => kind === 'oversize', size: kind === 'oversize' ? 65537 : 0 };
        },
        readFileSync() { reads++; throw new Error('unsafe read attempted'); },
      } });
      assert.throws(() => actions.readState('output', 'marker'));
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
  const actions = createTriggerActions({ fs: { ...fs, readFileSync() { reads++; throw new Error('FIFO opened'); } } });
  assert.throws(() => actions.readState(fifo, path.join(dir, 'missing')));
  assert.equal(reads, 0, 'FIFO must be rejected by lstat without opening it');
});

for (const errorOnMarker of [false, true]) {
  for (const failure of ['SyntaxError', 'EISDIR', 'EBUSY']) {
    for (const legacy of [true, false]) {
      test(`recovery ${failure} on ${errorOnMarker ? 'marker' : 'result'} lets legacy=${legacy} finish`, async t => {
        const readError = failure === 'SyntaxError' ? new SyntaxError('corrupt JSON') : Object.assign(new Error(failure), { code: failure });
        const r = await rig(t, { readError, errorOnMarker, payload: legacy ? {} : payload });
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
  fs.writeFileSync(r.input, JSON.stringify({ sessionId: id, command: 'do not route to legacy' }));
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
