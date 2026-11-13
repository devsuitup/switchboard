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

test('a selected preview rejection names its port in the open dialog and Cancel releases both rows', async t => {
  const h = setup(t), original = h.w.api.previewProjectDelete;
  const other = { ...h.p, projectPath: '/other', sessions: [] };
  h.w.cachedAllProjects = h.w.cachedProjects = [h.p, other];
  h.w.renderProjects([h.p, other]);
  let reject, calls = 0;
  h.w.api.previewProjectDelete = request => ++calls === 1 ? original(request) : new Promise((_resolve, fail) => { reject = fail; });
  const pending = h.start(); await flush();
  assert.ok(h.confirm());
  reject(Object.assign(new Error('Discovery failed'), { code: 'DISCOVERY_TIMEOUT', port: 'runClaude.agents', elapsedMs: 20000, boundMs: 20000 }));
  await flush();
  const message = h.document.querySelector('.choice-dialog').textContent;
  assert.equal(h.confirm().disabled, true);
  h.cancel(); await pending;
  assert.ok([...h.document.querySelectorAll('.project-delete-btn')].every(button => !button.disabled));
  assert.match(message, /runClaude\.agents/, 'open dialog must identify the failed port');
  assert.equal(h.calls.execute.length, 0);
});

for (const rejected of [true, false]) test(`capabilities DISCOVERY_TIMEOUT rejection=${rejected} names the port and releases both project rows`, async t => {
  const h = setup(t);
  const other = { ...h.p, folder: 'other', projectPath: '/other', sessions: [] };
  h.w.cachedAllProjects = h.w.cachedProjects = [h.p, other];
  h.w.renderProjects([h.p, other]);
  let finish;
  h.w.api.previewProjectDelete = () => new Promise((resolve, reject) => { finish = rejected ? reject : resolve; });
  const pending = h.start(); await flush();
  const buttons = [...h.document.querySelectorAll('.project-delete-btn')];
  assert.equal(buttons.length, 2);
  const ownHeader = h.document.getElementById('ph-' + h.w.folderId(h.p.projectPath, h.p.remoteAlias));
  const otherHeader = h.document.getElementById('ph-' + h.w.folderId(other.projectPath, other.remoteAlias));
  assert.equal(ownHeader.querySelector('.project-delete-btn').disabled, true, 'pending preview blocks its project');
  assert.equal(otherHeader.querySelector('.project-delete-btn').disabled, false, 'busy state is per project');
  const failure = { code: 'DISCOVERY_TIMEOUT', port: 'runClaude.agents', elapsedMs: 20000, boundMs: 20000 };
  finish(rejected ? Object.assign(new Error('Discovery failed'), failure) : { ok: false, ...failure });
  assert.equal(await pending, false);
  assert.match(h.document.querySelector('.app-notice[role="alert"]')?.textContent || '', /runClaude\.agents/, 'timeout notice must name the failed process port');
  assert.ok([...h.document.querySelectorAll('.project-delete-btn')].every(button => !button.disabled), 'failure releases every project row');
  assert.equal(h.document.querySelector('.choice-dialog'), null);
  assert.equal(h.calls.execute.length, 0);
});

for (const stalled of ['flushProjectDeletionWrites', 'previewProjectDelete']) test(`click shows a notice within 21 seconds when ${stalled} never settles`, async t => {
  const h = setup(t), timers = new Map(); let id = 0, time = 0, release;
  h.w.Date.now = () => time;
  h.w.setTimeout = (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; };
  h.w.clearTimeout = key => timers.delete(key);
  const target = stalled === 'previewProjectDelete' ? h.w.api : h.w;
  const original = target[stalled];
  target[stalled] = () => new Promise(resolve => { release = resolve; });
  const pending = h.start(); await flush();
  time = 20000;
  for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
  await flush();
  assert.equal(h.document.querySelector('.app-notice'), null, 'renderer must leave the main-side twenty-second budget intact');
  time = 21000;
  for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
  await flush();
  const notice = h.document.querySelector('.app-notice[role="alert"]');
  assert.ok(notice, 'a stalled pre-dialog port must show a notice by the discovery deadline plus 1000 ms');
  assert.match(notice.textContent, new RegExp(stalled));
  assert.equal(await pending, false);
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, false);
  target[stalled] = original;
  release(stalled === 'previewProjectDelete' ? await original({ options: {} }) : undefined);
  await flush();
  assert.equal(h.document.querySelector('.choice-dialog'), null, 'late completion must not open a stale dialog');
  assert.equal(h.calls.execute.length, 0);
});

