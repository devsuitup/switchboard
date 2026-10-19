'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const transitions = require('../session-transitions');
const { fixture, OLD, HEAD, barrier, tick } = require('./fixtures/continuation-718.cjs');

function setup(t, options = {}) {
  const h = fixture(t); h.write(OLD);
  const entry = { projectFolder: h.folder, pty: { pid: 7 }, knownJsonlFiles: new Set([OLD + '.jsonl']),
    continuationSnapshot: transitions.snapshotContinuations(h.file(OLD), OLD), backgroundCommandSource: OLD };
  h.append(OLD, h.link()); h.activeSessions.set(OLD, entry);
  const events = [], copies = [], confirmed = [], migrated = [];
  h.proof = { sessionId: HEAD, kind: 'bg', jobId: '1234abcd' }; h.hosted = true;
  transitions.init({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, log: h.log,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    rekeyMcpServer: (...args) => migrated.push(args), rekeyActivity: (...args) => migrated.push(args),
    getBackgroundTarget: () => h.proof, backgroundJobExists: () => h.hosted,
    rekeyMetadata: (...args) => { copies.push(args); return options.copy?.(); },
    onBackgroundConfirmed: context => { confirmed.push(context); return options.confirm?.(); },
    clearOwner: () => 'other', setTimeout: () => ({ unref() {} }), ...options.context });
  t.after(() => transitions.init({ activeSessions: new Map() }));
  const detect = () => transitions.detectSessionTransitions(h.folder);
  return Object.assign(h, { entry, events, copies, confirmed, migrated, detect });
}

test('C1/C4 lag then live attach copies once, confirms once and later reuses ACK', { timeout: 9000 }, async t => {
  const ack = barrier(), h = setup(t, { copy: () => ack.promise });
  h.hosted = false; h.detect(); assert.equal(h.copies.length, 0);
  const attach = { isAttach: true, pty: { pid: 8 } }; h.activeSessions.set(HEAD, attach);
  h.hosted = true; h.detect(); h.detect();
  assert.equal(h.copies.length, 1); assert.equal(h.confirmed.length, 1);
  ack.resolve(); await transitions.drainMetadataWrites(); h.detect();
  assert.equal(h.copies.length, 1); assert.equal(h.confirmed.length, 1); assert.equal(h.events.length, 0); assert.equal(h.migrated.length, 0);
  assert.equal(h.activeSessions.get(OLD), h.entry); assert.equal(h.activeSessions.get(HEAD), attach);
  assert.ok(h.logs.some(x => x.join(' ').includes('target-live')));
  h.activeSessions.delete(HEAD); h.detect(); await transitions.drainMetadataWrites();
  assert.equal(h.events.length, 1); assert.equal(h.copies.length, 1); assert.equal(h.confirmed.length, 1);
});

for (const reason of ['source-replaced', 'source-id-changed', 'target-live', 'source-stopped', 'background-proof-changed', 'background-job-gone', 'changed-job', 'revoked-command', 'changed-fresh-proof']) {
  test('C2 post-ACK guard ' + reason, { timeout: 9000 }, async t => {
    const ack = barrier(), h = setup(t, { copy: () => ack.promise }); h.detect();
    if (reason === 'source-replaced') h.activeSessions.set(OLD, {});
    if (reason === 'source-id-changed') h.entry.realSessionId = 'different';
    if (reason === 'target-live') h.activeSessions.set(HEAD, {});
    if (reason === 'source-stopped') h.entry.stopRequested = true;
    if (reason === 'background-proof-changed') h.proof.kind = 'interactive';
    if (reason === 'background-job-gone') h.hosted = false;
    if (reason === 'changed-job') h.proof.jobId = 'different';
    if (reason === 'revoked-command') h.entry.backgroundCommandSource = null;
    if (reason === 'changed-fresh-proof') h.append(OLD, h.link('different'));
    const priority = ['source-replaced', 'source-id-changed', 'target-live', 'source-stopped', 'background-proof-changed', 'background-job-gone'].indexOf(reason);
    if (priority >= 0) {
      if (priority < 1) h.entry.realSessionId = 'different';
      if (priority < 2) h.activeSessions.set(HEAD, {});
      if (priority < 3) h.entry.stopRequested = true;
      if (priority < 4) h.proof.kind = 'interactive';
      if (priority < 5) h.hosted = false;
    }
    ack.resolve(); await transitions.drainMetadataWrites();
    assert.equal(h.events.length, 0); assert.equal(h.migrated.length, 0);
    const expected = ['changed-job', 'revoked-command', 'changed-fresh-proof'].includes(reason) ? 'background-proof-changed' : reason;
    assert.ok(h.logs.some(x => x.join(' ').includes(expected) && x.join(' ').includes('metadataCopied=true')), JSON.stringify(h.logs));
    assert.equal(h.entry._metadataRekey, undefined);
  });
}

for (const asyncFailure of [false, true]) test('C3 copy failure caught and explicitly retried, async=' + asyncFailure, { timeout: 9000 }, async t => {
  let attempts = 0;
  const h = setup(t, { copy: () => { if (++attempts === 1) { if (asyncFailure) return Promise.reject(Error('disk gone')); throw Error('disk gone'); } } });
  assert.doesNotThrow(h.detect); await transitions.drainMetadataWrites(); assert.equal(h.events.length, 0);
  assert.ok(h.logs.some(x => x[0] === 'error' && x.join(' ').includes(OLD) && x.join(' ').includes(HEAD) && x.join(' ').includes('disk gone')));
  h.detect(); await transitions.drainMetadataWrites(); assert.equal(h.events.length, 1);
});

