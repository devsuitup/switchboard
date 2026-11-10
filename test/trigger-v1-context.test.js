'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const { createWorld } = require('./fixtures/trigger-sandbox-world.cjs');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
function fixture() {
  const writes = []; let proof = true; let start = '10'; let identity = 'namespace';
  const writer = { sessionId: ID, pid: 300, rawPid: 3, procStart: '30', status: 'idle', statusUpdatedAt: 1000 };
  const session = { pty: { pid: 12345, write: data => writes.push(data) }, generation: 7, sandbox: true,
    host: null, cwd: '/first', composerState: { pending: 0, lastInputAt: 0 } };
  const map = new Map([[ID, session]]);
  const source = {
    deliveryPtyStart: () => start,
    observeTabWriter: () => ({ writer, uncertain: false, identity: 'legacy' }),
    observeTabWriterV1: () => proof ? { writer, uncertain: false, identity } : { uncertain: true },
    findDeliveryTab: () => ({}), refreshProcessTable: async () => {}, deliveryProcessTableFresh: () => true,
  };
  const ctx = createTriggerContext({ activeSessions: map, cliSessionState: source, isPtyAlive: () => true,
    getCliStatus: () => ({ status: 'busy', statusUpdatedAt: 999 }), lifecycle: { launchAllowed: () => true } });
  const pinned = ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline: Date.now() + 1000 });
  pinned.binding.beginStep('hello');
  return { source, ctx, pinned, session, writes, loseProof: () => { proof = false; }, reusePid: () => { start = '20'; },
    regainProof: () => { proof = true; }, replaceWriter: () => { identity = 'replacement'; },
    restoreWriter: () => { identity = 'namespace'; }, observeWith: fn => { source.observeTabWriterV1 = fn; } };
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

const deadline = () => Date.now() + 1000;
test('a replacement writer admitted after the first proof receives no text and no Enter', async () => {
  const f = fixture(); await f.pinned.binding.admit(deadline()); f.replaceWriter();
  assert.throws(() => f.pinned.handle.write('hello'), /session target changed/);
  assert.throws(() => f.pinned.handle.write('\r'), /session target changed/);
  assert.deepEqual(f.writes, []);
});
test('a replacement between text and Enter suppresses Enter and keeps the partial-write evidence', async () => {
  const f = fixture(); await f.pinned.binding.admit(deadline());
  f.pinned.handle.write('hello'); f.replaceWriter();
  assert.throws(() => f.pinned.handle.write('\r'), /session target changed/);
  assert.deepEqual(f.writes, ['hello']);
  assert.equal(f.pinned.binding.step.text_written, true);
  assert.equal(f.pinned.binding.step.enter_written, false);
});
test('a replacement appearing during admission after the first authorized observation is refused', async () => {
  const f = fixture(); const first = f.source.observeTabWriterV1; let reads = 0;
  f.observeWith(args => { const observed = first(args); return ++reads === 1 ? observed : { ...observed, identity: 'replacement' }; });
  await assert.rejects(f.pinned.binding.admit(deadline()), /session target changed/);
  assert.deepEqual(f.writes, []);
});
test('revocation persists on the same binding when the original writer identity reappears', async () => {
  const f = fixture(); await f.pinned.binding.admit(deadline());
  assert.equal(f.pinned.ctx.getCliStatus(ID).status, 'idle');
  f.replaceWriter();
  assert.equal(f.pinned.ctx.getCliStatus(ID), undefined);
  f.restoreWriter();
  assert.equal(f.pinned.ctx.getCliStatus(ID), undefined, 'status stays unavailable after the original identity returns');
  assert.throws(() => f.pinned.handle.write('hello'), /session target changed/);
  assert.throws(() => f.pinned.binding.checkStop(), /session target changed/);
  assert.deepEqual(f.writes, []);
});
test('missing proof alone is not a replacement: the same identity regains status and keeps its authority', async () => {
  const f = fixture(); await f.pinned.binding.admit(deadline());
  f.loseProof(); assert.equal(f.pinned.ctx.getCliStatus(ID), undefined);
  f.regainProof(); assert.equal(f.pinned.ctx.getCliStatus(ID).status, 'idle');
  f.pinned.handle.write('hello'); assert.deepEqual(f.writes, ['hello']);
  f.replaceWriter();
  assert.throws(() => f.pinned.handle.write('\r'), /session target changed/);
});
test('a different valid writer after missing proof does not become the admitted writer', async () => {
  const f = fixture(); await f.pinned.binding.admit(deadline());
  f.loseProof(); assert.equal(f.pinned.ctx.getCliStatus(ID), undefined);
  f.regainProof(); f.replaceWriter();
  assert.equal(f.pinned.ctx.getCliStatus(ID), undefined);
  assert.throws(() => f.pinned.handle.write('hello'), /session target changed/);
  assert.deepEqual(f.writes, []);
});
for (const historical of [false, true]) {
  for (const replace of [false, true]) {
    test(`real reader: writer start 30 replaced by 31 after admission (historical=${historical}, replaced=${replace})`, async t => {
      const w = createWorld(t, { historical }); const p = w.pin();
      await p.binding.admit(w.deadline); p.binding.beginStep('private note');
      if (replace) w.writer('31');
      let refused;
      try { p.handle.write('private note'); p.handle.write('\r'); } catch (error) { refused = error.message; }
      assert.equal(w.writes.length, replace ? 0 : 2);
      assert.equal(refused === undefined, !replace);
      assert.ok(w.writes.every(entry => entry.start === '30'));
    });
  }
}
test('real reader: replacement between text and Enter leaves only the original text', async t => {
  const w = createWorld(t); const p = w.pin(); await p.binding.admit(w.deadline); p.binding.beginStep('private note');
  p.handle.write('private note'); w.writer('31');
  assert.throws(() => p.handle.write('\r'), /session target changed/);
  assert.deepEqual(w.writes.map(entry => [entry.data, entry.start]), [['private note', '30']]);
});
for (const offset of [0, 1]) {
  test(`pinned status is undefined when the final anchor read ends at deadline + ${offset}`, t => {
    const w = createWorld(t); let reads = 0;
    const readLink = w.procFs.readlinkSync;
    w.procFs.readlinkSync = p => { const value = readLink(p); if (p === '/proc/100/ns/pid' && ++reads === 3) w.setClock(w.deadline + offset); return value; };
    const pinned = w.pin();
    assert.equal(pinned.ctx.getCliStatus(ID), undefined);
    assert.equal(pinned.binding.observation.uncertain, true);
  });
}