test('a stalled real persistence chain shows a notice and shares the click budget with capabilities', async t => {
  const h = setup(t), timers = new Map(); let id = 0, time = 0, release;
  persistence(h);
  h.w.Date.now = () => time;
  h.w.setTimeout = (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; };
  h.w.clearTimeout = key => timers.delete(key);
  h.w.api.getSetting = () => new Promise(resolve => { release = resolve; });
  const saving = h.w.saveGlobalSettings({ sidebarWidth: 321 }); await flush();
  h.w.api.previewProjectDelete = () => new Promise(() => {});
  const pending = h.start(); await flush();
  time = 8000; release({}); await saving; await flush();
  time = 21000;
  for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
  await flush();
  assert.match(h.document.querySelector('.app-notice')?.textContent || '', /previewProjectDelete.*timed out/, 'capabilities must receive only the remaining click budget after the writer flush');
  assert.equal(await pending, false);
  assert.equal(h.document.querySelector('.choice-dialog'), null);
});

test('Confirm is disabled while the selected preview loads and becomes enabled on its valid reply', async t => {
  const h = setup(t), original = h.w.api.previewProjectDelete;
  let release, calls = 0;
  h.w.api.previewProjectDelete = request => ++calls === 1 ? original(request)
    : new Promise(resolve => { release = async () => resolve(await original(request)); });
  const pending = h.start(); await flush();
  assert.ok(h.confirm());
  assert.equal(h.confirm().disabled, true);
  await release(); await flush();
  assert.equal(h.confirm().disabled, false, 'loading is not a permanent refusal');
  h.cancel(); await pending;
});

function persistence(h) {
  let global = { hiddenProjects: [], sidebarWidth: 100 };
  Object.assign(h.w, { exitingApp: false, skippedWorkingSetEntries: new Map(), dormantWorkingSet: new Map(),
    restoreAwaitingConsent: [], restoreInFlight: new Map(), restoreSavedIndex: new Map(), restorePlanner: null });
  h.w.api.getSetting = async () => structuredClone(global);
  h.w.api.setSetting = async (key, value) => { h.calls.writes.push([key, value]); global = structuredClone(value); };
  loadAppFunctions(h.context, { functions: ['persistWorkingSet', 'pendingRestoreEntries', 'saveGlobalSettings'], declarations: ['_persistChain'] });
  h.w.flushProjectDeletionWrites = () => vm.runInContext('_persistChain', h.context);
  return () => global;
}

test('overlapping state reads keep writes held until the last reply', async t => {
  const h = setup(t), saved = persistence(h), replies = [];
  h.w.api.projectDeleteState = () => new Promise(resolve => replies.push(resolve));
  const operation = { operationId: 'same', host: null, projectPath: h.p.projectPath };
  const first = h.w.reconcileProjectDeletions({ operations: [operation] });
  const second = h.w.reconcileProjectDeletions({ operations: [operation] });
  await h.w.saveGlobalSettings({ sidebarWidth: 400 });
  replies[0]({ state: 'unknown', operationId: 'same' }); await first; await flush();
  assert.equal(saved().sidebarWidth, 100, 'one state reply must not release another in-flight read');
  replies[1]({ state: 'unknown', operationId: 'same' }); await second; await flush(); await h.w.flushProjectDeletionWrites();
  assert.equal(saved().sidebarWidth, 400);
  assert.equal(h.calls.writes.length, 1);
});

test('global patches remove keys only when requested and retain removal through deferral', async t => {
  const h = setup(t), saved = persistence(h);
  saved().chrome = true;
  assert.equal(await h.w.saveGlobalSettings({ browserMode: 'off' }), true);
  assert.equal(saved().chrome, true, 'generic patches must not infer key removal from browserMode');
  h.w.setProjectDeletionWritesBlocked(h.p, true);
  assert.equal(await h.w.saveGlobalSettings({ browserMode: 'managed' }, { remove: ['chrome'] }), 'deferred');
  await h.w.saveGlobalSettings({ sidebarWidth: 321 });
  assert.equal(saved().chrome, true);
  h.w.setProjectDeletionWritesBlocked(h.p, false);
  await flush(); await h.w.flushProjectDeletionWrites();
  assert.equal(Object.hasOwn(saved(), 'chrome'), false);
  assert.equal(saved().browserMode, 'managed');
  assert.equal(saved().sidebarWidth, 321);
  assert.equal(h.document.querySelector('.app-notice'), null, 'successful replay must not show a notice');
});

