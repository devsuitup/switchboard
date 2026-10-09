'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');

const { setup } = require('./continuations-harness');

for (const children of [['new', 'missing'], ['missing', 'new']]) {
  test(`R3 restore drops a disk-missing sibling (${children.join(', ')}) and persists the existing id`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: children, new: [] });
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), ['new']);
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.settings().openWorkingSet, [{ sessionId: 'new', projectPath: h.root, active: true }]);
    const result = await h.ctx.api.getSessionContinuations('old');
    assert.equal(result.unresolved, false);
    assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new']);
  });
}

for (const location of ['same folder', 'other folder', 'nested folder']) {
  test(`R3 an unindexed transcript in ${location} is not dropped beside an existing target`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: ['new', 'unindexed'], new: [], unindexed: [] });
    h.rows.delete('unindexed');
    if (location !== 'same folder') {
      const targetDir = path.join(h.root, 'other-project', ...(location === 'nested folder' ? ['legacy'] : []));
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(path.join(h.root, h.folder, 'unindexed.jsonl'), path.join(targetDir, 'unindexed.jsonl'));
    }
    const result = await h.ctx.api.getSessionContinuations('old');
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new']);
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
    assert.match(h.dom.window.notice, /sidebar/);
  });
}

for (const graph of [
  { old: ['missing-a', 'missing-b'] },
  { old: ['mid', 'missing-a'], mid: ['missing-b'] },
]) {
  test(`R3 all targets missing at ${graph.mid ? 'a descendant' : 'the root'} remain unresolved`, { timeout: 9000 }, async t => {
    const h = setup(t, graph);
    const result = await h.ctx.api.getSessionContinuations('old');
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.candidates, []);
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
    assert.match(h.dom.window.notice, /sidebar/);
  });
}

test('R3 a failed disk inventory cannot discard an unknown target', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'missing'], new: [] });
  t.mock.method(fs.promises, 'readdir', async () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); });
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
});

for (const [name, graph, expected] of [
  ['one continuation', { old: ['new'], new: [] }, 'new'],
  ['a chain old to mid to new', { old: ['mid'], mid: ['new'], new: [] }, 'new'],
  ['no continued-in record', { old: [] }, 'old'],
  ['converging branches', { old: ['mid', 'new'], mid: ['new'], new: [] }, 'new'],
]) {
  test(`restore resolves ${name} and persists the final id`, { timeout: 9000 }, async t => {
    const h = setup(t, graph);
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), [expected]);
    assert.equal(h.spawned[0].project, h.root);
    assert.deepEqual(h.settings().openWorkingSet, [{ sessionId: expected, projectPath: h.root, active: true }]);
    assert.equal(h.prompts.length, 0);
  });
}

for (const [name, graph] of [
  ['two terminal continuations', { old: ['a', 'b'], a: [], b: [] }],
  ['a cycle', { old: ['mid'], mid: ['old'] }],
  ['a missing continuation', { old: ['missing'] }],
]) {
  test(`restore holds ${name} and spawns nothing on dismissal`, { timeout: 9000 }, async t => {
    const h = setup(t, graph);
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.equal(h.prompts.length, 0);
    assert.match(h.dom.window.notice, /sidebar/);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
    if (name === 'two terminal continuations') {
      assert.match(h.dom.window.notice, /old/);
    }
  });
}

test('manual click offers the continuation before opening it', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true });
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.match(h.prompts[0], /new/);
});

test('choosing the second continuation opens only that candidate and persists it', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['a', 'b'], a: [], b: [] }, { answer: message => /Open b\?/.test(message) });
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['b']);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'b');
});

test('a fresh continuation index resolves without reading transcript contents again', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  const read = t.mock.method(fs, 'readSync');
  const full = t.mock.method(fs, 'readFileSync');
  const result = await h.ctx.api.getSessionContinuations('old');
  assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new']);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(full.mock.callCount(), 0);
});

test('a malformed continuation target holds rather than resuming the old id', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"continued-in","sessionId":"old","continuedInSessionId":"../escape"}\n');
  delete h.rows.get('old').continuationIndex;
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.prompts.length, 0);
  assert.match(h.dom.window.notice, /sidebar/);
});

test('restore attaches to the continued background job', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { live: { new: { kind: 'bg', jobId: '1234abcd', cwd: '/bg', pid: 1 } } });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.spawned[0].options.jobId, '1234abcd');
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'new');
  assert.equal(h.settings().openWorkingSet[0].active, true);
});

test('reopening a closed old tab still offers its continuation', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true });
  vm.runInContext('openSessions.set("old", { session: sessionMap.get("old"), closed: true });', h.ctx);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.match(h.prompts[0], /new/);
});

test('a held old entry is rekeyed when manual continuation opening meets a live schedule', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true, live: { new: { kind: 'schedule', pid: 2 } } });
  vm.runInContext(`skippedWorkingSetEntries.set('old', { item: { sessionId: 'old', projectPath: ${JSON.stringify(h.root)} }, index: 0 });`, h.ctx);
  await h.click();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'new');
});

test('manual continuation attach preserves the rekeyed held working-set entry', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true, live: { new: { kind: 'bg', jobId: '1234abcd', pid: 2 } } });
  vm.runInContext(`skippedWorkingSetEntries.set('old', { item: { sessionId: 'old', projectPath: ${JSON.stringify(h.root)} }, index: 0 });`, h.ctx);
  await h.click();
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.settings().openWorkingSet[0]?.sessionId, 'new');
  assert.equal(h.settings().openWorkingSet[0]?.active, true);
});

for (const size of [2, 5]) test(`legacy cache fallback streams a ${size} MiB ordinary record before continued-in`, { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, JSON.stringify({ sessionId: 'old', type: 'assistant', message: { content: 'x'.repeat(size * 1024 * 1024) } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' }) + '\n');
  delete h.rows.get('old').continuationIndex;
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});

test('a partial continuation recovers once the CLI finishes its record', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"continued-in","sessionId":"old",');
  await h.restore();
  assert.deepEqual(h.spawned, []);
  fs.appendFileSync(file, '"continuedInSessionId":"new"}\n');
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});

test('depth limit holds without resuming the original id', { timeout: 9000 }, async t => {
  const graph = { old: ['n0'] };
  for (let i = 0; i < 35; i++) graph['n' + i] = i === 34 ? [] : ['n' + (i + 1)];
  const h = setup(t, graph);
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.prompts.length, 0);
  assert.match(h.dom.window.notice, /sidebar/);
});

test('refresh indexes a continuation appended beyond the display header', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(300000) } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' }) + '\n{}\n');
  fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
  cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});
