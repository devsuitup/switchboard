'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, mutate, sha } = require('./fixtures/session-request-watcher.cjs');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const { createSessionRequestPublication } = require('../src/main/triggers/session-request-publication');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');

test('the action publication port refuses cleanup without a namespace decision', async t => {
  const r = await rig(t, { payload: {} });
  const input = path.join(r.dir, 'unguarded.json'), resultPath = path.join(r.processed, 'unguarded.result.json');
  fs.writeFileSync(input, '{}');
  let retained = 0;
  const actions = createTriggerActions({ fs, renameWithRetry: fs.renameSync });
  assert.equal(await actions.publish({ result: { version: 1, action: 'stop' }, triggerPath: input, resultPath,
    markerPath: path.join(r.processed, 'unguarded.action.json'), retained: () => retained++ }), false, 'unguarded action publication must fail closed');
  assert.equal(retained, 1); assert.equal(fs.existsSync(input), true); assert.equal(fs.existsSync(resultPath), false);
});

for (const family of ['legacy', 'action']) for (const fail of ['write', 'flush', 'rename']) {
  test(`${family} ${fail} failure retains input and retry publishes saved bytes without effects`, async t => {
    const r = await rig(t, { fail, stem: 'abcdef01-2345-6789-abcd-0123456789ab', payload: family === 'action'
      ? { version: 1, action: 'stop', sessionId: 'missing' } : {} });
    assert.equal(fs.existsSync(r.input), true, 'failed publication must retain the input');
    assert.deepEqual(fs.readFileSync(r.input), r.body, 'failed publication must retain the exact input');
    assert.equal(fs.existsSync(path.join(r.processed, r.stem + '.result.json')), false);
    const outcome = await r.journal.querySessionRequestOutcome({ stemKey: r.stem });
    assert.ok(outcome.owner?.resultBytes, 'publication candidate must be acknowledged before the file write');
    assert.equal(r.timers.values().next().value?.ms, 250);
    const effects = r.effects(); r.control.fail = null;
    await r.retry();
    assert.deepEqual(fs.readFileSync(path.join(r.processed, r.stem + '.result.json')), Buffer.from(outcome.owner.resultBytes));
    assert.equal(fs.existsSync(r.input), false);
    assert.equal(r.effects(), effects, 'publication retry cannot repeat any effect');
    r.watcher.close(); assert.equal(r.timers.size, 0);
  });
}

test('lost claim ACK publishes nothing and retry refuses uncertain legacy effects', async t => {
  const r = await rig(t, { ackError: true });
  assert.equal(fs.existsSync(r.input), true, 'lost ACK must retain input');
  assert.deepEqual(fs.readFileSync(r.input), r.body);
  assert.equal(r.effects(), 0);
  assert.deepEqual(fs.readdirSync(r.processed), []);
  r.control.ackError = false;
  await r.retry();
  assert.equal(r.effects(), 0, 'a committed pending claim never authorizes repeating an uncertain effect');
  assert.equal(fs.existsSync(r.input), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.processed, r.stem + '.result.json'), 'utf8')), {
    ok: false, submitted: 'no', wrote: true, steps_total: 0,
    error: 'interrupted by restart', reason: 'an earlier attempt may have executed; no automatic retry was performed', uncertain: true,
  }, 'an uncertain claim must block transport re-arming');
});

test('publication retry backoff is capped and watcher close cancels all timers', async t => {
  const r = await rig(t, { fail: 'rename', payload: {} });
  for (const delay of [250, 1000, 5000, 30000, 30000]) {
    assert.equal(r.timers.values().next().value?.ms, delay);
    await r.retry();
  }
  r.watcher.close(); assert.equal(r.timers.size, 0);
});

