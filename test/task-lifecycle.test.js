'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskTranscriptReader } = require('../task-transcript-reader');
const { createTaskRecordsClient } = require('../task-records-client');
const { normalizeTaskEvidence } = require('../task-records');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const id = fixture.parentSessionId;
const agent = fixture.agentId;
const copy = value => structuredClone(value);

function launch(registry) {
  registry.ingest(id, fixture.use);
  registry.ingest(id, fixture.launch);
}

test('async acknowledgement stays running at all silence thresholds, terminal notification ends within the next replay', () => {
  let at = Date.parse(fixture.use.timestamp);
  const r = createTaskRegistry({ now: () => at });
  launch(r);
  for (const elapsed of [30000, 60000, 120000, 300000, 600000]) {
    at = Date.parse(fixture.use.timestamp) + elapsed;
    r.prune(60000);
    assert.equal(r.agents(id).length, 1);
    assert.ok(r.primary(id, agent));
  }
  r.ingest(id, fixture.notification);
  assert.equal(r.agents(id).length, 0);
  assert.equal(r.background(id), false);
});

test('synchronous Agent ends on its matching result; unrelated results cannot complete it', () => {
  const r = createTaskRegistry();
  const use = copy(fixture.use);
  use.message.content[0].input.run_in_background = false;
  r.ingest(id, use);
  const wrong = copy(fixture.syncResult);
  wrong.uuid = 'wrong-result';
  wrong.message.content[0].tool_use_id = 'unknown';
  r.ingest(id, wrong);
  assert.equal(r.agents(id).length, 1);
  r.ingest(id, fixture.syncResult);
  assert.equal(r.agents(id).length, 0);
});

test('out-of-order and duplicate records converge without counting the tool and agent twice', () => {
  const r = createTaskRegistry();
  r.ingest(id, fixture.notification);
  r.ingest(id, fixture.launch);
  r.ingest(id, fixture.use);
  launch(r);
  r.ingest(id, fixture.notification);
  assert.equal(r.agents(id).length, 0);
  assert.equal(r.snapshot(id).tasks.filter(t => t.id === agent).length, 1);
});

test('unknown, quoted, assistant and tool-output notifications cannot end a correlated task', () => {
  const r = createTaskRegistry();
  launch(r);
  for (const mutate of [
    e => { e.message.content = `Example: ${e.message.content}`; },
    e => { e.type = 'assistant'; e.message.role = 'assistant'; },
    e => { e.message.content = [{ type: 'text', text: e.message.content }]; },
    e => { e.message.content = e.message.content.replace(agent, 'unknown'); },
    e => { e.message.content = e.message.content.replace('toolu_111', 'toolu_unknown'); },
    e => { e.message.content = e.message.content.replace('completed', 'future_terminal'); },
    e => { e.message.content = e.message.content.replace('</task-notification>', ''); },
  ]) {
    const e = copy(fixture.notification);
    e.uuid = Math.random().toString();
    mutate(e);
    r.ingest(id, e);
    assert.equal(r.agents(id).length, 1);
  }
});

test('terminal primary records remove overlapping sources and block delayed fallback growth', () => {
  const r = createTaskRegistry();
  launch(r);
  r.note(id, agent, 'local-transcript');
  r.note(id, agent, 'remote-watch');
  r.ingest(id, fixture.notification);
  assert.equal(r.note(id, agent, 'local-transcript'), false);
  assert.equal(r.agents(id).length, 0);
});

test('missing CLI records retain inferred expiry while primary tasks survive source release', () => {
  let at = 1000;
  const r = createTaskRegistry({ now: () => at });
  r.note(id, 'fallback', 'local-ipc');
  launch(r);
  r.note(id, agent, 'attached-ipc');
  r.release(id, agent, 'attached-ipc');
  at += 60001;
  r.prune(60000);
  assert.deepEqual(r.agents(id).map(t => t.id), [agent]);
});

