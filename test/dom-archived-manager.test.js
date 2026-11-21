'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectDeleteInventory } = require('../src/main/projects/project-delete-inventory');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { createProjectDeleteService } = require('../src/main/projects/project-delete');
const { identity } = require('../src/main/projects/project-delete-identity');

function plannerFor(h, sharedSettings = false) {
  const folder = p => h.w.encodeProjectPath(p);
  return createProjectDeletePlanner({
    waitForIndex: async () => {},
    readSnapshot: async () => ({ complete: true, initialScanComplete: true, revision: '1', declaredHosts: ['vps'],
      projects: [
        { alias: null, projectPath: entries[0], folderKeys: [folder(entries[0]), folder(entries[1])] },
        { alias: null, projectPath: entries[1], folderKeys: [] },
        { alias: 'vps', projectPath: '/srv/beta', folderKeys: ['vps::' + folder('/srv/beta')] },
        { alias: 'vps', projectPath: '/', folderKeys: ['vps::' + folder('/')] },
        ...(sharedSettings ? [{ alias: 'vps', projectPath: entries[0], folderKeys: ['vps::' + folder(entries[0])] }] : []),
      ] }),
    discoverOwnership: async () => ({ complete: true, groups: [], members: [], candidates: [] }),
    discoverSchedules: async () => ({ complete: true, schedules: [], candidates: [] }),
    readRuntimeState: async () => ({ complete: true, tabs: [], jobs: [], candidates: [] }),
    readRevision: async () => '1',
  });
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'expected asynchronous UI state');
}
async function openDelete(row) {
  row.querySelector('details').open = true;
  await new Promise(resolve => row.querySelector('details').addEventListener('toggle', resolve, { once: true }));
  await settle();
}
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
  const folders = {};
  const calls = { restore: [], folderRestore: [], archive: [], preview: [], execute: [], reload: 0 };
  w.cachedAllProjects = [{ projectPath: entries[0], sessions: [{ sessionId: 'one' }] }];
  w.api.getSetting = async key => key === 'archivedProjects' ? folders : settings;
  w.api.unarchiveFolder = async entry => { calls.folderRestore.push(entry); delete folders[entry]; return { ok: true }; };
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
  return { ...h, w, settings, folders, calls, q, rows, observers };
}

for (const count of [0, 1]) test(`folder disabled schedule count is accurate for ${count}`, async t => {
  const h = await setup(t, true);
  h.folders['vps::/srv/folder'] = { disabledSchedules: Array.from({ length: count }, (_, i) => `schedule-${i}.md`) };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 1);
  const meta = h.rows()[0].querySelector('.archived-meta');
  assert.equal(meta.textContent.trim(), count === 1 ? '1 schedule off' : '');
});

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

test('settings lists projects and sessions as sibling groups with one heading each and a combined nav count', async t => {
  const h = await setup(t);
  h.w.cachedAllProjects = [{ projectPath: '/visible', sessions: [{ sessionId: 'archived', archived: 1, name: 'Archived session' }] }];
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  const headings = [...h.q('#settings-page-archived').querySelectorAll('h3')].map(el => el.textContent);
  assert.deepEqual(headings, ['Projects and folders (4)', 'Sessions (1)']);
  assert.equal(h.q('[data-section="archived"]').textContent, 'Archived (4 · 1)');
});

