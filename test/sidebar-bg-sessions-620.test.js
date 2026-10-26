'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const cli = require('../cli-session-state');
const bgAgents = require('../bg-agents');
const { encodeProjectPath } = require('../encode-project-path');
const { scanContinuationIndex, resolveContinuationsSync } = require('../session-continuations');
const { setupSidebarDom } = require('./dom-setup');

const OLD = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const HEAD = '33333333-3333-4333-8333-333333333333';

test('A-T7 running sidebar job needs a live descriptor and accepts its state', t => {
  const h = setup(t, { state: 'running', indexedHead: true });
  assert.equal(bgAgents.getCachedJobs().get('33333333').state, 'running');
  const row = h.projects().flatMap(p => p.sessions).find(s => s.sessionId === HEAD);
  assert.equal(row.bgJobId, '33333333');
  assert.equal(h.render().querySelector('.bg-badge')?.textContent, 'bg');
  h.die();
  const dead = h.projects().flatMap(p => p.sessions).find(s => s.sessionId === HEAD);
  assert.equal(dead?.bgJobId ?? null, null);
});

function setup(t, { graph = {}, indexedHead = false, source = 'user', hidden = false, archived = false, state = 'working' } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-620-')));
  const projectPath = path.join(root, 'project');
  const projectsDir = path.join(root, 'projects');
  const dir = path.join(root, 'sessions');
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(jobsDir, '33333333'), { recursive: true });
  const jobFile = path.join(jobsDir, '33333333', 'state.json');
  fs.writeFileSync(jobFile, JSON.stringify({ state, sessionId: HEAD, respawnFlags: ['--name', 'fixture launch'] }));
  const folder = encodeProjectPath(projectPath);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const rows = [];
  const modified = '2026-10-14T00:00:00.000Z';
  for (const [id, targets] of Object.entries(graph)) {
    const file = path.join(projectsDir, folder, id + '.jsonl');
    const records = [{ type: 'user', sessionId: id, cwd: projectPath, timestamp: modified, message: { content: 'fixture prompt' } },
      ...targets.map(target => ({ type: 'continued-in', sessionId: id, continuedInSessionId: target, timestamp: modified }))];
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    rows.push({ sessionId: id, folder, projectPath, modified, fileMtime: fs.statSync(file).mtime.toISOString(),
      messageCount: 2, summary: 'fixture prompt', customTitle: 'fixture launch (2)', continuationIndex: scanContinuationIndex(file, id) });
  }
  if (indexedHead && !rows.some(row => row.sessionId === HEAD)) {
    rows.push({ sessionId: HEAD, folder, projectPath, modified, messageCount: 3, summary: 'first own turn', customTitle: 'fixture launch (2)' });
  }
  const headFile = path.join(projectsDir, folder, HEAD + '.jsonl');
  fs.writeFileSync(headFile, [
    { type: 'custom-title', sessionId: HEAD, customTitle: 'fixture launch (2)' },
    { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } },
    { type: 'queue-operation', operation: 'enqueue', sessionId: HEAD },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(cache.readSessionFile(headFile, folder, projectPath), null, 'bookkeeping before the first turn is not indexed');
  const descriptor = { pid: 4242, procStart: '111', kind: 'bg', jobId: '33333333', sessionId: HEAD,
    cwd: projectPath, status: 'idle', statusUpdatedAt: 100, startedAt: Date.parse(modified),
    name: 'fixture renamed', nameSource: source, version: '2.1.296' };
  const descriptorFile = path.join(dir, '4242.json');
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptor));
  let alive = true;
  let clock = Date.now();
  const activeSessions = new Map();
  cli.init({ dir, activeSessions, onIdle() {}, isProcessAlive: () => alive, readProcStart: () => '111', readParentPid: () => null, now: () => clock });
  assert.equal(cli.ensureWatching(), true);
  bgAgents.init({ jobsDir, cliSessionState: cli, resolveProjectRoots: async cwd => ({ projectRoot: cwd, worktreeRoot: cwd }) });
  bgAgents.start();
  const meta = new Map(rows.map(row => [row.sessionId, { name: 'fixture launch (2)', archived: archived ? 1 : 0 }]));
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log: console,
    getLocalDescriptors: () => cli.getSidebarDescriptors?.() || [],
    getLocalJobs: () => bgAgents.getCachedJobs?.() || new Map(),
    db: { getAllCached: () => rows, getAllMeta: () => meta,
      getAllFolderMeta: () => new Map([[folder, { projectPath }]]),
      getSetting: key => key === 'global' ? { hiddenProjects: hidden ? [projectPath] : [] } : null } });
  const ctx = setupSidebarDom();
  t.after(() => { ctx.destroy(); bgAgents.stop(); cli.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const projects = () => cache.buildProjectsFromCache(false);
  const render = () => { ctx.sidebar.renderProjects(projects(), false); return ctx.document; };
  const firstTurn = () => {
    fs.appendFileSync(headFile, [
      { type: 'user', sessionId: HEAD, cwd: projectPath, timestamp: modified, message: { content: 'first own turn' } },
      { type: 'assistant', timestamp: modified, message: { content: 'first reply' } },
      { type: 'assistant', timestamp: modified, message: { content: 'second reply' } },
    ].map(JSON.stringify).join('\n') + '\n');
    const row = cache.readSessionFile(headFile, folder, projectPath);
    assert.ok(row);
    rows.push(row);
  };
  return { rows, meta, descriptor, descriptorFile, jobFile, projects, render, ctx, firstTurn, activeSessions, die: () => { alive = false; clock += 5001; } };
}

async function afterEvent(subscribe, action) {
  let unsubscribe, timeout;
  try {
    await new Promise((resolve, reject) => {
      unsubscribe = subscribe(resolve);
      timeout = setTimeout(() => reject(new Error('no watcher notification')), 4000);
      action();
    });
  } finally { unsubscribe?.(); clearTimeout(timeout); }
}

test('a done hosted bg UUID keeps its descriptor-only sidebar row', t => {
  const h = setup(t, { state: 'done' });
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].descriptorOnly, true);
  assert.equal(sessions[0].bgJobId, '33333333');
  assert.equal(h.render().querySelector('.bg-badge')?.textContent, 'bg');
});

