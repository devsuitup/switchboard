'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const A = '2a633039-956f-48b4-979a-ce3d4b801ca1', B = '369b1c23-9bd7-47a2-b4bf-36ee3ca4b55f', J = '369b1c23';
function fixture(t, { indexed = false, attach = true, foreign = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-719-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const P = path.join(root, 'p'), Q = path.join(root, 'q'), projectsDir = path.join(root, 'projects');
  fs.mkdirSync(P); fs.mkdirSync(Q); fs.mkdirSync(projectsDir);
  const folder = encodeProjectPath(P), other = encodeProjectPath(Q);
  const rows = [A, ...(indexed ? [B] : [])].map((sessionId, i) => ({ sessionId, projectPath: foreign && i ? Q : P,
    folder: foreign && i ? other : folder, summary: sessionId, messageCount: i ? 3 : 2,
    modified: `2026-10-19T08:${i ? '15' : '14'}:00.000Z`, fileMtime: 'now',
    continuationIndex: JSON.stringify({ format: 3, complete: true, unresolved: false, mtime: 'now', ids: i ? [] : [B] }) }));
  const jobs = new Map([[J, { sessionId: B, state: 'done', transcriptPath: path.join(projectsDir, foreign ? other : folder, B + '.jsonl') }]]);
  const descriptors = [{ sessionId: B, jobId: J, kind: 'bg', cwd: foreign ? Q : P, startedAt: 1 }];
  const active = new Map(attach ? [[B, { isAttach: true, attachJobId: J, projectPath: foreign ? Q : P, cwd: foreign ? Q : P }]] : []);
  const meta = new Map(), settings = {}, folders = new Map([[folder, { folder, projectPath: P }], [other, { folder: other, projectPath: Q }]]);
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: active, getLocalDescriptors: () => descriptors,
    getLocalJobs: () => jobs, getMainWindow: () => null, log: console,
    db: { getAllCached: () => rows, getAllMeta: () => meta, getAllFolderMeta: () => folders, getSetting: key => key === 'global' ? settings : null } });
  return { rows, jobs, descriptors, active, meta, settings, folders, P, Q, folder, projectsDir,
    list: all => cache.buildProjectsFromCache(all).flatMap(p => p.sessions) };
}
for (const indexed of [false, true]) for (const attach of [false, true]) {
  test(`T2 gap retains proof independently of hosting: indexed=${indexed}, attach=${attach}`, t => {
    const h = fixture(t, { indexed, attach });
    const descriptor = h.descriptors[0];
    for (const present of [true, false, true]) {
      h.descriptors.splice(0, h.descriptors.length, ...(present ? [descriptor] : []));
      for (const all of [false, true]) {
        const rows = h.list(all); assert.equal(rows.length, 1);
        const row = rows[0];
        assert.deepEqual([row.sessionId, ...row.mergedMemberIds].sort(), [A, B].sort());
        assert.equal(row.sessionId, present || attach ? B : A);
        assert.equal(row.headSessionId, present || attach || indexed ? B : A);
        assert.equal(row.messageCount, indexed ? 5 : 2);
        assert.equal(Object.hasOwn(row, 'bgJobId'), present);
        assert.equal(Object.hasOwn(row, 'bgSessionId'), present);
        assert.equal(row.identityJobId, J); assert.equal(row.identitySessionId, B);
        assert.deepEqual(cache.conversationMemberIds(h.rows, A), [B]);
        assert.deepEqual(cache.conversationMemberIds(h.rows, B), [A]);
      }
    }
  });
}
for (const indexed of [false, true]) {
  test(`T2.4 every path rejects foreign target scope, indexed=${indexed}`, t => {
    const h = fixture(t, { indexed, foreign: true }); const d = h.descriptors[0];
    for (const present of [true, false, true]) {
      h.descriptors.splice(0, h.descriptors.length, ...(present ? [d] : []));
      const rows = h.list(true), a = rows.find(r => r.sessionId === A);
      assert.ok(a, 'the scoped source must remain a separate row');
      assert.deepEqual(a.mergedMemberIds, []); assert.equal(a.messageCount, 2);
      assert.equal(a.identityJobId, undefined);
      assert.deepEqual(cache.conversationMemberIds(h.rows, A), []);
      assert.equal(rows.some(r => r.sessionId === B), indexed || present);
    }
  });
}
test('T2.4 unscoped cached target cannot be treated as unindexed; descriptor disagreement keeps canonical membership', t => {
  const h = fixture(t, { indexed: true });
  delete h.rows[1].projectPath;
  assert.equal(h.list(true).length, 1);
  assert.deepEqual(h.list(true)[0].mergedMemberIds, []);
  assert.deepEqual(cache.conversationMemberIds(h.rows, A), []);
});

