'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vm = require('node:vm');
const { fixture, OLD: P, line } = require('./fixtures/continuation-718.cjs');
const { enumerateSessionFiles, resolveJsonlPath, readSubagentMeta } = require('../read-session-file');
const { subagentParentFromParts } = require('../subagent-attribution');
const cache = require('../session-cache');
const openStore = require('./fixtures/conversation-store.cjs');
const { setupSidebarDom } = require('./dom-setup');

const RUN = 'wf_abcdef-123';
const ID = `sub:${P}:workflow-child`;
const storeOptions = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function workflowFixture(t) {
  const h = fixture(t);
  h.descriptors.length = 0;
  h.write(P);
  const ordinary = path.join(P, 'subagents', 'agent-ordinary.jsonl');
  const relative = path.join(P, 'subagents', 'workflows', RUN, 'agent-workflow-child.jsonl');
  const file = path.join(h.dir, relative);
  const writeAgent = (rel, agentId) => {
    const target = path.join(h.dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, line({ type: 'user', sessionId: P, agentId, isSidechain: true,
      cwd: h.root, message: { content: 'Agent prompt' } }));
    fs.writeFileSync(target.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'researcher', description: agentId }));
  };
  writeAgent(ordinary, 'ordinary');
  writeAgent(relative, 'workflow-child');
  const journal = path.join(path.dirname(relative), 'journal.jsonl');
  fs.writeFileSync(path.join(h.dir, journal), line({ type: 'user', message: { content: 'Run journal' } }));
  const snapshot = path.join(h.dir, P, 'workflows', RUN + '.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ runId: RUN, workflowName: 'Research <topic>', status: 'running', agentCount: 1, startTime: Date.now() }));
  return { ...h, relative, file, journal, ordinary, snapshot, writeAgent };
}

function assertRows(rows) {
  const child = rows.find(row => row.sessionId === ID);
  assert.ok(child, 'workflow agent is indexed as sub:P:workflow-child');
  assert.equal(child.parentSessionId, P);
  assert.equal(child.workflowRunId, RUN);
  assert.equal(child.subagentType, 'researcher');
  assert.ok(!rows.some(row => row.sessionId.startsWith('agent-') || row.sessionId === 'journal'), 'no workflow transcript or journal becomes a root session');
}

test('full scan discovers workflow agents and ignores journals, malformed runs and linked runs', t => {
  const h = workflowFixture(t);
  h.writeAgent(path.join(P, 'subagents', 'workflows', 'bad-run', 'agent-invalid.jsonl'), 'invalid');
  const link = path.join(h.dir, P, 'subagents', 'workflows', 'wf_linked123');
  fs.symlinkSync(path.dirname(h.file), link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); });
  const entries = enumerateSessionFiles(h.dir);
  const workflow = entries.find(entry => entry.filePath === h.file);
  assert.ok(workflow, 'cold scan must discover a workflow transcript');
  assert.equal(workflow.workflowRunId, RUN);
  assert.equal(entries.length, 3, 'only parent, ordinary child and canonical workflow child');
  cache.refreshFolder(h.folder);
  assertRows([...h.rows.values()]);
});

test('targeted workflow refresh and subsequent full refresh preserve identity and cached read path', t => {
  const h = workflowFixture(t);
  cache.refreshFolder(h.folder, { files: new Set([h.relative, h.journal, path.join(P, 'unknown', 'journal.jsonl')]) });
  assertRows([...h.rows.values()]);
  cache.refreshFolder(h.folder);
  assertRows([...h.rows.values()]);
  assert.equal(h.effects.filter(([op]) => op === 'delete').length, 0, 'full refresh after targeted deletes nothing');
  assert.equal(resolveJsonlPath(h.root, h.rows.get(ID)), h.file);
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file) === h.file) reads++;
    return originalRead.call(this, file, ...args);
  });
  fs.appendFileSync(h.file, line({ type: 'assistant', message: { content: 'More work' } }));
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(h.file, later, later);
  cache.refreshFolder(h.folder, { files: new Set([h.relative]) });
  assert.equal(reads, 0, 'cached workflow row uses a header refresh rather than a full reread');
  assertRows([...h.rows.values()]);
});

test('targeted deletion of an entire workflow run removes its cached child', t => {
  const h = workflowFixture(t);
  cache.refreshFolder(h.folder, { files: new Set([h.relative]) });
  assert.ok(h.rows.has(ID));
  fs.unlinkSync(h.file);
  fs.unlinkSync(h.file.replace(/\.jsonl$/, '.meta.json'));
  fs.unlinkSync(path.join(h.dir, h.journal));
  fs.rmdirSync(path.dirname(h.file));
  cache.refreshFolder(h.folder, { files: new Set([h.relative]) });
  assert.equal(h.rows.has(ID), false, 'deleted run cannot retain its workflow child');
});