test('empty projects state explains both project and folder archives', async t => {
  const h = await setup(t, true);
  assert.match(h.q('#sv-archived-projects').textContent, /No archived project\./);
  assert.match(h.q('#sv-archived-projects').textContent, /Archive Project/);
  assert.match(h.q('#sv-archived-projects').textContent, /Archive folder/);
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
  await openDelete(row);
  row.querySelector('.archived-delete').click(); await waitFor(() => h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled);
  const remote = entry.includes('::'), projectPath = remote ? '/srv/beta' : entry;
  assert.equal(h.calls.preview[0].projectPath, projectPath);
  const planned = await planner.preview(JSON.parse(JSON.stringify(h.calls.preview[0])));
  assert.equal(planned.ok, true, 'the renderer folderKey must resolve in the real planner');
  assert.equal(planned.plan.project.key, identity({ alias: remote ? 'vps' : null, projectPath }).key);
  assert.equal(h.document.activeElement, h.q('.choice-dialog-cancel'));
  h.q('.choice-dialog-cancel').click(); await settle();
  assert.equal(h.calls.execute.length, 0); assert.equal(h.rows().length, 4);
  assert.equal(h.document.activeElement, row.querySelector('.archived-delete'), 'Cancel returns focus to the enabled Delete button');
  h.rows().find(r => r.dataset.entry === entry).querySelector('.archived-delete').click(); await waitFor(() => h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled);
  assert.ok(h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled, 'real planner preview must finish before confirming');
  h.q('.choice-dialog-confirm').click(); await waitFor(() => !h.rows().some(r => r.dataset.entry === entry));
  const accepted = await planner.preview(JSON.parse(JSON.stringify(h.calls.preview.at(-1))));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.execute)), [{ token: 'token', fingerprint: accepted.plan.fingerprint }]);
  assert.equal(h.calls.restore.length, 0); assert.equal(h.rows().some(r => r.dataset.entry === entry), false);
});


for (const layout of ['.claude/worktrees', '.worktrees', '.claude-worktrees', '.work-files/worktrees']) {
  for (const exists of [false, true]) test(`real inventory: Archived ${layout}, repository exists=${exists}`, {
    skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI',
  }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-inventory-'));
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = root;
    const db = openStore();
    t.after(() => {
      db.closeDb();
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const h = await setup(t, true), repository = path.join(root, 'repo');
    if (exists) fs.mkdirSync(repository);
    const entry = path.join(repository, layout, 'topic');
    const folder = h.w.encodeProjectPath(entry), projectsDir = path.join(root, 'projects');
    fs.mkdirSync(projectsDir);
    db.setFolderMeta(folder, entry, 1);
    db.setInitialScanComplete();
    h.settings.hiddenProjects = [entry];
    db.setSetting('global', h.settings);
    const worker = require('./fixtures/project-deletion-worker.cjs')(db);
    const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db }, {});
    await writer.ready;
    const inventory = createProjectDeleteInventory({ writer, projectsDir, dataDir: root, activeSessions: new Map(),
      getScheduleRunSnapshot: () => [], readJobs: async () => ({ complete: true, jobs: [] }) });
    const planner = createProjectDeletePlanner(inventory);
    const request = { projectPath: entry, folderKey: folder,
      options: { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false } };
    const planned = await planner.preview(request);
    assert.equal(planned.ok, !exists, JSON.stringify(planned));
    if (exists) assert.equal(planned.code, 'IDENTITY_UNAVAILABLE');
    h.w.api.previewProjectDelete = async input => {
      h.calls.preview.push(input);
      return { ...await planner.preview(JSON.parse(JSON.stringify(input))), token: 'inventory-token' };
    };
    h.w.api.deleteProject = async input => {
      h.calls.execute.push(input);
      return { ok: true, state: 'committed', operationId: 'inventory-op', invalidation: { sessionIds: [], restoreTargets: [] } };
    };
    h.w.applyProjectDeletion = async () => {};
    await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
    const row = h.rows()[0];
    await openDelete(row);
    const button = row.querySelector('.archived-delete');
    if (exists) {
      button.click();
      await waitFor(() => row.querySelector('.archived-delete-reason').textContent.includes('repository'));
      assert.equal(button.disabled, true, 'grouped worktree is refused');
      assert.match(row.querySelector('.archived-delete-reason')?.textContent || '', /This worktree is grouped under its repository.*delete its repository/i);
      const reason = h.document.getElementById(button.getAttribute('aria-describedby'));
      assert.ok(reason, 'disabled Delete must be linked to its reason');
      assert.doesNotMatch(reason.textContent, /Folder and path hints conflict|retry/i);
      assert.match(reason.textContent, /delete its repository/i);
      assert.doesNotMatch(reason.textContent, /from the sidebar/i);
      assert.equal(h.calls.execute.length, 0);
    } else {
      assert.equal(button.disabled, false, 'orphan worktree accepted by real inventory must be deletable');
      button.click();
      await waitFor(() => h.q('.choice-dialog-confirm'));
      await waitFor(() => !h.q('.choice-dialog-confirm').disabled);
      h.q('.choice-dialog-confirm').click();
      await waitFor(() => h.rows().length === 0);
      assert.equal(h.calls.execute[0].token, 'inventory-token');
      assert.equal(h.calls.restore.length, 0);
    }
  });
}

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
  await openDelete(h.rows()[0]);
  h.q('.archived-delete').click(); await waitFor(() => h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled);
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

