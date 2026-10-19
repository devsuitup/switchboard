'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');
const B = '369b1c23-9bd7-47a2-b4bf-36ee3ca4b55f', J = '369b1c23', K = 'aaaaaaaa';
const job = state => parseJobState(JSON.stringify({ sessionId: B, state, updatedAt: '2026-10-19T08:15:00Z',
  inFlight: { tasks: 0, kinds: [] }, fan: [] }));
for (const cli of [null, [], [{ id: J, sessionId: B, kind: 'background' }]]) {
  test(`T1.1 candidate union retains cached activity with CLI ${JSON.stringify(cli)}`, () => {
    const rows = mergeRoster({ cli, jobs: new Map([[J, job('done')]]),
      descriptors: [{ sessionId: B, jobId: J, kind: 'bg' }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].listed, !!cli?.length);
    assert.equal(rows[0].taskEvidence.valid, true);
    assert.equal(rows[0].hosted, true);
  });
}
test('T1.1 descriptor-only valid job IDs join the union; conflicting CLI identity cannot borrow cached evidence', () => {
  const rows = mergeRoster({ cli: [{ id: J, sessionId: '2a633039-956f-48b4-979a-ce3d4b801ca1', kind: 'background' }],
    jobs: new Map([[J, job('done')]]), descriptors: [{ sessionId: B, jobId: K, kind: 'bg' }] });
  assert.equal(rows.length, 2);
  assert.notEqual(rows.find(r => r.id === J).taskEvidence?.valid, true);
});
for (const reverse of [false, true]) {
  test(`T1.4/T1.7 exact row job wins across sidebar, Agents and incremental paint, reverse=${reverse}`, t => {
    const h = setupSidebarDom(); t.after(() => h.destroy());
    h.evalPublic('agents-view.js');
    const rows = [J, K].map((id, i) => ({ id, sessionId: B, kind: 'background', hosted: true,
      state: i ? 'working' : 'blocked', taskEvidence: job(i ? 'working' : 'blocked').taskEvidence }));
    h.window.applyAgentsSnapshot({ roster: reverse ? rows.reverse() : rows, daemonReachable: true });
    const row = { sessionId: B, bgJobId: J, bgSessionId: B, summary: 'fixture', projectPath: '/p' };
    h.window.sessionMap.set(B, row);
    const item = h.sidebar.buildSessionItem(row); h.document.getElementById('sidebar-content').append(item);
    const check = () => {
      assert.equal(item.querySelector('.session-status').textContent, 'Blocked');
      assert.match(item.querySelector('.session-icon').title, /job blocked/);
      assert.ok(item.querySelector('.session-icon').classList.contains('session-icon--waiting'));
    };
    check();
    h.window.applyStateClasses(B, h.window.storedActivitySnapshot(B)); check();
    h.window.paintSessionIcon(item.querySelector('.session-icon'), B); check();
    h.window.sessionMap.set(B, { ...row, bgJobId: K });
    assert.match(h.window.agentRowIcon(rows.find(e => e.id === J)).title, /job blocked/);
    h.evalPublic('shortcuts.js'); h.evalPublic('grid-view.js');
    const card = h.document.createElement('div'); card.innerHTML = '<span class="grid-card-dot"></span><div class="grid-card-footer"><span></span></div>';
    h.window.updateGridCardActivity(B, card, row);
    assert.match(card.querySelector('.grid-card-dot').title, /job blocked/);
    assert.equal(h.window.selectBackgroundActivity(B, row).entry.id, J);
    assert.equal(h.window.selectBackgroundActivity(B, { ...row, bgJobId: 'bbbbbbbb' }).unavailable, true);
    assert.equal(h.window.selectBackgroundActivity(B, { sessionId: B }).unavailable, true);
  });
}
test('T1.4 exact attach and identity select through marker gaps; non-head identity does not apply', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  h.window.applyAgentsSnapshot({ roster: [J, K].map(id => ({ id, sessionId: B, kind: 'background', state: 'done', hosted: false })) });
  const row = { sessionId: B, projectPath: '/p' };
  h.window.openSessions.set(B, { attach: true, attachJobId: J, session: row });
  assert.equal(h.window.selectBackgroundActivity(B, row).entry?.id, J);
  h.window.openSessions.clear();
  assert.equal(h.window.selectBackgroundActivity(B, { ...row, identityJobId: J, identitySessionId: B }).entry?.id, J);
  assert.equal(h.window.selectBackgroundActivity('a', { sessionId: 'a', identityJobId: J, identitySessionId: B }).entry, null);
});

