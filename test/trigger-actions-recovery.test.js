'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '200';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { makeWorld, startWatcher, tempRoot, ID_A, ID_B } = require('./helpers/trigger-world');

function layout(t) {
  const root = tempRoot(t);
  const triggers = path.join(root, 'triggers');
  const processed = path.join(triggers, 'processed');
  fs.mkdirSync(processed, { recursive: true });
  return { root, triggers, processed };
}

function countingBridge(world, calls) {
  return {
    waitReady: async () => ({ ok: true }),
    async ensureOpen(op) {
      calls.push(op.mode);
      if (op.mode === 'reattach') return { ok: true, generation: op.generation, spawned: false };
      const session = world.addSession(op.tabKey);
      world.statuses.set(op.tabKey, { status: 'idle', statusUpdatedAt: Date.now() + 5 });
      return { ok: true, generation: session.generation, spawned: true, launchStartedAt: Date.now() };
    },
  };
}

const marker = (uuid, fields) => ({ version: 1, uuid, action: 'open', mode: 'resume', sessionId: ID_A, tabKey: ID_A, stepsTotal: 1, deadline: Date.now() + 1000, phase: 'claimed', evidence: {}, ...fields });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('an interrupted action is reported as uncertain at every phase and never replayed', async t => {
  for (const [phase, evidence, flags] of [
    ['claimed', {}, { resumed: false }],
    ['spawned', { resumed: true, generation: 1 }, { resumed: true }],
    ['prompt-attempted', { resumed: true }, { resumed: true }],
    ['stop-requested', {}, {}],
  ]) {
    const dirs = layout(t);
    const uuid = randomUUID();
    const stop = phase === 'stop-requested';
    fs.writeFileSync(path.join(dirs.triggers, `${uuid}.json`), JSON.stringify({ version: 1, action: stop ? 'stop' : 'open', sessionId: ID_A, prompt: 'again' }));
    fs.writeFileSync(path.join(dirs.processed, `${uuid}.action.json`), JSON.stringify(marker(uuid, { phase, evidence, ...(stop ? { action: 'stop', mode: 'stop' } : {}) })));
    const world = makeWorld();
    const calls = [];
    const watcher = startWatcher(t, world, { bridge: countingBridge(world, calls) }, dirs.root);
    const result = await watcher.waitResult(uuid);
    assert.equal(result.outcome, 'refused', phase);
    assert.equal(result.reason, 'interrupted by restart', phase);
    assert.equal(result.uncertain, true, phase);
    assert.equal(result.sessionId, ID_A, phase);
    for (const [flag, value] of Object.entries(flags)) assert.equal(result[flag], value, `${phase} ${flag}`);
    assert.deepEqual(calls, [], phase);
    assert.deepEqual(world.writes, [], phase);
    assert.equal(fs.existsSync(path.join(dirs.triggers, `${uuid}.json`)), false, phase);
    assert.equal(fs.existsSync(path.join(dirs.processed, `${uuid}.action.json`)), false, phase);
    watcher.watcher.close();
  }
});

test('an orphan marker without its input is still settled, and a new session keeps its reserved id', async t => {
  const dirs = layout(t);
  const uuid = randomUUID();
  fs.writeFileSync(path.join(dirs.processed, `${uuid}.action.json`), JSON.stringify(marker(uuid, { mode: 'new', sessionId: null, tabKey: ID_B, phase: 'spawned', evidence: { created: true } })));
  const watcher = startWatcher(t, makeWorld(), {}, dirs.root);
  const result = await watcher.waitResult(uuid);
  assert.equal(result.reason, 'interrupted by restart');
  assert.equal(result.sessionId, ID_B);
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(path.join(dirs.processed, `${uuid}.action.json`)), false);
});

test('a result that already exists is immutable and only the leftovers are cleaned', async t => {
  const dirs = layout(t);
  const uuid = randomUUID();
  const original = { version: 1, action: 'open', ok: true, outcome: 'opened', reason: null, sessionId: ID_A };
  fs.writeFileSync(path.join(dirs.processed, `${uuid}.result.json`), JSON.stringify(original));
  fs.writeFileSync(path.join(dirs.processed, `${uuid}.action.json`), JSON.stringify(marker(uuid, {})));
  fs.writeFileSync(path.join(dirs.triggers, `${uuid}.json`), JSON.stringify({ version: 1, action: 'open', sessionId: ID_A, prompt: 'replay' }));
  const world = makeWorld();
  const calls = [];
  const watcher = startWatcher(t, world, { bridge: countingBridge(world, calls) }, dirs.root);
  const end = Date.now() + 3000;
  while (fs.existsSync(path.join(dirs.triggers, `${uuid}.json`)) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(readJson(path.join(dirs.processed, `${uuid}.result.json`)), original);
  assert.equal(fs.existsSync(path.join(dirs.processed, `${uuid}.action.json`)), false);
  assert.deepEqual(calls, []);
  void watcher;
});

test('the same request uuid yields one lifecycle action and one terminal result', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  const calls = [];
  const watcher = startWatcher(t, world, { bridge: countingBridge(world, calls), resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project' }) }, dirs.root);
  const uuid = randomUUID();
  const first = await watcher.submit({ version: 1, action: 'open', sessionId: ID_A }, uuid);
  assert.equal(first.outcome, 'opened');
  fs.writeFileSync(path.join(dirs.triggers, `${uuid}.json`), JSON.stringify({ version: 1, action: 'open', sessionId: ID_B, prompt: 'changed payload' }));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(calls, ['resume']);
  assert.deepEqual(readJson(watcher.resultOf(uuid)), first);
  assert.equal(fs.existsSync(path.join(dirs.triggers, `${uuid}.json`)), false);
});

test('an uppercase request filename is refused rather than executed', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  const calls = [];
  const watcher = startWatcher(t, world, { bridge: countingBridge(world, calls) }, dirs.root);
  const upper = randomUUID().toUpperCase();
  const result = await watcher.submit({ version: 1, action: 'open', sessionId: ID_A }, upper);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'trigger filename must be a lowercase UUID');
  assert.deepEqual(calls, []);
});

