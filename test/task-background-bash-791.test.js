'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const id = '11111111-1111-4111-8111-111111111111';
const shellId = 'bx5kzi3xp';
const use = (toolId = 'toolu_bash1', at = '2026-10-26T10:00:00.000Z') => ({ uuid: 'use-' + toolId, type: 'assistant', timestamp: at,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } });
const result = (toolId = 'toolu_bash1', at = '2026-10-26T10:00:01.000Z', extra = {}, block = {}) => ({ uuid: 'result-' + toolId, type: 'user', timestamp: at,
  toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: shellId, ...extra },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Command running in background with ID: ' + shellId, ...block }] } });
const NL = String.fromCharCode(10);
const envelope = (taskId, toolId, status = 'completed') => ['<task-notification>', '<task-id>' + taskId + '</task-id>',
  ...(toolId ? ['<tool-use-id>' + toolId + '</tool-use-id>'] : []),
  '<output-file>' + ['C:', 'Temp', 'claude', 'project', id, 'tasks', taskId + '.output'].join(path.win32.sep) + '</output-file>',
  '<status>' + status + '</status>', '<summary>Background command "sleep 600" ' + status + '</summary>', '</task-notification>'].join(NL);
const done = (taskId = shellId, toolId = 'toolu_bash1', at = '2026-10-26T10:10:00.000Z') => ({ uuid: 'done-' + taskId + '-' + toolId, type: 'user', timestamp: at,
  message: { role: 'user', content: envelope(taskId, toolId) }, origin: { kind: 'task-notification' } });
const queued = (taskId = shellId, at = '2026-10-26T10:10:00.000Z') => ({ uuid: 'queued-' + taskId, type: 'attachment', timestamp: at,
  attachment: { type: 'queued_command', prompt: envelope(taskId, null), origin: { kind: 'task-notification' } } });
const stop = (name, field, ok, at = '2026-10-26T10:05:00.000Z') => [
  { uuid: 'stop-' + name, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + name, name, input: { [field]: shellId } }] } },
  { uuid: 'stopped-' + name, type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + name, content: 'x', ...(ok ? {} : { is_error: true }) }] } },
];
function launched(options) {
  const r = createTaskRegistry(options);
  r.ingest(id, use());
  r.ingest(id, result());
  return r;
}

test('a background Bash launch is background work and never a running subagent, in the worker and the renderer registry', () => {
  const r = launched();
  assert.equal(r.background(id), true);
  assert.deepEqual(r.list(id).map(t => [t.id, t.kind]), [[shellId, 'bash']]);
  assert.equal(r.agents(id).length, 0);
  assert.equal(r.runningAgentCount([id]), 0);
  const renderer = createTaskRegistry();
  renderer.applySnapshot(r.snapshot(id));
  assert.equal(renderer.background(id), true);
  assert.equal(renderer.agents(id).length, 0);
});

for (const [name, entry] of [['with tool-use-id', done()], ['without tool-use-id', done(shellId, null)], ['as a queued attachment', queued()]]) {
  test('the matching terminal notification ' + name + ' ends the background Bash', () => {
    const r = launched();
    assert.equal(r.background(id), true);
    r.ingest(id, entry);
    assert.equal(r.background(id), false);
  });
}

test('a notification recorded before its launch result still ends the Bash', () => {
  const r = createTaskRegistry();
  r.ingest(id, use());
  r.ingest(id, done(shellId, 'toolu_bash1', '2026-10-26T10:00:00.500Z'));
  r.ingest(id, result());
  assert.equal(r.background(id), false);
  assert.deepEqual(r.snapshot(id).tasks.map(t => [t.id, t.kind, t.terminal]), [['bx5kzi3xp', 'bash', true]]);
});

test('a foreground result, an errored launch and an unrelated notification open or end nothing', () => {
  const foreground = createTaskRegistry();
  foreground.ingest(id, use());
  foreground.ingest(id, result(undefined, undefined, { backgroundTaskId: undefined }));
  assert.equal(foreground.background(id), false);
  const errored = createTaskRegistry();
  errored.ingest(id, use());
  errored.ingest(id, result(undefined, undefined, {}, { is_error: true }));
  assert.equal(errored.background(id), false);
  const ambiguous = createTaskRegistry();
  ambiguous.ingest(id, use());
  const multiple = result();
  multiple.message.content.push({ type: 'tool_result', tool_use_id: 'toolu_other', content: 'x' });
  ambiguous.ingest(id, multiple);
  assert.equal(ambiguous.background(id), false);
  const invalid = createTaskRegistry();
  invalid.ingest(id, use());
  invalid.ingest(id, result(undefined, undefined, { backgroundTaskId: 'BX-1' }));
  assert.equal(invalid.background(id), false);
  const mixed = createTaskRegistry();
  mixed.ingest(id, use());
  mixed.ingest(id, result(undefined, undefined, { agentId: 'agent1' }));
  assert.equal(mixed.background(id), false);
  const agent = createTaskRegistry();
  agent.ingest(id, result(undefined, undefined, { agentId: 'agent1', isAsync: true, status: 'async_launched' }));
  assert.equal(agent.background(id), false);
  const agentUse = use();
  agentUse.message.content[0].name = 'Agent';
  agent.ingest(id, agentUse);
  assert.equal(agent.agents(id).length, 1);
  assert.equal(agent.snapshot(id).tasks.filter(t => t.kind === 'bash').length, 0);
  const r = launched();
  r.ingest(id, done('bother1', 'toolu_other'));
  r.ingest(id, done('bother2', null));
  assert.equal(r.background(id), true);
});

