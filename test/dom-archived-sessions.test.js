'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'expected asynchronous UI state');
}

function setup(t, count = 2) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const w = h.window, calls = [];
  const sessions = Array.from({ length: count }, (_, i) => ({ sessionId: `s${i}`, name: `Session ${i}`, archived: 1,
    modified: '2026-11-19T12:00:00Z', messageCount: 4, fileSize: 2048, folder: '-repo', projectPath: '/repo' }));
  const projects = [{ projectPath: '/repo', folder: '-repo', sessions: [...sessions,
    { sessionId: 'live', archived: 0 }, { sessionId: 'child', archived: 1, parentSessionId: 's0' }] },
  { projectPath: '/repo', folder: 'vps::-repo', remoteAlias: 'vps', sessions: [
    { sessionId: 'remote', aiTitle: 'a "b" & <i', archived: 1, remoteAlias: 'vps', bgJobId: 'job' }] }];
  const settings = { hiddenProjects: ['/hidden'], hiddenProjectKinds: { '/hidden': 'archive', '/deleted': 'delete' } };
  w.cachedAllProjects = projects;
  w.api.getSetting = async key => key === 'global' ? settings : {};
  w.api.archiveSession = async (id, value) => { calls.push(['session', id, value]); return { ok: true }; };
  w.api.unarchiveProject = async entry => { calls.push(['project', entry, 0]); settings.hiddenProjects = []; return { ok: true }; };
  w.api.archiveProjectSettings = async () => { calls.push(['project', '/hidden', 1]); settings.hiddenProjects = ['/hidden']; return { ok: true }; };
  w.showJsonlViewer = session => calls.push(['transcript', session]);
  const container = h.document.createElement('div'); h.document.body.append(container);
  const filename = path.join(__dirname, '../public/archived-manager.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  const manager = w.renderArchivedProjects(container, { entries: settings.hiddenProjects, kinds: settings.hiddenProjectKinds,
    projects, hosts: [{ alias: 'vps', label: 'Server' }] });
  const q = selector => container.querySelector(selector);
  const rows = () => [...container.querySelectorAll('.archived-session-row')];
  return { ...h, w, calls, sessions, projects, settings, container, manager, q, rows };
}

test('archived sessions are top-level only, grouped by host-qualified project with metadata and safe names', t => {
  const h = setup(t);
  assert.equal(h.rows().length, 3, 'three top-level archived sessions');
  assert.deepEqual([...h.container.querySelectorAll('.archived-session-group .archived-group-toggle')].map(el => el.textContent.trim()), ['▾ repo (2)', '▾ Server · repo (1)']);
  assert.match(h.rows()[0].textContent, /Session 0.*4 msgs.*2 KB/s);
  assert.ok(h.rows()[0].querySelector('time[datetime]'));
  const remote = h.rows()[2];
  assert.equal(remote.querySelector('.archived-name strong').textContent, 'a "b" & <i');
  assert.equal(remote.querySelector('input').getAttribute('aria-label'), 'Select a "b" & <i');
  assert.equal(remote.querySelector('summary').getAttribute('aria-label'), 'More actions for a "b" & <i');
  assert.equal(remote.dataset.entry, 'session:remote');
  assert.equal(remote.querySelector('input').dataset.entry, 'session:remote');
  assert.match(h.container.textContent, /Sessions of archived projects appear after Unarchive/);
});

test('session groups show twelve rows then Show N more; select all includes collapsed rows', t => {
  const h = setup(t, 14);
  assert.equal(h.rows().length, 13, 'twelve local rows and one remote row initially');
  assert.equal(h.q('.archived-more').textContent, 'Show 2 more');
  h.q('.archived-session-group .archived-select-all').click();
  assert.equal(h.q('.archived-bulk').textContent, 'Unarchive selected (14)');
  h.q('.archived-more').click();
  assert.equal(h.rows().length, 15);
  assert.equal(h.rows().filter(row => row.querySelector('input').checked).length, 14);
});

test('Transcript receives the session; Unarchive persists then removes the row and Undo rearchives it', async t => {
  const h = setup(t);
  assert.ok(h.q('.archived-transcript'), 'session Transcript action exists');
  h.q('.archived-transcript').click();
  assert.equal(h.calls[0][1], h.sessions[0]);
  h.rows()[0].querySelector('.archived-unarchive').click();
  await waitFor(() => h.document.querySelector('.app-notice-action'));
  assert.deepEqual(h.calls[1], ['session', 's0', 0]);
  assert.equal(h.rows().length, 2);
  assert.match(h.document.querySelector('.app-notice').textContent, /Session.*restored/);
  h.document.querySelector('.app-notice-action').click();
  await waitFor(() => h.rows().length === 3);
  assert.deepEqual(h.calls[2], ['session', 's0', 1]);
});

