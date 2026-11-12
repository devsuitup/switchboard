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
  w.api = new Proxy({
    platform: 'win32',
    getSetting: async () => saved,
    setSetting: async (_key, value) => { saved = value; },
    getMemories: async () => listMemories({ claudeDir, projectsDir, activeProjectPaths: [project] }, p => fs.readFileSync(p, 'utf8')).view,
    listSchedules: async () => { calls.push('list'); return { now: Date.now(), projects: [] }; },
    runScheduleNow: async file => { calls.push(file); return { ok: true }; },
    readMemory: async file => { calls.push('open:' + file); return 'nightly'; },
    getShellProfiles: async () => [],
    getAppVersion: async () => '0.0.0',
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  for (const [name, id] of Object.entries({ memoryContent: 'memory-content', memoryViewer: 'memory-viewer', workFilesViewer: 'work-files-viewer', workFilesContent: 'work-files-content', placeholder: 'placeholder', terminalArea: 'terminal-area', statsViewer: 'stats-viewer', statsContent: 'stats-content', settingsViewer: 'settings-viewer', jsonlViewer: 'jsonl-viewer', sidebarContent: 'sidebar-content', sessionFilters: 'session-filters', searchBar: 'search-bar', searchInput: 'search-input' })) w[name] = w.document.getElementById(id);
  Object.assign(w, { activeTab: 'sessions', searchGeneration: 0, gridViewActive: false, activeSessionId: null, projectsChangedWhileAway: false, refreshSidebar() {}, memoryPanel: { open: (...args) => calls.push(args) }, setRemoteHostLabels() {}, CSS: { escape: value => value.replace(/\\/g, '\\\\') } });
  for (const file of ['setting-defaults.js', 'icons.js', 'utils.js', 'shortcuts.js', 'terminal-themes.js', 'app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js', 'settings-panel.js']) {
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
  return { w, calls, get saved() { return saved; }, tab: w.document.querySelector('[data-tab="schedules"]') };
}

for (const [label, settings] of [['default', {}], ['explicit off', { schedulesTab: false }], ['on', { schedulesTab: true }]]) {
  test(`${label}: tab and Agent Files follow the saved setting`, async t => {
    const h = await setup(t, settings);
    const enabled = settings.schedulesTab === true;
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

test('default Agent Files exposes schedule files and Run now', async t => {
  const h = await setup(t);
  const schedule = [...h.w.document.querySelectorAll('.memory-item')].find(row => row.textContent.includes('schedule-nightly.md'));
  assert.ok(schedule, 'default Agent Files restores schedule-nightly.md');
  assert.ok(schedule.querySelector('[title="Run now"]'), 'default schedule has Run now');
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
  for (const enabled of [true, false]) {
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