for (const [name, field] of [['TaskStop', 'task_id'], ['KillShell', 'shell_id']]) {
  test('a successful ' + name + ' ends the background Bash and a failed one does not', () => {
    const failed = launched();
    for (const e of stop(name, field, false)) failed.ingest(id, e);
    assert.equal(failed.background(id), true);
    const r = launched();
    for (const e of stop(name, field, true)) r.ingest(id, e);
    assert.equal(r.background(id), false);
  });
}

test('owner death ends the Bash; a restarted owner ends a Bash launched before it started and refuses its replay', () => {
  const dead = launched();
  assert.equal(dead.background(id), true);
  dead.ownerDied(id);
  assert.equal(dead.background(id), false);
  const earlier = launched();
  earlier.ownerAlive(id, { startedAt: Date.parse('2026-10-26T09:00:00.000Z') });
  assert.equal(earlier.background(id), true, 'a Bash launched by the current owner keeps running');
  const restarted = launched();
  restarted.ownerAlive(id, { startedAt: Date.parse('2026-10-26T11:00:00.000Z') });
  assert.equal(restarted.background(id), false);
  const replay = createTaskRegistry();
  replay.ownerAlive(id, { startedAt: Date.parse('2026-10-26T11:00:00.000Z') });
  replay.ingest(id, use());
  replay.ingest(id, result());
  assert.equal(replay.background(id), false);
});

test('the worker client forwards the owner start time', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bash-791-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, [use(), result()].map(e => JSON.stringify(e)).join(NL) + NL);
  const renderer = createTaskRegistry();
  const client = createTaskRecordsClient({ onSnapshot: s => renderer.applySnapshot(s) });
  t.after(() => client.dispose());
  await client.read(file, id);
  assert.equal(renderer.background(id), true);
  await client.ownerAlive(id, Date.parse('2026-10-26T11:00:00.000Z'));
  assert.equal(renderer.background(id), false);
});

test('main forwards the descriptor start time with an owner identity change', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').split(String.fromCharCode(13)).join('');
  const start = source.indexOf('cliSessionState.onStatusesChanged(');
  const end = source.indexOf(NL + '});', start) + 4;
  let callback;
  const live = [];
  const ctx = vm.createContext({ notifyRendererProjectsChanged() {}, sessionTransitions: { detectPendingBackgroundContinuations() {} },
    taskOwnerLiveness: new Map(), taskRecords: { ownerAlive: (sid, startedAt) => live.push([sid, startedAt]) },
    cliSessionState: { onStatusesChanged: cb => { callback = cb; }, getSidebarDescriptors: () => [{ sessionId: 'owner', pid: 12, startedAt: 1234 }] } });
  vm.runInContext(source.slice(start, end), ctx);
  callback();
  assert.deepEqual(live, [['owner', 1234]]);
});

test('an interactive row at rest with a running background Bash shows the background-work glyph, then the waiting ring once it ends', t => {
  const ctx = setupSidebarDom();
  t.after(ctx.destroy);
  const row = { sessionId: id, status: 'busy', modified: new Date().toISOString() };
  ctx.window.sessionMap.set(id, row);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
  const glyph = () => ctx.document.querySelector('.session-item[data-session-id="' + id + '"] .session-icon').dataset.glyph;
  ctx.window.activeSessionId = id;
  ctx.window.activePtyIds.add(id);
  ctx.window.applyHeadTurnSnapshot({ sessionId: id, state: 'open', revision: 1 });
  ctx.window.taskRegistry.ingest(id, use());
  ctx.window.taskRegistry.ingest(id, result());
  ctx.window.applyHeadTurnSnapshot({ sessionId: id, state: 'closed', revision: 2 });
  assert.equal(glyph(), String.fromCharCode(0x283f), 'background-work glyph');
  ctx.window.taskRegistry.ingest(id, done());
  assert.equal(glyph(), String.fromCharCode(0x25cb), 'waiting ring');
});

test('an aggregate stopped notification that lists the shell ends it', () => {
  const r = launched();
  assert.equal(r.background(id), true);
  r.ingest(id, { uuid: 'aggregate', type: 'user', timestamp: '2026-10-26T10:06:00.000Z', origin: { kind: 'task-notification' },
    message: { role: 'user', content: ['<task-notification>', '<task-id>' + shellId + '</task-id>', '<task-id>bother9</task-id>', '<status>stopped</status>', '</task-notification>'].join(NL) } });
  assert.equal(r.background(id), false);
});