for (const reason of ['before the job watcher fills', 'when only another job is cached']) {
  test(`a live bg descriptor keeps its sidebar row without cached job metadata ${reason}`, t => {
    const h = setup(t);
    const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
    const jobs = reason === 'when only another job is cached' ? new Map([['other-job', { state: 'working' }]]) : new Map();
    const projects = [];
    mergeLocalBackgroundSessions(projects, [], cli.getSidebarDescriptors(), {
      jobs, metaMap: new Map(), hiddenProjects: new Set(), showArchived: false,
    });
    assert.equal(jobs.has('33333333'), false);
    const rows = projects.flatMap(project => project.sessions);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].descriptorOnly, true);
    assert.equal(rows[0].sessionId, HEAD);
    assert.equal(rows[0].bgJobId, h.descriptor.jobId);
  });
}

test('a done hosted continuation keeps its head, merged members and registry rename', t => {
  const h = setup(t, { state: 'done', graph: { [OLD]: [MID], [MID]: [HEAD] }, indexedHead: true });
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, HEAD);
  assert.deepEqual(sessions[0].mergedMemberIds.slice().sort(), [OLD, MID].sort());
  assert.equal(sessions[0].name, 'fixture renamed');
  assert.equal(sessions[0].bgJobId, '33333333');
});

test('hosted sidebar membership and continuation identity do not flip across turn boundaries', async t => {
  const h = setup(t, { graph: { [OLD]: [MID], [MID]: [HEAD] }, indexedHead: true });
  const baseline = h.projects();
  for (const state of ['done', 'working']) {
    await afterEvent(bgAgents.onJobsChanged, () => {
      fs.writeFileSync(h.jobFile, JSON.stringify({ state, sessionId: HEAD, respawnFlags: ['--name', 'fixture launch'] }));
    });
    assert.deepEqual(h.projects(), baseline);
    assert.equal(h.render().querySelector('.bg-badge')?.textContent, 'bg');
  }
});

