'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { identity } = require('../src/main/projects/project-delete-identity');

function plannerFor(h) {
  const folder = p => h.w.encodeProjectPath(p);
  return createProjectDeletePlanner({
    waitForIndex: async () => {},
    readSnapshot: async () => ({ complete: true, initialScanComplete: true, revision: '1', declaredHosts: ['vps'],
      projects: [
        { alias: null, projectPath: entries[0], folderKeys: [folder(entries[0]), folder(entries[1])] },
        { alias: null, projectPath: entries[1], folderKeys: [] },
        { alias: 'vps', projectPath: '/srv/beta', folderKeys: ['vps::' + folder('/srv/beta')] },
        { alias: 'vps', projectPath: '/', folderKeys: ['vps::' + folder('/')] },
      ] }),
    discoverOwnership: async () => ({ complete: true, groups: [], members: [], candidates: [] }),
    discoverSchedules: async () => ({ complete: true, schedules: [], candidates: [] }),
    readRuntimeState: async () => ({ complete: true, tabs: [], jobs: [], candidates: [] }),
    readRevision: async () => '1',
  });
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const entries = ['/repo/alpha', '/repo/alpha/.work-files/worktrees/topic', 'vps::/srv/beta', 'removed::/old/gamma', '/gone'];

async function setup(t, empty = false) {
  const h = setupSidebarDom();
  t.after(async () => { await settle(); h.destroy(); });
  const w = h.window;
  for (const id of ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body', 'terminal-area', 'terminal-header', 'stats-viewer', 'memory-viewer', 'jsonl-viewer']) {
    const el = h.document.createElement('div'); el.id = id; h.document.body.append(el);
  }
  const settings = { hiddenProjects: empty ? [] : [...entries], hiddenProjectKinds: { [entries[0]]: 'archive', '/gone': 'delete' },
    hiddenProjectArchivedAt: { [entries[0]]: 1795089600000 }, remoteHosts: [{ alias: 'vps', label: 'Planificator' }] };
  const calls = { restore: [], archive: [], preview: [], execute: [], reload: 0 };
  w.cachedAllProjects = [{ projectPath: entries[0], sessions: [{ sessionId: 'one' }] }];
  w.api.getSetting = async () => settings;
  w.api.getHarnesses = w.api.getShellProfiles = async () => [];
  w.api.getAppVersion = async () => 'test';
  w.api.unarchiveProject = async entry => { calls.restore.push(entry); settings.hiddenProjects = settings.hiddenProjects.filter(e => e !== entry); return { ok: true }; };
  w.api.archiveProjectSettings = async (projectPath, folder) => {
    calls.archive.push([projectPath, folder]);
    const alias = folder.includes('::') ? folder.split('::')[0] : null;
    const entry = alias ? alias + '::' + projectPath : projectPath;
    settings.hiddenProjects.push(entry); settings.hiddenProjectKinds[entry] = 'archive';
    settings.hiddenProjectArchivedAt[entry] = Date.now(); return { ok: true, entry };
  };
  w.loadProjects = async () => { calls.reload++; };
  const observers = [];
  w.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };
  loadAppFunctions(h.context, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  for (const file of ['setting-defaults.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'archived-manager.js', 'settings-panel.js']) {
    const filename = path.join(__dirname, '../public', file);
    if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  }
  await w.openSettingsViewer('global', null, null, { section: 'archived' });
  const q = selector => h.document.querySelector(selector);
  const rows = () => [...h.document.querySelectorAll('.archived-row')];
  return { ...h, w, settings, calls, q, rows, observers };
}

test('host groups preserve separate worktree entries, names, safe paths, badges, dates and counts', async t => {
  const h = await setup(t);
  assert.equal(h.rows().length, 4, 'four archived entries including the worktree must have their own rows');
  assert.deepEqual([...h.document.querySelectorAll('.archived-host-label')].map(n => n.textContent), ['Local (2)', 'Planificator (1)', 'removed (1)']);
  assert.equal(h.rows()[1].querySelector('.archived-path').title, entries[1]);
  assert.match(h.rows()[0].textContent, /alpha.*Project.*1 session/s);
  assert.ok(h.rows()[0].querySelector('time[datetime]'), 'new archives show a date');
  assert.equal(h.rows()[1].querySelector('time'), null, 'legacy archives have no invented date');
  assert.match(h.rows()[1].textContent, /legacy/);
  assert.match(h.q('[data-section="archived"]').textContent, /4/);
});

test('filter matches name, path, host label and alias, clears by Escape and exposes no-match action', async t => {
  const h = await setup(t), filter = h.q('.archived-filter');
  assert.ok(filter, 'Archived needs a labelled filter');
  for (const value of ['bet', 'Planificator', 'vps', '/srv']) {
    filter.value = value; filter.dispatchEvent(new h.w.Event('input'));
    assert.deepEqual(h.rows().map(r => r.dataset.entry), [entries[2]]);
  }
  filter.value = '<zzz>'; filter.dispatchEvent(new h.w.Event('input'));
  assert.match(h.q('.archived-empty').textContent, /No archived item matches.*<zzz>/);
  assert.equal(h.q('zzz'), null);
  h.q('.archived-clear').click(); assert.equal(filter.value, '');
  filter.value = 'beta'; filter.dispatchEvent(new h.w.Event('input'));
  filter.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(filter.value, ''); assert.equal(h.rows().length, 4);
});

test('empty projects state does not promise folder or session archives', async t => {
  const h = await setup(t, true);
  assert.match(h.q('#sv-archived-projects').textContent, /No archived project\./);
  assert.match(h.q('#sv-archived-projects').textContent, /Archive Project/);
});

test('Unarchive uses the exact entry, reloads and Undo restores its remote identity and date', async t => {
  const h = await setup(t);
  const row = h.rows().find(r => r.dataset.entry === entries[2]);
  assert.ok(row, 'remote archive row exists');
  row.querySelector('.archived-unarchive').click(); await settle();
  assert.deepEqual(h.calls.restore, [entries[2]]);
  assert.equal(h.calls.reload, 1);
  assert.equal(h.rows().some(r => r.dataset.entry === entries[2]), false);
  assert.equal(h.q('.choice-dialog'), null, 'reversible action has no confirmation');
  assert.match(h.q('.app-notice').textContent, /restored/);
  h.q('.app-notice-action').click(); await settle();
  assert.deepEqual(h.calls.archive, [['/srv/beta', 'vps::-srv-beta']]);
  assert.ok(h.rows().find(r => r.dataset.entry === entries[2]).querySelector('time'));
});

test('failed Unarchive keeps its row and uses the shared alert with focus returned', async t => {
  const h = await setup(t);
  h.w.api.unarchiveProject = async () => ({ error: 'Host refused' });
  const button = h.q('.archived-unarchive');
  assert.ok(button, 'row exposes an action button');
  button.focus(); button.click(); await settle();
  assert.ok(h.q('.choice-dialog'), 'failed Unarchive must display an alert');
  assert.match(h.q('.choice-dialog').textContent, /Could not unarchive project.*Host refused/s);
  assert.equal(h.rows().length, 4);
  h.q('.choice-dialog-confirm').click(); await settle();
  assert.equal(button.disabled, false); assert.equal(h.document.activeElement, button);
});

test('bulk restoration is sequential with one Undo for the successful entries', async t => {
  const h = await setup(t);
  assert.ok(h.q('.archived-select'), 'rows expose selection checkboxes');
  h.rows()[0].querySelector('.archived-select').click(); h.rows()[2].querySelector('.archived-select').click();
  assert.equal(h.q('.archived-bulk').textContent, 'Unarchive selected (2)');
  const original = h.w.api.unarchiveProject; let active = false;
  h.w.api.unarchiveProject = async entry => { assert.equal(active, false); active = true; await settle(); const result = await original(entry); active = false; return result; };
  h.q('.archived-bulk').click(); await settle(); await settle(); await settle();
  assert.deepEqual(h.calls.restore, [entries[0], entries[2]]);
  assert.equal(h.document.querySelectorAll('.app-notice').length, 1);
  h.q('.app-notice-action').click(); await settle(); await settle();
  assert.equal(h.calls.archive.length, 2); assert.equal(h.rows().length, 4);
});

test('Undo after reopening Settings refreshes the currently mounted archived list', async t => {
  const h = await setup(t);
  h.q('.archived-unarchive').click(); await settle();
  h.w.closeSettingsViewer();
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 3);
  h.q('.app-notice-action').click(); await settle();
  assert.equal(h.rows().length, 4, 'Undo must update the new mounted list, not the detached old list');
});

test('Undo remains available while another archive action is pending', async t => {
  const h = await setup(t);
  h.q('.archived-unarchive').click(); await settle();
  const undo = h.q('.app-notice-action');
  let release;
  h.w.api.unarchiveProject = () => new Promise(resolve => { release = resolve; });
  h.q('.archived-unarchive').click(); await settle();
  undo.click();
  assert.ok(undo.isConnected, 'a busy action must not consume Undo without archiving');
  release({ error: 'busy' }); await settle();
  h.q('.choice-dialog-confirm').click(); await settle();
  undo.click(); await settle();
  assert.equal(h.calls.archive.length, 1);
});

test('host labels update from unsaved working hosts; keyboard folding and observed compact layout', async t => {
  const h = await setup(t);
  const label = h.q('.rh-label'); label.value = 'New label'; label.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.ok(h.q('.archived-host-label'), 'host groups expose named headers');
  assert.match(h.q('#sv-archived-projects').textContent, /New label/);
  const group = h.q('.archived-group-toggle');
  assert.equal(group.getAttribute('aria-expanded'), 'true');
  group.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.equal(group.getAttribute('aria-expanded'), 'false');
  assert.equal(h.q('.archived-group-rows').hidden, true);
  h.observers[0]([{ target: h.q('#settings-viewer'), contentRect: { width: 460 } }]);
  assert.ok(h.q('#settings-viewer').classList.contains('settings-compact'));
  h.q('.archived-search-toggle').click(); assert.equal(h.document.activeElement, h.q('.archived-filter'));
});

test('removing or renaming a working host falls back to the archived alias immediately', async t => {
  const h = await setup(t);
  const alias = h.q('.rh-alias'); alias.value = 'other'; alias.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.match(h.q('#sv-archived-projects .archived-list').textContent, /vps \(1\)/, 'changed host alias removes the old display label');
  alias.value = 'vps'; alias.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('.rh-remove').click();
  assert.match(h.q('#sv-archived-projects .archived-list').textContent, /vps \(1\)/);
});

for (const entry of [entries[0], entries[2]]) test(`Delete from Archived previews exact identity, Cancel keeps it, Confirm uses accepted token: ${entry}`, async t => {
  const h = await setup(t);
  const planner = plannerFor(h);
  h.w.api.previewProjectDelete = async request => {
    h.calls.preview.push(request);
    const result = await planner.preview(JSON.parse(JSON.stringify(request)));
    assert.equal(result.ok, true, JSON.stringify(result));
    return { ...result, token: 'token' };
  };
  h.w.api.deleteProject = async request => { h.calls.execute.push(request); return { ok: true, state: 'committed', operationId: 'op', invalidation: { sessionIds: [], restoreTargets: [] } }; };
  h.w.applyProjectDeletion = async () => {};
  const row = h.rows().find(r => r.dataset.entry === entry);
  assert.ok(row?.querySelector('.archived-delete'), 'archived row offers Delete without Unarchive');
  row.querySelector('.archived-delete').click(); await settle();
  const remote = entry.includes('::'), projectPath = remote ? '/srv/beta' : entry;
  assert.equal(h.calls.preview[0].projectPath, projectPath);
  const planned = await planner.preview(JSON.parse(JSON.stringify(h.calls.preview[0])));
  assert.equal(planned.ok, true, 'the renderer folderKey must resolve in the real planner');
  assert.equal(planned.plan.project.key, identity({ alias: remote ? 'vps' : null, projectPath }).key);
  assert.equal(h.document.activeElement, h.q('.choice-dialog-cancel'));
  h.q('.choice-dialog-cancel').click(); await settle();
  assert.equal(h.calls.execute.length, 0); assert.equal(h.rows().length, 4);
  assert.equal(h.document.activeElement, row.querySelector('.archived-delete'), 'Cancel returns focus to the enabled Delete button');
  h.rows().find(r => r.dataset.entry === entry).querySelector('.archived-delete').click(); await settle();
  h.q('.choice-dialog-confirm').click(); await settle();
  const accepted = await planner.preview(JSON.parse(JSON.stringify(h.calls.preview.at(-1))));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.execute)), [{ token: 'token', fingerprint: accepted.plan.fingerprint }]);
  assert.equal(h.calls.restore.length, 0); assert.equal(h.rows().some(r => r.dataset.entry === entry), false);
});