test('only a paired background Bash opens, including when its result is read first', () => {
  for (const name of ['Monitor', 'Bash']) {
    for (const resultFirst of [false, true]) {
      const r = createTaskRegistry();
      const launch = use();
      launch.message.content[0].name = name;
      if (name === 'Bash') launch.message.content[0].input.run_in_background = false;
      const output = name === 'Monitor' ? result(undefined, undefined, { backgroundTaskId: undefined, taskId: shellId }) : result();
      for (const entry of resultFirst ? [output, launch] : [launch, output]) r.ingest(id, entry);
      assert.equal(r.background(id), false, name + ', result first: ' + resultFirst);
      assert.equal(r.snapshot(id).tasks.length, 0);
    }
  }
  const deferred = createTaskRegistry();
  deferred.ingest(id, result());
  assert.equal(deferred.background(id), false);
  deferred.ingest(id, use());
  assert.equal(deferred.background(id), true);
  assert.deepEqual(deferred.snapshot(id).tasks.map(t => [t.id, t.kind]), [[shellId, 'bash']]);
  deferred.ingest(id, done());
  assert.equal(deferred.background(id), false);
});

function observedRegistry(options) {
  const maps = [];
  const sets = [];
  class ObservedMap extends Map {
    constructor(...args) { super(...args); maps.push(this); }
  }
  class ObservedSet extends Set {
    constructor(...args) { super(...args); sets.push(this); }
  }
  const ctx = vm.createContext({ module: { exports: {} }, Map: ObservedMap, Set: ObservedSet });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/task-registry.js'), 'utf8'), ctx);
  return { registry: ctx.module.exports.createTaskRegistry(options), maps, sets };
}

test('foreground Bash traffic leaves revisions, tracked calls and agent deduplication unchanged', () => {
  let changes = 0;
  const { registry: r, maps, sets } = observedRegistry({ maxEntries: 4, onChange: () => changes++ });
  const before = r.snapshot(id).revision;
  for (let i = 0; i < 10000; i++) {
    const launch = use('foreground' + i);
    launch.message.content[0].input.run_in_background = false;
    r.ingest(id, launch);
    r.ingest(id, result('foreground' + i, undefined, { backgroundTaskId: undefined }));
  }
  assert.equal(r.snapshot(id).revision, before, 'foreground Bash does not publish revisions');
  assert.equal(changes, 0, 'foreground Bash does not notify subscribers');
  assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.bash)).length, 0, 'processed Bash calls are released');
  assert.equal(sets.flatMap(set => [...set].filter(key => typeof key === 'string' && /^(use|result)-foreground/.test(key))).length, 0, 'foreground Bash does not occupy dedup slots');
  const agent = use('agent-dedup');
  agent.message.content[0].name = 'Agent';
  r.ingest(id, agent);
  const revision = r.snapshot(id).revision;
  for (let i = 0; i < 12; i++) {
    const launch = use('after-agent' + i);
    launch.message.content[0].input.run_in_background = false;
    r.ingest(id, launch);
    r.ingest(id, result('after-agent' + i, undefined, { backgroundTaskId: undefined }));
  }
  r.ingest(id, agent);
  assert.equal(r.snapshot(id).revision, revision, 'foreground traffic preserves the agent dedup key');
});

test('paired rejected Bash results release launch records in either read order', () => {
  for (const resultFirst of [false, true]) {
    const { registry: r, maps } = observedRegistry();
    for (let i = 0; i < 12; i++) {
      const launch = use('rejected-call' + i);
      launch.message.content[0].input.run_in_background = false;
      const output = result('rejected-call' + i);
      for (const entry of resultFirst ? [output, launch] : [launch, output]) r.ingest(id, entry);
    }
    assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.bash)).length, 0, 'failed background admission releases its Bash call');
    assert.equal(r.background(id), false);
  }
  for (const [extra, block] of [[{ backgroundEndsWithFinalResponse: true }, {}], [{}, { is_error: true }], [{ backgroundTaskId: 'INVALID' }, {}]]) {
    const { registry: r, maps } = observedRegistry();
    r.ingest(id, use());
    r.ingest(id, result(undefined, undefined, extra, block));
    assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.bash)).length, 0, 'malformed and rejected results release their Bash call');
  }
});

test('completed foreground Bash calls do not accumulate in the call table', () => {
  const { registry: r, maps } = observedRegistry();
  for (let i = 0; i < 10000; i++) {
    r.ingest(id, use('completed' + i));
    r.ingest(id, result('completed' + i, undefined, { backgroundTaskId: undefined }));
  }
  assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.bash)).length, 0);
});

test('foreground Bash does not evict an existing agent dedup key', () => {
  const r = createTaskRegistry({ maxEntries: 4 });
  const agent = use('retained-agent');
  agent.message.content[0].name = 'Agent';
  r.ingest(id, agent);
  for (let i = 0; i < 12; i++) {
    r.ingest(id, use('dedup-traffic' + i));
    r.ingest(id, result('dedup-traffic' + i, undefined, { backgroundTaskId: undefined }));
  }
  const before = r.snapshot(id).revision;
  r.ingest(id, agent);
  assert.equal(r.snapshot(id).revision, before, 'the agent entry is still deduplicated after foreground traffic');
});