test('an attached live bg UUID has a sidebar row before its first indexed turn and before opening Agents', t => {
  const h = setup(t);
  const row = h.render().querySelector(`[data-session-id="${HEAD}"]`);
  assert.ok(row, 'the descriptor-only background row must be visible');
  assert.equal(row.querySelector('.bg-badge')?.textContent, 'bg');
  assert.equal(row.querySelector('.session-summary').textContent, 'bgfixture renamed');
  assert.equal(h.projects().flatMap(p => p.sessions)[0].messageCount, 0);
  h.firstTurn();
  assert.equal(h.projects().flatMap(p => p.sessions).length, 1, 'indexing replaces the synthetic row');
  assert.equal(h.projects().flatMap(p => p.sessions)[0].messageCount, 3);
});

test('a two-hop proven bg continuation stays on one representative row before and after the first turn', t => {
  const h = setup(t, { graph: { [OLD]: [MID], [MID]: [HEAD] } });
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1, 'one conversation row, no separate continuation row');
  assert.equal(sessions[0].sessionId, HEAD);
  assert.ok(sessions[0].mergedMemberIds.includes(OLD));
  assert.ok(sessions[0].mergedMemberIds.includes(MID));
  assert.equal(sessions[0].messageCount, 4);
  const row = h.render().querySelector(`[data-session-id="${HEAD}"]`);
  assert.equal(row.querySelector('.bg-badge')?.textContent, 'bg');
  assert.equal(sessions[0].name, 'fixture renamed');
  h.firstTurn();
  assert.equal(h.projects().flatMap(p => p.sessions).length, 1);
  assert.equal(h.projects().flatMap(p => p.sessions)[0].messageCount, 7);
  assert.equal(h.rows[0].messageCount, 2, 'display projection must not mutate the cache');
});

test('an indexed bg row uses the user registry rename without opening Agents', t => {
  const h = setup(t, { indexedHead: true });
  const row = h.render().querySelector(`[data-session-id="${HEAD}"]`);
  assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'fixture renamed');
  assert.equal(row.querySelector('.bg-badge')?.textContent, 'bg');
});

test('a registry name whose source is not user keeps the indexed display name', t => {
  const h = setup(t, { indexedHead: true, source: 'generated' });
  assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'fixture launch (2)');
});

test('a name-only registry update notifies projects and updates the rendered name', async t => {
  const h = setup(t, { indexedHead: true });
  await afterEvent(cli.onStatusesChanged, () => {
    fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, name: 'second rename' }));
  });
  assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'second rename');
});

test('a dead bg descriptor loses its synthetic row', t => {
  const h = setup(t);
  assert.equal(h.projects().flatMap(p => p.sessions).length, 1);
  h.die();
  assert.equal(h.projects().flatMap(p => p.sessions).length, 0);
});

test('ambiguous and cyclic continuation evidence never selects a bg representative', t => {
  const h = setup(t, { graph: { [OLD]: [MID, HEAD], [MID]: [] } });
  assert.equal(h.projects().flatMap(p => p.sessions).length, 3);
  h.rows[0].continuationIndex = JSON.stringify({ format: 3, complete: true, ids: [OLD], mtime: h.rows[0].fileMtime });
  assert.equal(h.projects().flatMap(p => p.sessions).length, 3);
});

test('incomplete indexes and a shared bridge label do not prove continuation identity', t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] }, indexedHead: true });
  h.rows[0].continuationIndex = JSON.stringify({ format: 3, complete: false, ids: [HEAD] });
  for (const row of h.rows) row.bridgeSessionId = 'cse_fixture';
  assert.equal(h.projects().flatMap(p => p.sessions).length, 2);
});

test('a fork that converges on the bg head does not collapse the branching predecessor', t => {
  const h = setup(t, { graph: { [OLD]: [MID, HEAD], [MID]: [HEAD] } });
  const rows = h.projects().flatMap(p => p.sessions);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.sessionId === OLD).bgJobId, undefined);
  assert.equal(rows.find(row => row.sessionId === HEAD).bgJobId, '33333333');
});