test('T1.4 attach selection requires a local usable matching project scope', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const w = h.window, row = { sessionId: B, projectPath: '/p' };
  w.applyAgentsSnapshot({ roster: [J, K].map(id => ({ id, sessionId: B, kind: 'background', cachedJob: true, state: 'done' })) });
  for (const open of [
    { attach: true, attachJobId: J },
    { attach: true, attachJobId: J, projectPath: '/foreign' },
    { attach: true, attachJobId: J, projectPath: '/p', exited: true },
    { attach: true, attachJobId: J, session: { projectPath: '/p', remoteAlias: 'remote' } },
  ]) {
    w.openSessions.set(B, open);
    assert.equal(w.selectBackgroundActivity(B, row).entry, null);
    assert.equal(w.backgroundAttachFacts(row).length, 0);
  }
  w.openSessions.set(B, { attach: true, attachJobId: J, projectPath: '/p' });
  assert.equal(w.selectBackgroundActivity(B, row).entry?.id, J);
  assert.equal(w.backgroundAttachFacts({ sessionId: B }).length, 0);
});

test('T1.2 removed jobs clear job-keyed task contributions; independent transcript tasks survive', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const evidence = { ...job('working').taskEvidence, tasks: [{ id: 'task', kind: 'agent', startedAt: 1, doneAt: null }] };
  h.window.applyAgentsSnapshot({ roster: [{ id: J, sessionId: B, kind: 'background', hosted: true, state: 'working', taskEvidence: evidence }] });
  assert.equal(h.window.taskRegistry.agents(B, J).length, 1);
  h.window.applyAgentsSnapshot({ roster: [] });
  assert.equal(h.window.taskRegistry.agents(B, J).length, 0);
});

test('T1.2 another job timestamp cannot age out independent evidence on the same session', () => {
  const { createTaskRegistry } = require('../public/task-registry'); const registry = createTaskRegistry();
  const evidence = at => ({ valid: true, at, inFlight: 1, tasks: [{ id: String(at), kind: 'agent', startedAt: at, doneAt: null }] });
  registry.applyJob(B, evidence(100), { jobId: J }); registry.applyJob(B, evidence(200), { jobId: K });
  registry.applyJob(B, evidence(150), { jobId: J });
  assert.equal(registry.snapshot(B).jobs.find(([id]) => id === J)[1].at, 150);
  assert.equal(registry.agents(B, J)[0].id, '150'); assert.equal(registry.agents(B, K)[0].id, '200');
});