for (const [name, completion] of [['without tool-use-id', done(shellId, null, '2026-10-26T10:00:00.500Z')], ['as a queued attachment', queued(shellId, '2026-10-26T10:00:00.500Z')]]) {
  test('an early completion ' + name + ' survives until its Bash result', () => {
    const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
    r.ingest(id, use());
    r.ingest(id, completion);
    r.ingest(id, result());
    assert.equal(r.background(id), false);
    assert.equal(r.snapshot(id).tasks[0]?.terminal, true);
    assert.equal(maps.flatMap(map => [...map.keys()].filter(key => key === 'notification-task:' + shellId)).length, 0, 'consumed task-id notification is released');
  });
}

test('early task-id notifications are bounded and do not close another shell', () => {
  const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
  for (let i = 0; i < 12; i++) r.ingest(id, queued('bearly' + i, '2026-10-26T10:00:00.500Z'));
  const pending = maps.flatMap(map => [...map.keys()].filter(key => typeof key === 'string' && key.startsWith('notification-task:')));
  assert.equal(pending.length, 4);
  r.ingest(id, use());
  r.ingest(id, result());
  assert.equal(r.background(id), true, 'unrelated early completions do not close this task');
});

test('owner-start replay guard uses the Bash launch time even when its result is newer', () => {
  const r = createTaskRegistry();
  r.ownerAlive(id, { startedAt: Date.parse('2026-10-26T10:00:00.500Z') });
  r.ingest(id, use());
  r.ingest(id, result());
  assert.equal(r.background(id), false);
});

test('rekey preserves the latest owner start and refuses older Bash launches', () => {
  const nextId = '22222222-2222-4222-8222-222222222222';
  for (const [targetStart, launchAt] of [[undefined, undefined], ['2026-10-26T09:00:00.000Z', undefined], ['2026-10-26T10:00:02.000Z', '2026-10-26T10:00:00.750Z']]) {
    const r = createTaskRegistry();
    r.ownerAlive(id, { startedAt: Date.parse('2026-10-26T10:00:00.500Z') });
    if (targetStart) r.ownerAlive(nextId, { startedAt: Date.parse(targetStart) });
    r.rekey(id, nextId);
    r.ingest(nextId, use(undefined, launchAt));
    r.ingest(nextId, result());
    assert.equal(r.background(nextId), false, 'rekey retains the greater owner start: ' + targetStart);
  }
});

for (const [trigger, extra] of [['Ctrl+B', { backgroundedByUser: true }], ['timeout', { timedOutAfterMs: 0 }]]) {
  for (const resultFirst of [false, true]) {
    test(trigger + ' backgrounds a foreground Bash, result first: ' + resultFirst, () => {
      const r = createTaskRegistry();
      const renderer = createTaskRegistry();
      const before = r.snapshot(id);
      renderer.applySnapshot(before);
      const launch = use();
      delete launch.message.content[0].input.run_in_background;
      const output = result(undefined, undefined, extra);
      const entries = resultFirst ? [output, launch] : [launch, output];
      r.ingest(id, entries[0]);
      const pending = r.snapshot(id);
      renderer.applySnapshot(pending);
      assert.equal(renderer.background(id), false);
      r.ingest(id, entries[1]);
      assert.ok(r.snapshot(id).revision > pending.revision, 'backgrounding publishes a newer snapshot');
      renderer.applySnapshot(r.snapshot(id));
      assert.equal(renderer.background(id), true, 'the renderer accepts the backgrounded shell snapshot');
      assert.deepEqual(r.list(id).map(t => [t.id, t.kind]), [[shellId, 'bash']]);
      assert.equal(r.agents(id).length, 0);
      r.ingest(id, done());
      assert.equal(r.background(id), false);
    });
  }
}

for (const resultFirst of [false, true]) {
  test('a Bash ending with the final response opens nothing, result first: ' + resultFirst, () => {
    for (const extra of [{}, { backgroundedByUser: true }, { timedOutAfterMs: 1000 }]) {
      const r = createTaskRegistry();
      const output = result(undefined, undefined, { ...extra, backgroundEndsWithFinalResponse: true });
      for (const entry of resultFirst ? [output, use()] : [use(), output]) r.ingest(id, entry);
      assert.equal(r.background(id), false);
      assert.deepEqual(r.snapshot(id).tasks, []);
    }
  });
}

test('unpaired backgrounding signals and non-finite or non-numeric timeouts open nothing', () => {
  for (const extra of [{ backgroundedByUser: true }, { timedOutAfterMs: 1000 }]) {
    const r = createTaskRegistry();
    r.ingest(id, result(undefined, undefined, extra));
    assert.equal(r.background(id), false);
    assert.deepEqual(r.snapshot(id).tasks, []);
  }
  for (const extra of [{}, { backgroundedByUser: 'true' }, { timedOutAfterMs: null }, { timedOutAfterMs: '1000' }, { timedOutAfterMs: Infinity }, { timedOutAfterMs: NaN }]) {
    for (const resultFirst of [false, true]) {
      const r = createTaskRegistry();
      const launch = use();
      launch.message.content[0].input.run_in_background = false;
      const output = result(undefined, undefined, { ...extra, backgroundEndsWithFinalResponse: false });
      for (const entry of resultFirst ? [output, launch] : [launch, output]) r.ingest(id, entry);
      assert.equal(r.background(id), false);
      assert.deepEqual(r.snapshot(id).tasks, []);
    }
  }
});

