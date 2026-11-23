'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const { fixture: openFixture, ID, STEM, project } = require('./fixtures/trigger-open.cjs');
const { fixture: stopFixture } = require('./fixtures/trigger-stop.cjs');

for (const mode of ['new', 'resume', 'stop']) {
  test(`${mode} renderer-not-ready refusal logs only action, requested name and reason`, async t => {
    const f = mode === 'stop' ? stopFixture(t) : openFixture();
    const logs = [];
    const actions = createTriggerActions({ log: { info: (...args) => logs.push(args) } });
    f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'renderer not ready' });
    f.ctx.lifecycle.broker.waitForReady = async () => ({ ok: false, reason: 'renderer not ready' });
    const trigger = { version: 1, action: mode === 'stop' ? 'stop' : 'open',
      ...(mode === 'new' ? { new: { project, name: '  Task "1123"  ' } } : { sessionId: ID }),
      ...(mode !== 'stop' ? { prompt: 'secret prompt never logged' } : {}) };
    const result = await actions.execute(trigger, STEM, f.execution);
    assert.equal(result.reason, 'renderer not ready');
    assert.deepEqual(logs, [[`[trigger-watcher] v1 action refused: ${JSON.stringify({
      action: trigger.action, requestedName: mode === 'new' ? 'Task "1123"' : null, reason: 'renderer not ready',
    })}`]]);
  });
}

test('other refusals produce no renderer-not-ready info line', async () => {
  const f = openFixture();
  const logs = [];
  const actions = createTriggerActions({ log: { info: (...args) => logs.push(args) } });
  f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'renderer unavailable' });
  assert.equal((await actions.execute({ version: 1, action: 'open', sessionId: ID }, STEM, f.execution)).reason, 'renderer unavailable');
  assert.deepEqual(logs, []);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { extractFunction } = require('./app-source');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const { resolveProject } = require('../src/main/triggers/trigger-actions');
const { validateTriggerOpen } = require('../src/main/triggers/trigger-launch');

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
async function tick(t, ms) { t.mock.timers.tick(ms); await flush(); }
const snapshot = () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} });

function retryRig(t, lookup, timeout = 9000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const f = openFixture();
  const logs = [], times = [];
  f.execution.deadline = Date.now() + timeout;
  f.ctx.lifecycle.getProjectSnapshot = async () => { times.push(Date.now() - 10000); return lookup(times.length); };
  const actions = createTriggerActions({ log: { info: line => logs.push(line) } });
  const trigger = { version: 1, action: 'open', new: { project, name: 'Task' }, prompt: 'hello', timeout_ms: timeout };
  const run = () => actions.execute(trigger, STEM, f.execution);
  return { ...f, actions, trigger, run, logs, times };
}
const conflict = () => { throw Object.assign(new Error('project lookup unavailable'), { code: 'PROJECTS_SNAPSHOT_CONFLICT', reason: 'db', transient: true }); };

for (const kind of ['conflict', 'stale', 'transient error']) {
  test(`${kind} then a consistent project snapshot opens within the action deadline`, async t => {
    const f = retryRig(t, n => n > 1 ? snapshot() : kind === 'conflict' ? conflict()
      : kind === 'stale' ? { ...snapshot(), projectsStale: true }
        : { projectsError: { transient: true, reason: 'worker' } });
    let result;
    const pending = f.run().then(value => { result = value; });
    await flush();
    assert.equal(result, undefined, 'a transient project lookup must remain pending');
    await tick(t, 249);
    assert.deepEqual(f.times, [0], 'no lookup before the 250 ms backoff');
    await tick(t, 1); await pending;
    assert.equal(result.outcome, 'opened');
    assert.deepEqual(f.times, [0, 250]);
    assert.deepEqual(f.logs, [], 'recovery does not log a refusal');
  });
}

test('conflicts consume capped backoffs and refuse only at the deadline with one diagnostic', async t => {
  const f = retryRig(t, conflict);
  let result;
  const pending = f.run().then(value => { result = value; });
  await flush();
  assert.equal(result, undefined, 'a conflict must not refuse before the deadline');
  for (const ms of [250, 500, 1000, 2000, 2000, 2000, 1249]) await tick(t, ms);
  assert.equal(result, undefined, 'the final partial backoff uses the remaining deadline');
  assert.deepEqual(f.times, [0, 250, 750, 1750, 3750, 5750, 7750]);
  await tick(t, 1); await pending;
  assert.equal(result.reason, 'project lookup unavailable');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.created, false);
  assert.deepEqual(f.logs, ['[trigger] project lookup unavailable after 7 lookups (last: db)']);
  await tick(t, 10000);
  assert.equal(f.times.length, 7, 'no lookup at or after the deadline');
});

test('a consistent unknown project refuses immediately without retrying', async t => {
  const f = retryRig(t, () => ({ ...snapshot(), allProjects: [] }));
  assert.equal((await f.run()).reason, 'unknown project');
  assert.deepEqual(f.times, [0]);
  assert.deepEqual(f.logs, []);
});

