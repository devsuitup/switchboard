'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskRecordsClient } = require('../task-records-client');
const { createTaskTranscriptReader } = require('../task-transcript-reader');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const id = fixture.parentSessionId;
const agent = fixture.agentId;
const launch = r => { r.ingest(id, fixture.use); r.ingest(id, fixture.launch); };
const resume = (at = '2026-10-14T00:12:00Z', uuid = 'resume') => ({
  type: 'assistant', timestamp: at, uuid,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: uuid, name: 'SendMessage', input: { to: agent, message: 'Continue' } }] },
});

for (const variant of ['completedNoTool', 'failedNoTool', 'killed', 'stoppedNoOutput']) {
  test(`authenticated ${variant} ends a known agent through the worker snapshot path`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-review-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, id + '.jsonl');
    const renderer = createTaskRegistry();
    const client = createTaskRecordsClient({ onSnapshot: s => renderer.applySnapshot(s) });
    t.after(() => client.dispose());
    fs.writeFileSync(file, [fixture.use, fixture.launch].map(e => JSON.stringify(e)).join('\n') + '\n');
    await client.read(file, id);
    assert.equal(renderer.agents(id).length, 1);
    fs.appendFileSync(file, JSON.stringify(fixture[variant]) + '\n');
    await client.read(file, id);
    assert.equal(renderer.agents(id).length, 0, `${variant} must close the running agent`);
  });
}

test('monitor events, unmarked notifications and unknown task ids cannot end an agent', () => {
  const r = createTaskRegistry();
  launch(r);
  for (const e of [fixture.monitorEvent, fixture.withoutOrigin, { ...fixture.completedNoTool, uuid: 'unknown', message: { role: 'user', content: fixture.completedNoTool.message.content.replaceAll(agent, 'unknown') } }]) {
    r.ingest(id, e);
    assert.equal(r.agents(id).length, 1);
  }
  assert.equal(r.notification(fixture.monitorEvent), null);
  assert.equal(r.notification(fixture.withoutOrigin), null);
});

test('a notification with duplicate tool ids cannot take the no-tool-id correlation path', () => {
  const r = createTaskRegistry();
  launch(r);
  const entry = structuredClone(fixture.notification);
  entry.uuid = 'duplicate-tool';
  entry.message.content = entry.message.content.replace('<tool-use-id>toolu_111</tool-use-id>', '<tool-use-id>toolu_111</tool-use-id><tool-use-id>toolu_other</tool-use-id>');
  r.ingest(id, entry);
  assert.equal(r.agents(id).length, 1);
});