test('10000 unresolved Bash launches retain only the newest bounded calls', () => {
  const { registry: r, maps } = observedRegistry();
  for (let i = 0; i < 10000; i++) r.ingest(id, use('unresolved-' + i));
  const calls = maps.flatMap(map => [...map.entries()].filter(([, value]) => value?.bash));
  assert.equal(calls.length, 2048, 'unresolved calls respect the default cap');
  assert.equal(calls[0][0], 'unresolved-7952', 'oldest calls are evicted first');
  assert.equal(calls.at(-1)[0], 'unresolved-9999');
  r.ingest(id, result('unresolved-9999'));
  assert.equal(r.background(id), true, 'the newest call still correlates');
});

test('10000 completed background shells release all shell correlations', () => {
  const { registry: r, maps } = observedRegistry();
  for (let i = 0; i < 10000; i++) {
    const tool = 'completed-background-' + i;
    const shell = 'bcompleted' + i;
    r.ingest(id, use(tool));
    r.ingest(id, result(tool, undefined, { backgroundTaskId: shell }));
    r.ingest(id, done(shell, tool));
  }
  assert.equal(r.background(id), false);
  assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.shell || value?.bash)).length, 0, 'terminal shells retain no call records');
});

test('call bounds cover only Bash and stop records through insertion and merges', () => {
  const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
  r.ingest(id, use());
  r.ingest(id, result());
  for (let i = 0; i < 12; i++) {
    const entry = stop('TaskStop', 'task_id', false)[0];
    entry.uuid += '-' + i;
    entry.message.content[0].id += '-' + i;
    r.ingest(id, entry);
  }
  assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.stop)).length, 4, 'stop calls are capped');
  const agent = use('retained-agent-call');
  agent.message.content[0].name = 'Agent';
  r.ingest(id, agent);
  for (let i = 0; i < 12; i++) {
    const message = use('message-' + i);
    message.message.content[0].name = 'SendMessage';
    message.message.content[0].input = { to: 'tool:retained-agent-call' };
    r.ingest(id, message);
  }
  assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.sendMessage)).length, 12, 'SendMessage calls are never capped');
  const nextId = '22222222-2222-4222-8222-222222222222';
  for (const owner of [id, nextId]) for (let i = 0; i < 4; i++) r.ingest(owner, use(owner + '-' + i));
  r.rekey(id, nextId);
  const merged = Object.values(maps[0].get(nextId)).flatMap(value => value instanceof Map ? [...value.entries()] : []);
  const bounded = merged.filter(([, value]) => value?.bash || value?.shell || value?.stop);
  assert.equal(bounded.length, 4, 'only new call kinds are capped after merge');
  assert.deepEqual(bounded.map(([key]) => key), Array.from({ length: 4 }, (_, i) => id + '-' + i), 'merge evicts destination entries before the newly appended source entries');
  assert.equal(merged.filter(([, value]) => value?.sendMessage).length, 12, 'merge retains all SendMessage calls');
  assert.equal(merged.filter(([key]) => key === 'retained-agent-call').length, 1, 'merge retains Agent calls');
  r.ingest(nextId, result(id + '-3'));
  assert.equal(r.background(nextId), true, 'the newest merged source call is retained');
  const retained = observedRegistry({ maxEntries: 4 });
  retained.registry.ingest(id, agent);
  retained.registry.end(id, 'tool:retained-agent-call', Date.parse('2026-10-26T10:05:00Z'));
  assert.equal(retained.maps.flatMap(map => [...map.keys()].filter(key => key === 'retained-agent-call')).length, 1, 'terminal agent calls retain their existing semantics');
});

test('shell correlation cleanup covers early completion, owner cutoff and rekeyed terminal tasks', () => {
  for (const completion of [done(), queued()]) {
    const { registry: r, maps } = observedRegistry();
    r.ingest(id, use());
    r.ingest(id, completion);
    r.ingest(id, result());
    assert.equal(r.background(id), false);
    assert.equal(maps.flatMap(map => [...map.values()].filter(value => value?.shell)).length, 0);
  }
  const { registry: replay, maps: replayMaps } = observedRegistry();
  replay.ownerAlive(id, { startedAt: Date.parse('2026-10-26T11:00:00Z') });
  replay.ingest(id, use());
  replay.ingest(id, result());
  assert.equal(replayMaps.flatMap(map => [...map.values()].filter(value => value?.shell)).length, 0, 'rejected stale launches retain no shell correlation');
  const { registry: r, maps } = observedRegistry();
  const nextId = '22222222-2222-4222-8222-222222222222';
  r.ingest(id, use());
  r.ingest(id, result());
  r.ingest(nextId, use('destination-shell'));
  r.ingest(nextId, result('destination-shell'));
  r.ingest(nextId, done(shellId, 'destination-shell'));
  r.rekey(id, nextId);
  assert.equal(r.background(nextId), false);
  assert.equal([...maps[0].get(nextId).shellCalls.values()].filter(value => value?.shell).length, 0, 'a terminal destination releases the merged shell correlation');
  r.ingest(nextId, done());
  assert.equal(r.background(nextId), false, 'a late tool-id notification remains terminal');
  assert.equal(maps[0].get(nextId).pending.has('notification:toolu_bash1'), false, 'late terminal notifications do not become pending');
});

