'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../src/main/triggers/trigger-watcher');
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
function watch(t, dir) {
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = dir;
  let actions = 0;
  const watcher = start({ log: { info() {}, warn() {}, error() {} },
    getPtyForSession() { actions++; return null; }, isSessionBusy: () => false,
    lifecycle: { launchAllowed: () => true, stop() { actions++; } } });
  t.after(() => { watcher.close(); if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous; });
  return () => actions;
}

for (const phase of ['claimed', 'prompt-attempted', 'stop-requested']) for (const orphan of [false, true]) {
  test(`restart recovers ${phase} stop ${orphan ? 'orphan' : 'stale input'} without replay`, async t => {
    const f = directory(t);
    const marker = { version: 1, action: 'stop', mode: 'stop', sessionId: ID, requestedSessionId: ID,
      tabKey: ID, deadline: 1, phase, steps_total: phase === 'claimed' ? 0 : 1,
      ...(phase !== 'claimed' ? { wrote: true, text_written: true, enter_written: true, submitted: 'activity',
        delivery: { enterAt: 123, final_turn: { source: 'descriptor', timedOut: false } } } : {}) };
    fs.writeFileSync(f.marker, JSON.stringify(marker));
    if (!orphan) { fs.writeFileSync(f.input, JSON.stringify({ version: 1, action: 'stop', sessionId: ID })); fs.utimesSync(f.input, new Date(0), new Date(0)); }
    const calls = watch(t, f.dir); const r = await waitResult(f.result);
    assert.equal(r.reason, 'interrupted by restart'); assert.equal(r.uncertain, true); assert.equal(r.sessionId, ID);
    assert.equal(r.steps_total, marker.steps_total); assert.equal(calls(), 0, 'recovery must never execute a stop or note');
    if (phase === 'stop-requested') assert.equal(r.stop_requested, true, 'a durably recorded kill request survives restart');
    if (phase !== 'claimed') {
      assert.equal(r.submitted, 'activity');
      assert.ok(r.delivery, 'recorded note evidence must survive restart');
      assert.equal(r.delivery.enterAt, 123);
    }
    assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.existsSync(f.input), false);
  });
}

test('committed closed result wins over leftover input and stop marker, including a duplicate UUID', async t => {
  const f = directory(t); const prior = { version: 1, action: 'stop', sessionId: ID, ok: true, outcome: 'closed', reason: null };
  const bytes = JSON.stringify(prior) + '\n'; fs.writeFileSync(f.result, bytes);
  fs.writeFileSync(f.marker, JSON.stringify({ version: 1, action: 'stop', sessionId: ID, phase: 'stop-requested' }));
  fs.writeFileSync(f.input, JSON.stringify({ version: 1, action: 'stop', sessionId: ID, before: 'Never replay' }));
  const calls = watch(t, f.dir);
  for (let i = 0; i < 30 && fs.existsSync(f.input); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(f.input), false); assert.equal(fs.existsSync(f.marker), false);
  fs.writeFileSync(f.input, JSON.stringify({ version: 1, action: 'stop', sessionId: ID }));
  for (let i = 0; i < 30 && fs.existsSync(f.input); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.readFileSync(f.result, 'utf8'), bytes); assert.equal(calls(), 0);
});

test('failed stop result rename retains input and marker for restart; failed unlink leaves immutable result authoritative', t => {
  const f = directory(t); const marker = { version: 1, action: 'stop', sessionId: ID, phase: 'stop-requested' };
  fs.writeFileSync(f.input, '{}'); fs.writeFileSync(f.marker, JSON.stringify(marker));
  const result = { version: 1, action: 'stop', outcome: 'refused', reason: 'session stop not confirmed', uncertain: true };
  let retained = 0;
  const args = { result, resultPath: f.result, triggerPath: f.input, markerPath: f.marker, retained: () => retained++ };
  const broken = createTriggerActions({ renameWithRetry: () => { throw new Error('disk'); } });
  assert.equal(broken.publish(args), false); assert.equal(retained, 1);
  assert.equal(fs.existsSync(f.input), true); assert.equal(fs.existsSync(f.marker), true);
  assert.equal(broken.readState(f.result, f.marker).result.stop_requested, true);
  const unlink = createTriggerActions({ fs: { ...fs, unlinkSync: () => { throw new Error('unlink'); } }, renameWithRetry: fs.renameSync });
  assert.equal(unlink.publish(args), true); assert.equal(retained, 2);
  assert.deepEqual(unlink.readState(f.result, f.marker).result, result);
});