test('validated job fan and in-flight evidence distinguish agents from background work and map short job ids through the roster', () => {
  const job = parseJobState(JSON.stringify(fixture.job));
  const jobs = new Map([['abcdef12', job]]);
  const roster = mergeRoster({ jobs, descriptors: [], cli: null });
  assert.equal(roster[0].id, 'abcdef12');
  assert.equal(roster[0].sessionId, id);
  const r = createTaskRegistry();
  r.applyJob(roster[0].sessionId, roster[0].taskEvidence);
  assert.equal(r.agents(id).length, 1);
  assert.equal(r.list(id).length, 2);
  assert.equal(r.background(id), true);
  r.applyJob(id, normalizeTaskEvidence({ state: 'future_state' }));
  r.applyJob(id, normalizeTaskEvidence({ ...fixture.job, fan: null }));
  assert.equal(r.agents(id).length, 1, 'invalid snapshots are not authoritative empty sets');
  r.applyJob(id, normalizeTaskEvidence(fixture.terminalJob));
  assert.equal(r.background(id), false);
});

test('descriptor mapping correlates a job with no transcript path without equating its short id to a UUID', () => {
  const job = parseJobState(JSON.stringify({ ...fixture.job, linkScanPath: undefined }));
  const roster = mergeRoster({ jobs: new Map([['abcdef12', job]]), descriptors: [{ kind: 'bg', jobId: 'abcdef12', sessionId: id }], cli: null });
  assert.equal(roster[0].sessionId, id);
  const unmapped = mergeRoster({ jobs: new Map([['abcdef12', job]]), descriptors: [], cli: null });
  assert.equal(unmapped[0].sessionId, null);
});

test('an authoritative empty job fan ends job-only work while missing fan preserves unknown work and transcript tasks', () => {
  const r = createTaskRegistry();
  r.applyJob(id, normalizeTaskEvidence(fixture.job));
  const missing = { ...fixture.job, updatedAt: '2026-10-14T00:02:00.000Z', fan: undefined, inFlight: { tasks: 0, kinds: [] } };
  r.applyJob(id, normalizeTaskEvidence(missing));
  assert.equal(r.agents(id).length, 1, 'missing fan is not an empty set');
  r.applyJob(id, normalizeTaskEvidence({ ...missing, updatedAt: '2026-10-14T00:03:00.000Z', fan: [] }));
  assert.equal(r.list(id).length, 0, 'validated empty fan with no in-flight work clears job-only tasks');
  const overlap = createTaskRegistry();
  launch(overlap);
  overlap.applyJob(id, normalizeTaskEvidence(fixture.job));
  overlap.applyJob(id, normalizeTaskEvidence({ ...missing, updatedAt: '2026-10-14T00:03:00.000Z', fan: [] }));
  assert.deepEqual(overlap.agents(id).map(t => t.id), [agent], 'an unresolved transcript task still owns the agent');
});

test('confirmed owner death ends primary tasks; rekey preserves provenance and terminal evidence', () => {
  const r = createTaskRegistry();
  launch(r);
  r.rekey(id, 'new-parent');
  assert.equal(r.agents('new-parent').length, 1);
  r.ownerDied('new-parent');
  assert.equal(r.agents('new-parent').length, 0);
  assert.equal(r.note('new-parent', agent, 'remote-watch'), false);
});

test('owner death observed before cold replay suppresses historical open tasks and delayed growth', () => {
  const r = createTaskRegistry({ now: () => Date.parse('2026-10-14T01:00:00Z') });
  r.ownerDied(id);
  launch(r);
  assert.equal(r.agents(id).length, 0);
  assert.equal(r.note(id, agent, 'local-transcript'), false);
});

test('out-of-order entries without UUIDs deduplicate consistently during deferred replay', () => {
  const r = createTaskRegistry();
  for (const raw of [fixture.notification, fixture.launch, fixture.use]) {
    const e = copy(raw);
    delete e.uuid;
    r.ingest(id, e);
  }
  assert.equal(r.agents(id).length, 0);
});

test('a terminal job observed before replay suppresses old tasks and an explicit launch failure closes provisional work', () => {
  const r = createTaskRegistry();
  r.applyJob(id, normalizeTaskEvidence(fixture.terminalJob));
  launch(r);
  assert.equal(r.agents(id).length, 0, 'terminal job evidence must survive replay ordering');
  const failed = createTaskRegistry();
  failed.ingest(id, fixture.use);
  const error = copy(fixture.syncResult);
  delete error.toolUseResult;
  error.message.content[0].is_error = true;
  failed.ingest(id, error);
  assert.equal(failed.agents(id).length, 0, 'a failed launch is not an unresolved background task');
});

