'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(t, { jobId = 'abcdef12', open, check } = {}) {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const calls = [];
  Object.assign(w, {
    openSessions: new Map(open ? [['A', open]] : []),
    activePtyIds: new Set(),
    rowSessionIds: row => [row.sessionId, ...(row.mergedMemberIds || [])],
    cleanDisplayName: value => value,
    storedActivitySnapshot: () => ({ liveness: 'dead' }),
    remoteHostLabel: alias => alias === 'host' ? 'VPS' : alias,
    api: { bgAgentLiveJob: async id => {
      calls.push(id);
      return check || { known: true, job: { id: jobId } };
    } },
  });
  const filename = path.join(__dirname, '../public/stop-session-ui.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  return { w, calls };
}

for (const attached of [false, true]) {
  test(`a running ${attached ? 'attached' : 'unattached'} job refusal names the row's Stop session`, async t => {
    const { w, calls } = setup(t, { open: attached ? { attach: true, attachJobId: 'abcdef12' } : undefined });
    const result = await w.stopBeforeArchive({ sessionId: 'A' });
    assert.equal(result.ok, false);
    assert.match(result.error, /background job abcdef12 is still running this session/);
    assert.match(result.error, /use Stop session on its sidebar row first/);
    assert.doesNotMatch(result.error, /Agents view/);
    assert.deepEqual(calls, ['A'], 'reuse the refusal check when planning recovery');
  });
}

for (const [name, options] of [
  ['invalid daemon job id', { jobId: 'unknown-job' }],
  ['unidentified attached job', { open: { attach: true } }],
  ['different attached job', { open: { attach: true, attachJobId: '1234abcd' } }],
  ['interactive tab that Stop would stop instead', { open: { attach: false } }],
]) {
  test(`a refusal with ${name} keeps an actionable fallback`, async t => {
    const { w } = setup(t, options);
    const result = await w.stopBeforeArchive({ sessionId: 'A' });
    assert.equal(result.ok, false);
    assert.match(result.error, /stop it from the Agents view first/);
    assert.doesNotMatch(result.error, /use Stop session/);
  });
}

test('a group refusal names Stop session for a live older member without stopping anything', async t => {
  const { w } = setup(t);
  const jobs = new Map([
    ['A', { known: true, job: null }],
    ['B', { known: true, job: { id: 'abcdef12' } }],
  ]);
  w.api.bgAgentLiveJob = async id => jobs.get(id);
  const result = await w.planSessionArchive([{ sessionId: 'A', mergedMemberIds: ['B'] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Stop session/);
  assert.doesNotMatch(result.error, /Agents view/);
});

test('remote Archive keeps its host stop plan and never checks local daemon jobs', async t => {
  const { w, calls } = setup(t);
  const result = await w.planSessionArchive([{ sessionId: 'A', remoteAlias: 'host', remoteDescriptorSeen: true }]);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
  assert.equal(result.plans[0].plan.targets[0].remote, true);
  assert.match(result.plans[0].plan.confirmText, /on VPS/);
  assert.doesNotMatch(result.plans[0].plan.confirmText, /Agents view|background job/);
});

test('an unknown daemon state retains its reason without promising Stop session', async t => {
  const { w } = setup(t, { check: { known: false, reason: 'daemon offline' } });
  const result = await w.stopBeforeArchive({ sessionId: 'A' });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot tell.*daemon offline/);
  assert.doesNotMatch(result.error, /Stop session/);
});

for (const [jobId, recovery] of [['abcdef12', /use Stop session on its sidebar row/], ['bad-id', /Agents view/]]) {
  test(`an Archive stop plan for ${jobId} gives the available recovery`, async t => {
    const { w } = setup(t, { jobId });
    const plan = await w.planSessionStop({ sessionId: 'A' });
    assert.equal(plan.targets.length, 0);
    assert.match(plan.excluded[0].reason, recovery);
    if (jobId === 'abcdef12') assert.doesNotMatch(plan.confirmText, /Agents view/);
  });
}

test('detach confirmations describe the continuing job without stale stop advice', async t => {
  const { w } = setup(t, { open: { attach: true, attachJobId: 'abcdef12' } });
  const route = w.resolveSessionStop({ sessionId: 'A' }, { attach: true });
  const plan = await w.planSessionStop({ sessionId: 'A' }, { attach: true });
  for (const text of [route.confirmText, plan.confirmText]) {
    assert.match(text, /keeps running/);
    assert.doesNotMatch(text, /Agents view/);
  }
});
