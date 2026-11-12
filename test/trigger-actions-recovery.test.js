'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rig } = require('./fixtures/session-request-watcher.cjs');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const STEM = '21234567-89ab-cdef-0123-456789abcdef';

function directory(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stop-recovery-')));
  const processed = path.join(dir, 'processed'); fs.mkdirSync(processed);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, input: path.join(dir, STEM + '.json'), marker: path.join(processed, STEM + '.action.json'),
    result: path.join(processed, STEM + '.result.json') };
}
async function waitResult(file) {
  const limit = Date.now() + 3000;
  while (!fs.existsSync(file) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(file), 'startup must publish a terminal result');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
for (const phase of ['claimed', 'prompt-attempted', 'stop-requested']) for (const orphan of [false, true]) {
  test(`restart recovers ${phase} stop ${orphan ? 'orphan' : 'stale input'} without replay`, async t => {
    const marker = { version: 1, action: 'stop', mode: 'stop', sessionId: ID, requestedSessionId: ID,
      tabKey: ID, deadline: 1, phase, steps_total: phase === 'claimed' ? 0 : 1,
      ...(phase !== 'claimed' ? { wrote: true, text_written: true, enter_written: true, submitted: 'activity',
        delivery: { enterAt: 123, final_turn: { source: 'descriptor', timedOut: false } } } : {}) };
    const watcher = await rig(t, { stem: STEM, orphan, stale: !orphan,
      payload: { version: 1, action: 'stop', sessionId: ID },
      setup({ processed }) { fs.writeFileSync(path.join(processed, STEM + '.action.json'), JSON.stringify(marker)); } });
    const f = { input: watcher.input, marker: path.join(watcher.processed, STEM + '.action.json'), result: path.join(watcher.processed, STEM + '.result.json') };
    const r = await waitResult(f.result);
    assert.equal(r.reason, 'interrupted by restart'); assert.equal(r.uncertain, true); assert.equal(r.sessionId, ID);
    assert.equal(r.steps_total, marker.steps_total); assert.equal(watcher.effects(), 0, 'recovery must never execute a stop or note');
    if (phase === 'stop-requested') assert.equal(r.stop_requested, true, 'a durably recorded kill request survives restart');
    if (phase !== 'claimed') {
      assert.equal(r.submitted, 'activity');
      assert.ok(r.delivery, 'recorded note evidence must survive restart');
      assert.equal(r.delivery.enterAt, 123);
    }
    assert.equal(fs.existsSync(f.marker), !orphan); assert.equal(fs.existsSync(f.input), false);
    await watcher.notify();
    assert.equal(fs.existsSync(f.marker), !orphan, 'an extra archive rename event must preserve the marker policy');
    assert.equal(watcher.effects(), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.result, 'utf8')), r);
    if (!orphan) assert.ok(fs.readdirSync(path.dirname(f.result)).some(file => file.endsWith('.request')), 'unknown marker/input identity is archived as a conflict');
  });
}

test('committed closed result wins over leftover input and stop marker, including a duplicate UUID', async t => {
  const prior = { version: 1, action: 'stop', sessionId: ID, ok: true, outcome: 'closed', reason: null };
  const bytes = JSON.stringify(prior) + '\n';
  const watcher = await rig(t, { stem: STEM, payload: { version: 1, action: 'stop', sessionId: ID, before: 'Never replay' },
    setup({ processed }) {
      fs.writeFileSync(path.join(processed, STEM + '.result.json'), bytes);
      fs.writeFileSync(path.join(processed, STEM + '.action.json'), JSON.stringify({ version: 1, action: 'stop', sessionId: ID, phase: 'stop-requested' }));
    } });
  const f = { input: watcher.input, marker: path.join(watcher.processed, STEM + '.action.json'), result: path.join(watcher.processed, STEM + '.result.json') };
  assert.equal(fs.existsSync(f.input), false); assert.equal(fs.existsSync(f.marker), true);
  await watcher.notify();
  assert.equal(fs.existsSync(f.marker), true, 'an extra archive rename event must preserve the completed owner marker');
  fs.writeFileSync(f.input, JSON.stringify({ version: 1, action: 'stop', sessionId: ID }));
  await watcher.notify(); await watcher.notify();
  assert.equal(fs.existsSync(f.input), false); assert.equal(fs.existsSync(f.marker), true);
  assert.equal(fs.readFileSync(f.result, 'utf8'), bytes); assert.equal(watcher.effects(), 0);
});