test('hidden projects stay hidden and a bg conversation hides only when every part is archived', t => {
  const hidden = setup(t, { hidden: true });
  assert.equal(hidden.projects().flatMap(p => p.sessions).length, 0);
  const archived = setup(t, { graph: { [OLD]: [HEAD] }, archived: true });
  assert.equal(archived.projects().flatMap(p => p.sessions).length, 1);
  archived.meta.set(HEAD, { archived: 1 });
  assert.equal(archived.projects().flatMap(p => p.sessions).length, 0);
});

test('a live bg descriptor never annotates a same-UUID remote row', t => {
  const h = setup(t);
  h.rows.push({ sessionId: HEAD, folder: 'remote::project', projectPath: '/remote/project',
    modified: '2026-10-14T00:00:00.000Z', messageCount: 3, summary: 'remote name' });
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find(row => row.remoteAlias === 'remote').bgJobId, undefined);
  assert.equal(sessions.find(row => row.remoteAlias === null).bgJobId, '33333333');
});

test('timestamp-only descriptor updates do not reload projects', async t => {
  const h = setup(t, { indexedHead: true });
  let notifications = 0;
  let flushed;
  const flush = new Promise(resolve => { flushed = resolve; });
  const unsubscribeStatus = cli.onStatusesChanged(() => { notifications++; });
  const unsubscribeDescriptor = cli.onDescriptorsChanged(flushed);
  t.after(() => { unsubscribeStatus(); unsubscribeDescriptor(); });
  fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, statusUpdatedAt: 200, updatedAt: 200 }));
  let timeout;
  try {
    await Promise.race([flush, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('no descriptor flush')), 4000); })]);
  } finally { clearTimeout(timeout); }
  assert.equal(notifications, 0);
});

test('the background head rename wins over the parked predecessor registry name', t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] } });
  fs.writeFileSync(path.join(path.dirname(h.descriptorFile), '4343.json'), JSON.stringify({
    ...h.descriptor, pid: 4343, sessionId: OLD, kind: 'interactive', jobId: undefined, name: 'parked predecessor',
  }));
  cli.stop();
  assert.equal(cli.ensureWatching(), true);
  assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'fixture renamed');
});

test('an invalid descriptor start time cannot break sidebar loading', t => {
  const h = setup(t);
  fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, startedAt: 1e100 }));
  cli.stop();
  assert.equal(cli.ensureWatching(), true);
  const rows = h.projects().flatMap(p => p.sessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modified, null);
});

test('an attach tab remains listed and marked open when no registry descriptor is available', t => {
  const h = setup(t);
  cli.stop();
  fs.unlinkSync(h.descriptorFile);
  assert.equal(cli.ensureWatching(), true);
  h.activeSessions.set(HEAD, { isAttach: true, attachJobId: '33333333', cwd: h.descriptor.cwd,
    projectPath: h.descriptor.cwd, _openedAt: h.descriptor.startedAt });
  h.ctx.read('activePtyIds').add(HEAD);
  const row = h.render().querySelector(`[data-session-id="${HEAD}"]`);
  assert.ok(row, 'the open attach tab supplies its explicit session identity');
  assert.ok(row.querySelector('.session-icon.running'));
  assert.equal(row.querySelector('.bg-badge')?.textContent, 'bg');
  h.activeSessions.get(HEAD).exited = true;
  assert.equal(h.projects().flatMap(p => p.sessions).length, 0);
});

test('a live PID with a finished job supplies neither a synthetic row nor an indexed bg badge', t => {
  const h = setup(t, { state: 'stopped' });
  assert.equal(cli.getSidebarDescriptors().length, 1, 'the descriptor PID is still live');
  assert.equal(h.projects().flatMap(p => p.sessions).length, 0);
  h.firstTurn();
  const row = h.render().querySelector(`[data-session-id="${HEAD}"]`);
  assert.ok(row);
  assert.equal(row.querySelector('.bg-badge'), null);
});