test('a stalled first project read retains session action timed out', async t => {
  const f = retryRig(t, () => new Promise(() => {}), 100);
  const pending = f.run(); await flush(); await tick(t, 100);
  assert.equal((await pending).reason, 'session action timed out');
  assert.deepEqual(f.logs, []);
});

test('a committed then rolled-back shutdown cancels the waiting action permanently', async t => {
  const f = retryRig(t, conflict);
  let valid = true;
  f.ctx.lifecycle.captureAuthority = () => ({ valid: () => valid });
  let result;
  const pending = f.run().then(value => { result = value; }); await flush();
  assert.equal(result, undefined, 'shutdown must interrupt an action still waiting');
  valid = false;
  await tick(t, 50);
  assert.equal(result?.reason, 'Switchboard is closing.');
  await pending; await tick(t, 10000);
  assert.deepEqual(f.times, [0]);
  assert.deepEqual(f.logs, []);
});

function watcherRig(t, f) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-project-retry-'));
  let notify;
  const filename = path.resolve(__dirname, '../src/main/triggers/trigger-watcher.js');
  const nativeRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    require: name => name === 'fs' ? { ...fs, watch: (_dir, _opts, callback) => {
      notify = callback; return { on() {}, close() {} };
    } } : nativeRequire(name),
    process: { env: { ...process.env, SWITCHBOARD_TRIGGERS_DIR: dir }, platform: process.platform, pid: process.pid },
    Buffer, console, Date, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
  }, { filename });
  const watcher = module.exports.start({ ...f.ctx, sessionRequests: createJournal(),
    log: { info: line => f.logs.push(line), warn() {}, error() {} } });
  t.after(() => { watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = id => path.join(dir, id + '.json');
  return { watcher, input,
    write(id, trigger) { fs.writeFileSync(input(id), JSON.stringify(trigger)); notify('rename', id + '.json'); },
    result(id) { const file = path.join(dir, 'processed', id + '.result.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; },
  };
}

test('the watcher publishes a second trigger while the first waits for its project', async t => {
  const f = retryRig(t, conflict), w = watcherRig(t, f);
  w.write(STEM, f.trigger); await flush();
  const other = '31234567-89ab-cdef-0123-456789abcdef';
  w.write(other, { version: 1, action: 'open', sessionId: ID }); await flush();
  assert.equal(w.result(other)?.outcome, 'opened', 'the unrelated action must complete without advancing the clock');
  assert.equal(w.result(STEM), null, 'the conflicting action must still be pending');
  w.watcher.close(); await flush();
  assert.equal(w.result(STEM)?.reason, 'Switchboard is closing.', 'watcher close cancels the pending timer');
  await tick(t, 10000); assert.deepEqual(f.times, [0]);
});

for (const kind of ['replaced', 'removed']) test(`a ${kind} trigger stops retrying`, async t => {
  const f = retryRig(t, conflict), w = watcherRig(t, f);
  w.write(STEM, f.trigger); await flush();
  assert.equal(w.result(STEM), null, 'the original request must be waiting before supersession');
  if (kind === 'removed') fs.unlinkSync(w.input(STEM));
  else fs.writeFileSync(w.input(STEM), JSON.stringify({ ...f.trigger, prompt: 'replacement' }));
  await tick(t, 50);
  assert.equal(w.result(STEM)?.reason, 'trigger changed or was cancelled');
  await tick(t, 1000); assert.deepEqual(f.times, [0], 'the superseded request does no more project lookups');
});

test('main snapshot marks conflicts, stale rows and provenance changes retryable and preserves the reason', async () => {
  const filename = path.resolve(__dirname, '../main.js'), source = fs.readFileSync(filename, 'utf8');
  for (const kind of ['conflict', 'stale', 'settings']) {
    let settings = {};
    const context = vm.createContext({ structuredClone, getSetting: () => settings, getProjectsSnapshot: async () => {
      if (kind === 'settings') settings = { hiddenProjects: [project] };
      return kind === 'conflict' ? { projectsError: { code: 'PROJECTS_SNAPSHOT_CONFLICT', reason: 'db' } }
        : { ...snapshot(), projectsStale: kind === 'stale' };
    } });
    vm.runInContext(extractFunction(source, 'getTriggerProjectSnapshot'), context, { filename });
    await assert.rejects(context.getTriggerProjectSnapshot(), error => {
      assert.equal(error.transient, true, 'unavailable snapshots need retryable metadata');
      assert.equal(error.reason, kind === 'conflict' ? 'db' : kind);
      return true;
    });
  }
});

test('final launch validation preserves lookup exhaustion instead of replacing it with an action timeout', async t => {
  const f = retryRig(t, conflict, 100);
  const permit = { mode: 'new', project, tabKey: ID, requestId: STEM, deadline: f.execution.deadline };
  const deps = { ...f.ctx.lifecycle, resolveProject, log: { info: line => f.logs.push(line) }, broker: { checkPermit: () => true } };
  const pending = validateTriggerOpen(permit, deps); await flush(); await tick(t, 100);
  assert.equal((await pending).reason, 'project lookup unavailable');
  assert.deepEqual(f.logs, ['[trigger] project lookup unavailable after 1 lookups (last: db)']);
});