for (const method of ['getSetting', 'setSetting']) test(`deferred Settings replay ${method} rejection shows an actionable failure notice`, async t => {
  const h = setup(t);
  await settings(h, 'global');
  const saved = persistence(h);
  saved().chrome = true;
  h.w.setProjectDeletionWritesBlocked(h.p, true);
  assert.equal(await h.w.saveGlobalSettings({ browserMode: 'managed' }, { remove: ['chrome'] }), 'deferred');
  const original = h.w.api[method];
  h.w.api[method] = async () => { throw new Error('storage unavailable'); };
  h.w.closeSettingsViewer();
  h.w.setProjectDeletionWritesBlocked(h.p, false);
  await flush(); await h.w.flushProjectDeletionWrites();
  const notice = h.document.querySelector('.app-notice[role="alert"]');
  assert.ok(notice, 'failed deferred Settings replay must show an error notice');
  assert.match(notice.textContent, /settings could not be saved/i);
  assert.match(notice.textContent, /save again/i);
  assert.equal(saved().chrome, true, 'failed replay must not claim the removal was persisted');
  h.w.api[method] = original;
  const action = notice.querySelector('.app-notice-action');
  assert.equal(action?.textContent, 'Open Settings');
  action.click(); await flush();
  assert.equal(h.document.getElementById('settings-viewer').style.display, 'flex');
  assert.match(h.document.getElementById('settings-viewer-title').textContent, /Global Settings/);
  assert.ok(h.document.querySelector('#sv-save-btn'), 'recovery must offer the Settings Save control');
});

for (const method of ['deleteProject', 'projectDeleteState']) test(`${method} preserves the backend bounded unknown reply and operation ID`, async t => {
  const h = setup(t), timers = new Map(); let id = 0, reply;
  h.w.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  h.w.clearTimeout = key => timers.delete(key);
  h.w.api[method] = () => new Promise(resolve => { reply = resolve; });
  const pending = method === 'deleteProject' ? h.start()
    : h.w.reconcileProjectDeletions({ operations: [{ operationId: 'op-15s', host: null, projectPath: h.p.projectPath }] });
  await flush();
  if (method === 'deleteProject') { h.confirm().click(); await flush(); }
  for (const timer of timers.values()) if (timer.ms <= 15000) timer.fn();
  await flush();
  reply({ state: 'unknown', operationId: 'op-15s' }); await pending;
  assert.equal(h.document.querySelector('.app-notice-action')?.textContent, 'Check deletion state', 'backend reply must win without a competing renderer timeout');
  assert.doesNotMatch(h.document.querySelector('.app-notice').textContent, /timed out/, 'state replies must also retain the backend result');
  h.w.api.projectDeleteState = async request => { h.calls.state.push(request); return { state: 'unknown', operationId: request.operationId }; };
  h.document.querySelector('.app-notice-action').click(); await flush();
  assert.equal(h.calls.state.at(-1).operationId, 'op-15s');
});

test('a state response without state releases busy and offers an actionable check', async t => {
  const h = setup(t); h.w.api.projectDeleteState = async () => ({ ok: false, code: 'UNKNOWN_OPERATION' });
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'missing', host: null, projectPath: h.p.projectPath }] });
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, false, 'unrecognized operation must not lock the project forever');
  assert.equal(h.document.querySelector('.app-notice-action')?.textContent, 'Check deletion state');
});

test('unknown background worker evidence does not promise that Stop unblocks deletion', async t => {
  const h = setup(t, { jobs: [{ id: 'finished-record', liveness: { state: 'unknown', source: 'job' } }] });
  const pending = h.start(); await flush();
  assert.equal(h.confirm().disabled, true);
  assert.match(h.document.querySelector('.choice-dialog').textContent, /worker liveness.*cannot be verified/i);
  assert.doesNotMatch(h.document.querySelector('.choice-dialog').textContent, /Stop the background job.*then reopen/i);
  h.cancel(); await pending;
});