test('workflow paths attribute live writes to the parent and ignore the journal', () => {
  const parts = ['folder', P, 'subagents', 'workflows', RUN, 'agent-workflow-child.jsonl'];
  assert.deepEqual(subagentParentFromParts(parts), { parentSessionId: P, agentId: 'workflow-child' });
  assert.equal(subagentParentFromParts([...parts.slice(0, -1), 'journal.jsonl']), null);
  assert.equal(subagentParentFromParts(['folder', P, 'subagents', 'workflows', 'bad', 'agent-child.jsonl']), null);
});

async function scan(h, subset) {
  const messages = [];
  const worker = new Worker(path.join(__dirname, '../workers/scan-projects.js'), {
    workerData: { projectsDir: h.root, folderPrefix: 'vps',
      ...(subset ? { folders: [], targets: [{ folder: h.folder, files: [h.relative.split(path.sep).join('/'), h.journal.split(path.sep).join('/')], existingRows: [] }] }
        : { folders: [h.folder] }) },
  });
  worker.on('message', message => messages.push(message));
  await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', code => code ? reject(new Error(`scan worker exit ${code}`)) : resolve());
  });
  assert.equal(messages.at(-1).ok, true);
  return messages.find(message => message.type === 'folder').result;
}

for (const subset of [false, true]) {
  test(`remote scan keeps workflow identity and provenance: subset=${subset}`, async t => {
    const h = workflowFixture(t);
    const result = await scan(h, subset);
    assertRows(result.sessions);
    assert.equal(result.sessions.find(row => row.sessionId === ID).folder, 'vps::' + h.folder);
  });
}

test('workflow run id survives the real SQLite store and schema reconciliation does not reindex', storeOptions, t => {
  let store;
  t.after(() => store?.closeDb());
  const h = workflowFixture(t);
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  t.after(() => { if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous; });
  store = openStore();
  cache.init({ PROJECTS_DIR: h.root, activeSessions: new Map(), getMainWindow: () => null, log: h.log, db: store });
  cache.refreshFolder(h.folder, { files: new Set([h.relative]) });
  assertRows(store.getCachedByFolder(h.folder));
  cache.refreshFolder(h.folder);
  assertRows(store.getCachedByFolder(h.folder));
  assert.equal(resolveJsonlPath(h.root, store.getCachedSession(ID)), h.file);
  store.setInitialScanComplete();
  store.connection.exec('ALTER TABLE session_cache DROP COLUMN workflowRunId');
  store.closeDb();
  store = openStore();
  assert.ok(store.getCachedSession(ID), 'additive column reconciliation retains cached sessions');
  assert.ok(store.getFolderMeta(h.folder), 'folder freshness is retained');
  assert.equal(store.isInitialScanComplete(), true);
  assert.equal(store.getCachedSession(ID).workflowRunId, null);
});

test('sidebar groups workflow agents under their parent with a safe title and persistent expansion', t => {
  const h = workflowFixture(t);
  const child = { sessionId: ID, parentSessionId: P, agentId: 'workflow-child', workflowRunId: RUN,
    subagentType: 'researcher', modified: new Date().toISOString(), messageCount: 1 };
  h.rows.set(P, { sessionId: P, folder: h.folder, projectPath: h.root, summary: 'Parent', modified: child.modified });
  h.rows.set(ID, { ...child, folder: h.folder, projectPath: h.root });
  const secondRun = 'wf_second-run';
  h.rows.set(`sub:${P}:other`, { ...h.rows.get(ID), sessionId: `sub:${P}:other`, agentId: 'other', workflowRunId: secondRun });
  h.rows.set(`sub:${P}:ordinary`, { ...h.rows.get(ID), sessionId: `sub:${P}:ordinary`, agentId: 'ordinary', workflowRunId: null });
  const projects = cache.buildProjectsFromCache(false);
  assert.equal(projects[0].sessions.find(row => row.sessionId === ID).workflowName, 'Research <topic>');
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  for (const row of projects[0].sessions) ctx.window.sessionMap.set(row.sessionId, row);
  ctx.sidebar.renderProjects(projects, true);
  const group = ctx.document.querySelector('[data-workflow-run-id]');
  assert.ok(group, 'one workflow block appears beneath the parent');
  assert.equal(ctx.document.querySelectorAll('[data-workflow-run-id]').length, 2, 'one block for each run');
  assert.equal(group.dataset.workflowRunId, RUN);
  assert.ok(group.textContent.includes('Research <topic>'));
  assert.equal(group.querySelector('topic'), null, 'workflow name is text, not HTML');
  assert.ok(group.querySelector('[data-subagent]'));
  assert.equal(ctx.document.getElementById(`si-sub:${P}:ordinary`).closest('[data-workflow-run-id]'), null);
  assert.ok(group.closest('.sidebar-subagents-container'));
  const caret = group.querySelector('.sidebar-children-caret');
  const children = group.querySelector('.sidebar-subagents-container');
  assert.equal(children.style.display, 'none');
  caret.click();
  assert.equal(children.style.display, '');
  ctx.sidebar.renderProjects(structuredClone(projects), true);
  assert.equal(ctx.document.querySelector('[data-workflow-run-id] .sidebar-subagents-container').style.display, '');
  const restored = setupSidebarDom();
  t.after(() => restored.destroy());
  for (const row of projects[0].sessions) restored.window.sessionMap.set(row.sessionId, row);
  restored.window.localStorage.setItem('expandedSubagents', ctx.window.localStorage.getItem('expandedSubagents'));
  restored.sidebar.renderProjects(projects, true);
  assert.equal(restored.document.querySelector('[data-workflow-run-id] .sidebar-subagents-container').style.display, '', 'expansion survives rebuilding the renderer');
  fs.unlinkSync(h.snapshot);
  const fallback = cache.buildProjectsFromCache(false);
  assert.equal(fallback[0].sessions.find(row => row.sessionId === ID).workflowName, RUN);
  ctx.sidebar.renderProjects(fallback, true);
  assert.ok(ctx.document.querySelector('[data-workflow-run-id]').textContent.includes(RUN));
});

