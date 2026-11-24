'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { encodeProjectPath } = require('../encode-project-path');
const { listMemories } = require('../file-lists');
const { createWriterCommands } = require('../session-index-commands');
const { migrateSchedulesTabDefault } = require('../src/main/schedules/schedules-tab-migration');

const root = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, settings = {}, beforeInit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-setting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const claudeDir = path.join(dir, 'claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const folder = path.join(projectsDir, encodeProjectPath(project));
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(folder, 'seed.jsonl'), JSON.stringify({ type: 'user', cwd: project }));
  fs.writeFileSync(path.join(commands, 'schedule-nightly.md'), 'nightly');
  fs.writeFileSync(path.join(commands, 'deploy.md'), 'deploy');
  fs.writeFileSync(path.join(project, '.claude', 'schedule-notes.md'), 'notes');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  require('./app-source').loadAppFunctions(ctx, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  w.cachedAllProjects = [];
  require('./app-source').loadAppFunctions(ctx, { sourcePath: path.join(root, 'public/sidebar.js'),
    functions: ['isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  const calls = [];
  let saved = settings;
  const db = { getSetting: () => saved, setSetting: (_key, value) => { saved = value; } };
  const writer = createWriterCommands(db);
  w.api = new Proxy({
    platform: 'win32',
    getSetting: async () => saved,
    setSetting: async (_key, value) => { saved = value; },
    mergeGlobalSettings: async (patch, remove) => { writer.mergeGlobal(patch, remove); },
    getMemories: async () => listMemories({ claudeDir, projectsDir, activeProjectPaths: [project] }, p => fs.readFileSync(p, 'utf8')).view,
    listSchedules: async () => { calls.push('list'); return { now: Date.now(), projects: [] }; },
    runScheduleNow: async file => { calls.push(file); return { ok: true }; },
    readMemory: async file => { calls.push('open:' + file); return 'nightly'; },
    getShellProfiles: async () => [],
    getAppVersion: async () => '0.0.0',
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  for (const [name, id] of Object.entries({ memoryContent: 'memory-content', memoryViewer: 'memory-viewer', placeholder: 'placeholder', terminalArea: 'terminal-area', statsViewer: 'stats-viewer', statsContent: 'stats-content', settingsViewer: 'settings-viewer', jsonlViewer: 'jsonl-viewer', sidebarContent: 'sidebar-content', sessionFilters: 'session-filters', searchBar: 'search-bar', searchInput: 'search-input' })) w[name] = w.document.getElementById(id);
  Object.assign(w, { activeTab: 'sessions', searchGeneration: 0, gridViewActive: false, activeSessionId: null, projectsChangedWhileAway: false, refreshSidebar() {}, memoryPanel: { open: (...args) => calls.push(args) }, setRemoteHostLabels() {}, CSS: { escape: value => value.replace(/\\/g, '\\\\') } });
  for (const file of ['setting-defaults.js', 'icons.js', 'utils.js', 'shortcuts.js', 'terminal-themes.js', 'app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js', 'archived-manager.js', 'settings-panel.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  const filename = path.join(root, 'public/app.js');
  const src = fs.readFileSync(filename, 'utf8');
  const evalSlice = (start, end) => vm.runInContext(src.slice(start, end), ctx, { filename, lineOffset: src.slice(0, start).split('\n').length - 1 });
  const tabs = src.indexOf("document.querySelectorAll('.sidebar-tab').forEach(tab => {");
  evalSlice(tabs, src.indexOf('\n});', tabs) + 4);
  beforeInit(w);
  const init = src.indexOf('(async () => {', src.indexOf('// --- Init: restore settings ---'));
  evalSlice(init, src.indexOf('})();', init) + 5);
  await settle();
  await w.loadMemories();
  return { w, calls, db, writer, get saved() { return saved; }, tab: w.document.querySelector('[data-tab="schedules"]') };
}

test('the shipped page starts with the Schedules tab hidden until settings are applied', () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'));
  const tab = dom.window.document.querySelector('[data-tab="schedules"]');
  assert.equal(tab.hidden, true, 'this fixture guards the first-apply path below');
  dom.window.close();
});

for (const [label, settings] of [['fresh profile', null], ['absent', {}], ['upgraded without the key', { sidebarWidth: 300, theme: 'dark' }], ['explicit off', { schedulesTab: false }], ['on', { schedulesTab: true }]]) {
  test(`${label}: tab and Agent Files follow the saved setting`, async t => {
    const h = await setup(t, settings);
    const enabled = settings?.schedulesTab !== false;
    assert.equal(h.tab.hidden, !enabled, 'Schedules tab visibility follows the setting');
    assert.equal(h.tab.disabled, !enabled, 'disabled tab has no keyboard route');
    assert.equal(h.tab.tabIndex, enabled ? 0 : -1);
    const rows = [...h.w.document.querySelectorAll('.memory-item')];
    const schedule = rows.find(row => row.textContent.includes('schedule-nightly.md'));
    assert.equal(!!schedule, !enabled, 'Agent Files lists schedules only when the tab is off');
    assert.ok(rows.some(row => row.textContent.includes('deploy.md')));
    if (!enabled) {
      const run = schedule.querySelector('[title="Run now"]');
      assert.ok(run, 'legacy Agent Files has Run now');
      run.click();
      await settle();
      assert.equal(h.calls.filter(call => typeof call === 'string' && call.endsWith('schedule-nightly.md')).length, 1);
      assert.equal(run.title, 'Launched!');
      assert.equal(h.calls.some(call => typeof call === 'string' && call.startsWith('open:')), false, 'Run now does not open the file');
      schedule.click();
      await settle();
      assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'schedule-nightly.md'), 'click opens the schedule editor');
      h.tab.click();
      h.w.showSchedules('/p');
      assert.equal(h.w.activeTab, 'sessions');
      assert.equal(h.calls.includes('list'), false, 'off has no programmatic route');
    } else {
      h.tab.click();
      assert.equal(h.w.activeTab, 'schedules');
      assert.ok(h.calls.includes('list'));
    }
  });
}

test('fresh profile: Schedules is on and keyboard reachable without a restart or a Save', async t => {
  const h = await setup(t, null);
  assert.equal(h.w.schedulesTabEnabled, true);
  assert.equal(h.tab.hidden, false);
  assert.equal(h.tab.disabled, false);
  assert.equal(h.tab.tabIndex, 0);
  assert.equal(h.saved, null, 'turning the default on writes nothing');
  h.w.showSchedules('/p');
  assert.equal(h.w.activeTab, 'schedules', 'programmatic project navigation works');
  assert.ok(h.calls.includes('list'));
  const rows = [...h.w.document.querySelectorAll('.memory-item')];
  assert.equal(rows.some(row => row.textContent.includes('schedule-nightly.md')), false, 'Agent Files hides runner schedules');
});

test('a migration that commits after the first render shows the tab without a restart (#1239)', async t => {
  let migrated;
  const h = await setup(t, { schedulesTab: false }, w => {
    w.api.onSchedulesTabMigrated = callback => { migrated = callback; };
  });
  assert.equal(h.tab.hidden, true, 'the first render read the stored value before the migration committed');
  assert.equal(typeof migrated, 'function', 'startup listens for a late migration');
  await h.w.api.setSetting('global', { schedulesTabDefaultMigrated: true });
  migrated();
  await settle();
  assert.equal(h.w.schedulesTabEnabled, true);
  assert.equal(h.tab.hidden, false);
  assert.equal(h.tab.disabled, false);
  assert.equal(h.tab.tabIndex, 0);
});

test('a second apply of the same value keeps the tab in step with the setting', async t => {
  const h = await setup(t, {});
  h.w._applySchedulesTab(true);
  assert.equal(h.tab.hidden, false);
  h.w._applySchedulesTab(false);
  h.w._applySchedulesTab(false);
  assert.equal(h.tab.hidden, true);
  assert.equal(h.tab.disabled, true);
});

test('explicit off: only runner schedules carry the schedule icon and Run now in Agent Files', async t => {
  const h = await setup(t, { schedulesTab: false });
  const rows = [...h.w.document.querySelectorAll('.memory-item')];
  const notes = rows.find(row => row.textContent.includes('schedule-notes.md'));
  assert.ok(notes, 'a schedule-named file outside .claude/commands stays listed');
  assert.equal(notes.querySelector('[title="Run now"]'), null, 'the runner does not run it, so no Run now');
  assert.equal(notes.querySelector('.memory-schedule-icon'), null);
  const nightly = rows.find(row => row.textContent.includes('schedule-nightly.md'));
  assert.ok(nightly.querySelector('.memory-schedule-icon'));
});

test('startup with the default setting does not rebuild the sidebar', async t => {
  let renders = 0;
  await setup(t, {}, w => { w.refreshSidebar = () => { renders++; }; });
  assert.equal(renders, 0, 'unchanged startup setting does not re-render');
});

test('startup restores sidebar width and shortcuts before applying the Schedules tab', async t => {
  let observed;
  const shortcuts = { changesToggle: { key: 'q' } };
  await setup(t, { schedulesTab: true, sidebarWidth: 321, shortcuts }, w => {
    let restoredShortcuts;
    w.setAppShortcuts = value => { restoredShortcuts = value; };
    const apply = w._applySchedulesTab;
    w._applySchedulesTab = enabled => {
      observed = { width: w.document.getElementById('sidebar').style.width, shortcuts: restoredShortcuts };
      apply(enabled);
    };
  });
  assert.equal(observed.width, '321px', 'sidebar width is restored before the tab can throw');
  assert.deepEqual(observed.shortcuts, shortcuts, 'shortcuts are restored before the tab can throw');
});

for (const enabled of [false, true]) {
  test(`global Save with schedulesTab=${enabled} unchanged rebuilds the sidebar once and leaves Agent Files alone`, async t => {
    const h = await setup(t, { schedulesTab: enabled });
    let sidebarRenders = 0;
    let memoryLoads = 0;
    h.w.refreshSidebar = () => { sidebarRenders++; };
    const getMemories = h.w.api.getMemories;
    h.w.api.getMemories = (...args) => { memoryLoads++; return getMemories(...args); };
    h.w.activeTab = 'memory';
    await h.w.openSettingsViewer('global');
    h.w.document.querySelector('#sv-save-btn').click();
    await settle();
    assert.equal(h.saved.schedulesTab, enabled);
    assert.equal(sidebarRenders, 1, 'unchanged Save keeps the one sidebar refresh every Save does, and adds none');
    assert.equal(memoryLoads, 0, 'unchanged Save does not reload Agent Files');
  });
}

test('global Settings saves the toggle and switches surfaces live in both directions', async t => {
  const h = await setup(t);
  for (const enabled of [false, true]) {
    await h.w.openSettingsViewer('global');
    const toggle = h.w.document.querySelector('#sv-schedules-tab');
    assert.ok(toggle, 'Global Settings exposes Schedules tab');
    assert.equal(toggle.checked, !enabled);
    toggle.checked = enabled;
    h.w.document.querySelector('#sv-save-btn').click();
    await settle();
    assert.equal(h.saved.schedulesTab, enabled);
    assert.equal(h.tab.hidden, !enabled);
    if (enabled) h.tab.click();
    else {
      assert.equal(h.w.activeTab, 'sessions', 'turning off the active tab returns to Sessions');
      await h.w.loadMemories();
      assert.match(h.w.memoryContent.textContent, /schedule-nightly.md/);
    }
  }
  await h.w.openSettingsViewer('project', '/p');
  assert.equal(h.w.document.querySelector('#sv-schedules-tab'), null, 'the setting is global only');
});

test('an untouched stale Settings toggle follows a late migration, so its Save keeps the tab on (#1239)', async t => {
  let migrated;
  const h = await setup(t, { schedulesTab: false }, w => { w.api.onSchedulesTabMigrated = callback => { migrated = callback; }; });
  await h.w.openSettingsViewer('global');
  const toggle = h.w.document.querySelector('#sv-schedules-tab');
  assert.equal(toggle.checked, false, 'the form opened before the migration committed');
  assert.equal(migrateSchedulesTabDefault(h.db), 'turned-on');
  await migrated();
  assert.equal(h.tab.hidden, false);
  assert.equal(toggle.checked, true, 'the untouched toggle follows the committed value');
  assert.equal(h.w.document.querySelector('#sv-unsaved').textContent, '', 'following the stored value is not an unsaved change');
  h.w.document.querySelector('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.schedulesTab, true, 'an untouched Save does not opt out');
  assert.equal(h.saved.schedulesTabDefaultMigrated, true);
  assert.equal(h.tab.hidden, false);
});

test('a toggle the user changed keeps its value when the migration lands under an open form (#1239)', async t => {
  let migrated;
  const h = await setup(t, { schedulesTab: false }, w => { w.api.onSchedulesTabMigrated = callback => { migrated = callback; }; });
  await h.w.openSettingsViewer('global');
  const toggle = h.w.document.querySelector('#sv-schedules-tab');
  for (const checked of [true, false]) {
    toggle.checked = checked;
    toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  }
  assert.equal(migrateSchedulesTabDefault(h.db), 'turned-on');
  await migrated();
  assert.equal(toggle.checked, false, 'an edited off is the user choice');
  h.w.document.querySelector('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.schedulesTab, false);
  assert.equal(h.tab.hidden, true);
  assert.equal(migrateSchedulesTabDefault(h.db), 'none', 'the next launch keeps the explicit off');
});

test('an explicit off queued behind the migration keeps its marker, so the next launch does not turn the tab back on (#1239)', async t => {
  let migrated;
  const h = await setup(t, { schedulesTab: false }, w => { w.api.onSchedulesTabMigrated = callback => { migrated = callback; }; });
  await h.w.openSettingsViewer('global');
  const toggle = h.w.document.querySelector('#sv-schedules-tab');
  for (const checked of [true, false]) {
    toggle.checked = checked;
    toggle.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  }
  const merge = h.w.api.mergeGlobalSettings;
  let queued, acknowledge;
  h.w.api.mergeGlobalSettings = (...args) => { queued = args; return new Promise(resolve => { acknowledge = resolve; }); };
  h.w.document.querySelector('#sv-save-btn').click();
  await settle();
  assert.ok(queued, 'Settings submitted while the migration was pending');
  assert.equal(migrateSchedulesTabDefault(h.db), 'turned-on');
  await merge(...queued);
  acknowledge();
  await settle();
  await migrated();
  assert.equal(h.saved.schedulesTab, false, 'the explicit off is applied');
  assert.equal(h.saved.schedulesTabDefaultMigrated, true, 'the merge kept the committed marker');
  assert.equal(migrateSchedulesTabDefault(h.db), 'none');
  assert.equal(h.tab.hidden, true);
});
