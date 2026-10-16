'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskRecordsClient } = require('../task-records-client');
const { normalizeTaskEvidence } = require('../task-records');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const { parentSessionId: id, agentId: agent } = fixture;

function launch(r) {
  r.ingest(id, fixture.use);
  r.ingest(id, fixture.launch);
}

function completion(origin) {
  return { type: 'attachment', uuid: 'attachment-completion', timestamp: fixture.notification.timestamp,
    attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: fixture.notification.message.content, ...(origin ? { origin } : {}) } };
}

for (const origin of [undefined, { kind: 'task-notification' }, { kind: 'task-notification', producer: 'session-task' }]) {
  test(`#667 attachment-only completion ends the agent (origin ${JSON.stringify(origin)})`, () => {
    const r = createTaskRegistry();
    launch(r);
    r.ingest(id, completion(origin));
    assert.equal(r.runningAgentCount([id]), 0);
  });
}

test('#667 no-origin queued commands without task-notification mode end nothing', () => {
  for (const mode of [undefined, 'normal']) {
    const r = createTaskRegistry();
    launch(r);
    const entry = completion();
    if (mode === undefined) delete entry.attachment.commandMode;
    else entry.attachment.commandMode = mode;
    r.ingest(id, entry);
    assert.equal(r.runningAgentCount([id]), 1);
  }
});

test('#667 explicit task-notification origin does not require commandMode', () => {
  const r = createTaskRegistry();
  launch(r);
  const entry = completion({ kind: 'task-notification' });
  delete entry.attachment.commandMode;
  r.ingest(id, entry);
  assert.equal(r.runningAgentCount([id]), 0);
});

test('#667 SendMessage reopen ends on its next attachment-only completion', () => {
  const r = createTaskRegistry();
  launch(r);
  r.ingest(id, fixture.notification);
  r.ingest(id, { type: 'assistant', timestamp: '2026-10-14T00:12:00Z', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'SendMessage', id: 'send-667', input: { to: agent, message: 'Placeholder' } },
  ] } });
  assert.equal(r.runningAgentCount([id]), 1);
  r.ingest(id, { ...completion(), timestamp: '2026-10-14T00:13:00Z' });
  assert.equal(r.runningAgentCount([id]), 0);
});

test('#667 attachment parsing rejects free text, wrong origins, wrong envelopes and mismatched output', () => {
  for (const mutate of [
    e => { e.attachment.prompt = `Example: ${e.attachment.prompt}`; },
    e => { e.attachment.prompt += '\nPlaceholder'; },
    e => { e.attachment.origin = { kind: 'user' }; },
    e => { e.attachment.type = 'other'; },
    e => { e.attachment.prompt = e.attachment.prompt.replace('</task-notification>', ''); },
    e => { e.attachment.prompt = e.attachment.prompt.replace(`${agent}.output`, 'unknown.output'); },
    e => { e.attachment.prompt = e.attachment.prompt.replace('completed', 'unknown'); },
    e => { e.attachment.prompt = [{ type: 'text', text: e.attachment.prompt }]; },
  ]) {
    const r = createTaskRegistry();
    launch(r);
    const entry = completion();
    mutate(entry);
    r.ingest(id, entry);
    assert.equal(r.runningAgentCount([id]), 1);
  }
});

test('#667 real worker replay delivers attachment-only completion from a disposable transcript', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-667-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, `${id}.jsonl`);
  const r = createTaskRegistry();
  const client = createTaskRecordsClient({ onSnapshot: s => r.applySnapshot(s) });
  t.after(() => client.dispose());
  fs.writeFileSync(file, [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join(''));
  await client.read(file, id);
  assert.equal(r.runningAgentCount([id]), 1);
  fs.appendFileSync(file, JSON.stringify(completion()) + '\n');
  await client.read(file, id);
  assert.equal(r.runningAgentCount([id]), 0);
});