test('mixed bulk restores projects before sessions and has one combined Undo', async t => {
  const h = setup(t);
  assert.equal(h.rows().length, 3, 'sessions available to bulk selection');
  h.rows()[0].querySelector('input').click(); h.rows()[1].querySelector('input').click();
  h.q('.archived-row:not(.archived-session-row) input').click();
  assert.equal(h.q('.archived-bulk').textContent, 'Unarchive selected (3)');
  h.q('.archived-bulk').click();
  await waitFor(() => h.document.querySelector('.app-notice-action'));
  assert.deepEqual(h.calls, [['project', '/hidden', 0], ['session', 's0', 0], ['session', 's1', 0]]);
  assert.equal(h.document.querySelectorAll('.app-notice').length, 1);
  assert.match(h.document.querySelector('.app-notice').textContent, /1 project.*2 sessions.*restored/s);
  h.document.querySelector('.app-notice-action').click();
  await waitFor(() => h.rows().length === 3);
  assert.deepEqual(h.calls.slice(3), [['project', '/hidden', 1], ['session', 's0', 1], ['session', 's1', 1]]);
});

test('session restore refusal keeps row, selection and focus, with an actionable error', async t => {
  const h = setup(t);
  assert.equal(h.rows().length, 3, 'session rows available for refusal');
  h.w.api.archiveSession = async () => ({ ok: false, error: 'Host refused' });
  h.rows()[0].querySelector('input').click();
  const button = h.rows()[0].querySelector('.archived-unarchive'); button.focus(); button.click();
  await waitFor(() => h.document.querySelector('.choice-dialog'));
  assert.match(h.document.querySelector('.choice-dialog').textContent, /Could not unarchive.*Session 0.*Host refused/s);
  h.document.querySelector('.choice-dialog-confirm').click();
  await waitFor(() => h.document.activeElement === button);
  assert.equal(h.rows().length, 3);
  assert.equal(h.q('.archived-bulk').textContent, 'Unarchive selected (1)');
});

test('accepted project reload refreshes the mounted manager without losing its filter or checked set', async t => {
  const h = setup(t), filter = h.q('.archived-filter');
  filter.value = 'hidden'; filter.dispatchEvent(new h.w.Event('input'));
  h.q('.archived-select').click();
  h.w.loadingStatus = h.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus']) h.w[name] = () => {};
  h.w.pollActiveSessions = async () => {};
  h.settings.hiddenProjects.push('/hidden-new');
  const next = structuredClone(h.projects); next[0].sessions.push({ sessionId: 'new', name: 'hidden session', archived: 1 });
  h.w.api.getProjects = async () => ({ defaultProjects: [], allProjects: next });
  h.w.api.getActiveTerminals = async () => [];
  const fns = loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] });
  await fns.loadProjects();
  await waitFor(() => h.container.textContent.includes('hidden-new'));
  assert.equal(filter.value, 'hidden');
  assert.equal(h.q('[data-entry="/hidden"] input').checked, true);
  assert.equal(h.rows().length, 1);
  h.rows()[0].querySelector('input').click();
  await fns.loadProjects();
  assert.equal(h.q('.archived-bulk').textContent, 'Unarchive selected (2)');
});

test('archive filter footer counts top-level sessions and non-deleted project entries, then opens Archived', t => {
  const h = setup(t), opened = [];
  h.w.openSettingsViewer = (...args) => opened.push(args);
  h.w.renderProjects.hiddenSettings = [['/hidden', '/deleted'], { '/deleted': 'delete' }];
  h.w.showArchived = false; h.w.renderProjects([]);
  assert.equal(h.document.querySelector('.sidebar-archived-footer'), null);
  h.w.showArchived = true; h.w.renderProjects([]);
  const footer = h.document.querySelector('.sidebar-archived-footer');
  assert.ok(footer, 'archive filter exposes a management footer even with no visible project');
  assert.equal(footer.textContent, '3 archived sessions · 1 archived project or folder — Manage');
  footer.querySelector('button').click();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['global', null, null, { section: 'archived' }]]);
  assert.equal(typeof h.w.archivedCounts, 'function', 'counts helper exported to renderer tests');
});

