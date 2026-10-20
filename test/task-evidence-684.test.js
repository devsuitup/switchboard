'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { normalizeTaskEvidence } = require('../task-records');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');
const { setupSidebarDom } = require('./dom-setup');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const job = (kinds = ['artifact_watch']) => ({ state: 'working', sessionId: SID,
  updatedAt: '2026-10-16T12:00:00.000Z', fan: [],
  inFlight: { tasks: 2, queued: 1, kinds, drainableMonitors: 2 } });

test('artifact watches retain their counts and recognized activity label', () => {
  const evidence = normalizeTaskEvidence(job());
  assert.equal(evidence.valid, true);
  assert.equal(evidence.inFlight, 2);
  assert.equal(evidence.queued, 1);
  assert.equal(evidence.drainableMonitors, 2);
  assert.deepEqual(evidence.inFlightKinds, [{ kind: 'artifact_watch', label: 'Artifact watch', known: true }]);
});

test('future kinds preserve known kinds, task identities and all counts while marking unknown activity', () => {
  const raw = job(['local_agent', 'future_kind']);
  raw.fan = [{ id: 'agent-1', kind: 'agent', startedAt: 1 }];
  const evidence = normalizeTaskEvidence(raw);
  assert.equal(evidence.valid, true);
  assert.equal(evidence.inFlight, 2);
  assert.equal(evidence.queued, 1);
  assert.equal(evidence.drainableMonitors, 2);
  assert.equal(evidence.tasks[0].id, 'agent-1');
  assert.deepEqual(evidence.inFlightKinds, [
    { kind: 'local_agent', label: 'Agent', known: true },
    { kind: 'future_kind', label: 'Unknown activity (future_kind)', known: false },
  ]);
});

test('optional counts default to zero and terminal jobs may omit in-flight evidence', () => {
  const raw = job([]);
  delete raw.inFlight.queued;
  delete raw.inFlight.drainableMonitors;
  const evidence = normalizeTaskEvidence(raw);
  assert.equal(evidence.valid, true);
  assert.equal(evidence.queued, 0);
  assert.equal(evidence.drainableMonitors, 0);
  assert.equal(normalizeTaskEvidence({ ...raw, state: 'done', inFlight: undefined }).valid, true);
});

for (const field of ['queued', 'drainableMonitors']) {
  test(`invalid optional ${field} defaults to zero without invalidating activity`, () => {
    for (const value of [null, '2', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      const raw = job();
      raw.inFlight[field] = value;
      const evidence = normalizeTaskEvidence(raw);
      assert.equal(evidence.valid, true, `${field}: ${JSON.stringify(value)}`);
      assert.equal(evidence[field], 0);
      assert.equal(evidence.inFlight, 2);
      assert.equal(evidence.inFlightKinds[0].label, 'Artifact watch');
    }
  });
}

test('unknown kind labels keep 40 characters and append an ellipsis only when truncated', () => {
  const boundary = 'x'.repeat(40);
  const longKind = boundary + 'hidden-suffix';
  const evidence = normalizeTaskEvidence(job([boundary, longKind]));
  assert.equal(evidence.valid, true);
  assert.deepEqual(evidence.inFlightKinds, [
    { kind: boundary, label: `Unknown activity (${boundary})`, known: false },
    { kind: longKind, label: `Unknown activity (${boundary}…)`, known: false },
  ]);
});

test('malformed in-flight evidence remains invalid for working and terminal jobs', () => {
  const malformed = [null, [], 'activity', {}, { tasks: 2, kinds: null }, { tasks: 2, kinds: 'monitor' },
    ...[null, 1, {}, [], ''].map(kind => ({ tasks: 2, kinds: [kind] }))];
  for (const field of ['tasks']) {
    for (const value of [-1, 0.5, '2', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      malformed.push({ ...job(['monitor']).inFlight, [field]: value });
    }
  }
  for (const state of ['working', 'done']) {
    for (const inFlight of malformed) {
      assert.equal(normalizeTaskEvidence({ ...job(), state, inFlight }).valid, false, JSON.stringify({ state, inFlight }));
    }
  }
});

for (const [kinds, labels, optionalCounts] of [
  [['artifact_watch'], ['Artifact watch'], {}],
  [['monitor', 'future_kind'], ['Monitor', 'Unknown activity (future_kind)'], {}],
  [['artifact_watch'], ['Artifact watch'], { queued: null }],
  [['artifact_watch'], ['Artifact watch'], { drainableMonitors: '2' }],
  [['x'.repeat(40) + 'hidden-suffix'], [`Unknown activity (${'x'.repeat(40)}…)`], {}],
]) {
  test(`roster to renderer shows background activity and labels for ${kinds.join(', ')} ${JSON.stringify(optionalCounts)}`, t => {
    const h = setupSidebarDom();
    t.after(() => h.destroy());
    const filename = path.join(__dirname, '..', 'public', 'agents-view.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
    const raw = job(kinds);
    Object.assign(raw.inFlight, optionalCounts);
    const parsed = parseJobState(JSON.stringify(raw));
    const roster = mergeRoster({ jobs: new Map([['abcdef12', parsed]]), descriptors: [], cli: null });
    h.window.applyAgentsSnapshot({ roster });
    h.emitHeadTurn(SID, 'closed');
    assert.equal(h.window.taskRegistry.background(SID), true);
    assert.equal(h.window.taskRegistry.agents(SID).length, 0);
    const element = h.sidebar.buildSessionItem({ sessionId: SID, bgJobId: 'abcdef12', summary: 'Watching' });
    const status = element.querySelector('.session-status');
    assert.equal(status.textContent, '');
    assert.equal(status.title, '');
    const title = element.querySelector('.session-icon').title;
    assert.match(title, /Background work running · Running in background · job working/);
    assert.ok(!title.includes('hidden-suffix'), title);
    for (const label of labels) assert.ok(title.includes(label), title);
    assert.ok(element.querySelector('.session-icon--agents-busy'));
  });
}

for (const [kinds, optionalCounts, status, diagnostic] of [
  [['artifact_watch'], {}, 0, null],
  [['monitor', 'future_kind'], {}, 1, /PINNED ASSUMPTION BROKEN: unknown inFlight kind.*future_kind/],
  [['artifact_watch'], { queued: null }, 1, /PINNED ASSUMPTION BROKEN:.*queued/],
  [['artifact_watch'], { drainableMonitors: '2' }, 1, /PINNED ASSUMPTION BROKEN:.*drainableMonitors/],
]) {
  test(`canary ${status ? 'flags drift' : 'accepts known'} kinds: ${kinds.join(', ')} ${JSON.stringify(optionalCounts)}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-canary-684-')));
    t.after(() => {
      assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const dir = path.join(root, '.claude', 'jobs', 'abcdef12');
    fs.mkdirSync(dir, { recursive: true });
    const raw = job(kinds);
    Object.assign(raw.inFlight, optionalCounts);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
      path.join(__dirname, 'canary-bg-agents-files.test.js')], {
      encoding: 'utf8', env, timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, /# skipped 0/);
    if (diagnostic) assert.match(result.stdout, diagnostic);
  });
}