test('failed stop result rename retains input and marker for restart; failed unlink leaves immutable result authoritative', async t => {
  const f = directory(t); const marker = { version: 1, action: 'stop', sessionId: ID, phase: 'stop-requested' };
  fs.writeFileSync(f.input, '{}'); fs.writeFileSync(f.marker, JSON.stringify(marker));
  const result = { version: 1, action: 'stop', outcome: 'refused', reason: 'session stop not confirmed', uncertain: true };
  let retained = 0;
  const args = { result, resultPath: f.result, triggerPath: f.input, markerPath: f.marker, retained: () => retained++ };
  const broken = createTriggerActions({ renameWithRetry: () => { throw new Error('disk'); } });
  const { createSessionRequestPublication } = require('../src/main/triggers/session-request-publication');
  const { sha } = require('./fixtures/session-request-watcher.cjs');
  const expected = sha(Buffer.from('{}'));
  const namespace = publisher => ({ publish(value) {
    publisher.publish(f.result, Buffer.from(JSON.stringify(value) + '\n'));
    publisher.cleanup(f.input, expected, f.marker);
  } });
  args.namespace = namespace(createSessionRequestPublication({ fs, renameWithRetry: () => { throw new Error('disk'); } }));
  assert.equal(await broken.publish(args), false); assert.equal(retained, 1);
  assert.equal(fs.existsSync(f.input), true); assert.equal(fs.existsSync(f.marker), true);
  assert.equal(broken.readState(f.result, f.marker).result.stop_requested, true);
  const unlink = createTriggerActions({ fs: { ...fs, unlinkSync: () => { throw new Error('unlink'); } }, renameWithRetry: fs.renameSync });
  args.namespace = namespace(createSessionRequestPublication({ fs: { ...fs, unlinkSync: () => { throw new Error('unlink'); } }, renameWithRetry: fs.renameSync }));
  assert.equal(await unlink.publish(args), false); assert.equal(retained, 2);
  assert.deepEqual(unlink.readState(f.result, f.marker).result, result);
});

const openMarker = extra => ({ version: 1, action: 'open', mode: 'new', requestedSessionId: null, sessionId: ID, tabKey: ID,
  deadline: 1, phase: 'spawned', created: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed', steps_total: 1, ...extra });
async function recoverOpen(t, marker, effectsOf) {
  const watcher = await rig(t, { stem: STEM, orphan: true, payload: { version: 1, action: 'open', new: { project: process.cwd(), name: 'Task' }, prompt: 'hello' },
    setup({ processed }) { fs.writeFileSync(path.join(processed, STEM + '.action.json'), JSON.stringify(marker)); } });
  const result = await waitResult(path.join(watcher.processed, STEM + '.result.json'));
  assert.equal(watcher.effects(), 0, 'recovery never launches, saves, delivers or observes');
  effectsOf?.(watcher);
  return result;
}
test('an orphan new-session marker with naming provenance recovers the requested name and no actual name', async t => {
  const r = await recoverOpen(t, openMarker({ nameVersion: 1, requestedName: 'smithy-hardening' }));
  assert.equal(r.reason, 'interrupted by restart'); assert.equal(r.uncertain, true);
  assert.equal(r.requestedName, 'smithy-hardening'); assert.equal(r.actualName, null);
  assert.equal(r.created, true); assert.equal(r.sessionId, ID); assert.equal(r.submitted, 'assumed'); assert.equal(r.steps_total, 1);
  assert.equal(r.enter_written, true);
});
test('an orphan new-session marker from before naming omits both name fields and keeps its effects', async t => {
  const r = await recoverOpen(t, openMarker({}));
  assert.equal(r.reason, 'interrupted by restart'); assert.equal(r.uncertain, true);
  assert.equal('requestedName' in r, false); assert.equal('actualName' in r, false);
  assert.equal(r.created, true); assert.equal(r.submitted, 'assumed'); assert.equal(r.steps_total, 1);
});
const unusable = [
  ['an unknown version', { nameVersion: 2, requestedName: 'Task' }],
  ['a string version', { nameVersion: '1', requestedName: 'Task' }],
  ['a missing version', { requestedName: 'Task' }],
  ['a missing name', { nameVersion: 1 }],
  ['an empty name', { nameVersion: 1, requestedName: '' }],
  ['an untrimmed name', { nameVersion: 1, requestedName: ' Task' }],
  ['a non-string name', { nameVersion: 1, requestedName: { toString: () => 'Task' } }],
  ['an over-long name', { nameVersion: 1, requestedName: 'x'.repeat(257) }],
  ['a control character', { nameVersion: 1, requestedName: 'a\nb' }],
  ['an isolated surrogate', { nameVersion: 1, requestedName: 'a\ud800b' }],
];
for (const [label, naming] of unusable) {
  test(`an orphan marker with ${label} cannot manufacture a name`, async t => {
    const r = await recoverOpen(t, openMarker(naming));
    assert.equal(r.reason, 'interrupted by restart'); assert.equal(r.uncertain, true); assert.equal(r.created, true);
    assert.equal('requestedName' in r, false); assert.equal('actualName' in r, false);
  });
}
test('naming provenance on a resume marker is not accepted', async t => {
  const r = await recoverOpen(t, openMarker({ mode: 'resume', created: undefined, resumed: true, requestedSessionId: ID, nameVersion: 1, requestedName: 'Task' }));
  assert.equal('requestedName' in r, false);
});
test('a stale input beside a named marker does not replay and keeps the marker authoritative for the name', async t => {
  const watcher = await rig(t, { stem: STEM, stale: true, payload: { version: 1, action: 'open', new: { project: process.cwd(), name: 'Other' }, prompt: 'hello' },
    setup({ processed }) { fs.writeFileSync(path.join(processed, STEM + '.action.json'), JSON.stringify(openMarker({ nameVersion: 1, requestedName: 'Task' }))); } });
  const r = await waitResult(path.join(watcher.processed, STEM + '.result.json'));
  assert.equal(r.requestedName, 'Task'); assert.equal(r.actualName, null); assert.equal(watcher.effects(), 0);
});