test('a failed result publication keeps the input and the marker and suppresses replay', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  const calls = [];
  const bridge = countingBridge(world, calls);
  const ensure = bridge.ensureOpen;
  bridge.ensureOpen = async op => { const out = await ensure(op); fs.chmodSync(dirs.processed, 0o500); return out; };
  const watcher = startWatcher(t, world, { bridge, resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project' }) }, dirs.root);
  const uuid = randomUUID();
  fs.writeFileSync(path.join(dirs.triggers, `${uuid}.json`), JSON.stringify({ version: 1, action: 'open', sessionId: ID_A }));
  const end = Date.now() + 3000;
  while (calls.length === 0 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 600));
  fs.chmodSync(dirs.processed, 0o700);
  assert.equal(fs.existsSync(path.join(dirs.processed, `${uuid}.result.json`)), false);
  assert.equal(fs.existsSync(path.join(dirs.triggers, `${uuid}.json`)), true, 'the input survives');
  assert.equal(fs.existsSync(path.join(dirs.processed, `${uuid}.action.json`)), true, 'the marker survives');
  assert.deepEqual(calls, ['resume']);
  void watcher;
});

test('a marker that cannot be saved refuses the action before any side effect', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  const calls = [];
  const watcher = startWatcher(t, world, { bridge: countingBridge(world, calls), resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project' }) }, dirs.root);
  const uuid = randomUUID();
  fs.mkdirSync(path.join(dirs.processed, `${uuid}.action.json.tmp`));
  const result = await watcher.submit({ version: 1, action: 'open', sessionId: ID_A }, uuid);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'action state could not be saved');
  assert.deepEqual(calls, []);
  assert.equal(result.resumed, false);
});

test('an aged duplicate input cannot overwrite its committed v1 result', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  world.addSession(ID_A);
  const watcher = startWatcher(t, world, {}, dirs.root);
  const uuid = randomUUID();
  const request = { version: 1, action: 'open', sessionId: ID_A };
  await watcher.submit(request, uuid);
  const first = fs.readFileSync(watcher.resultOf(uuid), 'utf8');
  const temp = path.join(watcher.triggers, uuid + '.tmp');
  fs.writeFileSync(temp, JSON.stringify(request));
  const old = new Date(Date.now() - 700000);
  fs.utimesSync(temp, old, old);
  fs.renameSync(temp, path.join(watcher.triggers, uuid + '.json'));
  const end = Date.now() + 3000;
  while (fs.existsSync(path.join(watcher.triggers, uuid + '.json')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(watcher.resultOf(uuid), 'utf8'), first);
});

test('a legacy payload under a completed v1 request uuid is not executed and does not replace the result', async t => {
  const dirs = layout(t);
  const world = makeWorld();
  world.addSession(ID_A);
  const watcher = startWatcher(t, world, {}, dirs.root);
  const uuid = randomUUID();
  await watcher.submit({ version: 1, action: 'open', sessionId: ID_A }, uuid);
  const first = fs.readFileSync(watcher.resultOf(uuid), 'utf8');
  fs.writeFileSync(path.join(watcher.triggers, uuid + '.tmp'), JSON.stringify({ sessionId: ID_A, command: 'replayed' }));
  fs.renameSync(path.join(watcher.triggers, uuid + '.tmp'), path.join(watcher.triggers, uuid + '.json'));
  const end = Date.now() + 3000;
  while (fs.existsSync(path.join(watcher.triggers, uuid + '.json')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(watcher.resultOf(uuid), 'utf8'), first);
  assert.deepEqual(world.writes, []);
});

test('non-object JSON under a request uuid gets the specified shape refusal', async t => {
  const dirs = layout(t);
  const watcher = startWatcher(t, makeWorld(), {}, dirs.root);
  for (const body of [null, [], 3, 'text']) {
    const result = await watcher.submit(body);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, 'trigger must be an object');
    assert.equal(result.version, null);
    assert.equal(result.action, null);
  }
});
