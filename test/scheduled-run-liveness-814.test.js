'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const state = require('../cli-session-state');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function transcriptFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'follow-814-')));
  t.after(() => {
    assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('read-session-jsonl'");
  const end = source.indexOf('\n});', start) + 4;
  const followerFile = path.join(__dirname, '../src/main/viewer/transcript-follower.js');
  const follower = fs.existsSync(followerFile) ? require(followerFile).createTranscriptFollower() : null;
  t.after(() => follower?.dispose());
  let invoke;
  vm.runInNewContext(source.slice(start, end), {
    fs, path, Buffer, transcriptFollower: follower,
    getCachedFolder: () => 'fixture', projectsDirForFolder: () => root,
    ipcMain: { handle: (name, handler) => { assert.equal(name, 'read-session-jsonl'); invoke = handler; } },
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const file = path.join(root, 'run.jsonl');
  const line = text => JSON.stringify({ type: 'assistant', message: { content: text } }) + '\n';
  fs.writeFileSync(file, line('first'));
  return { file, line, invoke: options => invoke(null, 'run', options) };
}

test('live message refresh reads only appended data rather than re-reading history', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  fs.appendFileSync(h.file, h.line('second'));
  const original = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = (...args) => { if (args[0] === h.file) fullReads++; return original(...args); };
  try {
    const next = await h.invoke({ mode: 'next', token: initial.token });
    assert.equal(fullReads, 0, 'live refresh must not synchronously re-read the whole transcript');
    assert.equal(next.append, true);
    assert.deepEqual(Array.from(next.entries, entry => entry.message.content), ['second']);
    const idle = await h.invoke({ mode: 'next', token: initial.token });
    assert.deepEqual(Array.from(idle.entries), [], 'unchanged transcripts do not duplicate messages');
  } finally { fs.readFileSync = original; }
});

test('re-arm resumes an unchanged prefix without a full read', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  await h.invoke({ mode: 'next', token: initial.token, final: true });
  await h.invoke({ mode: 'stop', token: initial.token, park: true });
  fs.appendFileSync(h.file, h.line('next run'));
  const original = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = (...args) => { fullReads++; return original(...args); };
  try {
    const next = await h.invoke({ mode: 'follow', checkpoint: initial.token });
    assert.equal(fullReads, 0, 're-arm never reads the full transcript');
    assert.equal(next.append, true);
    assert.equal(next.reset, false);
    assert.deepEqual(Array.from(next.entries, entry => entry.message.content), ['next run']);
  } finally { fs.readFileSync = original; }
});

for (const change of ['replace', 'rewrite', 'expired']) {
  test(`re-arm resets with bounded reads after ${change}`, async t => {
    const h = transcriptFixture(t);
    const initial = await h.invoke({ mode: 'follow' });
    await h.invoke({ mode: 'stop', token: initial.token, park: true });
    if (change === 'replace') fs.renameSync(h.file, h.file + '.old');
    fs.writeFileSync(h.file, h.line('replacement'));
    const readFile = fs.readFileSync, read = fs.readSync;
    let fullReads = 0, bytes = 0;
    fs.readFileSync = (...args) => { fullReads++; return readFile(...args); };
    fs.readSync = (...args) => { const n = read(...args); bytes += n; return n; };
    try {
      const next = await h.invoke({ mode: 'follow', checkpoint: change === 'expired' ? 'expired' : initial.token });
      assert.equal(fullReads, 0);
      assert.ok(bytes <= 8 * 1024 * 1024);
      assert.equal(next.reset, true);
      assert.deepEqual(Array.from(next.entries, entry => entry.message.content), ['replacement']);
      assert.equal((await h.invoke({ mode: 'stop', token: initial.token })).ok, false, 'old stop cannot close the new cursor');
      fs.appendFileSync(h.file, h.line('after reset'));
      const appended = await h.invoke({ mode: 'next', token: next.token });
      assert.equal(appended.reset, false);
      assert.deepEqual(Array.from(appended.entries, entry => entry.message.content), ['after reset']);
    } finally { fs.readSync = read; fs.readFileSync = readFile; }
  });
}

test('re-arm clears the final-size boundary on every subsequent run', async t => {
  const h = transcriptFixture(t);
  let result = await h.invoke({ mode: 'follow' });
  for (const text of ['second run', 'third run']) {
    fs.appendFileSync(h.file, h.line('end of previous run'));
    const final = await h.invoke({ mode: 'next', token: result.token, final: true });
    assert.deepEqual(Array.from(final.entries, entry => entry.message.content), ['end of previous run']);
    await h.invoke({ mode: 'stop', token: result.token, park: true });
    fs.appendFileSync(h.file, h.line(text));
    result = await h.invoke({ mode: 'follow', checkpoint: result.token });
    assert.equal(result.reset, false);
    assert.deepEqual(Array.from(result.entries, entry => entry.message.content), [text]);
  }
});

test('a large API record is skipped with bounded reads before the next visible message', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  fs.appendFileSync(h.file, '{"type":"api-request","params":"');
  for (let i = 0; i < 20; i++) fs.appendFileSync(h.file, 'x'.repeat(1024 * 1024));
  fs.appendFileSync(h.file, '"}\n' + h.line('after API'));
  const original = fs.readSync, readFile = fs.readFileSync;
  let bytes = 0, fullReads = 0;
  fs.readSync = (...args) => { const n = original(...args); bytes += n; return n; };
  fs.readFileSync = (...args) => { if (args[0] === h.file) fullReads++; return readFile(...args); };
  const messages = [];
  try {
    let result;
    for (let i = 0; i < 8; i++) {
      bytes = 0;
      result = await h.invoke({ mode: 'next', token: initial.token });
      assert.equal(fullReads, 0, 'tail reads never use the full-file API');
      assert.ok(bytes <= 8 * 1024 * 1024, 'one follow request is limited to 8 MiB');
      assert.equal(result.skipped, 0, 'API metadata is intentionally ignored, not reported as omitted messages');
      messages.push(...result.entries.map(entry => entry.message.content));
      if (!result.more) break;
    }
    assert.equal(result.more, false);
    assert.deepEqual(messages, ['after API']);
  } finally { fs.readSync = original; fs.readFileSync = readFile; }
});

test('partial UTF-8 writes complete once and a replaced transcript resets the viewer', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  const text = Buffer.from(h.line('café 🧭'));
  const split = text.indexOf(Buffer.from('é')) + 1;
  fs.appendFileSync(h.file, text.subarray(0, split));
  const partial = await h.invoke({ mode: 'next', token: initial.token });
  assert.equal(partial.entries.length, 0, 'a partial line is never presented as a message');
  fs.appendFileSync(h.file, text.subarray(split));
  const complete = await h.invoke({ mode: 'next', token: initial.token });
  assert.deepEqual(Array.from(complete.entries, entry => entry.message.content), ['café 🧭']);
  fs.renameSync(h.file, h.file + '.old');
  fs.writeFileSync(h.file, h.line('replacement'));
  const replaced = await h.invoke({ mode: 'next', token: initial.token });
  assert.equal(replaced.reset, true);
  assert.deepEqual(Array.from(replaced.entries, entry => entry.message.content), ['replacement']);
});

