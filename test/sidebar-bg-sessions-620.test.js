'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const cli = require('../cli-session-state');
const { encodeProjectPath } = require('../encode-project-path');
const { scanContinuationIndex } = require('../session-continuations');
const { setupSidebarDom } = require('./dom-setup');

const OLD = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const HEAD = '33333333-3333-4333-8333-333333333333';

function setup(t, { graph = {}, indexedHead = false, source = 'user', hidden = false, archived = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-620-')));
  const projectPath = path.join(root, 'project');
  const projectsDir = path.join(root, 'projects');
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(dir);
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
      messageCount: 2, summary: 'fixture prompt', continuationIndex: scanContinuationIndex(file, id) });
  }
  if (indexedHead && !rows.some(row => row.sessionId === HEAD)) {
    rows.push({ sessionId: HEAD, folder, projectPath, modified, messageCount: 3, summary: 'first own turn' });
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
  cli.init({ dir, activeSessions, onIdle() {}, isProcessAlive: () => alive, readParentPid: () => null, now: () => clock });
  assert.equal(cli.ensureWatching(), true);
  const meta = new Map(rows.map(row => [row.sessionId, { name: 'fixture launch (2)', archived: archived ? 1 : 0 }]));
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log: console,
    getLocalDescriptors: () => cli.getSidebarDescriptors?.() || [],
    db: { getAllCached: () => rows, getAllMeta: () => meta,
      getAllFolderMeta: () => new Map([[folder, { projectPath }]]),
      getSetting: key => key === 'global' ? { hiddenProjects: hidden ? [projectPath] : [] } : null } });
  const ctx = setupSidebarDom();
  t.after(() => { ctx.destroy(); cli.stop(); fs.rmSync(root, { recursive: true, force: true }); });
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
  return { rows, descriptor, descriptorFile, projects, render, ctx, firstTurn, activeSessions, die: () => { alive = false; clock += 5001; } };
}

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
  assert.equal(sessions[0].sessionId, OLD);
  assert.ok(sessions[0].mergedMemberIds.includes(HEAD));
  assert.ok(sessions[0].mergedMemberIds.includes(MID));
  assert.equal(sessions[0].messageCount, 4);
  const row = h.render().querySelector(`[data-session-id="${OLD}"]`);
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
  let notifications = 0;
  const unsubscribe = cli.onStatusesChanged(() => { notifications++; });
  t.after(unsubscribe);
  fs.writeFileSync(h.descriptorFile, JSON.stringify({ ...h.descriptor, name: 'second rename' }));
  const deadline = Date.now() + 4000;
  while (!notifications && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(notifications > 0, 'a rename must notify project listeners even when status stays idle');
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
  assert.equal(rows.find(row => row.sessionId === MID).bgJobId, '33333333');
});

test('hidden projects and archived predecessors are not resurrected by their bg descriptor', t => {
  const hidden = setup(t, { hidden: true });
  assert.equal(hidden.projects().flatMap(p => p.sessions).length, 0);
  const archived = setup(t, { graph: { [OLD]: [HEAD] }, archived: true });
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
