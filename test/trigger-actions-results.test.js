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
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v1-results-')));
  const processed = path.join(dir, 'processed');
  fs.mkdirSync(processed);
  const input = path.join(dir, request + '.json');
  const output = path.join(processed, request + '.result.json');
  const marker = path.join(processed, request + '.action.json');
  if (options.prior) fs.writeFileSync(output, JSON.stringify(options.prior) + '\n');
  if (options.marker) fs.writeFileSync(marker, JSON.stringify(options.marker));
  if (!options.orphan) fs.writeFileSync(input, JSON.stringify(payload));
  if (options.stale && !options.orphan) fs.utimesSync(input, new Date(0), new Date(0));
  let notify;
  let publications = 0;
  const events = [];
  const errors = [];
  const filename = path.resolve(__dirname, '../src/main/triggers/trigger-watcher.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const fakeFs = { ...fs,
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