for (const scopeDefect of ['different-folder', 'remote-host', 'unscoped-source']) {
  test(`T2.4 current same-project scope remains separate for ${scopeDefect} through descriptor gaps`, t => {
    const h = fixture(t, { indexed: true }); const descriptor = h.descriptors[0];
    if (scopeDefect === 'different-folder') {
      h.rows[1].folder += '-other'; h.folders.set(h.rows[1].folder, { projectPath: h.P });
      h.jobs.get(J).transcriptPath = path.join(h.projectsDir, h.rows[1].folder, B + '.jsonl');
    }
    if (scopeDefect === 'remote-host') {
      h.rows[1].folder = 'remote::' + h.rows[1].folder; h.rows[1].remoteAlias = 'remote'; h.descriptors.length = 0;
    }
    if (scopeDefect === 'unscoped-source') delete h.rows[0].projectPath;
    for (const present of [true, false, true]) {
      h.descriptors.splice(0, h.descriptors.length, ...(present && scopeDefect !== 'remote-host' ? [descriptor] : []));
      assert.deepEqual(cache.conversationMemberIds(h.rows, A), []);
      assert.deepEqual(cache.conversationMemberIds(h.rows, B), []);
      for (const all of [false, true]) {
        const rows = h.list(all), a = rows.find(row => row.sessionId === A);
        if (scopeDefect === 'unscoped-source') assert.equal(a, undefined);
        else { assert.ok(a); assert.equal(a.messageCount, 2); assert.deepEqual(a.mergedMemberIds, []); }
      }
    }
  });
}

test('T2.4 unscoped prior bridge rows cannot grant operation membership', t => {
  const h = fixture(t, { indexed: true }); h.jobs.clear(); h.descriptors.length = 0; h.active.clear();
  delete h.rows[0].projectPath; delete h.rows[1].projectPath;
  h.rows[1].mergedIntoSessionId = A;
  assert.deepEqual(cache.conversationMemberIds(h.rows, A), []); assert.deepEqual(cache.conversationMemberIds(h.rows, B), []);
});

test('T2.4 a foreign prior bridge peer stays out of independently scoped background membership', t => {
  const h = fixture(t, { indexed: true }); const C = '9285e9d3-dda3-4d46-9a37-aee03b23d737';
  h.rows.push({ ...h.rows[1], sessionId: C, projectPath: h.Q, folder: encodeProjectPath(h.Q), mergedIntoSessionId: A });
  for (const all of [false, true]) {
    const rows = h.list(all), a = rows.find(row => [row.sessionId, ...row.mergedMemberIds].includes(A)), c = rows.find(row => row.sessionId === C);
    assert.ok(a && c); assert.notEqual(a, c); assert.deepEqual([a.sessionId, ...a.mergedMemberIds].sort(), [A, B].sort());
    assert.deepEqual(c.mergedMemberIds, []); assert.deepEqual(cache.conversationMemberIds(h.rows, C), []);
    assert.deepEqual(cache.conversationMemberIds(h.rows, A), [B]);
  }
});