test('an open attach PTY cannot keep a finished job descriptor-only row alive', t => {
  const h = setup(t, { state: 'done' });
  cli.stop();
  fs.unlinkSync(h.descriptorFile);
  cli.ensureWatching();
  h.activeSessions.set(HEAD, { isAttach: true, attachJobId: '33333333', cwd: h.descriptor.cwd });
  assert.equal(h.projects().flatMap(p => p.sessions).length, 0);
});

test('job watcher completion preserves the hosted badge and continuation display merge', async t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] }, indexedHead: true });
  assert.equal(h.projects().flatMap(p => p.sessions).length, 1);
  await afterEvent(bgAgents.onChange, () => {
    fs.writeFileSync(h.jobFile, JSON.stringify({ state: 'done', sessionId: HEAD }));
  });
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].bgJobId, '33333333');
  assert.equal(sessions[0].sessionId, HEAD);
  assert.ok(sessions[0].mergedMemberIds.includes(OLD));
  assert.equal(h.render().querySelector('.bg-badge')?.textContent, 'bg');
});

test('working and blocked cached jobs retain the badge', t => {
  for (const state of ['working', 'blocked']) {
    const h = setup(t, { state });
    assert.equal(h.render().querySelector('.bg-badge')?.textContent, 'bg');
  }
});

test('a Switchboard rename wins over a user registry name for interactive and bg rows', t => {
  const h = setup(t, { indexedHead: true });
  h.meta.set(HEAD, { name: 'my Switchboard rename' });
  for (const kind of ['interactive', 'bg']) {
    fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, kind }));
    cli.stop();
    cli.ensureWatching();
    assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'my Switchboard rename');
  }
});

test('a numbered launch title yields to a user registry name for interactive and bg rows', t => {
  const h = setup(t, { indexedHead: true });
  h.meta.set(HEAD, { name: 'x (3)' });
  h.rows[0].customTitle = 'x (3)';
  for (const kind of ['interactive', 'bg']) {
    fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, kind, name: 'x' }));
    cli.stop();
    cli.ensureWatching();
    assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'x');
  }
});

test('a numbered Switchboard rename is preserved when the launch title differs from the registry name', t => {
  const h = setup(t, { indexedHead: true });
  h.meta.set(HEAD, { name: 'x (3)' });
  for (const kind of ['interactive', 'bg']) {
    fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, kind, name: 'x' }));
    cli.stop();
    cli.ensureWatching();
    assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'x (3)');
  }
});

test('a merged row keeps its Switchboard rename over the bg head user name', t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] } });
  h.meta.set(OLD, { name: 'my conversation name' });
  assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'my conversation name');
});

test('a non-user bg head takes the most recent user-named part in either descriptor order', t => {
  const h = setup(t, { graph: { [OLD]: [MID], [MID]: [HEAD] }, source: 'generated' });
  const predecessors = [OLD, MID].map((sessionId, i) => ({ ...h.descriptor, pid: 4343 + i,
    sessionId, kind: 'interactive', jobId: undefined, nameSource: 'user', name: i ? 'recent part' : 'older part' }));
  h.rows[0].modified = '2026-10-13T00:00:00.000Z';
  for (const descriptors of [[...predecessors, h.descriptor], [h.descriptor, ...predecessors.reverse()]]) {
    fs.rmSync(h.descriptorFile);
    for (let i = 0; i < descriptors.length; i++) {
      fs.writeFileSync(path.join(path.dirname(h.descriptorFile), `${4242 + i}.json`), JSON.stringify({ ...descriptors[i], pid: 4242 + i }));
    }
    cli.stop();
    cli.ensureWatching();
    assert.equal(h.projects().flatMap(p => p.sessions)[0].name, 'recent part');
  }
});

test('a dead bg PID keeps the indexed chain on its root row without a bg marker', t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] }, indexedHead: true });
  assert.equal(h.projects().flatMap(p => p.sessions).length, 1);
  h.die();
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, OLD);
  assert.deepEqual(sessions[0].mergedMemberIds, [HEAD]);
  assert.ok(sessions.every(row => !row.bgJobId));
});

