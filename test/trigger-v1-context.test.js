'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
function fixture() {
  const writes = []; let proof = true; let start = '10';
  const writer = { sessionId: ID, pid: 300, rawPid: 3, procStart: '30', status: 'idle', statusUpdatedAt: 1000 };
  const session = { pty: { pid: 12345, write: data => writes.push(data) }, generation: 7, sandbox: true,
    host: null, cwd: '/first', composerState: { pending: 0, lastInputAt: 0 } };
  const map = new Map([[ID, session]]);
  const source = {
    deliveryPtyStart: () => start,
    observeTabWriter: () => ({ writer, uncertain: false, identity: 'legacy' }),
    observeTabWriterV1: () => proof ? { writer, uncertain: false, identity: 'namespace' } : { uncertain: true },
    findDeliveryTab: () => ({}), refreshProcessTable: async () => {}, deliveryProcessTableFresh: () => true,
  };
  const ctx = createTriggerContext({ activeSessions: map, cliSessionState: source, isPtyAlive: () => true,
    getCliStatus: () => ({ status: 'busy', statusUpdatedAt: 999 }), lifecycle: { launchAllowed: () => true } });
  const pinned = ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline: Date.now() + 1000 });
  pinned.binding.beginStep('hello');
  return { source, ctx, pinned, session, writes, loseProof: () => { proof = false; }, reusePid: () => { start = '20'; } };
}
test('v1 sandbox status comes from the very same namespace writer proof', () => {
  const f = fixture(); assert.equal(f.pinned.ctx.getCliStatus(ID).status, 'idle');
  f.loseProof(); assert.equal(f.pinned.ctx.getCliStatus(ID), undefined);
});
test('losing namespace proof after text suppresses Enter even for a direct key', () => {
  const f = fixture(); f.pinned.handle.write('hello'); f.loseProof();
  assert.throws(() => f.pinned.handle.write('\r'), /ownership/);
  assert.deepEqual(f.writes, ['hello']);
});
test('v1 deadline suppresses Enter as well as text', () => {
  const f = fixture(); f.pinned.handle.write('hello'); f.pinned.binding.deadline = 0;
  assert.throws(() => f.pinned.handle.write('\r'), /deadline/);
  assert.deepEqual(f.writes, ['hello']);
});
test('same-number PTY PID reuse invalidates the bound start identity', () => {
  const f = fixture(); f.reusePid();
  assert.throws(() => f.pinned.handle.write('hello'), /generation binding changed/);
  assert.deepEqual(f.writes, []);
});
test('expected cwd is checked again at the actual write boundary', () => {
  const f = fixture(); f.pinned.binding.expectedCwd = '/first'; f.session.cwd = '/second';
  assert.throws(() => f.pinned.handle.write('hello'), /expectedCwd does not match/);
  assert.deepEqual(f.writes, []);
});
test('closing after readiness suppresses all subsequent bytes', () => {
  const f = fixture(); f.ctx.lifecycle.launchAllowed = () => false;
  assert.throws(() => f.pinned.handle.write('hello'), /Switchboard is closing/);
  assert.deepEqual(f.writes, []);
});