test('T2.4 canonical cached transcript scope survives a contradictory foreign descriptor without duplicates', t => {
  const h = fixture(t, { attach: false }); h.descriptors[0].cwd = h.Q;
  const d = h.descriptors[0];
  for (const present of [true, false, true]) {
    h.descriptors.splice(0, h.descriptors.length, ...(present ? [d] : []));
    const rows = h.list(true); assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, A);
    assert.deepEqual(rows[0].mergedMemberIds, [B]); assert.equal(rows[0].identityJobId, J);
    assert.equal(rows[0].bgJobId, undefined); assert.equal(rows[0].projectPath, h.P);
  }
});
for (const kind of ['missing', 'relative', 'outside', 'mismatched', 'foreign-mapping', 'absent-mapping']) {
  test(`T2.4 unindexed canonical scope validation: ${kind}`, t => {
    const h = fixture(t, { attach: false }); h.descriptors.length = 0;
    if (kind === 'missing') delete h.jobs.get(J).transcriptPath;
    if (kind === 'relative') h.jobs.get(J).transcriptPath = path.join(h.folder, B + '.jsonl');
    if (kind === 'outside') h.jobs.get(J).transcriptPath = path.join(h.P, h.folder, B + '.jsonl');
    if (kind === 'mismatched') h.jobs.get(J).transcriptPath = path.join(h.projectsDir, h.folder, A + '.jsonl');
    if (kind === 'foreign-mapping') h.folders.set(h.folder, { projectPath: h.Q });
    if (kind === 'absent-mapping') h.folders.delete(h.folder);
    const members = cache.conversationMemberIds(h.rows, A);
    assert.deepEqual(members, kind === 'absent-mapping' ? [B] : []);
  });
}
for (const defect of ['stale', 'incomplete', 'unresolved', 'branch', 'convergence', 'cycle', 'depth']) {
  test(`T2.4 current graph invalidation recomputes conservative proof: ${defect}`, t => {
    const h = fixture(t, { indexed: true }); assert.equal(h.list(true).length, 1);
    const index = JSON.parse(h.rows[0].continuationIndex);
    if (defect === 'stale') index.mtime = 'old';
    if (defect === 'incomplete') index.complete = false;
    if (defect === 'unresolved') index.unresolved = true;
    if (defect === 'branch') index.ids.push('other');
    if (defect === 'cycle') h.rows[1].continuationIndex = JSON.stringify({ ...index, ids: [A] });
    if (defect === 'convergence') h.rows.push({ ...h.rows[0], sessionId: 'other', continuationIndex: JSON.stringify(index) });
    if (defect === 'depth') {
      const intermediate = Array.from({ length: 33 }, (_, i) => 'step-' + i); index.ids = [intermediate[0]];
      for (let i = 0; i < intermediate.length; i++) h.rows.push({ ...h.rows[0], sessionId: intermediate[i],
        continuationIndex: JSON.stringify({ ...index, ids: [intermediate[i + 1] || B] }) });
    }
    h.rows[0].continuationIndex = JSON.stringify(index);
    assert.equal(cache.conversationMemberIds(h.rows, A).includes(B), false);
    const a = h.list(true).find(r => r.sessionId === A); assert.ok(a); assert.equal(a.mergedMemberIds.includes(B), false);
  });
}

test('T2.6 a separate hidden older row stays payload-present and expansion does not change membership', t => {
  const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
  const h = setupSidebarDom(); t.after(() => h.destroy());
  const now = new Date().toISOString();
  const rows = Array.from({ length: 10 }, (_, i) => ({ sessionId: 'running-' + i, modified: now, summary: 'running' }));
  for (const row of rows) h.window.activePtyIds.add(row.sessionId);
  const projects = [makeSampleProject({ sessions: rows })]; h.sidebar.renderProjects(projects, true);
  rows.push({ sessionId: A, modified: now, summary: 'original' });
  h.sidebar.renderProjects(projects, false); h.sidebar.renderProjects(projects, true);
  assert.equal(projects[0].sessions.some(row => row.sessionId === A), true);
  const a = h.document.querySelector(`[data-session-id="${A}"]`), older = a.closest('.sessions-older');
  assert.ok(older); assert.equal(older.style.display, 'none');
  h.document.querySelector('.sessions-more-toggle').click(); assert.equal(older.style.display, '');
  assert.equal(projects[0].sessions.length, 11);
});
test('T2.3 unindexed identity survives all known lifecycles and disappears when current proof is removed', t => {
  const h = fixture(t); h.descriptors.length = 0;
  for (const state of ['working', 'done', 'working', 'stopped', 'failed']) {
    h.jobs.get(J).state = state;
    const row = h.list(true)[0]; assert.equal(row.sessionId, B);
    assert.deepEqual([row.sessionId, ...row.mergedMemberIds].sort(), [A, B].sort());
    assert.equal(Object.hasOwn(row, 'bgJobId'), state === 'working');
  }
  h.active.clear();
  assert.equal(h.list(true)[0].sessionId, A);
  assert.deepEqual(h.list(true)[0].mergedMemberIds, [B]);
  h.jobs.clear(); assert.deepEqual(h.list(true)[0].mergedMemberIds, []);
});