test('rekeyed snapshots and continuation notifications finish tasks under their current identity', () => {
  const r = createTaskRegistry();
  r.applySnapshot({ parentSessionId: id, revision: 1, known: true, tasks: [{ id: agent, kind: 'agent', terminal: false, at: 1 }] });
  r.rekey(id, 'new-parent');
  r.applySnapshot({ parentSessionId: id, revision: 2, known: true, tasks: [{ id: agent, kind: 'agent', terminal: true, at: 2 }] });
  assert.equal(r.agents('new-parent').length, 0, 'late old-id completion routes to the rekeyed registry');
  assert.equal(r.note(id, agent, 'local-transcript'), false, 'late old-id growth cannot bypass the moved terminal record');
  const continued = createTaskRegistry();
  launch(continued);
  continued.ingest(id, { type: 'continued-in', sessionId: id, continuedInSessionId: '22222222-2222-4222-8222-222222222222', timestamp: '2026-10-14T00:02:00Z', uuid: 'continuation' });
  continued.ingest('22222222-2222-4222-8222-222222222222', fixture.notification);
  assert.equal(continued.agents(id).length, 0);
  assert.equal(continued.agents('22222222-2222-4222-8222-222222222222').length, 0);
});

function disk(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-624-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return path.join(root, `${id}.jsonl`);
}
const jsonl = (...entries) => entries.map(e => JSON.stringify(e) + '\n').join('');

test('incremental disk replay recovers an old open task, deduplicates reads, buffers split JSONL and UTF-8, and reads explicit completion', async t => {
  const file = disk(t);
  const r = createTaskRegistry();
  const reader = createTaskTranscriptReader({ registry: r, chunkBytes: 47 });
  t.after(() => reader.dispose());
  fs.writeFileSync(file, jsonl(fixture.use, fixture.launch));
  fs.utimesSync(file, 100, 100);
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 1);
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 1);
  const n = copy(fixture.notification);
  n.message.content = n.message.content.replace('Sanitized task', 'Sanitized café');
  const tail = JSON.stringify(n);
  fs.appendFileSync(file, tail.slice(0, -12));
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 1);
  fs.appendFileSync(file, tail.slice(-12) + '\n');
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 0);
});

test('rotation invalidates cursors, continuation starts a new cursor, and unavailable data never ends an open task', async t => {
  const file = disk(t);
  const r = createTaskRegistry();
  const reader = createTaskTranscriptReader({ registry: r, chunkBytes: 64 });
  t.after(() => reader.dispose());
  fs.writeFileSync(file, jsonl(fixture.use, fixture.launch));
  await reader.read(file, id);
  fs.renameSync(file, file + '.old');
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 1);
  fs.writeFileSync(file, jsonl(fixture.notification));
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 0);
  fs.writeFileSync(file + '.continuation', jsonl({ ...fixture.use, uuid: 'new-use' }));
  await reader.read(file + '.continuation', 'continuation');
  assert.equal(r.agents('continuation').length, 1);
});

test('real worker client delivers cold-start and terminal snapshots without Electron or main-thread scanning', async t => {
  const file = disk(t);
  const received = [];
  const client = createTaskRecordsClient({ onSnapshot: s => received.push(s) });
  t.after(() => client.dispose());
  fs.writeFileSync(file, jsonl(fixture.use, fixture.launch));
  await client.read(file, id);
  assert.equal(client.hasRecord(id, agent), true);
  assert.equal(received.at(-1).tasks.find(t => t.id === agent).terminal, false);
  fs.appendFileSync(file, jsonl(fixture.notification));
  await client.read(file, id);
  assert.equal(received.at(-1).tasks.find(t => t.id === agent).terminal, true);
});

test('in-place compaction with the same byte length invalidates the old cursor', async t => {
  const file = disk(t);
  const r = createTaskRegistry();
  const reader = createTaskTranscriptReader({ registry: r });
  t.after(() => reader.dispose());
  const before = jsonl(fixture.use, fixture.launch);
  fs.writeFileSync(file, before);
  await reader.read(file, id);
  const after = jsonl(fixture.notification);
  assert.ok(after.length < before.length);
  fs.writeFileSync(file, after + ' '.repeat(before.length - after.length));
  fs.utimesSync(file, 2000000000, 2000000000);
  await reader.read(file, id);
  assert.equal(r.agents(id).length, 0, 'the new terminal record must be replayed after same-size compaction');
});