test('T1.2 real corrupt and evicted job reads invalidate current evidence without losing lifecycle', { timeout: 10000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), bg = require('../bg-agents');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-job-719-'));
  const h = setupSidebarDom(); h.evalPublic('agents-view.js');
  t.after(() => { bg.stop(); h.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, J)); const file = path.join(dir, J, 'state.json');
  const raw = { sessionId: B, state: 'done', updatedAt: '2026-10-19T08:15:00Z', inFlight: { tasks: 0, kinds: [] }, fan: [] };
  fs.writeFileSync(file, JSON.stringify(raw));
  bg.init({ jobsDir: dir, homeDir: dir, runClaude: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    cliSessionState: { readAllDescriptors: () => [], onDescriptorsChanged: () => () => {}, ensureWatching: () => true },
    log: { info() {}, debug() {}, warn() {}, error() {} } });
  const wait = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'job watcher published the expected current read'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  bg.start(); const initial = await bg.reconcile(); assert.equal(initial.roster[0].taskEvidence.valid, true);
  h.window.applyAgentsSnapshot(initial);
  fs.writeFileSync(file, '{'); await wait(() => bg.getCachedJobs().get(J)?.taskEvidence.valid === false);
  const invalid = await bg.reconcile(); assert.equal(invalid.roster[0].state, 'done'); assert.equal(invalid.roster[0].sessionId, B);
  h.window.applyAgentsSnapshot(invalid); assert.equal(h.window.backgroundActivityEntry(B).taskEvidence.valid, false);
  assert.match(h.window.backgroundActivityLabel(B, {}).title, /Job activity unavailable/);
  fs.writeFileSync(file, JSON.stringify({ ...raw, updatedAt: '2026-10-19T08:16:00Z' }));
  await wait(() => bg.getCachedJobs().get(J)?.taskEvidence.valid === true); h.window.applyAgentsSnapshot(await bg.reconcile());
  assert.equal(h.window.backgroundActivityEntry(B).taskEvidence.valid, true);
  fs.writeFileSync(file, JSON.stringify(raw)); await wait(() => bg.getCachedJobs().get(J)?.taskEvidence.at === Date.parse(raw.updatedAt));
  h.window.applyAgentsSnapshot(await bg.reconcile()); assert.equal(h.window.backgroundActivityEntry(B).taskEvidence.valid, false);
  fs.rmSync(path.join(dir, J), { recursive: true }); await wait(() => !bg.getCachedJobs().has(J));
  h.window.applyAgentsSnapshot(await bg.reconcile()); assert.equal(h.window.backgroundActivityEntry(B), null);
});

test('T1.2 per-job evidence watermarks survive rekey and job identity moves remove the prior session contribution', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const evidence = { ...job('working').taskEvidence, at: 100, tasks: [{ id: 'task', kind: 'agent', startedAt: 1, doneAt: null }] };
  const registry = h.window.taskRegistry;
  registry.applyJob(B, evidence, { jobId: J }); registry.rekey(B, 'next', { continued: true });
  registry.applyJob('next', { ...evidence, at: 50 }, { jobId: J });
  assert.equal(registry.snapshot('next').jobs[0][1].at, 100);
  const publish = sessionId => h.window.applyAgentsSnapshot({ roster: [{ id: K, sessionId, kind: 'background', state: 'working', hosted: true, taskEvidence: evidence }] });
  publish('old'); publish('new');
  assert.equal(registry.agents('old', K).length, 0);
});

for (const marked of [false, true]) {
  test(`T1.6 selected job changes repaint at constant hosted membership without a projects response, marked=${marked}`, t => {
    const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
    const row = Object.freeze({ sessionId: B, ...(marked ? { bgJobId: J, bgSessionId: B } : {}), summary: 'fixed' });
    h.window.sessionMap.set(B, row); let paints = 0;
    h.window.api.getProjects = () => assert.fail('activity-only event must not reload projects');
    h.window.refreshSidebar = () => { paints++; h.document.getElementById('sidebar-content').replaceChildren(h.sidebar.buildSessionItem(row)); };
    const entry = id => ({ id, sessionId: B, kind: 'background', state: 'done', hosted: true, taskEvidence: job('done').taskEvidence });
    h.window.applyAgentsSnapshot({ roster: [entry(J)] }); assert.equal(paints, 1);
    h.window.applyAgentsSnapshot({ roster: [entry(K)] }); assert.equal(paints, 2);
    assert.equal(h.document.querySelector('.session-status').textContent, marked ? 'Activity unavailable' : 'Idle');
    assert.equal(h.window.selectBackgroundActivity(B, row).entry?.id, marked ? undefined : K);
    h.window.applyAgentsSnapshot({ roster: [{ ...entry(K), tokens: 42, tempo: 'fast', detail: 'metadata' }] }); assert.equal(paints, 2);
  });
}
test('T1.5 hosted-only changes repaint Idle and Job done while Agents stays closed', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const row = { sessionId: B, bgJobId: J }; h.window.sessionMap.set(B, row); let paints = 0;
  h.window.refreshSidebar = () => { paints++; h.document.getElementById('sidebar-content').replaceChildren(h.sidebar.buildSessionItem(row)); };
  const entry = { id: J, sessionId: B, kind: 'background', state: 'done', taskEvidence: job('done').taskEvidence };
  for (const hosted of [true, false, true]) {
    h.window.applyAgentsSnapshot({ roster: [{ ...entry, hosted }] });
    assert.equal(h.document.querySelector('.session-status').textContent, hosted ? 'Idle' : 'Job done');
  }
  assert.equal(paints, 3);
});