for (const state of ['done', 'stopped', 'failed']) for (const from of [A, B]) {
  test(`T2.7 shared main metadata and deletion resolve all unindexed parts: ${state}, from=${from}`, async t => {
    const h = fixture(t, { attach: false }); h.descriptors.length = 0; h.jobs.get(J).state = state;
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const { extractFunction } = require('./app-source');
    const handlers = new Map(), names = [], searchTitles = [];
    const set = (ids, patch) => { for (const id of ids) h.meta.set(id, { ...h.meta.get(id), ...patch }); };
    const { createWriterCommands } = require('../session-index-commands');
    const commands = createWriterCommands({ getSetting: () => null, setSetting() {},
      setName: (ids, name) => { names.push([...ids]); set(ids, { name, nameSource: 'user', nameRevision: names.length }); },
      getCachedSession: id => h.rows.find(r => r.sessionId === id), updateSearchTitle: (...args) => searchTitles.push(args) });
    const context = vm.createContext({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      getAllCached: () => h.rows, sessionCache: cache, activeSessions: h.active,
      cliSessionState: { getSidebarDescriptors: () => h.descriptors },
      setStarred: (ids, starred) => { set(ids, { starred: Number(starred) }); return starred; },
      setArchived: (ids, archived) => set(ids, { archived }), writer: { renameSession: commands.renameSession } });
    for (const name of ['getConversationPartIds', 'getMergedMemberIds']) vm.runInContext(extractFunction(source, name), context);
    for (const name of ['set-star', 'rename-session', 'archive-session']) {
      const start = source.indexOf(`ipcMain.handle('${name}'`); vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    }
    for (const value of [true, false]) {
      await handlers.get('set-star')(null, from, value);
      assert.ok([A, B].every(id => h.meta.get(id)?.starred === Number(value)));
      await handlers.get('archive-session')(null, from, value);
      assert.ok([A, B].every(id => h.meta.get(id)?.archived === Number(value)));
      assert.equal(h.list(false).length, value ? 0 : 1); assert.equal(h.list(true).length, 1);
    }
    for (const name of ['user rename', null]) {
      await handlers.get('rename-session')(null, from, name);
      assert.ok([A, B].every(id => h.meta.get(id).name === name));
    }
    assert.ok(names.every(ids => ids.slice().sort().join() === [A, B].sort().join()));
    assert.equal(searchTitles.filter(([id]) => id === B).at(-1)[2], '', 'unindexed member has no invented summary');
    const folder = path.join(h.projectsDir, h.folder), physical = path.join(h.projectsDir, 'other-physical-folder');
    fs.mkdirSync(folder); fs.mkdirSync(physical);
    fs.writeFileSync(path.join(folder, A + '.jsonl'), '{}'); fs.writeFileSync(path.join(physical, B + '.jsonl'), '{}');
    fs.mkdirSync(path.join(physical, B)); fs.writeFileSync(path.join(physical, B, 'agent.jsonl'), '{}');
    fs.writeFileSync(path.join(physical, 'unrelated.jsonl'), '{}');
    const { makeDeleteSessionGuard } = require('../delete-session-guard');
    const guarded = [], cleaned = [];
    const guard = makeDeleteSessionGuard({ activeSessions: h.active, getMergedMemberIds: context.getMergedMemberIds,
      bgAgents: { liveJobCheck: id => { guarded.push(id); return { known: true, job: null }; } },
      cliSessionState: { liveElsewhereChecked: async () => ({ known: true, live: null }) }, sessionHasPty: () => false, ptyPids: () => [] });
    const { loadDeletionHandlers } = require('./delete-session-harness');
    const deletion = loadDeletionHandlers({ PROJECTS_DIR: h.projectsDir, getMergedMemberIds: context.getMergedMemberIds,
      getCachedFolder: id => id === A ? h.folder : null, getCachedByParent: () => [], deleteSessionGuard: guard,
      deleteCachedSession: id => cleaned.push(id), deleteSearchSession() {} });
    const preview = await deletion.get('delete-session-preview')(null, from);
    assert.equal(preview.ok, true); assert.deepEqual(Array.from(preview.partIds).sort(), [A, B].sort());
    const removed = await deletion.get('delete-session')(null, from, preview.partIds);
    assert.equal(removed.ok, true); assert.deepEqual([...new Set(guarded)].sort(), [A, B].sort());
    assert.ok([A, B].every(id => cleaned.includes(id)));
    assert.equal(fs.existsSync(path.join(folder, A + '.jsonl')), false);
    assert.equal(fs.existsSync(path.join(physical, B + '.jsonl')), false);
    assert.equal(fs.existsSync(path.join(physical, B)), false);
    assert.equal(fs.existsSync(path.join(physical, 'unrelated.jsonl')), true);
    assert.equal(h.jobs.has(J), true, 'sidebar deletion does not remove daemon jobs');
  });
}

test('T2.7 missing unindexed targets and changed proof refuse whole deletion before filesystem effects', async t => {
  const h = fixture(t, { attach: false }); h.descriptors.length = 0;
  const folder = path.join(h.projectsDir, h.folder); fs.mkdirSync(folder);
  const file = path.join(folder, A + '.jsonl'); fs.writeFileSync(file, '{}');
  const { loadDeletionHandlers } = require('./delete-session-harness');
  const deletion = loadDeletionHandlers({ PROJECTS_DIR: h.projectsDir, getMergedMemberIds: id => cache.conversationMemberIds(h.rows, id),
    getCachedFolder: id => id === A ? h.folder : null, getCachedByParent: () => [] });
  assert.equal((await deletion.get('delete-session-preview')(null, A)).ok, false);
  const result = await deletion.get('delete-session')(null, A, [A, B]);
  assert.equal(result.ok, false); assert.ok(fs.existsSync(file));
});