test('session filter supports title and host, empty and no-match states, Escape and keyboard folding', t => {
  const h = setup(t), filter = h.q('.archived-filter');
  filter.value = 'Server'; filter.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.rows().length, 1, 'host label filters sessions too');
  filter.value = 'absent'; filter.dispatchEvent(new h.w.Event('input'));
  assert.match(h.q('.archived-empty').textContent, /No archived item matches "absent"/);
  filter.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const toggle = h.q('.archived-session-group .archived-group-toggle');
  toggle.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.q('.archived-session-group .archived-group-rows').hidden, true);
});

test('Show in sidebar reveals an old archived row through conflicting filters without opening it', async t => {
  const h = setup(t);
  assert.ok(h.q('.archived-show-sidebar'), 'session overflow offers Show in sidebar');
  h.w.showArchived = false; h.w.showStarredOnly = h.w.showRunningOnly = h.w.showTodayOnly = true;
  h.w.searchMatchIds = new Set(['other']);
  h.w.searchInput = h.document.createElement('input'); h.w.searchBar = h.document.createElement('div');
  h.w.activeTab = 'sessions';
  loadAppFunctions(h.context, { functions: ['clearSearch', 'endSessionSearch', 'paintSearchStatus', 'dropSearchReveal', 'showArchivedSessionInSidebar'], declarations: ['searchGeneration', 'searchDebounceTimer', 'clearRenderRaf', 'searchReveal', 'searchSnippets'] });
  h.w.closeSettingsViewer = () => h.container.remove();
  let renders = 0;
  h.w.refreshSidebar = () => { renders++; h.w.renderProjects(h.w.cachedAllProjects); };
  h.w.sessionMaxAgeDays = 0;
  h.q('.archived-show-sidebar').click();
  assert.equal(h.w.showArchived, true);
  assert.equal(h.w.showStarredOnly || h.w.showRunningOnly || h.w.showTodayOnly, false);
  const row = h.document.getElementById('si-s0');
  assert.ok(row, 'target row rendered');
  assert.equal(h.document.activeElement, row);
  assert.deepEqual(h.calls, [], 'no resume or transcript is requested');
  await new Promise(resolve => h.w.requestAnimationFrame(resolve));
  assert.equal(renders, 1, 'no deferred clear-search rebuild may steal the revealed row focus');
});

test('entirely empty archives show only the shared explanation', async t => {
  const h = setup(t);
  h.w.cachedAllProjects = []; h.settings.hiddenProjects = [];
  await h.manager.refresh();
  assert.equal(h.q('.archived-list').textContent, 'Nothing is archived. Archive hides a session, a folder or a project from the sidebar and keeps everything on disk; it is listed here.');
  assert.equal(h.container.querySelectorAll('.archived-empty').length, 1);
});

test('mixed partial failures keep failed rows and Undo restores successful sessions only', async t => {
  const h = setup(t);
  h.w.api.archiveSession = async (id, value) => {
    h.calls.push(['session', id, value]); return id === 's0' ? { ok: false, error: 'Refused zero' } : { ok: true };
  };
  h.rows()[0].querySelector('input').click(); h.rows()[1].querySelector('input').click();
  h.q('.archived-bulk').click();
  await waitFor(() => h.document.querySelector('.choice-dialog'));
  assert.match(h.document.querySelector('.choice-dialog').textContent, /Session 0.*Refused zero/s);
  assert.equal(h.document.querySelectorAll('.app-notice').length, 1);
  assert.equal(h.rows().length, 2);
  h.document.querySelector('.choice-dialog-confirm').click();
  h.document.querySelector('.app-notice-action').click();
  await waitFor(() => h.rows().length === 3);
  assert.deepEqual(h.calls, [['session', 's0', 0], ['session', 's1', 0], ['session', 's1', 1]]);
});

test('a snapshot received during a refused restore is applied after the alert closes', async t => {
  const h = setup(t);
  let release;
  h.w.api.archiveSession = () => new Promise(resolve => { release = resolve; });
  h.rows()[0].querySelector('.archived-unarchive').click();
  const next = structuredClone(h.projects);
  next[0].sessions.push({ sessionId: 'later', archived: 1, name: 'Later' });
  h.w.cachedAllProjects = next;
  await h.manager.refresh(next, h.settings);
  assert.equal(h.rows().length, 3, 'active action retains its row');
  release({ ok: false, error: 'refused' });
  await waitFor(() => h.document.querySelector('.choice-dialog'));
  h.document.querySelector('.choice-dialog-confirm').click();
  await waitFor(() => h.rows().length === 4);
});

