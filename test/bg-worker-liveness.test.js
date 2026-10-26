'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWorkerLiveness } = require('../bg-worker-liveness');
const bootTime = Date.parse('2026-10-25T10:00:00Z');
const stamp = ms => String((BigInt(ms) + 11644473600000n) * 10000n);
const job = { id: 'aaaaaaaa', daemonShort: 'bbbbbbbb', sessionId: 's', updatedAt: '2026-10-25T11:00:00Z' };
function sample(overrides = {}) {
  const worker = { pid: 42, procStart: stamp(bootTime + 1000) };
  return { descriptors: [], roster: { proto: 1, supervisorPid: 43, updatedAt: '2026-10-25T12:00:00Z', workers: { bbbbbbbb: worker } },
    processTableFresh: true, tableEntry: pid => [42, 43].includes(pid) ? { created: worker.procStart } : undefined,
    bootTime, observedAt: bootTime + 10000000, ...overrides };
}
test('A-T5 live descriptor is sufficient even when the roster is unreadable', () => {
  assert.equal(classifyWorkerLiveness(job, sample({ roster: null, descriptors: [{ kind: 'bg', jobId: job.id, sessionId: 's' }] })), 'live');
  assert.equal(classifyWorkerLiveness(job, sample({ roster: null, descriptors: [{ kind: 'interactive', sessionId: 's' }] })), 'unknown');
});
test('A-T5 matching process creation proves live, keyed by daemonShort rather than id', () => {
  assert.equal(classifyWorkerLiveness(job, sample()), 'live');
  const s = sample();
  s.roster.workers = { [job.id]: s.roster.workers[job.daemonShort] };
  assert.equal(classifyWorkerLiveness({ ...job, daemonShort: null }, s), 'live');
});
for (const [name, change] of [
  ['unreadable roster', s => { s.roster = null; }],
  ['proto 2', s => { s.roster.proto = 2; }],
  ['stale table', s => { s.processTableFresh = false; }],
  ['unparseable FILETIME', s => { s.roster.workers.bbbbbbbb.procStart = 'broken'; }],
  ['pid reuse', s => { s.tableEntry = () => ({ created: stamp(bootTime + 2000) }); }],
  ['missing worker', s => { s.roster.workers = {}; }],
  ['missing process snapshot', s => { s.tableEntry = undefined; }],
  ['invalid boot time', s => { s.bootTime = NaN; }],
]) {
  test(`A-T5 unknown remains unknown: ${name}`, () => {
    const s = sample(); change(s);
    assert.equal(classifyWorkerLiveness(job, s), 'unknown');
  });
}
for (const field of ['procStart', 'updatedAt']) {
  test(`A-T5 ${field} before boot proves death`, () => {
    const s = sample({ tableEntry: () => undefined });
    if (field === 'procStart') s.roster.workers.bbbbbbbb.procStart = stamp(bootTime - 1000);
    else s.roster.updatedAt = new Date(bootTime - 1000).toISOString();
    assert.equal(classifyWorkerLiveness(job, s), 'dead');
  });
}
test('A-T5 supervisor absence needs a delayed agreeing re-read, newer than the job', () => {
  const first = sample({ tableEntry: () => undefined });
  const second = sample({ tableEntry: () => undefined, observedAt: first.observedAt + 1000 });
  assert.equal(classifyWorkerLiveness(job, first), 'unknown');
  assert.equal(classifyWorkerLiveness(job, first, { ...second, observedAt: first.observedAt + 999 }), 'unknown');
  assert.equal(classifyWorkerLiveness(job, first, second), 'dead');
  assert.equal(classifyWorkerLiveness({ ...job, updatedAt: '2026-10-25T13:00:00Z' }, first, second), 'unknown');
});
test('A-T5 spawn race or stale/disagreeing second read stays unknown', () => {
  const first = sample({ tableEntry: () => undefined });
  for (const change of [s => { s.tableEntry = () => ({ created: stamp(bootTime + 2000) }); },
    s => { s.roster.updatedAt = '2026-10-25T12:01:00Z'; }, s => { s.processTableFresh = false; }, s => { s.roster = null; }]) {
    const second = sample({ tableEntry: () => undefined, observedAt: first.observedAt + 1000 });
    change(second);
    assert.equal(classifyWorkerLiveness(job, first, second), 'unknown');
  }
});
test('A-T5 pid reuse can still be dead when an independent boot proof exists', () => {
  const s = sample({ tableEntry: () => ({ created: stamp(bootTime + 2000) }) });
  s.roster.updatedAt = new Date(bootTime - 1000).toISOString();
  assert.equal(classifyWorkerLiveness(job, s), 'dead');
});

test('A-T5 invalid observations cannot confirm supervisor death', () => {
  for (const change of [s => { s.bootTime = NaN; }, s => { s.roster.workers.bbbbbbbb.procStart = 'broken'; },
    s => { s.roster.updatedAt = 'broken'; }]) {
    const first = sample({ tableEntry: () => undefined });
    const second = sample({ tableEntry: () => undefined, observedAt: first.observedAt + 1000 });
    change(first); change(second);
    assert.equal(classifyWorkerLiveness(job, first, second), 'unknown');
  }
});