for (const reason of ['attach', 'elsewhere', 'unknown', 'working', 'blocked', 'hosted-done', 'stopped-process', 'failed-process', 'clear-done', 'clear-stopped', 'clear-failed']) {
  test(`T2.7 every current member receives fresh deletion guards: ${reason}`, async t => {
    const h = fixture(t, { attach: false }); h.descriptors.length = 0;
    const state = reason.includes('stopped') ? 'stopped' : reason.includes('failed') ? 'failed'
      : reason === 'working' || reason === 'blocked' ? reason : 'done';
    h.jobs.get(J).state = state;
    if (reason === 'hosted-done') h.descriptors.push({ sessionId: B, jobId: J, kind: 'bg', cwd: h.P });
    if (reason === 'attach') h.active.set(B, { isAttach: true, attachJobId: J, cwd: h.P, projectPath: h.P });
    const folder = path.join(h.projectsDir, h.folder); fs.mkdirSync(folder);
    for (const id of [A, B]) fs.writeFileSync(path.join(folder, id + '.jsonl'), '{}');
    const { makeDeleteSessionGuard } = require('../delete-session-guard');
    const { isHostedJob } = require('../bg-agents-roster');
    const checked = [];
    const guard = makeDeleteSessionGuard({ activeSessions: h.active,
      bgAgents: { liveJobCheck: id => { checked.push(id); return { known: !(id === B && reason === 'unknown'),
        job: id === B && isHostedJob({ ...h.jobs.get(J), id: J }, h.descriptors) ? { id: J } : null }; } },
      cliSessionState: { liveElsewhereChecked: async id => ({ known: true,
        live: id === B && ['elsewhere', 'stopped-process', 'failed-process'].includes(reason) ? { pid: 42 } : null }) },
      sessionHasPty: () => false, ptyPids: () => [] });
    const { loadDeletionHandlers } = require('./delete-session-harness');
    const handlers = loadDeletionHandlers({ PROJECTS_DIR: h.projectsDir, activeSessions: h.active,
      getMergedMemberIds: id => cache.conversationMemberIds(h.rows, id), getCachedFolder: id => id === A ? h.folder : null,
      getCachedByParent: () => [], deleteSessionGuard: guard, deleteCachedSession() {}, deleteSearchSession() {} });
    const preview = await handlers.get('delete-session-preview')(null, A);
    const result = await handlers.get('delete-session')(null, A, preview.partIds);
    assert.equal(result.ok, reason.startsWith('clear-'));
    assert.equal(fs.existsSync(path.join(folder, A + '.jsonl')), !reason.startsWith('clear-'));
    assert.ok(checked.includes(A)); if (reason !== 'attach') assert.ok(checked.includes(B));
  });
}

test('T2.7 a part-set change during guard await and a symlink refusal keep every transcript untouched', async t => {
  const h = fixture(t, { attach: false }); h.descriptors.length = 0;
  const folder = path.join(h.projectsDir, h.folder); fs.mkdirSync(folder);
  for (const id of [A, B]) fs.writeFileSync(path.join(folder, id + '.jsonl'), '{}');
  const { loadDeletionHandlers } = require('./delete-session-harness');
  const deps = { PROJECTS_DIR: h.projectsDir, getMergedMemberIds: id => cache.conversationMemberIds(h.rows, id),
    getCachedFolder: id => id === A ? h.folder : null, getCachedByParent: () => [] };
  const changing = loadDeletionHandlers({ ...deps, deleteSessionGuard: async () => { await Promise.resolve(); h.jobs.clear(); return null; } });
  const preview = await changing.get('delete-session-preview')(null, A);
  assert.equal((await changing.get('delete-session')(null, A, preview.partIds)).ok, false);
  assert.ok(fs.existsSync(path.join(folder, A + '.jsonl')));
  h.jobs.set(J, { sessionId: B, state: 'done', transcriptPath: path.join(folder, B + '.jsonl') });
  fs.unlinkSync(path.join(folder, B + '.jsonl'));
  const outside = path.join(h.Q, 'outside.jsonl'); fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(folder, B + '.jsonl'), 'file');
  const linked = loadDeletionHandlers(deps);
  assert.equal((await linked.get('delete-session-preview')(null, A)).ok, false);
  assert.equal((await linked.get('delete-session')(null, A, [A, B])).ok, false);
  assert.ok(fs.existsSync(path.join(folder, A + '.jsonl'))); assert.ok(fs.existsSync(outside));
});