test('oversized visible records are reported and do not prevent following later messages', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  fs.appendFileSync(h.file, h.line('x'.repeat(5 * 1024 * 1024)) + h.line('after long message'));
  const next = await h.invoke({ mode: 'next', token: initial.token });
  assert.equal(next.skipped, 1, 'omitted visible output is explicitly reported');
  assert.deepEqual(Array.from(next.entries, entry => entry.message.content), ['after long message']);
});

test('the final snapshot includes a complete JSON record without a trailing newline', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  fs.appendFileSync(h.file, h.line('final without newline').trimEnd());
  const waiting = await h.invoke({ mode: 'next', token: initial.token });
  assert.equal(waiting.entries.length, 0, 'live reads wait for the record delimiter');
  const next = await h.invoke({ mode: 'next', token: initial.token, final: true });
  assert.deepEqual(Array.from(next.entries, entry => entry.message.content), ['final without newline']);
});

test('the shipped preload forwards follow options and preserves the ordinary read call', async () => {
  const filename = path.join(__dirname, '../preload.js');
  const calls = [];
  let api;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { process,
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({}); }, on() {}, send() {} } }),
  }, { filename });
  const options = { mode: 'next', token: 'opaque', final: true };
  await api.readSessionJsonl('run', options);
  await api.readSessionJsonl('run');
  assert.deepEqual(calls.filter(args => args[0] === 'read-session-jsonl'), [
    ['read-session-jsonl', 'run', options], ['read-session-jsonl', 'run'],
  ]);
});

