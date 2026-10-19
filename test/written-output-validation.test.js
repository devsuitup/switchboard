'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskRecordsClient } = require('../task-records-client');

test('a complete output record in the tail avoids reading backwards through an 8 MB image', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-written-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const tailBytes = 256 * 1024;
  let bytesRead = 0;
  const trackedFs = { ...fs, readSync(...args) {
    const count = fs.readSync(...args);
    bytesRead += count;
    return count;
  } };
  const module = { exports: {} };
  const tailFilename = path.join(__dirname, '../transcript-tail.js');
  const tailModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(tailFilename, 'utf8'), {
    module: tailModule, Buffer, require: name => name === 'node:fs' ? trackedFs : require(name),
  }, { filename: tailFilename });
  const filename = path.join(__dirname, '../transcript-turn.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, require: name => name === 'fs' ? trackedFs
      : name === './transcript-tail' ? tailModule.exports : require(name),
  }, { filename });
  const reader = module.exports.createTranscriptTurnReader({ tailBytes });
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'image', source: { data: 'x'.repeat(8 * 1024 * 1024) } }] } }) + '\n');
  let previous;
  for (const text of ['first answer', 'second answer']) {
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: text } }) + '\n');
    bytesRead = 0;
    const output = reader.read(file).writtenOutput;
    assert.ok(bytesRead <= 1024 * 1024, 'one poll must not scan the 8 MB image');
    assert.notEqual(output, previous);
    assert.match(output, /^[a-f0-9]{64}$/);
    previous = output;
  }
});

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

test('i730c: appending dropped oversized tool results advances the worker written-output signal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-written-dropped-'));
  const file = path.join(dir, 's.jsonl');
  let snapshot;
  const client = createTaskRecordsClient({ onSnapshot: value => { snapshot = value; } });
  t.after(() => { client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const read = async () => {
    await client.readBatch([{ file, parentSessionId: 's', turnOnly: true }]);
    return snapshot.headTurn.writtenOutput;
  };
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'baseline' } }) + '\n');
  let previous = await read();
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5 * 1024 * 1024) }] } }) + '\n';
  for (let record = 0; record < 2; record++) {
    fs.appendFileSync(file, line);
    let written;
    for (let poll = 0; poll < 8; poll++) written = await read();
    assert.notEqual(written, previous, 'a newly dropped record must signal written activity');
    assert.match(written, /^[a-f0-9]{64}$/);
    assert.equal(await read(), written, 'unchanged output must stay stable');
    const coldReader = require('../transcript-turn').createTranscriptTurnReader();
    let cold;
    for (let poll = 0; poll < 8; poll++) cold = coldReader.read(file);
    assert.equal(cold.writtenOutput, written, 'backward and appended scans must identify the same record');
    assert.equal(cold.state, 'unknown');
    previous = written;
  }
});

for (const scan of ['append', 'backward']) {
  for (const [kind, record, changes] of [
    ['system', { type: 'system', content: 'x'.repeat(5 * 1024 * 1024) }, false],
    ['user prompt', { type: 'user', message: { content: 'x'.repeat(5 * 1024 * 1024) } }, false],
    ['tool result', { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5 * 1024 * 1024) }] } }, true],
    ['assistant', { type: 'assistant', message: { content: 'x'.repeat(5 * 1024 * 1024) } }, true],
  ]) {
    test(`i730d: a dropped 5 MiB ${kind} ${changes ? 'advances' : 'preserves'} the worker fingerprint on ${scan}`, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-written-kind-'));
      const file = path.join(dir, 's.jsonl');
      let snapshot;
      const client = createTaskRecordsClient({ onSnapshot: value => { snapshot = value; } });
      t.after(() => { client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
      const read = async () => {
        await client.readBatch([{ file, parentSessionId: 's', turnOnly: true }]);
        return snapshot.headTurn.writtenOutput;
      };
      const baseline = JSON.stringify({ type: 'assistant', message: { content: 'baseline' } }) + '\n';
      fs.writeFileSync(file, baseline);
      const previous = await read();
      assert.match(previous, /^[a-f0-9]{64}$/);
      const line = JSON.stringify(record) + '\n';
      if (scan === 'append') {
        fs.appendFileSync(file, line.slice(0, 17));
        assert.equal(await read(), previous);
        fs.appendFileSync(file, line.slice(17, -1));
        for (let poll = 0; poll < 8; poll++) assert.equal(await read(), previous);
        fs.appendFileSync(file, '\n');
      } else {
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, baseline + line);
      }
      let written;
      for (let poll = 0; poll < 8; poll++) written = await read();
      if (changes) assert.notEqual(written, previous);
      else assert.equal(written, previous, `${kind} must not signal written activity`);
      assert.match(written, /^[a-f0-9]{64}$/);
      assert.equal(await read(), written, 'unchanged output must stay stable');
    });
  }
}

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