for (const mode of ['hosted', 'unknown', 'done', 'stopped', 'failed', 'stop-failure', 'unarchive']) {
  test(`T2.7 actual sidebar Archive prelude checks all parts before stop/detach and metadata: ${mode}`, async t => {
    const h = fixture(t, { attach: false }); h.descriptors.length = 0;
    const { setupSidebarDom } = require('./dom-setup');
    const dom = setupSidebarDom(); t.after(() => dom.destroy()); const w = dom.window, calls = [];
    const confirmations = [];
    w.appConfirm = async options => { confirmations.push(options); return true; };
    const row = h.list(true)[0]; if (mode === 'unarchive') row.archived = 1;
    w.sessionMap.set(row.sessionId, row);
    for (const id of [A, B]) { w.openSessions.set(id, { session: { sessionId: id }, attach: id === B }); w.activePtyIds.add(id); }
    w.api.bgAgentLiveJob = async id => {
      calls.push('check:' + id);
      return { known: !(mode === 'unknown' && id === B), job: mode === 'hosted' && id === B ? { id: J } : null };
    };
    w.api.stopSession = async id => { calls.push('stop:' + id); return { ok: !(mode === 'stop-failure' && id === B) }; };
    w.api.archiveSession = async () => { calls.push('metadata'); return { ok: true }; };
    dom.sidebar.renderProjects([{ projectPath: h.P, sessions: [row] }], true);
    await dom.document.querySelector('.session-archive-btn').onclick({ stopPropagation() {} });
    assert.equal(confirmations.length, ['unarchive', 'hosted', 'unknown'].includes(mode) ? 0 : 1);
    if (confirmations.length) assert.match(confirmations[0].message, /Archive this session\?[\s\S]*in this window/);
    if (mode === 'unarchive') assert.deepEqual(calls, ['metadata']);
    else if (mode === 'hosted' || mode === 'unknown') assert.equal(calls.some(call => call.startsWith('stop:') || call === 'metadata'), false);
    else {
      assert.deepEqual(calls.slice(0, 2), ['check:' + A, 'check:' + B]);
      assert.deepEqual(calls.filter(call => call.startsWith('stop:')), ['stop:' + A, 'stop:' + B]);
      assert.equal(calls.includes('metadata'), mode !== 'stop-failure');
    }
  });
}

for (const reason of ['archived', 'hidden-project', 'sdk-only']) {
  test(`T6.6 shipped producer supplies current ${reason} removal evidence`, t => {
    const h = fixture(t, { indexed: true, attach: false });
    const { createSessionProjectionDiagnostics } = require('../public/session-projection-diagnostics');
    const rows = h.list(true), facts = rows[0].projectionFacts, records = [];
    const d = createSessionProjectionDiagnostics({ emit: record => records.push(record) });
    d.observe({ rows: [{ scope: facts.scope, rootId: facts.rootId, sessionId: B, headSessionId: B, memberIds: [A, B],
      visibleInDefault: true, background: { jobId: J, sessionId: B }, activity: { source: 'none', jobId: null, valid: false, state: null, hosted: false, attached: false, foreground: false }, inputs: facts.inputs }] });
    if (reason === 'archived') for (const id of [A, B]) h.meta.set(id, { archived: 1 });
    if (reason === 'hidden-project') h.settings.hiddenProjects = [h.P];
    if (reason === 'sdk-only') { h.descriptors.length = 0; for (const row of h.rows) row.entrypoint = 'sdk-py'; }
    assert.equal(h.list(false).length, 0);
    const removedInputs = cache.getProjectsProjection().removedInputs;
    assert.equal(removedInputs[facts.scope + '|' + facts.rootId].filterReason, reason);
    d.observe({ rows: [], removedInputs });
    assert.equal(records.length, 2); assert.equal(records[1].inputs.filterReason, reason); assert.equal(records[1].priorInputs, undefined);
  });
}