test('opening 40 overflow menus and copying paths spends no deletion previews', async t => {
  const h = await setup(t, true);
  h.settings.hiddenProjects = Array.from({ length: 40 }, (_, i) => '/repo/project-' + i);
  h.w.api.previewProjectDelete = async input => { h.calls.preview.push(input); return { ok: false, error: 'Unavailable' }; };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  for (const row of h.rows()) {
    await openDelete(row);
    row.querySelector('.archived-copy').click(); await settle();
  }
  assert.equal(h.calls.preview.length, 0, 'opening menus must not spend preview tokens or run discovery');
});

for (const remembered of [false, true]) test(`one Delete click uses one preview with remembered choices=${remembered}`, async t => {
  const h = await setup(t), planner = plannerFor(h);
  if (remembered) {
    h.w.localStorage.setItem('deleteProject.sessions', '1');
    h.w.localStorage.setItem('deleteProject.settings', '0');
  }
  h.w.api.previewProjectDelete = async input => {
    h.calls.preview.push(input);
    return { ...await planner.preview(JSON.parse(JSON.stringify(input))), token: 'one-token' };
  };
  h.w.api.deleteProject = async input => {
    h.calls.execute.push(input);
    return { ok: true, state: 'committed', operationId: 'single', invalidation: { sessionIds: [], restoreTargets: [] } };
  };
  h.w.applyProjectDeletion = async () => {};
  await openDelete(h.rows()[0]);
  h.q('.archived-delete').click();
  await waitFor(() => h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled);
  assert.equal(h.q('.archived-delete-reason').textContent, '', 'opening the dialog clears the row checking message');
  assert.equal(h.calls.preview.length, 1, 'one Delete click must mint at most one preview token');
  assert.equal(h.calls.preview[0].options.sessions, remembered);
  assert.equal(h.calls.preview[0].options.settings, !remembered);
  h.q('.choice-dialog-confirm').click();
  await waitFor(() => h.rows().length === 3);
  assert.equal(h.calls.execute[0].token, 'one-token');
});

test('unavailable remembered settings can be kept without blocking Archived deletion', async t => {
  const h = await setup(t), planner = plannerFor(h, true);
  const service = createProjectDeleteService({
    writer: { listProjectDeletionOperations: async () => ({ revision: '1', rows: [], nextCursor: null }),
      readProjectDeletionScope: async () => ({ writerRevision: '1', projectEpoch: 1 }) },
    planner: { preview: input => planner.preview(input) }, inventory: {}, stop: {}, gate: {},
  });
  await service.initialize();
  t.after(() => service.dispose());
  const sender = { valid: () => true, wc: {} };
  let tokens = 0;
  h.w.api.previewProjectDelete = async input => {
    h.calls.preview.push(input);
    const reply = await service.preview(sender, JSON.parse(JSON.stringify(input)));
    if (reply.token) tokens++;
    return reply;
  };
  await openDelete(h.rows()[0]);
  h.q('.archived-delete').click();
  await waitFor(() => h.q('.choice-dialog-confirm') && !h.q('.choice-dialog-confirm').disabled);
  const settings = h.q('[data-choice-id="settings"]');
  assert.equal(settings.disabled, true);
  assert.equal(settings.checked, false);
  assert.equal(tokens, 1, 'only the accepted plan may mint a token');
  h.q('[data-choice-id="sessions"]').click();
  await waitFor(() => !h.q('.choice-dialog-confirm').disabled);
  assert.equal(tokens, 2, 'changed choices need a fresh matching token');
  assert.equal(h.calls.preview.at(-1).options.sessions, true);
  h.q('.choice-dialog-cancel').click(); await settle();
});

