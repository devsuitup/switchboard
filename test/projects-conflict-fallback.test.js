'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadHandler = require('./get-projects-handler.cjs');
const { loadAppFunctions } = require('./app-source');
const { setupSidebarDom } = require('./dom-setup');
const { createRestorePlanner } = require('../public/restore-plan');
const conflict = () => Object.assign(new Error('Projects changed while loading; reload to retry.'), { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
const rows = name => ({ defaultProjects: [{ projectPath: name, sessions: [] }], allProjects: [{ projectPath: name, sessions: [] }] });
function fixture(overrides = {}) {
  let reply = rows('/consistent'), error;
  const invoke = loadHandler({ TRACE: { on: false }, projectsReconciledAt: 0,
    console: { error() {} }, getSetting: () => ({}),
    isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    backfillEntrypoints() {}, backfillCustomTitles() {},
    writer: { applyAndPersistArchived: async projects => projects },
    mergePlaceholderSessions: projects => projects, annotateRemoteAttachable: projects => projects,
    projectsClient: { request: async () => { if (error) throw error; return reply; } }, ...overrides });
  return { invoke, conflict: () => { error = conflict(); }, reply: value => { error = null; reply = value; } };
}
for (const disk of [null, rows('/disk-only')]) test(`conflict without an in-process result is unavailable, disk=${!!disk}`, async () => {
  let loads = 0;
  const f = fixture({ lastKnownProjects: { load: async () => { loads++; return disk; }, remember() {} } });
  f.conflict();
  const reply = await f.invoke(null, 'both');
  assert.equal(reply.projectsError?.code, 'PROJECTS_SNAPSHOT_CONFLICT', 'no empty or on-disk fallback can masquerade as a project load');
  assert.equal(reply.allProjects, undefined);
  assert.equal(loads, 0, 'disk snapshots are provisional renderer paint only');
});
test('effect-free stale rows pass through after a conflict and do not resurrect deleted cached projects', async () => {
  const f = fixture();
  await f.invoke(null, 'both'); f.conflict(); await f.invoke(null, 'both');
  f.reply({ ...rows('/real'), stale: true });
  const reply = await f.invoke(null, 'both');
  assert.equal(reply.allProjects[0].projectPath, '/real', 'current DB rows must replace the old consistent rows');
  assert.equal(reply.projectsFallback, undefined);
  assert.equal(reply.projectsStale, true);
});
test('conflicts after success return only an error envelope without assembling cached lists', async () => {
  let assemblies = 0;
  const f = fixture({ writer: { applyAndPersistArchived: async projects => { assemblies++; return projects; } } });
  await f.invoke(null, 'both'); f.conflict();
  for (const mode of ['both', false, true]) {
    const reply = await f.invoke(null, mode);
    assert.equal(reply.projectsError?.code, 'PROJECTS_SNAPSHOT_CONFLICT', 'every conflict must return an error envelope even after a successful load');
    assert.equal(reply.allProjects, undefined);
    assert.equal(reply.defaultProjects, undefined);
    assert.equal(reply.projectsFallback, undefined);
  }
  assert.equal(assemblies, 2, 'conflicts must not re-assemble or persist old lists');
  await assert.rejects(f.invoke.triggerSnapshot(), /project lookup unavailable/, 'trigger must refuse a conflict after success');
});
test('trigger snapshot refuses effect-free stale rows', async () => {
  const f = fixture(); f.reply({ ...rows('/real'), stale: true });
  await assert.rejects(f.invoke.triggerSnapshot(), /project lookup unavailable/, 'stale project lookup must be retryable');
});
for (const consumer of ['loadStartupProjects', 'markRestoreIndexingDone', 'reloadProjects']) test(`renderer keeps previous lists and pending restore on a conflict through ${consumer}`, async t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window;
  const planner = createRestorePlanner({ savedSet: [{ sessionId: 'saved' }] });
  const provisional = [{ projectPath: '/provisional', sessions: [] }];
  let ready = 0, loaded, ticks = 0;
  w.cachedProjects = provisional; w.cachedAllProjects = provisional;
  w.sidebarContent.classList.add('projects-provisional');
  w.loadingStatus = w.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus', 'setRemoteHostLabels', 'refreshSidebar', 'clearAppNotice']) w[name] = () => {};
  w.console.warn = () => {}; w.setTimeout = () => 1;
  w.pollActiveSessions = async () => undefined;
  const f = fixture(); await f.invoke(null, 'both'); f.conflict();
  const filename = path.join(__dirname, '../preload.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('getProjects: ') + 'getProjects: '.length;
  const end = source.indexOf('  sessionProjectionChanged:', start);
  assert.ok(start > 'getProjects: '.length && end > start);
  w.api.getProjects = vm.runInNewContext(source.slice(start, end).trimEnd().replace(/,$/, ''), { ipcRenderer: { invoke: (_name, mode) => f.invoke(null, mode) } }, { filename });
  w.api.getSetting = async () => ({}); w.api.getActiveTerminals = async () => [];
  w.api.triggerActionsReady = async () => { ready++; };
  w.restorePlanner = planner; w.skippedWorkingSetEntries = new Map();
  w.tickRestorePlanner = async () => { ticks++; planner.tick({ sessionMap: w.sessionMap, openSessions: w.openSessions, indexingDone: true }); };
  w.maybeRetryRestoreWorkingSet = w.tickRestorePlanner;
  w.restoreStartupSessions = async options => { loaded = options?.projectsLoaded; if (loaded) await w.tickRestorePlanner(); };
  loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects', 'reloadProjects', 'loadStartupProjects', 'markRestoreIndexingDone'], declarations: ['startupProjectsHandedOver'] });
  await w[consumer]({ restoreRetry: true });
  assert.equal(w.loadProjects.state.committed, 0, 'conflict must not commit a project generation');
  assert.equal(w.cachedProjects, provisional);
  assert.equal(w.cachedAllProjects, provisional);
  assert.equal(w.sidebarContent.classList.contains('projects-provisional'), true);
  if (consumer === 'loadStartupProjects') assert.equal(loaded, false);
  assert.equal(ready, 0);
  assert.equal(ticks, 0, 'conflict must not advance the restore planner');
  assert.equal(planner.isSettled(), false);
});