test('T6.1/T6.6 actual cache provenance reaches renderer commits and archive visibility then hidden removal', async t => {
  const h = fixture(t, { indexed: true, attach: false });
  const { setupSidebarDom } = require('./dom-setup');
  const { loadAppFunctions } = require('./app-source');
  const dom = setupSidebarDom(); t.after(() => dom.destroy()); const w = dom.window, records = [];
  w.TextEncoder = TextEncoder;
  dom.evalPublic('session-projection-diagnostics.js'); dom.evalPublic('agents-view.js');
  w.cachedProjects = []; w.cachedAllProjects = []; w.loadingStatus = w.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus']) w[name] = () => {};
  w.refreshSidebar = () => dom.sidebar.renderProjects(w.cachedProjects);
  w.pollActiveSessions = async () => {};
  w.api.sessionProjectionChanged = record => records.push(record);
  w.api.getSetting = async () => h.settings; w.api.getActiveTerminals = async () => [];
  let buildId = 0;
  w.api.getProjects = async () => {
    const defaultProjects = cache.buildProjectsFromCache(false), first = cache.getProjectsProjection();
    const allProjects = cache.buildProjectsFromCache(true), second = cache.getProjectsProjection();
    return { defaultProjects, allProjects, projection: { buildId: ++buildId, removedInputs: { ...first.removedInputs, ...second.removedInputs } } };
  };
  loadAppFunctions(dom.context, { functions: ['dedup', 'loadProjects', 'observeSessionProjection'] });
  await w.loadProjects(); assert.equal(records.length, 1); assert.equal(records[0].projectsBuildId, 1);
  for (const id of [A, B]) h.meta.set(id, { archived: 1 });
  await w.loadProjects(); assert.equal(records.length, 2);
  assert.deepEqual(Array.from(records[1].changes), ['visibility']); assert.equal(records[1].inputs.filterReason, 'archived');
  h.settings.hiddenProjects = [h.P]; await w.loadProjects();
  assert.equal(records.length, 3); assert.deepEqual(Array.from(records[2].changes), ['removed']);
  assert.equal(records[2].inputs.filterReason, 'hidden-project'); assert.equal(records[2].priorInputs, undefined);
});

test('T6.1 accepted cache and roster events log exact merge, gap, split and evidence cardinality', async t => {
  const h = fixture(t, { indexed: true, attach: true });
  const { setupSidebarDom } = require('./dom-setup'), { loadAppFunctions } = require('./app-source');
  const dom = setupSidebarDom(); t.after(() => dom.destroy()); const w = dom.window, records = [];
  w.TextEncoder = TextEncoder; dom.evalPublic('session-projection-diagnostics.js'); dom.evalPublic('agents-view.js');
  w.cachedProjects = []; w.cachedAllProjects = []; w.loadingStatus = w.document.createElement('div');
  w.openSessions.set(B, { attach: true, attachJobId: J, session: { sessionId: B, projectPath: h.P }, terminal: { focus() {} } });
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus']) w[name] = () => {};
  w.refreshSidebar = () => dom.sidebar.renderProjects(w.cachedProjects);
  w.pollActiveSessions = async () => {}; w.api.getSetting = async () => h.settings; w.api.getActiveTerminals = async () => [];
  w.api.sessionProjectionChanged = record => records.push(record); let buildId = 0;
  const build = () => {
    const defaultProjects = cache.buildProjectsFromCache(false), first = cache.getProjectsProjection();
    const allProjects = cache.buildProjectsFromCache(true), second = cache.getProjectsProjection();
    return { defaultProjects, allProjects, projection: { buildId: ++buildId, removedInputs: { ...first.removedInputs, ...second.removedInputs } } };
  };
  w.api.getProjects = async () => build();
  loadAppFunctions(dom.context, { functions: ['dedup', 'loadProjects', 'observeSessionProjection'] });
  const push = (hosted, valid = true, at = 1, listed = true) => w.applyAgentsSnapshot({ cliAvailable: true, cliEntryCount: listed ? 1 : 0,
    roster: [{ id: J, sessionId: B, kind: 'background', state: 'done', cachedJob: true, hosted, listed,
      taskEvidence: { valid, at, tasks: [], inFlight: 0 } }] });
  push(true); await w.loadProjects(); assert.equal(records.length, 1);
  push(true, true, 2, false); assert.equal(records.length, 1, 'CLI omission and evidence time only refresh deciding inputs');
  const descriptor = h.descriptors[0]; h.descriptors.length = 0;
  push(false, true, 2, false); assert.equal(records.length, 2); assert.equal(records.at(-1).inputs.cli, 'omitted');
  await w.loadProjects(); assert.equal(records.length, 3); assert.equal(records.at(-1).changes.includes('background-membership'), true);
  assert.equal(records.at(-1).inputs.attach.jobId, J);
  h.descriptors.push(descriptor); push(true, true, 3); assert.equal(records.length, 4); await w.loadProjects(); assert.equal(records.length, 5);
  const index = h.rows[0].continuationIndex; h.rows[0].continuationIndex = JSON.stringify({ ...JSON.parse(index), ids: [] });
  await w.loadProjects(); assert.equal(records.length, 7); assert.deepEqual(new Set(records.slice(-2).map(record => record.rootId)), new Set([A, B]));
  await w.loadProjects(); assert.equal(records.length, 7, 'paired views and repeated accepted projection do not duplicate records');
  h.rows[0].continuationIndex = index; await w.loadProjects(); assert.equal(records.length, 9);
  assert.equal(records.at(-1).changes.includes('removed'), true);
  push(true, false, 4); assert.equal(records.length, 10); push(true, true, 5); assert.equal(records.length, 11);
  for (const project of w.cachedProjects) for (const row of project.sessions) {
    const item = w.sessionItemEl(row.sessionId); w.paintSessionIcon(item.querySelector('.session-icon'), row.sessionId, row);
    w.applyStateClasses(row.sessionId, w.storedActivitySnapshot(row.sessionId, row));
  }
  assert.equal(records.length, 11, 'ordinary paints never observe diagnostic transitions');
  let releaseOld, releaseNew;
  w.api.getProjects = () => new Promise(resolve => { if (!releaseOld) releaseOld = resolve; else releaseNew = resolve; });
  h.rows[0].continuationIndex = JSON.stringify({ ...JSON.parse(index), ids: [] }); const stale = build();
  h.rows[0].continuationIndex = index; const fresh = build();
  const old = w.loadProjects(), newest = w.loadProjects(); releaseNew(fresh); await newest; await old;
  releaseOld(stale); for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(records.length, 11, 'late obsolete split payload produces zero records');
});