test('task snapshot IPC hydrates the workflow child using its cached transcript path', async t => {
  const h = workflowFixture(t);
  let handler;
  const calls = [];
  const child = { sessionId: ID, folder: h.folder, parentSessionId: P, agentId: 'workflow-child', workflowRunId: RUN };
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('get-task-snapshots'");
  const context = {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    cliSessionState: { getSidebarDescriptors: () => [{ sessionId: P }], readAllDescriptors: () => [] },
    activeSessions: new Map(), bgAgents: { getSnapshot: () => ({ roster: [] }) },
    refreshRemoteHeadTurns: async () => {},
    getAllCached: () => [{ sessionId: P, folder: h.folder }, child], getCachedByParent: () => [child],
    parseFolderKey: () => ({ alias: null }), projectsDirForFolder: () => h.dir,
    taskRecords: { read: async () => {}, child: async (...args) => calls.push(args), snapshots: () => [] },
    path, resolveJsonlPath,
  };
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context, { filename });
  await handler();
  assert.deepEqual(calls, [[h.file, P, 'workflow-child']]);
});

test('shared classifier rejects journals and unknown layouts under either separator', () => {
  const { classifyTranscriptPath } = require('../subagent-attribution');
  for (const sep of ['/', '\\']) {
    assert.deepEqual(classifyTranscriptPath([P, 'subagents', 'workflows', RUN, 'agent-child.jsonl'].join(sep)),
      { parentSessionId: P, agentId: 'child', workflowRunId: RUN });
    for (const relative of [
      [P, 'subagents', 'workflows', RUN, 'journal.jsonl'],
      [P, 'subagents', 'workflows', 'wf_short', 'agent-child.jsonl'],
      [P, 'subagents', 'unknown', 'agent-child.jsonl'],
      ['..', 'parent.jsonl'],
      [P, 'subagents', 'agent-child.meta.json'],
    ]) assert.equal(classifyTranscriptPath(relative.join(sep)), null, relative.join(sep));
  }
});

test('workflow transitions detect new and growing agents even when the ordinary directory stays unchanged', t => {
  const h = workflowFixture(t);
  const transitions = require('../session-transitions');
  const events = [];
  transitions.init({ PROJECTS_DIR: h.root, activeSessions: new Map(), log: h.log,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } }) });
  const session = {};
  transitions.detectSubagentTransitions(P, session, h.dir);
  assert.ok(session.knownSubagents.has('workflow-child'), 'bootstrap records workflow children');
  const mtime = fs.statSync(path.join(h.dir, P, 'subagents')).mtime;
  h.writeAgent(path.join(P, 'subagents', 'workflows', RUN, 'agent-later.jsonl'), 'later');
  fs.utimesSync(path.join(h.dir, P, 'subagents'), mtime, mtime);
  transitions.detectSubagentTransitions(P, session, h.dir);
  assert.ok(events.some(event => event.channel === 'subagent-spawned' && event.payload.agentId === 'later'));
  const laterFile = path.join(path.dirname(h.file), 'agent-later.jsonl');
  fs.unlinkSync(laterFile);
  const changed = new Date(Date.now() + 20000);
  fs.utimesSync(path.dirname(h.file), changed, changed);
  transitions.detectSubagentTransitions(P, session, h.dir);
  assert.equal(session.knownSubagents.has('later'), false, 'the remaining journal must not keep a deleted workflow agent in the live registry');
});

test('Changes resolves the workflow agent sidecar from its cached run id', t => {
  const h = workflowFixture(t);
  const { resolveGitChangesTarget } = require('../git-changes-target');
  const meta = JSON.parse(fs.readFileSync(h.file.replace(/\.jsonl$/, '.meta.json')));
  meta.worktreePath = h.root;
  fs.writeFileSync(h.file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
  const row = { sessionId: ID, folder: h.folder, parentSessionId: P, agentId: 'workflow-child', workflowRunId: RUN };
  const result = resolveGitChangesTarget(ID, { projectsDir: h.root, getCachedFolder: () => h.folder,
    getCachedSession: () => row, isRemoteFolder: () => false, readSubagentMeta, existsSync: fs.existsSync }, { allowSubagent: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cwd, h.root);
});