test('a non-SDK continuation keeps its SDK root listed with the bg marker and registry name', t => {
  const h = setup(t, { graph: { [OLD]: [HEAD] }, indexedHead: true });
  h.rows[0].entrypoint = 'sdk-ts';
  const sessions = h.projects().flatMap(p => p.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, HEAD);
  assert.equal(sessions[0].bgJobId, '33333333');
  assert.equal(sessions[0].name, 'fixture renamed');
});

test('continuation projection matches the bounded forward resolver on graph fixtures', t => {
  const fixtures = [{ [OLD]: [MID], [MID]: [HEAD] }, { [OLD]: [HEAD], [MID]: [HEAD] },
    { [OLD]: [MID, HEAD], [MID]: [HEAD] }, { [OLD]: [MID], [MID]: [OLD] }, { [OLD]: ['missing'] },
    { [OLD]: [] }];
  for (const graph of fixtures) {
    const h = setup(t, { graph });
    const paths = h.rows.map(row => ({ id: row.sessionId, result: resolveContinuationsSync(row.sessionId, id => {
      const found = h.rows.find(r => r.sessionId === id);
      if (!found) return id === HEAD ? { index: { ids: [] } } : null;
      const index = JSON.parse(found.continuationIndex);
      return index.complete && !index.unresolved && index.ids.length <= 1 ? { index, modified: found.modified } : null;
    }, { includeReachable: true }) })).filter(({ result }) => !result.incomplete && result.continued
      && result.candidates.length === 1 && result.candidates[0].sessionId === HEAD);
    const roots = paths.filter(candidate => !paths.some(other => other !== candidate && other.result.reachable.includes(candidate.id)));
    const expected = roots.length === 1
      ? [HEAD, ...Object.keys(graph).filter(id => !roots[0].result.reachable.includes(id))].sort()
      : [...Object.keys(graph), HEAD].sort();
    assert.deepEqual(h.projects().flatMap(p => p.sessions).map(row => row.sessionId).sort(), expected);
    if (roots.length === 1) assert.deepEqual(h.projects().flatMap(p => p.sessions).find(row => row.bgJobId).mergedMemberIds.slice().sort(),
      roots[0].result.reachable.filter(id => id !== HEAD).sort());
  }
});

test('bridge members on a continuation path contribute their visible row only once', t => {
  const h = setup(t, { graph: { [OLD]: [MID], [MID]: [HEAD] }, indexedHead: true });
  h.rows.find(row => row.sessionId === HEAD).mergedIntoSessionId = MID;
  const sessions = h.projects().flatMap(project => project.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messageCount, 7);
  assert.deepEqual(sessions[0].mergedMemberIds.slice().sort(), [OLD, MID].sort());
});

test('#715 a descriptor-only bg row never shows the title the renderer inherited from the original conversation', t => {
  const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
  const { loadAppFunctions } = require('./app-source');
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-715-'));
  const ctx = setupSidebarDom();
  t.after(() => { ctx.destroy(); fs.rmSync(projectPath, { recursive: true, force: true }); });
  const projects = mergeLocalBackgroundSessions([], [], [{ kind: 'bg', jobId: '33333333', sessionId: HEAD, cwd: projectPath,
    name: 'devex-board', startedAt: Date.parse('2026-10-19T08:15:29.000Z') }], {
    hiddenProjects: new Set(), metaMap: new Map(), showArchived: false, jobs: new Map([['33333333', { state: 'working', sessionId: HEAD }]]),
  });
  const row = projects.flatMap(project => project.sessions).find(session => session.sessionId === HEAD);
  assert.equal(row.descriptorOnly, true);
  ctx.window.sessionMap.set(HEAD, { sessionId: HEAD, name: 'devex-board', aiTitle: 'Onboarding setup', summary: 'hello onboarding',
    projectPath, bgJobId: '33333333', bgSessionId: HEAD });
  const { dedup } = loadAppFunctions(ctx.context, { functions: ['dedup'] });
  dedup(projects);
  ctx.sidebar.renderProjects(projects, false);
  const title = ctx.document.querySelector(`[data-session-id="${HEAD}"] .session-summary`).textContent;
  assert.match(title, /devex-board/);
  assert.doesNotMatch(title, /Onboarding setup/);
});