for (const refusal of [
  { code: 'IDENTITY_UNAVAILABLE', error: 'No unambiguous known project mapping; reload projects.', retry: true },
  { code: 'INVALID_REQUEST', error: 'Invalid project selection.', retry: true },
  { code: 'SNAPSHOT_STALE', error: 'Snapshot changed.', refresh: true, retry: true },
  { code: 'TOKEN_LIMIT', error: 'Too many previews.', retry: true },
  { code: 'UNAUTHORIZED', error: 'Sender unavailable.', retry: true },
  { error: 'IPC rejected', thrown: true, retry: true },
  { code: 'NOT_READY', error: 'Recovery pending', retry: true },
  { code: 'DISCOVERY_TIMEOUT', port: 'readJobs', retry: true },
  { code: 'DISCOVERY_UNAVAILABLE', error: 'Index unavailable', retry: true },
  { error: 'Index unavailable', retry: true },
]) test(`click-time refusal stays accessible with appropriate advice: ${refusal.code || refusal.error}`, async t => {
  const h = await setup(t), row = h.rows()[1], button = row.querySelector('.archived-delete');
  h.w.api.previewProjectDelete = async input => {
    h.calls.preview.push(input);
    if (refusal.thrown) throw new Error(refusal.error);
    return { ok: false, ...refusal };
  };
  await openDelete(row);
  button.click();
  await waitFor(() => button.disabled && row.querySelector('.archived-delete-reason').textContent !== 'Checking deletion availability…');
  const reason = h.document.getElementById(button.getAttribute('aria-describedby'));
  assert.ok(reason && reason.textContent, 'refused Delete keeps its accessible reason');
  assert.doesNotMatch(reason.textContent, /delete its repository|Folder and path hints conflict/i);
  assert.equal(/try again/i.test(reason.textContent), refusal.retry, 'every non-grouped refusal offers another Delete attempt');
  assert.doesNotMatch(reason.textContent, /Close and reopen this menu to retry|Retry preview, or cancel/i);
  assert.equal(h.calls.execute.length, 0);
  if (refusal.retry) {
    row.querySelector('details').open = false; await settle();
    await openDelete(row);
    assert.equal(button.disabled, false, 'reopening permits an explicit retry click');
    assert.equal(h.calls.preview.length, 1, 'reopening itself must not retry discovery');
  }
});

for (const grouped of [false, true]) test(`refused Archived Delete returns focus to its described summary, grouped=${grouped}`, async t => {
  const h = await setup(t), row = h.rows()[1], button = row.querySelector('.archived-delete');
  const focused = [];
  h.document.addEventListener('focusin', event => focused.push(event.target));
  h.w.api.previewProjectDelete = async () => ({ ok: false, code: 'IDENTITY_UNAVAILABLE',
    error: grouped ? 'Folder and path hints conflict.' : 'Project mapping unavailable.' });
  await openDelete(row);
  button.focus(); button.click();
  await waitFor(() => row.querySelector('.archived-delete-reason').textContent !== 'Checking deletion availability…');
  await settle();
  const summary = row.querySelector('summary');
  assert.equal(h.document.activeElement, summary, 'refusal returns focus to the Archived row summary');
  assert.equal(focused.includes(h.q('#sidebar-content')), false, 'refusal must never focus the sidebar');
  assert.equal(summary.getAttribute('aria-describedby'), button.getAttribute('aria-describedby'), 'summary exposes the refusal reason');
  row.querySelector('details').open = false; await settle();
  await openDelete(row);
  assert.equal(button.disabled, grouped, 'only the grouped worktree remains disabled after reopening');
});

test('reason IDs remain unique and stable when filtering changes row positions', async t => {
  const h = await setup(t);
  const ids = new Map(h.rows().map(row => [row.dataset.entry, row.querySelector('.archived-delete').getAttribute('aria-describedby')]));
  assert.equal(new Set(ids.values()).size, ids.size);
  const filter = h.q('.archived-filter');
  filter.value = 'beta'; filter.dispatchEvent(new h.w.Event('input'));
  const button = h.q('.archived-delete');
  assert.equal(button.getAttribute('aria-describedby'), ids.get(entries[2]), 'filtering must preserve the same entry description ID');
  assert.ok(h.document.getElementById(button.getAttribute('aria-describedby')));
});