test('failed recovery publication retains both input and action marker, then retries stored bytes', async t => {
  const stem = 'abcdef01-2345-6789-abcd-0123456789ab', journal = createJournal();
  const raw = Buffer.from(JSON.stringify({ version: 1, action: 'stop', sessionId: 'missing' }));
  await mutate(journal, 'claimSessionResultNamespace', { stemKey: stem, actualStem: stem, family: 'action', rawHash: sha(raw), suppliedHash: null });
  const r = await rig(t, { journal, stem, raw, fail: 'rename', setup({ processed }) {
    fs.writeFileSync(path.join(processed, stem + '.action.json'), JSON.stringify({ version: 1, action: 'stop', sessionId: 'missing', phase: 'stop-requested' }));
  } });
  const marker = path.join(r.processed, stem + '.action.json');
  assert.equal(fs.existsSync(r.input), true, 'failed recovery publication retains input');
  assert.equal(fs.existsSync(marker), true, 'failed recovery publication retains marker');
  const bytes = (await journal.querySessionRequestOutcome({ stemKey: stem })).owner.resultBytes;
  assert.ok(bytes);
  r.control.fail = null; await r.retry();
  assert.deepEqual(fs.readFileSync(path.join(r.processed, stem + '.result.json')), Buffer.from(bytes));
  assert.equal(fs.existsSync(marker), false); assert.equal(r.effects(), 0);
});

test('Windows directory-flush unsupported policy logs once while unexpected post-rename failures retain input', async t => {
  const r = await rig(t, { payload: {} }), target = path.join(r.processed, 'directory-flush.result.json');
  let warnings = 0;
  const publisher = createSessionRequestPublication({ platform: 'win32', renameWithRetry: fs.renameSync,
    log: { warn: () => warnings++ }, fs: { ...fs, openSync(file, ...args) {
      if (file === r.processed) throw Object.assign(new Error('directory handles unsupported'), { code: 'EISDIR' });
      return fs.openSync(file, ...args);
    } } });
  publisher.publish(target, Buffer.from('one\n')); publisher.publish(target, Buffer.from('one\n'));
  assert.equal(warnings, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'one\n');
  const failed = await rig(t, { payload: {}, fs: { openSync(file, ...args) {
    if (path.basename(file) === 'processed') throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
    return fs.openSync(file, ...args);
  } } });
  assert.equal(fs.existsSync(failed.input), true, 'a visible rename cannot authorize cleanup after unexpected parent flush failure');
  assert.ok(fs.existsSync(path.join(failed.processed, failed.stem + '.result.json')), 'post-rename visibility cannot be retracted');
  const bytes = fs.readFileSync(path.join(failed.processed, failed.stem + '.result.json'));
  await failed.retry();
  assert.deepEqual(fs.readFileSync(path.join(failed.processed, failed.stem + '.result.json')), bytes);
  assert.equal(failed.effects(), 0);
});

test('a different incoming request cannot strand the saved original result after a failed publication', async t => {
  const r = await rig(t, { fail: 'rename', payload: {} });
  const original = (await r.journal.querySessionRequestOutcome({ stemKey: r.stem })).owner.resultBytes;
  fs.writeFileSync(r.input, JSON.stringify({ sessionId: 'missing', command: 'different' }));
  r.control.fail = null; await r.retry();
  const output = path.join(r.processed, r.stem + '.result.json');
  assert.ok(fs.existsSync(output), 'a conflict must also restore the acknowledged original result when publication was pending');
  assert.deepEqual(fs.readFileSync(output), Buffer.from(original));
  assert.ok(fs.readdirSync(r.processed).some(name => name.endsWith('.request')));
  assert.equal(r.effects(), 0);
});

test('lost publication ACK retains input with no ordinary file, and the ordered retry uses committed bytes', async t => {
  const r = await rig(t, { ackError: 'recordSessionResultPublication' });
  assert.equal(fs.existsSync(r.input), true);
  assert.deepEqual(fs.readdirSync(r.processed), [], 'lost ACK cannot publish a generic fallback');
  const first = await r.journal.querySessionRequestOutcome({ stemKey: r.stem }), effects = r.effects();
  assert.ok(first.owner.resultBytes);
  r.control.ackError = false; await r.retry();
  assert.deepEqual(fs.readFileSync(path.join(r.processed, r.stem + '.result.json')), Buffer.from(first.owner.resultBytes));
  assert.equal(r.effects(), effects);
});