test('T2.4 main snapshot preserves transcript scope through the shipped worker and invalidates liveVersion on scope alone', async t => {
  const h = fixture(t, { attach: false });
  const { extractFunction } = require('./app-source');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const context = vm.createContext({ activeSessions: h.active, getProjectsRevision: () => 'db',
    cliSessionState: { getSidebarDescriptors: () => h.descriptors }, bgAgents: { getCachedJobs: () => h.jobs },
    sessionCache: { getRemoteRoots: () => new Map() } });
  vm.runInContext(extractFunction(source, 'projectsSnapshot'), context);
  const snapshot = context.projectsSnapshot();
  assert.equal(snapshot.localJobs[0][1].transcriptPath, h.jobs.get(J).transcriptPath);
  const { projectsWorker } = require('./fixtures/projects-worker-718.cjs');
  const worker = projectsWorker({ root: h.projectsDir, rows: new Map(h.rows.map(row => [row.sessionId, row])), meta: h.meta, folders: h.folders });
  await worker.handle({ ...snapshot, id: 1, reconcile: false });
  const accepted = worker.replies.find(r => r.id === 1 && r.result).result;
  const merged = accepted.allProjects.flatMap(p => p.sessions);
  assert.equal(merged.length, 1); assert.deepEqual(Array.from(merged[0].mergedMemberIds), [A]);
  const descriptor = h.descriptors[0]; h.descriptors.length = 0;
  await worker.handle({ ...context.projectsSnapshot(), id: 2, reconcile: false });
  const gap = worker.replies.find(r => r.id === 2 && r.result).result.allProjects.flatMap(p => p.sessions);
  assert.equal(gap.length, 1); assert.deepEqual(Array.from(gap[0].mergedMemberIds), [B]);
  h.descriptors.push(descriptor);
  h.jobs.get(J).transcriptPath = path.join(h.projectsDir, encodeProjectPath(h.Q), B + '.jsonl');
  const foreign = context.projectsSnapshot(); assert.notEqual(foreign.liveVersion, snapshot.liveVersion);
  h.jobs.get(J).tokens = 100; assert.equal(context.projectsSnapshot().liveVersion, foreign.liveVersion);
  h.descriptors[0].cwd = h.Q;
  await worker.handle({ ...context.projectsSnapshot(), id: 3, reconcile: false });
  const split = worker.replies.find(r => r.id === 3 && r.result).result.allProjects.flatMap(p => p.sessions);
  assert.equal(split.length, 2); assert.deepEqual(Array.from(split.find(r => r.sessionId === A).mergedMemberIds), []);
});

test('T2.4 the updated #639 scoped positive fixture still merges without launching its Electron tests', () => {
  const source = fs.readFileSync(path.join(__dirname, 'bg-continuation-639.test.js'), 'utf8');
  const start = source.indexOf("test('sidebar keeps one original conversation");
  assert.ok(start >= 0);
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    test: (_name, fn) => fn(), assert, OLD: '11111111-1111-4111-8111-111111111111', HEAD: '22222222-2222-4222-8222-222222222222',
    mergeLocalBackgroundSessions: require('../sidebar-bg-sessions').mergeLocalBackgroundSessions });
});