for (const state of ['unknown', 'partial', 'committed', 'rejected']) test(`writes resume once after ${state} execute reply and keep the latest state`, async t => {
  const h = setup(t), saved = persistence(h);
  let reply, reject;
  h.w.api.deleteProject = request => { h.calls.execute.push(request); return new Promise((yes, no) => { reply = yes; reject = no; }); };
  const pending = h.start(); await flush();
  await h.w.saveGlobalSettings({ sidebarWidth: 150 });
  assert.equal(saved().sidebarWidth, 150, 'preview must not suspend settings writes');
  h.confirm().click(); await flush();
  await h.w.saveGlobalSettings({ sidebarWidth: 200 });
  await h.w.saveGlobalSettings({ sidebarWidth: 300 });
  h.w.openSessions.set('new', { session: { sessionId: 'new', projectPath: '/other' } });
  await h.w.persistWorkingSet();
  h.w.openSessions.set('latest', { session: { sessionId: 'latest', projectPath: '/other' } });
  await h.w.persistWorkingSet();
  assert.equal(saved().sidebarWidth, 150, 'execute must hold writes');
  if (state === 'rejected') reject(new Error('lost response'));
  else reply({ state, operationId: 'held', ok: state === 'committed', invalidation: { sessionIds: [], restoreTargets: [] } });
  await pending; await flush(); await h.w.flushProjectDeletionWrites();
  assert.equal(h.w.projectDeletionWritesBlocked, false, 'a receipt must release the global write block');
  assert.equal(saved().sidebarWidth, 300, 'the latest dropped sidebar width must be written');
  assert.deepEqual(saved().openWorkingSet.map(item => item.sessionId), ['new', 'latest']);
  assert.equal(h.calls.writes.length, 3, 'one initial write, one merged patch and one latest working set');
});

test('a final working-set flush during execute logs its deferral and is replayed on receipt', async t => {
  const h = setup(t), saved = persistence(h), warnings = [];
  h.w.console.warn = (...args) => warnings.push(args.join(' '));
  let reply;
  h.w.api.deleteProject = () => new Promise(resolve => { reply = resolve; });
  const pending = h.start(); await flush(); h.confirm().click(); await flush();
  h.w.openSessions.set('final', { session: { sessionId: 'final', projectPath: '/other' } });
  await h.w.persistWorkingSet({ final: true, checked: true });
  assert.ok(warnings.some(line => /final.*defer.*deletion/i.test(line)), 'final flush must explain why it was deferred');
  h.w.exitingApp = true;
  reply({ state: 'unknown', operationId: 'op' }); await pending; await flush(); await h.w.flushProjectDeletionWrites();
  assert.equal(saved().openWorkingSet?.[0]?.sessionId, 'final', 'the deferred final working set must be written after receipt');
});

