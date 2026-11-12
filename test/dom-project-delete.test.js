'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const flush = () => new Promise(resolve => setImmediate(resolve));
const unavailable = 'Project deletion is unavailable until recovery of an interrupted deletion finishes';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function settings(h) {
  for (const id of ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body', 'terminal-area', 'terminal-header', 'stats-viewer', 'memory-viewer', 'jsonl-viewer']) {
    if (!h.document.getElementById(id)) { const el = h.document.createElement('div'); el.id = id; h.document.body.append(el); }
  }
  h.w.api.getSetting = async () => ({}); h.w.api.getShellProfiles = async () => [];
  for (const file of ['setting-defaults.js', 'shortcuts.js', 'terminal-themes.js', 'settings-panel.js']) {
    const filename = path.join(__dirname, '../public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  }
  await h.w.openSettingsViewer('project', h.p.projectPath, h.p.folder);
  return h.document.querySelector('#sv-delete-btn');
}
function setup(t, extra = {}) {
  const ctx = setupSidebarDom(); t.after(() => ctx.destroy());
  const w = ctx.window, p = makeSampleProject();
  const calls = { preview: [], execute: [], state: [], writes: [] };
  w.cachedAllProjects = w.cachedProjects = [p];
  w.api.platform = 'win32';
  w.api.previewProjectDelete = async request => {
    calls.preview.push(request);
    return { ok: true, token: 'token-' + calls.preview.length, plan: {
      project: { alias: null, projectPath: p.projectPath }, fingerprint: 'fp-' + calls.preview.length,
      categories: { sessions: { available: true, selected: request.options.sessions }, settings: { available: true, selected: request.options.settings } },
      counts: { conversations: p.sessions.length }, groups: [], members: Array.from({ length: 12 }, (_, i) => ({ id: 'target-' + i })),
      tabs: [], jobs: [], stops: [], schedules: [], warnings: [], refusals: [], ...extra,
    } };
  };
  w.api.deleteProject = async request => { calls.execute.push(request); return { ok: true, state: 'committed', operationId: 'op', invalidation: { sessionIds: [], restoreTargets: [] } }; };
  w.api.projectDeleteState = async request => { calls.state.push(request); return { state: 'unknown', operationId: request.operationId, host: null, projectPath: p.projectPath }; };
  w.api.setSetting = async (...args) => { calls.writes.push(args); };
  w.applyProjectDeletion = async () => {};
  w.loadProjects = async () => {};
  w.showArchived = false; w.searchInput = ctx.document.createElement('input');
  w.pruneRemoteActivityTimers = w.pruneLocalTranscriptTimers = () => {};
  loadAppFunctions(ctx.context, { functions: ['refreshSidebar'] });
  w.renderProjects([p]);
  const start = () => {
    assert.equal(typeof w.confirmAndDeleteProjectFolder, 'function', 'both entry points need the shared deletion controller');
    return w.confirmAndDeleteProjectFolder(p, ctx.document.querySelector('.project-delete-btn'));
  };
  return { ...ctx, w, p, calls, start, confirm: () => ctx.document.querySelector('.choice-dialog-confirm'), cancel: () => ctx.document.querySelector('.choice-dialog-cancel')?.click() };
}
test('AC1 complete preview uses the exact accepted token and both options only', async t => {
  const h = setup(t); const pending = h.start(); await flush();
  assert.match(h.document.querySelector('.choice-dialog').textContent, /target-11/);
  assert.equal(h.confirm().disabled, false); h.confirm().click(); await pending;
  assert.equal(h.calls.execute.length, 1);
  const last = h.calls.preview.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(last.options)), { sessions: false, settings: true, schedules: false, transcripts: false, stopBackgroundJobs: false });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.execute[0])), { token: 'token-' + h.calls.preview.length, fingerprint: 'fp-' + h.calls.preview.length });
});
test('AC4 AC5 AC11 busy survives skipped partial full renders; duplicate Cancel has no effects', async t => {
  const h = setup(t); const pending = h.start(); await flush();
  h.w.refreshSidebar({ skipUnchanged: true }); h.w.refreshSidebar({ skipUnchanged: true });
  h.p.sessions[0].summary = 'partial'; h.w.renderProjects([h.p]); h.w.renderProjects([h.p], true);
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, true);
  const before = h.calls.preview.length; await h.start();
  assert.equal(h.calls.preview.length, before, 'rerender must not forget busy ownership');
  h.document.querySelector('[data-choice-id="sessions"]').click(); await flush();
  h.cancel(); await pending;
  assert.equal(h.calls.execute.length, 0); assert.equal(h.calls.writes.length, 0);
  assert.equal(h.w.localStorage.getItem('deleteProject.sessions'), null);
  assert.equal(h.w.localStorage.getItem('deleteProject.settings'), null);
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, false);
});
for (const platform of ['linux', 'darwin']) test(`local PTY plan on ${platform} cannot confirm`, async t => {
  const h = setup(t, { stops: [{ evidence: { source: 'pty' }, targetId: 'pty' }] }); h.w.api.platform = platform;
  const pending = h.start(); await flush();
  assert.equal(h.confirm().disabled, true); assert.match(h.document.body.textContent, /Windows/);
  h.cancel(); await pending; assert.equal(h.calls.execute.length, 0);
});
test('background jobs stay excluded and shared settings ignore remembered true', async t => {
  const h = setup(t, { jobs: [{ id: 'job', liveness: { state: 'running' } }], categories: { sessions: { available: true }, settings: { available: false, reason: 'Shared key' } } });
  h.w.localStorage.setItem('deleteProject.settings', '1');
  const pending = h.start(); await flush();
  const box = h.document.querySelector('[data-choice-id="settings"]'); assert.equal(box.disabled, true); assert.equal(box.checked, false);
  assert.equal(h.confirm().disabled, true); assert.match(h.document.body.textContent, /Agents view/);
  h.cancel(); await pending; assert.equal(h.w.localStorage.getItem('deleteProject.settings'), '1');
  assert.equal(h.calls.execute.length, 0);
});
test('NOT_READY is global, retries next open, and never executes', async t => {
  const h = setup(t); h.w.api.previewProjectDelete = async () => ({ ok: false, code: 'NOT_READY' });
  await h.start(); assert.match(h.document.body.textContent, new RegExp(unavailable));
  await h.w.confirmAndDeleteProjectFolder({ ...h.p, projectPath: '/other' });
  assert.match(h.document.body.textContent, new RegExp(unavailable)); assert.equal(h.calls.execute.length, 0);
});
test('announced unknown operation retains project identity and reads state without replay', async t => {
  const h = setup(t);
  assert.equal(typeof h.w.reconcileProjectDeletions, 'function', 'recovery listener must reconcile announced operations');
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'lost', host: null, projectPath: h.p.projectPath }] });
  assert.match(h.document.body.textContent, /unresolved/i);
  await h.start(); assert.equal(h.calls.execute.length, 0); assert.equal(h.calls.preview.length, 0);
  assert.equal(h.calls.state[0].operationId, 'lost');
});