test('older in-flight reload cannot invalidate a newer restore Undo', async t => {
  const h = await setup(t);
  const staleSettings = JSON.parse(JSON.stringify(h.settings));
  let release;
  h.w.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
  h.w.api.getSetting = async key => key === 'archivedProjects' ? h.folders : staleSettings;
  h.w.api.getActiveTerminals = () => new Promise(resolve => { release = resolve; });
  h.w.loadingStatus = h.document.createElement('div');
  h.w.reportActivityFocus = h.w.reportActivityTitles = h.w.refreshSidebar = h.w.renderDefaultStatus = () => {};
  const realLoad = loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] }).loadProjects;
  const pending = realLoad();
  await waitFor(() => release);
  h.w.loadProjects = Object.assign(async () => {}, { state: realLoad.state });
  h.w.api.getSetting = async key => key === 'archivedProjects' ? h.folders : h.settings;
  h.q('.archived-unarchive').click(); await settle();
  const undo = h.q('.app-notice-action');
  assert.ok(undo, 'restore creates Undo while older reload is pending');
  h.w.loadProjects = realLoad;
  release([]); await pending;
  assert.equal(undo.isConnected, true, 'older reload must preserve newer restore Undo');
});

test('folder-only archives show Folder, archive date and disabled schedule count', async t => {
  const h = await setup(t, true);
  h.folders['vps::/srv/folder'] = { archivedAt: '2026-11-19T10:00:00Z', disabledSchedules: ['one', 'two'] };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 1, 'folder archive must be listed');
  const row = h.rows()[0];
  assert.deepEqual([...row.querySelectorAll('.archived-badge')].map(n => n.textContent), ['Folder', 'vps']);
  assert.equal(row.querySelector('time').getAttribute('datetime'), '2026-11-19T10:00:00.000Z');
  assert.match(row.textContent, /2 schedules off/);
  assert.match(h.q('[data-section="archived"]').textContent, /1/);
  row.querySelector('.archived-unarchive').click();
  await waitFor(() => h.rows().length === 0);
  assert.deepEqual(h.calls.folderRestore, ['vps::/srv/folder']);
  assert.deepEqual(h.calls.restore, []);
  assert.equal(h.calls.reload, 1);
  assert.equal(h.q('.app-notice-action'), null, 'folder restore has no misleading Undo');
  assert.match(h.q('.app-notice').textContent, /Archive folder/);
});

test('combined archive is one row with two badges and restores project before folder', async t => {
  const h = await setup(t, true);
  const entry = 'vps::/srv/combined';
  h.settings.hiddenProjects = [entry];
  h.settings.hiddenProjectKinds[entry] = 'archive';
  h.folders[entry] = { archivedAt: '2026-11-19T10:00:00Z', disabledSchedules: ['one', 'two'] };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 1);
  assert.deepEqual([...h.rows()[0].querySelectorAll('.archived-badge')].map(n => n.textContent), ['Project', 'Folder', 'vps']);
  const order = [];
  const project = h.w.api.unarchiveProject, folder = h.w.api.unarchiveFolder;
  h.w.api.unarchiveProject = async e => { order.push('project:' + e); return project(e); };
  h.w.api.unarchiveFolder = async e => { order.push('folder:' + e); return folder(e); };
  h.q('.archived-unarchive').click();
  await waitFor(() => h.rows().length === 0);
  assert.deepEqual(order, ['project:' + entry, 'folder:' + entry]);
  assert.match(h.q('.app-notice').textContent, /Archive folder/);
  h.q('.app-notice-action').click();
  await waitFor(() => h.rows().length === 1);
  assert.deepEqual(h.calls.archive, [['/srv/combined', 'vps::-srv-combined']]);
  assert.doesNotMatch(h.rows()[0].querySelector('.archived-name').textContent, /Folder/);
});

test('combined restore accepts the folder already cleared by the real project writer', async t => {
  const h = await setup(t, true), entry = 'vps::/srv/combined';
  h.settings.hiddenProjects = [entry];
  h.settings.hiddenProjectKinds[entry] = 'archive';
  h.folders[entry] = { archivedAt: '2026-11-19T10:00:00Z', disabledSchedules: ['one'] };
  const state = { global: h.settings, archivedProjects: h.folders };
  const writer = require('./fixtures/writer-memory.cjs').memoryWriter({
    getSetting: key => state[key], setSetting: (key, value) => { state[key] = value; },
  }, {});
  h.w.api.unarchiveProject = async e => { await writer.unhideProject(e, 'vps', '/srv/combined'); return { ok: true }; };
  h.w.api.unarchiveFolder = async e => {
    h.calls.folderRestore.push(e);
    return await writer.clearArchivedEntry('vps', '/srv/combined') ? { ok: true } : { error: 'Folder is not archived', code: 'NOT_ARCHIVED' };
  };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.match(h.rows()[0].textContent, /Folder/);
  h.q('.archived-unarchive').click();
  await waitFor(() => h.rows().length === 0);
  assert.deepEqual(h.calls.folderRestore, [entry]);
  assert.equal(h.q('.choice-dialog'), null);
  assert.equal(state.archivedProjects[entry], undefined);
  assert.deepEqual(state.scheduleReenableOffers[entry].disabledSchedules, ['one']);
});