async function settings(h, scope = 'project') {
  for (const id of ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body', 'terminal-area', 'terminal-header', 'stats-viewer', 'memory-viewer', 'jsonl-viewer']) {
    if (!h.document.getElementById(id)) { const el = h.document.createElement('div'); el.id = id; h.document.body.append(el); }
  }
  h.w.api.getSetting = async () => ({}); h.w.api.getShellProfiles = async () => [];
  for (const file of ['shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'settings-panel.js']) {
    const filename = path.join(__dirname, '../public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  }
  await h.w.openSettingsViewer(scope, h.p.projectPath, h.p.folder);
  return h.document.querySelector('#sv-delete-btn');
}

test('Global Settings deferred by deletion apply in-window and persist after its receipt', async t => {
  const h = setup(t);
  await settings(h, 'global');
  const saved = persistence(h), applied = {};
  saved().chrome = true;
  h.w._setVisibleSessionCount = value => { applied.count = value; };
  h.w._setSessionMaxAge = value => { applied.age = value; };
  h.w._applyTerminalTheme = value => { applied.theme = value; };
  h.document.querySelector('#sv-visible-count').value = '23';
  h.document.querySelector('#sv-max-age').value = '42';
  const theme = h.document.querySelector('#sv-terminal-theme');
  theme.selectedIndex = 1;
  h.document.querySelector('#sv-remote-add').click();
  for (const [selector, value] of [['.rh-alias', 'box'], ['.rh-label', 'Test host']]) {
    const input = h.document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new h.w.Event('input'));
  }
  let read;
  const getSetting = h.w.api.getSetting;
  h.w.api.getSetting = () => new Promise(resolve => { read = resolve; });
  h.document.querySelector('#sv-save-btn').click();
  await flush();
  h.w.setProjectDeletionWritesBlocked(h.p, true);
  read({ chrome: true });
  await flush();
  assert.deepEqual(applied, { count: 23, age: 42, theme: theme.value }, 'deferred settings must apply immediately in this window');
  assert.equal(h.w.remoteHostLabel('box'), 'Test host');
  assert.doesNotMatch(h.document.querySelector('#app-notices').textContent, /not saved|save again/i);
  assert.equal(h.calls.writes.length, 0, 'the deletion must still hold persistence');
  h.w.api.getSetting = getSetting;
  saved().hiddenProjects = ['/deleted'];
  h.w.setProjectDeletionWritesBlocked(h.p, false);
  await flush(); await h.w.flushProjectDeletionWrites();
  assert.equal(saved().visibleSessionCount, 23);
  assert.equal(saved().sessionMaxAgeDays, 42);
  assert.equal(saved().terminalTheme, theme.value);
  assert.equal(saved().remoteHosts[0].label, 'Test host');
  assert.deepEqual(saved().hiddenProjects, ['/deleted']);
  assert.equal(Object.hasOwn(saved(), 'chrome'), false, 'deferred Settings must remove the legacy chrome key');
  assert.equal(h.calls.writes.length, 1);
});

test('remote Project Settings refuses Save while its deletion dialog is open', async t => {
  const h = setup(t);
  h.p.remoteAlias = 'box';
  h.p.folder = 'box::' + h.p.folder;
  h.w.cachedAllProjects = [{ ...h.p, remoteAlias: null, folder: 'local' }, h.p];
  await settings(h);
  const pending = h.start();
  await flush();
  assert.ok(h.confirm(), 'the remote deletion preview must be open');
  assert.equal(!!h.w.projectDeletionWritesBlocked, false, 'preview does not hold global writes');
  h.document.querySelector('#sv-save-btn').click();
  await flush();
  assert.equal(h.calls.writes.length, 0, 'remote project settings must not save during its deletion preview');
  assert.match(h.document.querySelector('#app-notices').textContent, /not saved/i);
  h.cancel(); await pending;
  h.document.querySelector('#sv-save-btn').click();
  await flush();
  assert.equal(h.calls.writes.length, 1, 'cancelling deletion must allow Save again');
});
function setup(t, extra = {}) {
  const ctx = setupSidebarDom(); t.after(() => ctx.destroy());
  const defaults = path.join(__dirname, '../public/setting-defaults.js');
  vm.runInContext(fs.readFileSync(defaults, 'utf8'), ctx.context, { filename: defaults });
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
  const before = h.calls.preview.length; const duplicate = h.start(); await flush();
  assert.equal(h.calls.preview.length, before, 'rerender must not forget busy ownership');
  await duplicate;
  assert.equal(h.document.querySelector('.project-delete-btn').disabled, true);
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
  h.w.api[callback] = async request => {
    if (callback === 'deleteProject') h.calls.execute.push(request);
    return { ok: false, code: 'NOT_READY', retryable: true };
  };
  if (callback === 'projectDeleteState') await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'recover', host: null, projectPath: h.p.projectPath }] });
  else {
    button.click(); await flush();
    if (callback === 'deleteProject') { h.confirm().click(); await flush(); }
  }
  assert.match(h.document.body.textContent, new RegExp(unavailable));
  h.w.api.previewProjectDelete = async () => ({ ok: false, code: 'NOT_READY' });
  await h.w.confirmAndDeleteProjectFolder({ ...h.p, projectPath: '/other' });
  assert.equal(h.calls.execute.length, callback === 'deleteProject' ? 1 : 0);
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

