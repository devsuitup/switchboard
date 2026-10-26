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
  r.ingest(id, done());
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
      for (const entry of resultFirst ? [result(), launch] : [launch, result()]) r.ingest(id, entry);
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