test('Settings and sidebar share one operation and empty project completes', async t => {
  const h = setup(t); h.p.sessions = [];
  const button = await settings(h); button.click(); await flush();
  const count = h.calls.preview.length; await h.start(); assert.equal(h.calls.preview.length, count);
  h.confirm().click(); await flush();
  assert.equal(h.calls.execute.length, 1); assert.equal(h.document.querySelector('#settings-viewer').style.display, 'none');
});

for (const callback of ['previewProjectDelete', 'deleteProject', 'projectDeleteState']) test(`${callback} NOT_READY blocks both entry points without another execution`, async t => {
  const h = setup(t); const button = await settings(h);
  h.w.api[callback] = async () => ({ ok: false, code: 'NOT_READY', retryable: true });
  if (callback === 'projectDeleteState') await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'recover', host: null, projectPath: h.p.projectPath }] });
  else {
    button.click(); await flush();
    if (callback === 'deleteProject') { h.confirm().click(); await flush(); }
  }
  assert.match(h.document.body.textContent, new RegExp(unavailable));
  h.w.api.previewProjectDelete = async () => ({ ok: false, code: 'NOT_READY' });
  await h.w.confirmAndDeleteProjectFolder({ ...h.p, projectPath: '/other' });
  assert.equal(h.calls.execute.length, 0);
});

test('committed refresh failure offers reload; unknown and partial outcomes never replay', async t => {
  const h = setup(t); let result = { state: 'unknown', operationId: 'op', stopped: [{ id: 'pty' }] };
  h.w.api.deleteProject = async request => { h.calls.execute.push(request); return result; };
  const pending = h.start(); await flush(); h.confirm().click(); await pending;
  await h.start(); assert.equal(h.calls.execute.length, 1); assert.match(h.document.body.textContent, /unresolved/);
  h.w.api.projectDeleteState = async () => ({ state: 'partial', operationId: 'op', host: null, projectPath: h.p.projectPath });
  h.document.querySelector('.app-notice-action').click(); await flush();
  assert.match(h.document.body.textContent, /partially completed/); await h.start(); assert.equal(h.calls.execute.length, 1);
  result = { ok: true, state: 'committed', operationId: 'op', invalidation: { sessionIds: [], restoreTargets: [] } };
  h.w.api.projectDeleteState = async () => result; h.w.loadProjects = async () => { throw new Error('offline'); };
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'op', host: null, projectPath: h.p.projectPath }] });
  assert.match(h.document.body.textContent, /Deletion completed/); assert.match(h.document.body.textContent, /Reload window/);
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, true, 'acknowledged deletion must not be offered again after a failed refresh');
  await h.start(); assert.equal(h.calls.execute.length, 1);
});