for (const alias of [null, 'box']) test(`committed ACK prunes only acknowledged tabs and pending restore targets (${alias || 'local'})`, async t => {
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
  h.w.openSessions.set('own', { session: { ...own, remoteAlias: alias } }); h.w.openSessions.set('other', { session: other });
  Object.assign(h.w, { exitingApp: false });
  h.w.api.getSetting = async () => ({ openWorkingSet: [own, other] });
  loadAppFunctions(h.context, { functions: ['applyProjectDeletion', 'pendingRestoreEntries', 'persistWorkingSet'], declarations: ['_persistChain'] });
  let oldReply;
  h.w.api.getProjects = () => new Promise(resolve => { oldReply = resolve; });
  h.w.api.getActiveTerminals = async () => [];
  Object.assign(h.w, { loadingStatus: h.document.createElement('div'), reportActivityFocus() {}, reportActivityTitles() {}, refreshSidebar() {}, renderDefaultStatus() {} });
  loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] });
  const oldLoad = h.w.loadProjects();
  await h.w.applyProjectDeletion({ ok: true, state: 'committed', invalidation: { sessionIds: ['own'], restoreTargets: [{ ...own, alias }] } });
  assert.deepEqual(destroyed, ['own']); assert.equal(h.w.openSessions.has('other'), true);
  assert.deepEqual(Array.from(h.w.pendingRestoreEntries(), row => row.item.sessionId), ['other', 'other', 'other']);
  assert.equal(h.w.pendingSessions.has('own'), false);
  assert.notEqual(h.w.filePanelState.get('own').currentTab.returnList, oldTouched, 'late Touched replies must target a detached list');
  assert.equal(memories, 1, 'Agent Files must refresh after ACK');
  assert.equal(h.w.isDeletedProjectRestoreTarget({ ...own, sessionId: 'unrelated' }), false);
  assert.equal(h.w.isDeletedProjectRestoreTarget({ ...own, projectPath: '/another/project' }), false);
  assert.equal(h.w.isDeletedProjectRestoreTarget({ ...own, projectPath: own.projectPath.toUpperCase() }), alias === null, 'path case follows the deletion host, not the hostless saved item');
  assert.equal(h.w.isDeletedProjectRestoreTarget({ ...own, projectPath: own.projectPath + '/child/..' }), true);
  oldReply({ defaultProjects: [h.p], allProjects: [{ ...h.p, remoteAlias: alias }] });
  await oldLoad;
  assert.equal(h.w.isDeletedProjectRestoreTarget(own), true, 'a load started before the deletion ACK must retain restore tombstones');
  await h.w.persistWorkingSet();
  assert.equal(h.calls.writes.at(-1)[1].openWorkingSet.some(item => item.sessionId === 'own'), false, 'hostless restore entries must not be persisted after remote deletion');
  h.w.cachedAllProjects = [];
  h.w.api.getProjects = async () => ({ defaultProjects: [h.p], allProjects: [{ ...h.p, remoteAlias: alias }] });
  await h.w.loadProjects();
  assert.equal(h.w.isDeletedProjectRestoreTarget(own), false, 'a reappeared project must release its restore tombstones');
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
  h.w.setProjectDeletionWritesBlocked(h.p, true);
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

test('a late preview cannot clear global NOT_READY; the next open can retry recovery', async t => {
  const h = setup(t);
  const preview = h.w.api.previewProjectDelete;
  let finishPreview;
  h.w.api.previewProjectDelete = async request => {
    const reply = await preview(request);
    if (h.calls.preview.length === 2) await new Promise(resolve => { finishPreview = resolve; });
    return reply;
  };
  const pending = h.start(); await flush();
  h.w.api.projectDeleteState = async () => ({ ok: false, code: 'NOT_READY' });
  await h.w.reconcileProjectDeletions({ operations: [{ operationId: 'other-op', host: null, projectPath: '/other' }] });
  finishPreview(); await flush();
  assert.equal(h.confirm().disabled, true, 'a stale successful preview must not clear recovery unavailability');
  assert.match(h.document.querySelector('.choice-dialog').textContent, new RegExp(unavailable));
  h.cancel(); await pending;
  assert.equal(h.calls.execute.length, 0);
  const retry = h.start(); await flush();
  assert.equal(h.confirm().disabled, false, 'a fresh open probes recovery again');
  h.cancel(); await retry;
});