test('closing a follower interrupts an in-flight read and a stale token performs no reads', async t => {
  const h = transcriptFixture(t);
  const initial = await h.invoke({ mode: 'follow' });
  for (let i = 0; i < 4; i++) fs.appendFileSync(h.file, h.line('x'.repeat(300000)));
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = original(...args); bytes += n; return n; };
  try {
    const pending = h.invoke({ mode: 'next', token: initial.token });
    const beforeClose = bytes;
    const closed = await h.invoke({ mode: 'stop', token: initial.token });
    assert.equal(closed.ok, true);
    const result = await pending;
    assert.match(result.error, /closed/i);
    assert.equal(bytes, beforeClose, 'no more chunks are read after close');
    const stale = await h.invoke({ mode: 'next', token: initial.token });
    assert.match(stale.error, /closed|expired/i);
    assert.equal(bytes, beforeClose);
  } finally { fs.readSync = original; }
});

test('scheduled children notify existing liveness subscribers on start and exit/error', async t => {
  let changes = 0;
  const unsubscribe = state.onStatusesChanged(() => changes++);
  t.after(unsubscribe);
  for (const event of ['exit', 'error']) {
    const child = new EventEmitter();
    child.pid = 12345;
    state.trackScheduleRun('scheduled-' + event, child, '/project', 'Audit');
    t.after(() => child.emit('exit'));
    assert.equal(changes, event === 'exit' ? 1 : 3, 'start must notify the existing liveness channel');
    assert.equal((await state.liveElsewhere('scheduled-' + event, () => false)).kind, 'schedule');
    child.emit(event, event === 'error' ? new Error('spawn failed') : 0);
    assert.equal(changes, event === 'exit' ? 2 : 4, 'end must notify the existing liveness channel');
    child.emit('exit', 0);
    assert.equal(changes, event === 'exit' ? 2 : 4, 'release is idempotent');
  }
});

test('project replies expose current scheduled member ids locally and clear them after exit', t => {
  assert.equal(typeof state.annotateScheduleRuns, 'function', 'project replies need the schedule liveness annotation');
  const child = new EventEmitter();
  child.pid = 12345;
  state.trackScheduleRun('PART', child, '/project', 'Audit');
  t.after(() => child.emit('exit'));
  const local = { sessionId: 'root', headSessionId: 'part', mergedMemberIds: ['part'] };
  const remote = { sessionId: 'part', remoteAlias: 'host' };
  const projects = [{ sessions: [local] }, { remoteAlias: 'host', sessions: [remote] }];
  assert.equal(state.annotateScheduleRuns(projects), projects);
  assert.deepEqual(local.runningScheduleIds, ['part']);
  assert.equal(remote.runningScheduleIds, undefined, 'a matching remote id is independent');
  child.emit('exit', 0);
  state.annotateScheduleRuns(projects);
  assert.equal(local.runningScheduleIds, undefined, 'end removes the liveness field');
});

test('an old child exit cannot clear or announce the end of a newer binding', t => {
  const old = new EventEmitter(), current = new EventEmitter();
  state.trackScheduleRun('reused', old, '/project');
  state.trackScheduleRun('reused', current, '/project');
  t.after(() => current.emit('exit'));
  let changes = 0;
  const unsubscribe = state.onStatusesChanged(() => changes++);
  t.after(unsubscribe);
  old.emit('exit');
  assert.equal(changes, 0);
  current.emit('exit');
  assert.equal(changes, 1);
});