test('projects-changed refreshes an open Archived page even when the sidebar tab is Memory', async t => {
  const h = setup(t);
  const viewer = h.document.createElement('div'); viewer.id = 'settings-viewer'; viewer.style.display = 'flex';
  const page = h.document.createElement('section'); page.id = 'settings-page-archived';
  h.document.body.append(viewer); viewer.append(page); page.append(h.container);
  h.w.activeTab = 'memory'; h.w.projectsChangedTimer = null; h.w.projectsChangedWhileAway = false;
  h.w.reloadProjects = async () => { h.calls.push(['reload']); await h.manager.refresh(); };
  let changed;
  h.w.api.onProjectsChanged = cb => { changed = cb; };
  const filename = path.join(__dirname, '../public/app.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('window.api.onProjectsChanged(payload => {');
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), h.context, { filename });
  h.w.cachedAllProjects = [...h.projects, { projectPath: '/new', sessions: [{ sessionId: 'new', archived: 1 }] }];
  changed({ cause: ['archive'] });
  await waitFor(() => h.rows().length === 4);
  assert.deepEqual(h.calls, [['reload']]);
  viewer.style.display = 'none';
  changed({ cause: ['archive'] });
  assert.equal(h.w.projectsChangedWhileAway, true, 'a closed viewer keeps the existing deferred reload');
});

test('accepted snapshots do not read archive settings for a closed viewer', async t => {
  const h = setup(t);
  const viewer = h.document.createElement('div'); viewer.id = 'settings-viewer'; viewer.style.display = 'none';
  h.document.body.append(viewer); viewer.append(h.container);
  let reads = 0;
  h.w.api.getSetting = async () => { reads++; return {}; };
  await h.w.refreshArchivedManager(h.projects, h.settings);
  assert.equal(reads, 0, 'closed Settings must not add archive reads to every sidebar refresh');
});

test('accepted snapshots leave a hidden Archived page untouched while Settings is open elsewhere', async t => {
  const h = setup(t);
  const viewer = h.document.createElement('div'); viewer.id = 'settings-viewer'; viewer.style.display = 'flex';
  const page = h.document.createElement('section'); page.id = 'settings-page-archived'; page.hidden = true;
  h.document.body.append(viewer); viewer.append(page); page.append(h.container);
  const row = h.rows()[0];
  let reads = 0;
  h.w.api.getSetting = async () => { reads++; return {}; };
  await h.w.refreshArchivedManager(h.projects, h.settings);
  assert.equal(reads, 0, 'hidden Archived page must not read archive settings');
  assert.equal(h.rows()[0], row, 'hidden Archived page retains its DOM');
  page.hidden = false;
  await h.w.refreshArchivedManager(h.projects, h.settings);
  assert.equal(reads, 1, 'visible Archived page still refreshes');
  assert.notEqual(h.rows()[0], row);
});

test('loadProjects footer counts folder-only and combined archives exactly like the page', async t => {
  const h = setup(t, 0);
  const folders = { '/folder': {}, '/hidden': {}, '/deleted': {} };
  h.settings.hiddenProjects.push('/deleted');
  h.w.api.getSetting = async key => key === 'global' ? h.settings : folders;
  h.w.api.getProjects = async () => ({ defaultProjects: [], allProjects: h.projects });
  h.w.api.getActiveTerminals = async () => [];
  h.w.loadingStatus = h.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus']) h.w[name] = () => {};
  h.w.pollActiveSessions = async () => {};
  h.w.refreshSidebar = ({ hiddenSettings }) => {
    h.w.renderProjects.hiddenSettings = hiddenSettings;
    h.w.renderProjects([]);
  };
  h.w.showArchived = true;
  await loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] }).loadProjects();
  await h.manager.refresh(h.projects, h.settings);
  assert.equal(h.q('.settings-section-title').textContent, 'Projects and folders (2)');
  assert.equal(h.document.querySelector('.sidebar-archived-footer').textContent,
    '1 archived session · 2 archived projects and folders — Manage');
  assert.equal(h.w.renderProjects.unchanged([]), true);
  delete folders['/folder'];
  assert.equal(h.w.renderProjects.unchanged([]), false, 'folder archives participate in the sidebar render key');
});