test('T1.7 an explicit merged row carries its selected head job through member snapshot combination', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const A = '2a633039-956f-48b4-979a-ce3d4b801ca1';
  const entries = [J, K].map((id, i) => ({ id, sessionId: B, kind: 'background', hosted: true,
    state: i ? 'working' : 'blocked', taskEvidence: job(i ? 'working' : 'blocked').taskEvidence }));
  h.window.applyAgentsSnapshot({ roster: entries });
  h.window.sessionMap.set(B, { sessionId: B, bgJobId: K, status: 'busy' }); h.emitHeadTurn(B, 'open');
  const row = { sessionId: A, headSessionId: B, bgJobId: J, bgSessionId: B, mergedMemberIds: [B], mergedMemberStatuses: { [B]: { status: 'idle' } } };
  const snapshot = h.window.mergedRowSnapshot([A, B], A, { liveness: 'unknown' }, row);
  assert.equal(snapshot.waitingForInput, true); assert.equal(snapshot.busy, false);
  assert.equal(h.window.renderSessionIcon(snapshot).slotClasses[0], 'session-icon--waiting');
});

for (const state of ['working', 'blocked', 'done', 'stopped', 'failed']) for (const descriptorOnly of [false, true]) {
  test(`T1.8 omission retains normal reachable verbs: ${state}, descriptorOnly=${descriptorOnly}`, () => {
    const { agentVerbAvailability } = require('../public/agents-view');
    const descriptors = descriptorOnly || state === 'done' ? [{ sessionId: B, jobId: J, kind: 'bg', pid: 42 }] : [];
    const jobs = descriptorOnly ? new Map() : new Map([[J, job(state)]]);
    const omitted = mergeRoster({ cli: [], jobs, descriptors })[0];
    const listed = mergeRoster({ cli: [{ id: J, sessionId: B, kind: 'background', state: descriptorOnly ? null : state }], jobs, descriptors })[0];
    assert.ok(omitted && listed, 'both parsed snapshots retain the candidate');
    assert.equal(omitted.listed, false); assert.equal(listed.listed, true);
    assert.deepEqual(agentVerbAvailability(omitted, true), agentVerbAvailability(listed, true));
    const unreachable = agentVerbAvailability(omitted, false);
    for (const verb of ['attach', 'stop', 'respawn', 'rm']) assert.equal(unreachable[verb], false);
    assert.equal(unreachable.transcript, true);
  });
}

test('T2.4 changing only cached transcript scope triggers the existing structural job notification', { timeout: 10000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), bg = require('../bg-agents');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-notification-719-'));
  t.after(() => { bg.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, J));
  const file = path.join(dir, J, 'state.json');
  const raw = { sessionId: B, state: 'done', updatedAt: '2026-10-19T08:15:00Z', linkScanPath: path.join(dir, 'p', B + '.jsonl') };
  fs.writeFileSync(file, JSON.stringify(raw));
  bg.init({ jobsDir: dir, homeDir: dir, runClaude: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    cliSessionState: { readAllDescriptors: () => [], onDescriptorsChanged: () => () => {}, ensureWatching: () => true },
    log: { info() {}, debug() {}, warn() {}, error() {} } });
  const changed = action => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('scope change did not notify')); }, 4000);
    const unsubscribe = bg.onJobsChanged(() => { clearTimeout(timer); unsubscribe(); resolve(); });
    action();
  });
  await changed(() => bg.start());
  await changed(() => fs.writeFileSync(file, JSON.stringify({ ...raw, linkScanPath: path.join(dir, 'q', B + '.jsonl') })));
  assert.equal(bg.getCachedJobs().get(J).transcriptPath, path.join(dir, 'q', B + '.jsonl'));
  const snapshot = await bg.reconcile(); assert.equal(snapshot.cliAvailable, true); assert.equal(snapshot.cliEntryCount, 0);
  assert.equal(snapshot.daemonReachable, true); assert.equal(snapshot.roster[0].listed, false);
});