test('recovery NOT_READY retains a retry action for the announced operation', async t => {
  const h = setup(t); h.w.api.projectDeleteState = async () => ({ code: 'NOT_READY', retryable: true });
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'known', host: null, projectPath: h.p.projectPath }] });
  assert.equal(h.document.querySelector('.app-notice-action')?.textContent, 'Check deletion state');
});

test('committed ACK prunes only acknowledged tabs and pending restore targets', async t => {
  const h = setup(t);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(source, /function applyProjectDeletion\(/, 'app must consume acknowledged invalidation');
  const own = { sessionId: 'own', projectPath: h.p.projectPath }, other = { sessionId: 'other', projectPath: '/other' };
  Object.assign(h.w, { restoreAwaitingConsent: [own, other], restoreInFlight: new Map([['own', own], ['other', other]]),
    restoreSavedIndex: new Map([['own', 0], ['other', 1]]), dormantWorkingSet: new Map([['own', { item: own }]]),
    skippedWorkingSetEntries: new Map(), restorePlanner: { isSettled: () => false, pending: () => [own, other] },
    pendingSessions: new Map([['own', { session: own, projectPath: own.projectPath }], ['other', { session: other, projectPath: other.projectPath }]]), closeAllDiffs() {},
    queueSchedulesReload() {}, resetSearchFilter() {}, loadWorkFiles: async () => {},
    setActiveSession() {}, switchPanel() {}, placeholder: h.document.getElementById('placeholder'), terminalHeader: h.document.createElement('div'),
  });
  let memories = 0; h.w.loadMemories = async () => { memories++; };
  const oldTouched = { type: 'touched', data: { files: ['stale'] } };
  h.w.filePanelState = new Map([['own', { currentTab: { type: 'changes', returnList: oldTouched } }]]);
  const destroyed = []; h.w.destroySession = id => { destroyed.push(id); h.w.openSessions.delete(id); };
  h.w.openSessions.set('own', { session: own }); h.w.openSessions.set('other', { session: other });
  loadAppFunctions(h.context, { functions: ['applyProjectDeletion', 'pendingRestoreEntries'] });
  await h.w.applyProjectDeletion({ ok: true, state: 'committed', invalidation: { sessionIds: ['own'], restoreTargets: [{ ...own, alias: null }] } });
  assert.deepEqual(destroyed, ['own']); assert.equal(h.w.openSessions.has('other'), true);
  assert.deepEqual(Array.from(h.w.pendingRestoreEntries(), row => row.item.sessionId), ['other', 'other', 'other']);
  assert.equal(h.w.pendingSessions.has('own'), false);
  assert.notEqual(h.w.filePanelState.get('own').currentTab.returnList, oldTouched, 'late Touched replies must target a detached list');
  assert.equal(memories, 1, 'Agent Files must refresh after ACK');
});

test('historical committed recovery refreshes without tearing down a re-added session', async t => {
  const h = setup(t); let applied = 0; h.w.applyProjectDeletion = async () => { applied++; };
  h.w.api.projectDeleteState = async () => ({ ok: true, state: 'committed', operationId: 'old', host: null, projectPath: h.p.projectPath,
    invalidation: { sessionIds: ['reopened'], restoreTargets: [] } });
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'old', host: null, projectPath: h.p.projectPath }] });
  assert.equal(applied, 0, 'historical receipt has no proof that reopened sessions still belong to its epoch');
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, false);
});

test('a global snapshot read before deletion cannot overwrite its committed hidden state', async t => {
  const h = setup(t); let resolveRead;
  h.w.api.getSetting = () => new Promise(resolve => { resolveRead = resolve; });
  Object.assign(h.w, { exitingApp: false, skippedWorkingSetEntries: new Map(), dormantWorkingSet: new Map(),
    restoreAwaitingConsent: [], restoreInFlight: new Map(), restoreSavedIndex: new Map(), restorePlanner: null });
  loadAppFunctions(h.context, { functions: ['persistWorkingSet', 'pendingRestoreEntries'], declarations: ['_persistChain'] });
  const write = h.w.persistWorkingSet(); await flush();
  h.w.setProjectDeletionBusy(h.p, true);
  resolveRead({ hiddenProjects: [] }); await write;
  assert.equal(h.calls.writes.length, 0, 'stale global snapshot must not overwrite deletion visibility');
});

test('partial receipt offers an explicit fresh preview without replaying the old operation', async t => {
  const h = setup(t);
  h.w.api.deleteProject = async request => { h.calls.execute.push(request); return { state: 'partial', operationId: 'partial' }; };
  const pending = h.start(); await flush(); h.confirm().click(); await pending;
  const action = h.document.querySelector('.app-notice-action');
  assert.equal(action.textContent, 'Review remaining deletion');
  action.click(); await flush(); assert.ok(h.confirm()); assert.equal(h.calls.execute.length, 1);
  h.cancel(); await flush();
});