for (const route of ['TaskStop', 'KillShell', 'ownerDied', 'ownerAlive', 'end']) {
  test(route + ' releases the terminal shell correlation and accepts a late tool-id notification', () => {
    const { registry: r, maps } = observedRegistry();
    r.ingest(id, use());
    r.ingest(id, result());
    if (route === 'TaskStop' || route === 'KillShell') {
      for (const entry of stop(route, route === 'TaskStop' ? 'task_id' : 'shell_id', true)) r.ingest(id, entry);
    } else if (route === 'ownerAlive') r.ownerAlive(id, { startedAt: Date.parse('2026-10-26T10:05:00Z') });
    else if (route === 'ownerDied') r.ownerDied(id);
    else r.end(id, shellId, Date.parse('2026-10-26T10:05:00Z'));
    assert.equal(r.background(id), false);
    assert.equal(maps[0].get(id).shellCalls.has('toolu_bash1'), false, 'the launch correlation is released');
    r.ingest(id, done());
    assert.equal(r.background(id), false);
    assert.equal(maps[0].get(id).pending.has('notification:toolu_bash1'), false, 'known terminal shells do not queue late notifications');
  });
}

test('unrelated task-id notifications cannot evict a deferred Bash result', () => {
  for (const kind of ['invalid', 'agent', 'shell']) {
    const { registry: r, maps } = observedRegistry();
    r.ingest(id, result());
    for (let i = 0; i < 3000; i++) {
      const taskId = kind === 'invalid' ? 'INVALID-' + i : kind + i;
      if (kind === 'agent') {
        r.note(id, taskId, 'cli-task');
        r.end(id, taskId);
      }
      r.ingest(id, queued(taskId));
    }
    assert.equal(maps.flatMap(map => [...map.keys()].filter(key => key === 'result:toolu_bash1')).length, 1, 'the deferred launch result survives unrelated notifications');
    r.ingest(id, use());
    assert.equal(r.background(id), true);
  }
});

function completeSynchronousAgents(r, owner = id) {
  for (let i = 0; i < 3000; i++) {
    const tool = 'sync-agent-' + i;
    const entry = use(tool);
    entry.message.content[0].name = 'Agent';
    entry.message.content[0].input.run_in_background = false;
    r.ingest(owner, entry);
    r.ingest(owner, result(tool, undefined, { backgroundTaskId: undefined }));
  }
}

test('3000 completed synchronous Agents do not evict a running Agent tool-id correlation', () => {
  const r = createTaskRegistry();
  const entry = use('long-agent');
  entry.message.content[0].name = 'Agent';
  r.ingest(id, entry);
  r.ingest(id, result('long-agent', undefined, { backgroundTaskId: undefined, isAsync: true, status: 'async_launched', agentId: 'along' }));
  completeSynchronousAgents(r);
  assert.deepEqual(r.agents(id).map(t => t.id), ['along']);
  r.ingest(id, done('along', 'long-agent'));
  assert.equal(r.background(id), false, 'the retained Agent correlation accepts its completion');
  assert.equal(r.snapshot(id).tasks.find(t => t.id === 'along')?.terminal, true);
});

test('3000 completed synchronous Agents do not evict a SendMessage reopen correlation', () => {
  const r = createTaskRegistry();
  r.note(id, 'along', 'cli-task');
  r.end(id, 'along', Date.parse('2026-10-26T09:00:00Z'));
  const message = use('reopen-message');
  message.message.content[0].name = 'SendMessage';
  message.message.content[0].input = { to: 'along' };
  r.ingest(id, message);
  completeSynchronousAgents(r);
  assert.deepEqual(r.agents(id).map(t => t.id), ['along']);
  r.ingest(id, result('reopen-message', undefined, { backgroundTaskId: undefined }, { is_error: true }));
  assert.equal(r.background(id), false, 'the retained SendMessage error closes its reopen group');
  assert.equal(r.snapshot(id).tasks.find(t => t.id === 'along')?.terminal, true);
});

test('continued-in preserves an active shell correlation for its tool-id completion', () => {
  const { registry: r, maps } = observedRegistry();
  const nextId = '22222222-2222-4222-8222-222222222222';
  r.ingest(id, use());
  r.ingest(id, result());
  r.ingest(id, { type: 'continued-in', sessionId: id, continuedInSessionId: nextId, timestamp: '2026-10-26T10:01:00Z' });
  assert.equal(r.resolve(id), nextId);
  assert.equal(r.background(nextId), true);
  r.ingest(id, done());
  assert.equal(r.background(nextId), false, 'completion follows the continued-in redirect');
  assert.equal(maps[0].get(nextId).pending.has('notification:toolu_bash1'), false, 'the correlated completion is consumed');
});