for (const guard of ['source-stopped', 'source-id-changed', 'target-live', 'background-proof-changed', 'background-job-gone']) test('C2 synchronous background adapter revalidates ' + guard, { timeout: 9000 }, async t => {
  let h;
  h = setup(t, { copy: () => {
    if (guard === 'source-stopped') h.entry.stopRequested = true;
    if (guard === 'source-id-changed') h.entry.realSessionId = 'different';
    if (guard === 'target-live') h.activeSessions.set(HEAD, {});
    if (guard === 'background-proof-changed') h.proof.kind = 'interactive';
    if (guard === 'background-job-gone') h.hosted = false;
  } });
  h.detect(); assert.equal(h.events.length, 0); assert.ok(h.logs.some(row => row.join(' ').includes(guard)));
});

for (const negative of ['old', 'unobserved', 'ambiguous', 'incomplete', 'interactive', 'unhosted']) test('C5 negative proof never copies/confirms/publishes: ' + negative, { timeout: 9000 }, async t => {
  const h = setup(t);
  if (negative === 'old') h.entry.continuationSnapshot = transitions.snapshotContinuations(h.file(OLD), OLD);
  if (negative === 'unobserved') h.entry.backgroundCommandSource = null;
  if (negative === 'ambiguous') h.append(OLD, h.link('different'));
  if (negative === 'incomplete') h.append(OLD, '{"type":"continued-in"');
  if (negative === 'interactive') h.proof.kind = 'interactive';
  if (negative === 'unhosted') h.hosted = false;
  h.detect(); await transitions.drainMetadataWrites();
  assert.equal(h.copies.length, 0); assert.equal(h.confirmed.length, 0); assert.equal(h.events.length, 0);
});

for (const rejected of [false, true]) test('A4 callback failure cannot escape metadata cleanup, rejection=' + rejected, { timeout: 9000 }, async t => {
  const h = setup(t, { confirm: () => { if (rejected) return Promise.reject(Error('callback gone')); throw Error('callback gone'); } });
  assert.doesNotThrow(h.detect); await transitions.drainMetadataWrites(); await tick();
  assert.equal(h.events.length, 1); assert.ok(h.logs.some(x => x.join(' ').includes('callback gone')));
});

test('C7 ordinary info diagnostics deduplicate each reason per tuple', { timeout: 9000 }, async t => {
  const ack = barrier(), h = setup(t, { copy: () => ack.promise });
  h.proof = null; h.detect(); h.detect(); h.proof = { kind: 'bg', jobId: '1234abcd' }; h.hosted = false; h.detect(); h.detect();
  h.hosted = true; h.detect(); h.detect(); h.detect(); ack.resolve(); await transitions.drainMetadataWrites();
  for (const reason of ['background-proof-pending', 'background-job-pending', 'metadata-pending']) assert.equal(h.logs.filter(x => x[0] === 'info' && x.join(' ').includes(reason)).length, 1, reason);
});

test('C1 live-target metadata-only attempt falls through to a later owned clear', { timeout: 9000 }, async t => {
  const fs = require('node:fs');
  const h = setup(t, { context: { clearOwner: () => 'mine' } });
  h.activeSessions.set(HEAD, { isAttach: true }); h.detect(); await transitions.drainMetadataWrites();
  const cleared = '44444444-4444-4444-8444-444444444444';
  fs.writeFileSync(h.file(cleared), JSON.stringify({ type: 'user', sessionId: cleared, message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }) + '\n');
  h.detect(); await transitions.drainMetadataWrites();
  assert.equal(h.activeSessions.get(cleared), h.entry);
  assert.equal(h.events.length, 1); assert.equal(h.events[0][3], 'clear');
  assert.ok(h.entry.knownJsonlFiles.has(cleared + '.jsonl'));
});

test('C6 captured effective source routes through real writer metadata command before publication', { timeout: 9000 }, async t => {
  const calls = [], ack = barrier();
  const h = setup(t, { context: { rekeyMetadata: (from, to) => {
    const { createWriterCommands } = require('../session-index-commands');
    createWriterCommands({ getCachedSession: id => ({ customTitle: id + ' title' }), rekeySessionMeta: (...args) => calls.push(args) }).rekeySessionMeta(from, to);
    return ack.promise;
  } } });
  h.activeSessions.delete(OLD); h.activeSessions.set('map-key', h.entry); h.entry.realSessionId = OLD;
  h.detect(); assert.deepEqual(calls, [[OLD, HEAD, OLD + ' title']]); assert.equal(h.events.length, 0);
  ack.resolve(); await transitions.drainMetadataWrites(); assert.equal(h.events[0][1], 'map-key');
});

for (const rejected of [false, true]) test('C2 removed source discards its background attempt after metadata settles, rejection=' + rejected, async t => {
  const ack = barrier(), h = setup(t, { copy: () => ack.promise });
  h.detect(); assert.ok(h.entry._backgroundRekey);
  h.activeSessions.delete(OLD);
  if (rejected) ack.reject(Error('metadata failed')); else ack.resolve();
  await transitions.drainMetadataWrites();
  assert.equal(h.entry._backgroundRekey, undefined, 'removed source must not retain an attempt');
  assert.equal(h.entry._metadataRekey, undefined);
  assert.equal(h.events.length, 0);
});