test('#667 a snapshot with K ended tasks emits one fully applied change', () => {
  const events = [];
  const r = createTaskRegistry({ onChange: s => events.push(s) });
  const tasks = Array.from({ length: 12 }, (_, n) => ({ id: `agent-${n}`, kind: 'agent', terminal: true, at: 100 }));
  r.applySnapshot({ parentSessionId: id, revision: 1, known: true, tasks });
  assert.equal(events.length, 1);
  assert.equal(events[0].tasks.filter(t => t.terminal).length, 12);
  r.applySnapshot({ parentSessionId: id, revision: 2, known: true, tasks });
  assert.equal(events.length, 2);
  r.applySnapshot({ parentSessionId: id, revision: 2, known: true, tasks });
  assert.equal(events.length, 2);
});

test('#667 end ignores terminal evidence at the same or an earlier time', () => {
  let changes = 0;
  const r = createTaskRegistry({ onChange: () => changes++ });
  r.note(id, agent, 'cli-task');
  r.end(id, agent, 100);
  const revision = r.snapshot(id).revision;
  r.end(id, agent, 100);
  r.end(id, agent, 99);
  assert.equal(r.snapshot(id).revision, revision);
  assert.equal(changes, 2);
  r.end(id, agent, 101);
  assert.equal(r.snapshot(id).tasks[0].at, 101);
  assert.equal(changes, 3);
});

test('#667 repeated cli-task notes bump revision once, source and type changes still notify', () => {
  let at = 10;
  const r = createTaskRegistry({ now: () => at });
  for (let n = 0; n < 20; n++) { at++; r.note(id, agent, 'cli-task'); }
  assert.equal(r.snapshot(id).revision, 1);
  r.note(id, agent, 'local-ipc');
  assert.equal(r.snapshot(id).revision, 2);
  r.note(id, agent, 'cli-task', { subagentType: 'explore' });
  assert.equal(r.snapshot(id).revision, 3);
  r.note(id, agent, 'cli-task', { subagentType: 'explore' });
  assert.equal(r.snapshot(id).revision, 3);
});

test('#667 correlating an existing job agent publishes the removed provisional task', () => {
  const events = [];
  const r = createTaskRegistry({ onChange: s => events.push(s) });
  const renderer = createTaskRegistry();
  const use = structuredClone(fixture.use);
  use.message.content[0].id = 'toolu_1';
  r.ingest(id, use);
  r.applyJob(id, { valid: true, at: Date.parse(fixture.job.updatedAt), inFlight: 0, fanKnown: true,
    tasks: [{ id: 'aagent1', kind: 'agent', startedAt: Date.parse(use.timestamp), doneAt: null }] });
  const before = r.snapshot(id);
  assert.deepEqual(before.tasks.map(t => t.id), ['tool:toolu_1', 'aagent1']);
  renderer.applySnapshot(before);
  assert.equal(renderer.runningAgentCount([id]), 2);
  assert.equal(r.note(id, 'aagent1', 'cli-task', { toolUseId: 'toolu_1' }), true);
  const after = r.snapshot(id);
  assert.deepEqual(after.tasks.map(t => t.id), ['aagent1']);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(events.length, 3);
  renderer.applySnapshot(after);
  assert.equal(renderer.runningAgentCount([id]), 1);
  r.note(id, 'aagent1', 'cli-task', { toolUseId: 'toolu_1' });
  assert.equal(r.snapshot(id).revision, after.revision);
  assert.equal(events.length, 3);
});

test('#667 worker child correlation updates the rendered count after job evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-667b-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, `${id}.jsonl`);
  const child = path.join(root, 'agent-aagent1.jsonl');
  const use = structuredClone(fixture.use);
  use.message.content[0].id = 'toolu_1';
  fs.writeFileSync(file, JSON.stringify(use) + '\n');
  fs.writeFileSync(child.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }));
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const session = { sessionId: id, summary: 'Placeholder', modified: use.timestamp };
  h.window.sessionMap.set(id, session);
  h.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
  const row = h.document.getElementById('si-' + id);
  const errors = [];
  const client = createTaskRecordsClient({ onSnapshot: s => h.window.taskRegistry.applySnapshot(s), onError: e => errors.push(e) });
  t.after(() => client.dispose());
  await client.read(file, id);
  await client.job(id, { valid: true, at: Date.parse(fixture.job.updatedAt), inFlight: 0, fanKnown: true,
    tasks: [{ id: 'aagent1', kind: 'agent', startedAt: Date.parse(use.timestamp), doneAt: null }] });
  assert.equal(row.querySelector('.session-subagent-count').textContent, '2 subagents running');
  await client.child(child, id, 'aagent1');
  assert.deepEqual(errors, []);
  assert.equal(row.querySelector('.session-subagent-count').textContent, '1 subagent running');
});