test('local worktree Delete is disabled with a visible alternative and real planner refusal', async t => {
  const h = await setup(t), planner = plannerFor(h);
  const refused = await planner.preview({ projectPath: entries[1], folderKey: h.w.encodeProjectPath(entries[1]),
    options: { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'IDENTITY_UNAVAILABLE');
  const row = h.rows().find(r => r.dataset.entry === entries[1]);
  assert.equal(row.querySelector('.archived-delete').disabled, true, 'worktree cannot be deleted as a project');
  row.querySelector('details').open = true;
  assert.match(row.querySelector('.archived-delete-reason')?.textContent || '', /Delete the worktree.*repository/i);
  h.q('.archived-unarchive').click(); await settle();
  assert.equal(row.querySelector('.archived-delete').disabled, true, 'unlock must preserve the worktree refusal');
});

test('remote root has a visible path and Delete resolves through the real planner', async t => {
  const h = await setup(t, true);
  h.settings.hiddenProjects = ['vps::'];
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.q('.archived-path').textContent, '/', 'empty remote path represents the root');
  assert.equal(h.q('.archived-name strong').textContent, '/');
  const planner = plannerFor(h);
  h.w.api.previewProjectDelete = async request => {
    h.calls.preview.push(request);
    return { ...await planner.preview(JSON.parse(JSON.stringify(request))), token: 'root' };
  };
  h.q('.archived-delete').click(); await settle();
  assert.equal(h.calls.preview[0].projectPath, '/');
  assert.ok(h.q('.choice-dialog-cancel'), 'root preview reaches the shared confirmation');
  h.q('.choice-dialog-cancel').click(); await settle();
});

test('invalid host prefix stays a local path rather than creating a remote host', async t => {
  const h = await setup(t, true);
  h.settings.hiddenProjects = ['/repo/not an alias::part'];
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.q('.archived-host-label').textContent, 'Local (1)');
  assert.equal(h.q('.archived-path').textContent, '/repo/not an alias::part');
});

test('restored Undo is invalidated when a later reload reports a deletion', async t => {
  const h = await setup(t);
  h.q('.archived-unarchive').click(); await settle();
  const undo = h.q('.app-notice-action');
  assert.ok(undo);
  h.settings.hiddenProjects.push(entries[0]);
  h.settings.hiddenProjectKinds[entries[0]] = 'delete';
  h.w.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
  h.w.api.getActiveTerminals = async () => [];
  h.w.loadingStatus = h.document.createElement('div');
  h.w.reportActivityFocus = h.w.reportActivityTitles = h.w.refreshSidebar = h.w.renderDefaultStatus = () => {};
  await loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] }).loadProjects();
  assert.equal(undo.isConnected, false, 'deleted project must lose its restore Undo');
  assert.equal(h.settings.hiddenProjectKinds[entries[0]], 'delete');
});