test('SendMessage reopens a completed known agent until its next terminal notification', () => {
  const r = createTaskRegistry();
  launch(r);
  r.ingest(id, fixture.notification);
  assert.equal(r.agents(id).length, 0);
  r.ingest(id, resume());
  assert.equal(r.primary(id, agent), true, 'SendMessage must reopen primary work');
  r.ingest(id, { ...fixture.completedNoTool, uuid: 'completion-2', timestamp: '2026-10-14T00:13:00Z' });
  assert.equal(r.agents(id).length, 0);
  r.ingest(id, { ...resume(), uuid: 'wrong', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', id: 'wrong', input: { to: 'unknown' } }] } });
  assert.equal(r.agents(id).length, 0);
});

for (const kind of ['clear', 'fork']) {
  test(`${kind} moves tasks without redirecting old notes or old owner death`, async t => {
    const r = createTaskRegistry();
    launch(r);
    r.rekey(id, 'new');
    assert.equal(r.agents('new').length, 1);
    r.note(id, 'old-only', 'local-transcript');
    assert.deepEqual(r.agents(id).map(t => t.id), ['old-only']);
    assert.deepEqual(r.agents('new').map(t => t.id), [agent]);
    r.ownerDied(id);
    assert.equal(r.agents('new').length, 1, 'the old owner cannot end moved tasks');
    const client = createTaskRecordsClient();
    t.after(() => client.dispose());
    await client.job(id, { valid: true, at: 10, tasks: [{ id: agent, kind: 'agent', startedAt: 1, doneAt: null }], inFlight: 0 });
    await client.rekey(id, 'new');
    assert.equal(client.hasRecord(id, agent), false, 'client has no permanent old-id alias');
    assert.equal(client.hasRecord('new', agent), true);
    await client.ownerDied(id);
    assert.equal(client.snapshots().find(s => s.parentSessionId === 'new').tasks[0].terminal, false);
  });
}

test('repeated ownerAlive observations leave the revision and liveness timestamp unchanged', () => {
  let at = 100;
  const r = createTaskRegistry({ now: () => at });
  r.ownerAlive(id);
  const before = r.snapshot(id);
  at = 200;
  r.ownerAlive(id);
  assert.deepEqual(r.snapshot(id), before);
  r.ownerDied(id);
  at = 300;
  r.ownerAlive(id);
  assert.equal(r.snapshot(id).ownerAliveAt, 300);
});

test('bounded pending notifications drop oldest unrelated Bash and Monitor records', () => {
  const r = createTaskRegistry({ maxEntries: 3 });
  r.ingest(id, fixture.notification);
  for (let i = 0; i < 3; i++) {
    const e = structuredClone(fixture.notification);
    e.uuid = `bash-${i}`;
    e.message.content = e.message.content.replaceAll(agent, `b${i}`).replaceAll('toolu_111', `toolu_b${i}`);
    r.ingest(id, e);
  }
  launch(r);
  assert.equal(r.agents(id).length, 1, 'the oldest pending completion was evicted');
});

test('seen record ids and continuation redirects retain only their bounded newest entries', () => {
  const r = createTaskRegistry({ maxEntries: 3 });
  launch(r);
  r.ingest(id, fixture.notification);
  r.ingest(id, resume());
  r.ingest(id, { ...fixture.completedNoTool, timestamp: '2026-10-14T00:13:00Z', uuid: 'done-2' });
  r.ingest(id, resume('2026-10-14T00:14:00Z', 'resume-2'));
  r.ingest(id, { ...fixture.completedNoTool, timestamp: '2026-10-14T00:15:00Z', uuid: 'done-3' });
  r.ingest(id, { ...resume('2026-10-14T00:16:00Z'), uuid: 'resume' });
  assert.equal(r.primary(id, agent), true, 'the evicted record id is accepted again');
  for (let i = 0; i < 4; i++) {
    const oldId = `${i}1111111-1111-4111-8111-111111111111`;
    r.ingest(oldId, { type: 'continued-in', sessionId: oldId, continuedInSessionId: '22222222-2222-4222-8222-222222222222', timestamp: fixture.notification.timestamp });
  }
  assert.equal(r.resolve('01111111-1111-4111-8111-111111111111'), '01111111-1111-4111-8111-111111111111');
  assert.equal(r.resolve('31111111-1111-4111-8111-111111111111'), '22222222-2222-4222-8222-222222222222');
});

test('the client bounds continuation aliases while retaining its newest worker redirects', async t => {
  const { EventEmitter } = require('node:events');
  const worker = new EventEmitter();
  worker.postMessage = message => queueMicrotask(() => worker.emit('message', { requestId: message.requestId }));
  worker.terminate = async () => {};
  const client = createTaskRecordsClient({ maxEntries: 3, workerFactory: () => worker });
  t.after(() => client.dispose());
  await client.ownerAlive('new');
  worker.emit('message', { snapshot: { parentSessionId: 'new', tasks: [{ id: agent }] } });
  for (let i = 0; i < 4; i++) worker.emit('message', { rekey: { oldId: `old-${i}`, newId: 'new', continued: true } });
  assert.equal(client.hasRecord('old-0', agent), false);
  assert.equal(client.hasRecord('old-3', agent), true);
});

test('unchanged same-size transcript with newer mtime reads only the 128-byte boundary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'parent.jsonl');
  fs.writeFileSync(file, [fixture.use, fixture.launch].map(e => JSON.stringify(e)).join('\n') + '\n');
  let bytes = 0, ingested = 0;
  const real = require('node:fs/promises');
  const reader = createTaskTranscriptReader({ registry: { ingest() { ingested++; } }, files: {
    stat: real.stat,
    async open(...args) {
      const handle = await real.open(...args);
      return { stat: () => handle.stat(), close: () => handle.close(), async read(...args) { const result = await handle.read(...args); bytes += result.bytesRead; return result; } };
    },
  } });
  t.after(() => reader.dispose());
  await reader.read(file, id);
  bytes = 0;
  fs.utimesSync(file, 2000000000, 2000000000);
  await reader.read(file, id);
  assert.equal(bytes, 128, 'a metadata-only change must not replay the transcript');
  assert.equal(ingested, 2);
  bytes = 0;
  await reader.read(file, id);
  assert.equal(bytes, 0, 'the validated mtime is saved');
  fs.utimesSync(file, 1900000000, 1900000000);
  await reader.read(file, id);
  assert.equal(bytes, 128, 'a backwards metadata-only mtime also retains the validated boundary');
  assert.equal(ingested, 2);
});