for (const failure of ['project', 'folder']) test(`combined ${failure} refusal leaves an accurate retryable row`, async t => {
  const h = await setup(t, true), entry = entries[0];
  h.settings.hiddenProjects = [entry];
  h.settings.hiddenProjectKinds[entry] = 'archive';
  h.folders[entry] = { disabledSchedules: [] };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.match(h.rows()[0].textContent, /Folder/);
  const original = failure === 'project' ? h.w.api.unarchiveProject : h.w.api.unarchiveFolder;
  h.w.api[failure === 'project' ? 'unarchiveProject' : 'unarchiveFolder'] = async () => ({ error: 'refused' });
  h.q('.archived-unarchive').click();
  await waitFor(() => h.q('.choice-dialog'));
  assert.equal(h.rows().length, 1);
  assert.equal(/Project/.test(h.rows()[0].querySelector('.archived-name').textContent), failure === 'project');
  assert.equal(h.calls.folderRestore.length, 0);
  h.q('.choice-dialog-confirm').click();
  await waitFor(() => !h.q('.choice-dialog'));
  assert.equal(h.q('.archived-unarchive').disabled, false);
  h.w.api[failure === 'project' ? 'unarchiveProject' : 'unarchiveFolder'] = original;
  h.q('.archived-unarchive').click();
  await waitFor(() => h.rows().length === 0);
  assert.equal(h.calls.restore.length, 1, 'retry must not repeat a successful project restore');
});

test('unknown standalone folder keeps its row and reports NOT_ARCHIVED', async t => {
  const h = await setup(t, true);
  h.folders['/folder'] = {};
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 1, 'folder archive must be listed');
  h.w.api.unarchiveFolder = async () => ({ error: 'Folder is not archived', code: 'NOT_ARCHIVED' });
  h.q('.archived-unarchive').click();
  await waitFor(() => h.q('.choice-dialog'));
  assert.match(h.q('.choice-dialog').textContent, /Folder is not archived/);
  assert.equal(h.rows().length, 1);
  assert.equal(h.q('.archived-unarchive').disabled, false);
});

test('mixed bulk restore stays sequential and Undo only rearchives project entries', async t => {
  const h = await setup(t, true);
  h.settings.hiddenProjects = [entries[0]];
  h.settings.hiddenProjectKinds[entries[0]] = 'archive';
  h.folders['/folder'] = { archivedAt: 'invalid', disabledSchedules: [] };
  h.folders['/gone'] = { disabledSchedules: [] };
  await h.w.openSettingsViewer('global', null, null, { section: 'archived' });
  assert.equal(h.rows().length, 2, 'deleted entries stay excluded from the merged list');
  assert.equal(h.rows()[1].querySelector('time'), null, 'invalid dates are omitted');
  const order = [];
  const project = h.w.api.unarchiveProject, folder = h.w.api.unarchiveFolder;
  h.w.api.unarchiveProject = async e => { order.push('project'); await settle(); return project(e); };
  h.w.api.unarchiveFolder = async e => { assert.deepEqual(order, ['project']); order.push('folder'); return folder(e); };
  h.q('.archived-select-all').click(); h.q('.archived-bulk').click();
  await waitFor(() => h.rows().length === 0);
  assert.deepEqual(order, ['project', 'folder']);
  assert.equal(h.document.querySelectorAll('.app-notice').length, 1);
  assert.match(h.q('.app-notice').textContent, /2.*restored.*Undo.*project.*Archive folder/s);
  h.q('.app-notice-action').click();
  await waitFor(() => h.rows().length === 1);
  assert.deepEqual(h.calls.archive, [[entries[0], h.w.encodeProjectPath(entries[0])]]);
});