test('task-id notification capacity cannot evict a deferred tool-id completion', () => {
  const { registry: r, maps } = observedRegistry();
  r.ingest(id, done());
  for (let i = 0; i < 3000; i++) r.ingest(id, queued('bunrelated' + i));
  assert.equal(maps[0].get(id).pending.has('notification:toolu_bash1'), true);
  assert.equal(maps.flatMap(map => [...map.keys()].filter(key => typeof key === 'string' && key.startsWith('notification-task:'))).length, 256, 'task-id notifications have their own small cap');
  r.ingest(id, use());
  r.ingest(id, result());
  assert.equal(r.background(id), false, 'the tool-id completion survives the task-id flood');
});

test('rekey bounds task-id notifications separately and consumes the retained early completion', () => {
  const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
  const nextId = '22222222-2222-4222-8222-222222222222';
  r.ingest(id, result());
  for (let i = 0; i < 4; i++) {
    r.ingest(nextId, queued('bdestination' + i));
    r.ingest(id, queued(i === 3 ? shellId : 'bsource' + i));
  }
  r.rekey(id, nextId);
  const p = maps[0].get(nextId);
  assert.equal(p.taskNotifications.size, 4, 'the merged task-id queue respects the configured small cap');
  assert.deepEqual([...p.taskNotifications.keys()], ['bsource0', 'bsource1', 'bsource2', shellId].map(key => 'notification-task:' + key));
  assert.equal(p.pending.has('result:toolu_bash1'), true, 'the separately merged result survives');
  r.ingest(nextId, use());
  assert.equal(r.snapshot(nextId).tasks.find(t => t.id === shellId)?.terminal, true, 'the merged early completion is applied');
  assert.equal(r.background(nextId), false);
  assert.equal(p.taskNotifications.has('notification-task:' + shellId), false, 'the merged completion is consumed');
});

test('owner death clears the separate task-id notification queue', () => {
  const { registry: r, maps } = observedRegistry();
  r.ingest(id, queued());
  assert.equal(maps[0].get(id).taskNotifications.size, 1);
  r.ownerDied(id);
  assert.equal(maps[0].get(id).taskNotifications.size, 0);
});

test('an early tool-id notification for another task cannot end the shell', () => {
  const r = createTaskRegistry();
  r.ingest(id, use());
  r.ingest(id, done('bother1', 'toolu_bash1', '2026-10-26T10:00:00.500Z'));
  r.ingest(id, result());
  assert.equal(r.background(id), true);
  assert.equal(r.snapshot(id).tasks.find(t => t.id === shellId)?.terminal, false);
});

test('Bash uses and paired rejected results do not fill pending or evict an early completion', () => {
  const maps = [];
  class ObservedMap extends Map {
    constructor(...args) { super(...args); maps.push(this); }
  }
  const ctx = vm.createContext({ module: { exports: {} }, Map: ObservedMap });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/task-registry.js'), 'utf8'), ctx);
  for (const resultFirst of [false, true]) {
    const r = ctx.module.exports.createTaskRegistry({ maxEntries: 4 });
    r.ingest(id, done());
    for (let i = 0; i < 12; i++) {
      const launch = use('rejected' + i);
      launch.message.content[0].input.run_in_background = false;
      const output = result('rejected' + i);
      for (const entry of resultFirst ? [output, launch] : [launch, output]) r.ingest(id, entry);
    }
    const pendingKeys = () => maps.flatMap(map => [...map.keys()].filter(key => typeof key === 'string' && /^(result|bash):/.test(key)));
    assert.deepEqual(pendingKeys(), [], 'paired rejected results leave no pending entries');
    for (let i = 0; i < 12; i++) r.ingest(id, use('unresolved' + i));
    assert.deepEqual(pendingKeys(), [], 'Bash uses leave the shared pending queue free');
    assert.equal(r.background(id), false);
    r.ingest(id, use());
    r.ingest(id, result());
    assert.equal(r.background(id), false, 'the early completion survives the rejected results and Bash uses');
    assert.equal(r.snapshot(id).tasks.find(t => t.id === shellId)?.terminal, true);
  }
});

function stoppedShellTraffic(r, count) {
  for (let i = 0; i < count; i++) {
    const tool = 'noise-shell-' + i;
    const taskId = 'bnoise' + i;
    r.ingest(id, use(tool));
    r.ingest(id, result(tool, undefined, { backgroundTaskId: taskId }));
    const name = i % 2 ? 'KillShell' : 'TaskStop';
    const entries = stop(name, name === 'TaskStop' ? 'task_id' : 'shell_id', true);
    entries[0].uuid += '-' + i;
    entries[0].message.content[0].id += '-' + i;
    entries[0].message.content[0].input = { [name === 'TaskStop' ? 'task_id' : 'shell_id']: taskId };
    entries[1].uuid += '-' + i;
    entries[1].message.content[0].tool_use_id += '-' + i;
    for (const entry of entries) r.ingest(id, entry);
  }
}