test('worker continuation rekeys an existing renderer snapshot before delivering its completion', async t => {
  const file = disk(t);
  const renderer = createTaskRegistry();
  const client = createTaskRecordsClient({ onSnapshot: s => renderer.applySnapshot(s), onRekey: (oldId, newId) => renderer.rekey(oldId, newId) });
  t.after(() => client.dispose());
  fs.writeFileSync(file, jsonl(fixture.use, fixture.launch));
  await client.read(file, id);
  assert.equal(renderer.agents(id).length, 1);
  const newId = '22222222-2222-4222-8222-222222222222';
  fs.appendFileSync(file, jsonl({ type: 'continued-in', sessionId: id, continuedInSessionId: newId, timestamp: '2026-10-14T00:02:00Z' }));
  await client.read(file, id);
  assert.equal(renderer.agents(id).length, 0);
  assert.equal(renderer.agents(newId).length, 1);
  fs.writeFileSync(file + '.next', jsonl(fixture.notification));
  await client.read(file + '.next', newId);
  assert.equal(renderer.agents(newId).length, 0);
});

test('worker failure settles pending and subsequent reads without inventing an empty snapshot', async t => {
  const { EventEmitter } = require('node:events');
  const worker = new EventEmitter();
  worker.postMessage = () => {};
  worker.terminate = async () => {};
  const events = [];
  const client = createTaskRecordsClient({ workerFactory: () => worker, onSnapshot: s => events.push(s), onError() {} });
  t.after(() => client.dispose());
  const first = client.read('unavailable.jsonl', id);
  worker.emit('error', new Error('worker failed'));
  await first;
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('subsequent read hung after worker failure')), 100); });
  try { await Promise.race([client.read('other.jsonl', id), expired]); } finally { clearTimeout(timer); }
  assert.deepEqual(events, [], 'unavailability must not publish authoritative empty tasks');
});

test('validated child toolUseId merges provisional synchronous and concrete fallback evidence', () => {
  const r = createTaskRegistry();
  const use = copy(fixture.use);
  use.message.content[0].input.run_in_background = false;
  r.ingest(id, use);
  r.note(id, agent, 'local-transcript');
  r.note(id, agent, 'cli-task', { toolUseId: 'toolu_111', subagentType: 'explore' });
  assert.deepEqual(r.agents(id).map(t => t.id), [agent], 'one Agent call must produce one shared agent entry');
  r.prune(60000);
  assert.ok(r.primary(id, agent));
  r.ingest(id, fixture.syncResult);
  assert.equal(r.agents(id).length, 0);
});

test('child metadata resolves a terminal notification received before the launch acknowledgement', () => {
  const r = createTaskRegistry();
  r.ingest(id, fixture.use);
  r.ingest(id, fixture.notification);
  r.note(id, agent, 'cli-task', fixture.childMeta);
  assert.equal(r.agents(id).length, 0, 'correlation must drain an already recorded terminal notification');
});

test('a positively observed resumed owner allows new fallback ids while terminal ids remain protected', () => {
  let at = 1000;
  const r = createTaskRegistry({ now: () => at });
  r.note(id, 'old-agent', 'local-transcript');
  r.ownerDied(id);
  at = 2000;
  r.applySnapshot({ parentSessionId: id, revision: 10, known: true, ownerDiedAt: 1000, ownerAliveAt: 2000, tasks: [{ id: 'old-agent', kind: 'agent', terminal: true, at: 1000 }] });
  assert.equal(r.note(id, 'new-agent', 'local-transcript'), true, 'a new proven owner can supply fallback evidence');
  assert.equal(r.note(id, 'old-agent', 'local-transcript'), false, 'an ended id cannot revive from growth');
});

test('worker child metadata correlates a synchronous launch before its result and ends the concrete agent on result', async t => {
  const file = disk(t);
  const r = createTaskRegistry();
  const client = createTaskRecordsClient({ onSnapshot: snapshot => r.applySnapshot(snapshot) });
  t.after(() => client.dispose());
  const use = copy(fixture.use);
  use.message.content[0].input.run_in_background = false;
  fs.writeFileSync(file, jsonl(use));
  const child = path.join(path.dirname(file), `agent-${agent}.jsonl`);
  fs.writeFileSync(child.replace('.jsonl', '.meta.json'), JSON.stringify(fixture.childMeta));
  await client.read(file, id);
  await client.child(child, id, agent);
  assert.deepEqual(r.agents(id).map(t => t.id), [agent]);
  fs.appendFileSync(file, jsonl(fixture.syncResult));
  await client.read(file, id);
  assert.equal(r.agents(id).length, 0);
});
