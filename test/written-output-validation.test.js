'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRecordsClient } = require('../task-records-client');

test('the worker advances written output for a tool result larger than the transcript tail', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-written-large-'));
  const file = path.join(dir, 's.jsonl');
  let snapshot;
  const client = createTaskRecordsClient({ onSnapshot: value => { snapshot = value; } });
  t.after(() => { client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const read = async () => { await client.readBatch([{ file, parentSessionId: 's', turnOnly: true }]); return snapshot.headTurn.writtenOutput; };
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'baseline' } }) + '\n');
  let previous = await read();
  for (const size of [300, 600]) {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'x'.repeat(size * 1024) }] } });
    fs.appendFileSync(file, line);
    assert.equal(await read(), previous);
    fs.appendFileSync(file, '\n');
    const written = await read();
    assert.notEqual(written, previous);
    fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'progress' }) + '\n');
    assert.equal(await read(), written);
    previous = written;
  }
});

test('the worker validates new main output, ignores metadata/partial writes/children, and carries the signature through rekey', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-written-'));
  const file = path.join(dir, 's.jsonl');
  const snapshots = new Map();
  const client = createTaskRecordsClient({ onSnapshot: snapshot => snapshots.set(snapshot.parentSessionId, snapshot) });
  t.after(() => { client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const append = entry => fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  const read = async () => { await client.readBatch([{ file, parentSessionId: 's', turnOnly: true }]); return snapshots.get('s').headTurn.writtenOutput; };
  fs.writeFileSync(file, '');
  const baseline = await read();
  assert.equal(typeof baseline, 'string');
  for (const entry of [{ type: 'file-history-snapshot' }, { type: 'system', subtype: 'progress' }, { type: 'assistant', isSidechain: true, message: { content: 'child' } }]) {
    append(entry);
    assert.equal(await read(), baseline);
  }
  const answer = { type: 'assistant', uuid: 'one', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'answer' }] } };
  fs.appendFileSync(file, JSON.stringify(answer));
  assert.equal(await read(), baseline);
  fs.appendFileSync(file, '\n');
  const written = await read();
  assert.notEqual(written, baseline);
  append({ ...answer, message: { ...answer.message, usage: { output_tokens: 10 } } });
  assert.equal(await read(), written);
  append({ ...answer, message: { content: [{ text: 'answer', type: 'text', metadata: { cache: true } }] } });
  assert.equal(await read(), written);
  append({ type: 'user', uuid: 'notice', message: { content: [{ type: 'text', text: '<task-notification>completed</task-notification>' }] } });
  const notice = await read();
  assert.notEqual(notice, written);
  client.rekey('s', 'next', { continued: true });
  await client.readBatch([]);
  assert.equal(snapshots.get('next').headTurn.writtenOutput, notice);
});