test('2100 background shells and stops cannot evict an async Agent result dedup key', () => {
  const r = createTaskRegistry();
  const launch = use('dedup-agent');
  launch.message.content[0].name = 'Agent';
  const output = result('dedup-agent', undefined, { backgroundTaskId: undefined, isAsync: true, status: 'async_launched', agentId: 'along' });
  r.ingest(id, launch);
  r.ingest(id, output);
  r.ingest(id, done('along', 'dedup-agent'));
  stoppedShellTraffic(r, 2100);
  const before = r.snapshot(id).revision;
  r.ingest(id, output);
  assert.equal(r.snapshot(id).revision, before, 'Bash noise must not evict the async_launched entry main retains');
  assert.deepEqual(r.agents(id), [], 'replay must not resurrect the finished agent');
  assert.equal(r.snapshot(id).tasks.find(t => t.id === 'along')?.terminal, true);
});

test('a long shell completes by tool id after 2100 background shells are launched and stopped', () => {
  const r = createTaskRegistry();
  r.ingest(id, use());
  r.ingest(id, result());
  stoppedShellTraffic(r, 2100);
  assert.deepEqual(r.list(id).map(t => t.id), [shellId]);
  r.ingest(id, done());
  assert.equal(r.background(id), false, 'P4: the original shell must accept its tool-id completion');
  assert.equal(r.snapshot(id).tasks.find(t => t.id === shellId)?.terminal, true);
});

for (const [name, field] of [['TaskStop', 'task_id'], ['KillShell', 'shell_id']]) {
  for (const ok of [false, true]) {
    test(name + ' releases its stop correlation after a result, successful: ' + ok, () => {
      const { registry: r, maps } = observedRegistry();
      r.ingest(id, use());
      r.ingest(id, result());
      for (const entry of stop(name, field, ok)) r.ingest(id, entry);
      assert.equal(r.background(id), !ok);
      assert.equal(maps[0].get(id).shellCalls.has('toolu_' + name), false, 'finished stop calls release their correlation on success and error');
    });
  }
}

test('an evicted live shell correlation still accepts its task id in a tool-id notification', () => {
  const { registry: r, maps } = observedRegistry();
  r.ingest(id, use());
  r.ingest(id, result());
  for (let i = 0; i < 2100; i++) r.ingest(id, use('unresolved-eviction-' + i));
  assert.equal(maps[0].get(id).shellCalls.has('toolu_bash1'), false);
  r.ingest(id, done());
  assert.equal(r.background(id), false, 'a known Bash task can complete after losing its bounded correlation');
  assert.equal(maps[0].get(id).pending.has('notification:toolu_bash1'), false, 'the fallback consumes the completion');
});

test('an unknown tool id cannot complete a known agent by task id alone', () => {
  const r = createTaskRegistry();
  const entry = use('known-agent');
  entry.message.content[0].name = 'Agent';
  r.ingest(id, entry);
  r.ingest(id, result('known-agent', undefined, { backgroundTaskId: undefined, isAsync: true, status: 'async_launched', agentId: 'along' }));
  r.ingest(id, done('along', 'missing-tool'));
  assert.equal(r.agents(id).length, 1, 'main requires the agent tool correlation when a tool id is present');
});

test('a shell launched exactly at the new owner start remains running', () => {
  const r = launched();
  r.ownerAlive(id, { startedAt: Date.parse('2026-10-26T10:00:00.000Z') });
  assert.equal(r.background(id), true, 'ownerAlive ends only launches strictly older than startedAt');
  assert.equal(r.snapshot(id).tasks.find(t => t.id === shellId)?.terminal, false);
});

test('shell deduplication is bounded separately and cleared on owner death', () => {
  const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
  stoppedShellTraffic(r, 12);
  const p = maps[0].get(id);
  assert.equal(p.shellSeen?.size, 4, 'shell entries use their own bounded deduplication set');
  assert.equal(p.seen.size, 0, 'main admits none of these Bash and stop records');
  r.ownerDied(id);
  assert.equal(p.shellSeen.size, 0, 'owner death clears shell replay keys');
});

test('rekey merges and bounds shell deduplication independently of agent keys', () => {
  const { registry: r, maps } = observedRegistry({ maxEntries: 4 });
  const nextId = '22222222-2222-4222-8222-222222222222';
  for (const owner of [nextId, id]) for (let i = 0; i < 4; i++) {
    const tool = owner + '-dedup-' + i;
    r.ingest(owner, use(tool));
    r.ingest(owner, result(tool, undefined, { backgroundTaskId: 'bmerge' + i }));
  }
  r.rekey(id, nextId);
  const p = maps[0].get(nextId);
  assert.equal(p.shellSeen?.size, 4, 'merged shell replay keys respect the configured cap');
  assert.deepEqual([...p.shellSeen], Array.from({ length: 4 }, (_, i) => 'result-' + id + '-dedup-' + i));
  assert.equal(p.seen.size, 0);
  const before = r.snapshot(nextId).revision;
  r.ingest(nextId, result(id + '-dedup-3', undefined, { backgroundTaskId: 'bmerge3' }));
  assert.equal(r.snapshot(nextId).revision, before, 'a replayed source result is deduplicated after rekey');
});