test('#667 fallback heartbeat refreshes TTL without emitting a visible change', () => {
  let at = 100;
  const r = createTaskRegistry({ now: () => at });
  r.note(id, agent);
  at = 150;
  r.note(id, agent);
  assert.equal(r.snapshot(id).revision, 1);
  at = 201;
  r.prune(100);
  assert.equal(r.agents(id).length, 1);
  at = 251;
  r.prune(100);
  assert.equal(r.agents(id).length, 0);
});

test('#667 one parent reflection updates count, tint, icon and local active flags on completion', t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const session = { sessionId: id, summary: 'Placeholder', modified: fixture.use.timestamp };
  h.window.sessionMap.set(id, session);
  h.window.activePtyIds.add(id);
  h.emitHeadTurn(id, 'closed');
  h.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
  const row = h.document.getElementById('si-' + id);
  const reflect = h.window.reflectSubagentRunningState;
  let reflects = 0;
  h.window.reflectSubagentRunningState = (...args) => { reflects++; return reflect(...args); };
  const tasks = ['A', 'B', 'C'].map(taskId => ({ id: taskId, kind: 'agent', terminal: false, at: 100 }));
  h.window.taskRegistry.applySnapshot({ parentSessionId: id, revision: 1, known: true, tasks });
  assert.equal(reflects, 1);
  assert.equal(row.querySelector('.session-subagent-count').textContent, '3 subagents running');
  assert.ok(row.classList.contains('has-busy-agents'));
  assert.ok(row.querySelector('.session-icon--agents-busy'));
  assert.equal(h.window.storedActivitySnapshot(id).agentsBusy, true);
  reflects = 0;
  h.window.taskRegistry.applySnapshot({ parentSessionId: id, revision: 2, known: true, tasks: tasks.map(task => ({ ...task, terminal: true, at: 200 })) });
  assert.equal(reflects, 1);
  assert.equal(row.querySelector('.session-subagent-count'), null);
  assert.equal(row.classList.contains('has-busy-agents'), false);
  assert.equal(row.querySelector('.session-icon--agents-busy'), null);
  assert.equal(h.window.storedActivitySnapshot(id).agentsBusy, false);
});

test('#667 newer unchanged job evidence does not notify but a terminal transition does once', () => {
  let changes = 0;
  const r = createTaskRegistry({ onChange: () => changes++ });
  const evidence = normalizeTaskEvidence(fixture.job);
  r.applyJob(id, evidence);
  assert.equal(changes, 1);
  r.applyJob(id, { ...evidence, at: evidence.at + 1000 });
  assert.equal(changes, 1);
  r.applyJob(id, normalizeTaskEvidence(fixture.terminalJob));
  assert.equal(changes, 2);
  assert.equal(r.background(id), false);
});

test('#667 unchanged Agents polling avoids rebuilds, while a new metadata time still refreshes its tooltip', t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  h.evalPublic('agents-view.js');
  let renders = 0;
  h.window.refreshSidebar = () => { renders++; };
  const entry = { kind: 'background', id: 'job-667', sessionId: id, state: 'working', hosted: true, taskEvidence: normalizeTaskEvidence(fixture.job) };
  h.window.applyAgentsSnapshot({ roster: [structuredClone(entry)] });
  const revision = h.window.taskRegistry.snapshot(id).revision;
  h.window.applyAgentsSnapshot({ roster: [structuredClone(entry)] });
  assert.equal(renders, 1);
  const newer = structuredClone(entry);
  newer.taskEvidence.at += 1000;
  h.window.applyAgentsSnapshot({ roster: [newer] });
  assert.equal(renders, 2);
  assert.equal(h.window.taskRegistry.snapshot(id).revision, revision);
  h.window.applyAgentsSnapshot({ roster: [{ ...entry, state: 'done', hosted: false, taskEvidence: normalizeTaskEvidence(fixture.terminalJob) }] });
  assert.equal(renders, 3);
  assert.equal(h.window.taskRegistry.background(id), false);
});
