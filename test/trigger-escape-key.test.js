'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../src/main/triggers/trigger-watcher');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const id = 'escape-session';

async function run(payload, options = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-escape-')));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const written = [];
  let writerStatus = options.writerStatus ?? options.status ?? 'waiting';
  let writerId = options.writerId ?? id;
  const ptyProcess = { pid: process.pid, write(data) {
    written.push(data);
    if (options.busyAfterWrite) writerStatus = 'busy';
  } };
  const session = { pty: ptyProcess, cwd: tmp, generation: 1, realSessionId: id,
    host: options.attachedRemote ? 'vps' : null, isAttach: options.attach, isPlainTerminal: options.plainTerminal };
  const desc = { status: options.status ?? 'waiting', statusUpdatedAt: Date.now() };
  const getCliStatus = () => {
    if (options.descriptorThrows) throw new Error('descriptor unreadable');
    return options.noDescriptor ? undefined : { ...desc };
  };
  const ctx = !options.missing && !options.remote && !options.dead ? createTriggerContext({
    activeSessions: new Map([[id, session]]), log: silent,
    getCliStatus, isPtyAlive: () => !options.dead,
    observeTabWriter: () => {
      if (options.descriptorThrows || options.observationThrows) throw new Error('descriptor unreadable');
      if (options.unsupportedObservation) return { supported: false };
      return { supported: true, writer: options.noDescriptor || options.noWriter ? null : { sessionId: writerId, status: writerStatus }, identity: 'p:1' };
    },
    cliSessionState: { deliveryPtyStart: () => null, findDeliveryTab: () => ({}), refreshProcessTable: async () => {} },
  }) : {
    log: silent,
    getPtyForSession: () => options.missing || options.remote ? null : { ptyProcess, cwd: tmp, session },
    getCliStatus,
    isSessionBusy: () => false,
    isPtyAlive: () => !options.dead,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  if (options.changeBeforeWrite) {
    const pin = ctx.pinDelivery;
    ctx.pinDelivery = (...args) => {
      const pinned = pin(...args);
      const beginStep = pinned.binding.beginStep;
      pinned.binding.beginStep = (...stepArgs) => {
        beginStep(...stepArgs);
        if (options.changeBeforeWrite === 'status') writerStatus = 'busy';
        else writerId = 'someone-else';
      };
      return pinned;
    };
  }
  ctx.remote = {
    lookup: () => options.remote ? { alias: 'vps', descriptor: { status: 'waiting' } } : null,
    send: () => { written.push('remote send'); throw new Error('unexpected remote send'); },
  };
  const watcher = start(ctx);
  try {
    const body = typeof payload === 'function' ? payload(tmp) : payload;
    for (let n = 0; n < (options.count ?? 1); n++) {
      fs.writeFileSync(path.join(tmp, `escape-${n}.json`), JSON.stringify({ sessionId: id, key: 'escape', ...body }));
    }
    const resultPaths = Array.from({ length: options.count ?? 1 }, (_, n) => path.join(tmp, 'processed', `escape-${n}.result.json`));
    const deadline = performance.now() + 5000;
    while (!resultPaths.every(resultPath => fs.existsSync(resultPath))) {
      assert.ok(performance.now() < deadline, 'result file must be produced');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = resultPaths.map(resultPath => JSON.parse(fs.readFileSync(resultPath, 'utf8')));
    return { result: results[0], results, written };
  } finally {
    watcher.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('waiting local session receives exactly one Escape without Enter', async () => {
  const { result, written } = await run({});
  assert.deepEqual(written, ['\x1b']);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(result.key, 'escape');
  assert.equal(result.sessionId, id);
});

for (const [name, options] of [
  ['unsupported observation', { unsupportedObservation: true }],
  ['plain terminal', { plainTerminal: true }],
]) {
  test(`${name} refuses Escape with an unsupported reason and no write`, async () => {
    const { result, written } = await run({}, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.reason, 'escape needs a session whose state can be observed here (unsupported on this platform or tab)');
  });
}

for (const status of ['idle', 'busy', 'shell']) {
  test(`${status} session refuses Escape with its current status`, async () => {
    const { result, written } = await run({}, { status });
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.reason, `session not waiting on a dialog (status: ${status})`);
  });
}

for (const [name, options, reason] of [
  ['unknown', { missing: true }, 'session not found'],
  ['remote without tab', { remote: true }, 'escape is not supported on remote sessions'],
  ['remote with tab', { attachedRemote: true }, 'escape is not supported on remote sessions'],
  ['dead', { dead: true }, 'target process not running'],
  ['missing descriptor', { noDescriptor: true }, 'session not waiting on a dialog (status: unknown)'],
  ['unreadable descriptor', { descriptorThrows: true }, 'session not waiting on a dialog (status: unknown)'],
]) {
  test(`${name} session refuses Escape without writing`, async () => {
    const { result, written } = await run({}, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.reason, reason);
  });
}

for (const [name, payload, reason] of [
  ['command', { command: 'hello' }, 'key and command are mutually exclusive'],
  ['enter', { key: 'enter' }, 'unsupported key: only "escape" is supported'],
  ['null', { key: null }, 'unsupported key: only "escape" is supported'],
  ['chain', { chain: [{ command: 'hello' }] }, 'key does not support chain'],
  ['wait none', { wait: 'none' }, 'key does not support wait'],
  ['wait idle', { wait: 'idle' }, 'key does not support wait'],
]) {
  test(`key with ${name} is refused without writing`, async () => {
    const { result, written } = await run(payload);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.reason, reason);
  });
}

test('command containing Escape still refuses forbidden control characters', async () => {
  const { result, written } = await run({ key: undefined, command: 'hello\x1b' }, { status: 'idle' });
  assert.deepEqual(written, []);
  assert.equal(result.ok, false);
  assert.match(result.error, /command contains forbidden control characters/);
});

test('real trigger context sends Escape through the pinned local PTY', async () => {
  const { result, written } = await run({}, { status: 'busy', writerStatus: 'waiting' });
  assert.deepEqual(written, ['\x1b']);
  assert.equal(result.ok, true);
});

test('fresh waiting writer ignores stale busy cache and preserves the key payload contract', async () => {
  const options = { status: 'busy', writerStatus: 'waiting' };
  for (const payload of [{}, cwd => ({ timeout_ms: 5000, expectedCwd: cwd })]) {
    const { result, written } = await run(payload, options);
    assert.deepEqual(written, ['\x1b']);
    assert.deepEqual(result, { ok: true, sessionId: id, key: 'escape', submitted: 'no', wrote: true, steps_total: 0 });
  }
  for (const key of ['Escape', '', 27, '\x1b', ['escape']]) {
    const { result, written } = await run({ key }, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.reason, 'unsupported key: only "escape" is supported');
  }
  const { result, written } = await run({ expectedCwd: 'C:/nowhere' }, options);
  assert.deepEqual(written, []);
  assert.equal(result.ok, false);
  assert.equal(result.submitted, 'no');
  assert.equal(result.targetMismatch, true);
});

for (const status of ['idle', 'busy', 'shell']) {
  test(`fresh ${status} writer refuses Escape despite cached waiting`, async () => {
    const { result, written } = await run({}, { writerStatus: status });
    assert.deepEqual(written, [], 'ESC must not reach a writer whose fresh descriptor is not waiting');
    assert.equal(result.wrote, false);
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.reason, `session not waiting on a dialog (status: ${status})`);
  });
}

for (const options of [{ noWriter: true }, { observationThrows: true }, { attach: true }]) {
  test(`cached waiting cannot replace a fresh writer observation: ${JSON.stringify(options)}`, async () => {
    const { result, written } = await run({}, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.reason, options.attach
      ? 'escape needs a session whose state can be observed here (unsupported on this platform or tab)'
      : 'session not waiting on a dialog (status: unknown)');
  });
}

test('an unrelated waiting writer cannot receive Escape through a direct session key', async () => {
  const { result, written } = await run({}, { writerId: 'someone-else' });
  assert.deepEqual(written, [], 'ESC requires ownership mine for the observed target writer');
  assert.equal(result.wrote, false);
  assert.equal(result.ok, false);
  assert.equal(result.submitted, 'no');
  assert.match(result.reason, /ownership/);
});

test('two queued Escape triggers re-read the writer after the first write', async () => {
  const { results, written } = await run({}, { count: 2, busyAfterWrite: true });
  assert.deepEqual(written, ['\x1b'], 'only the first queued Escape may reach the writer');
  assert.equal(results.filter(result => result.ok).length, 1);
  const refused = results.find(result => !result.ok);
  assert.equal(refused.submitted, 'no');
  assert.equal(refused.reason, 'session not waiting on a dialog (status: busy)');
});

for (const changeBeforeWrite of ['status', 'ownership']) {
  test(`the write re-check refuses a ${changeBeforeWrite} change after the initial key check`, async () => {
    const { result, written } = await run({}, { changeBeforeWrite });
    assert.deepEqual(written, [], 'the write must re-check the fresh writer after the initial key check');
    assert.equal(result.wrote, false);
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    if (changeBeforeWrite === 'status') assert.equal(result.reason, 'session not waiting on a dialog (status: busy)');
    else assert.match(result.reason, /ownership/);
  });
}
