'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');

const root = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
const globalPages = ['general', 'sessions', 'keyboard', 'automation', 'remote', 'integrations', 'archived', 'advanced'];

function setup(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const saved = {};
  const timers = [];
  const observers = [];
  w.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  w.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; };
  w.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  w.cachedAllProjects = [];
  w.setRemoteHostLabels = () => {};
  w.api = new Proxy({
    platform: 'linux',
    getSetting: async key => saved[key] || {},
    setSetting: async (key, value) => { saved[key] = value; },
    getShellProfiles: async () => [],
    getHarnesses: async () => [{ id: 'claude', label: 'Claude', enabled: true }, { id: 'codex', label: 'Codex', enabled: true }],
    getHarnessModels: async () => [],
    getAppVersion: async () => '0.0.0',
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  loadAppFunctions(ctx, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  loadAppFunctions(ctx, { sourcePath: path.join(root, 'public/sidebar.js'), functions: ['isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  for (const file of ['setting-defaults.js', 'utils.js', 'app-notices.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'settings-panel.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  const q = selector => w.document.querySelector(selector);
  const nav = () => [...w.document.querySelectorAll('.settings-nav button')];
  const open = (scope = 'global', options) => w.openSettingsViewer(scope, scope === 'project' ? '/project' : null, null, options);
  const click = id => {
    const button = nav().find(b => b.dataset.section === id);
    assert.ok(button, `navigation has ${id}`);
    button.click();
    return button;
  };
  const active = () => [...w.document.querySelectorAll('.settings-page')].filter(p => !p.hidden).map(p => p.dataset.section);
  return { w, q, nav, open, click, active, saved, timers, observers, ctx };
}

test('global and project navigation expose the ordered pages and named regions', async t => {
  const h = setup(t);
  await h.open();
  assert.deepEqual(h.nav().map(b => b.dataset.section), globalPages);
  assert.equal(h.q('nav').getAttribute('aria-label'), 'Settings sections');
  for (const page of h.w.document.querySelectorAll('.settings-page')) {
    assert.equal(page.getAttribute('role'), 'region');
    assert.equal(h.q('#' + page.getAttribute('aria-labelledby')).tagName, 'H2');
  }
  await h.open('project');
  assert.deepEqual(h.nav().map(b => b.dataset.section), ['launch', 'project']);
  assert.deepEqual(h.active(), ['launch']);
});

test('click and keyboard select one page with roving focus; Tab enters its controls', async t => {
  const h = setup(t);
  await h.open();
  h.click('keyboard');
  assert.deepEqual(h.active(), ['keyboard']);
  assert.equal(h.nav()[2].getAttribute('aria-current'), 'page');
  const key = (button, key) => button.dispatchEvent(new h.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  for (const [from, pressed, index] of [[2, 'ArrowDown', 3], [3, 'End', 7], [7, 'Home', 0], [0, 'ArrowUp', 7]]) {
    key(h.nav()[from], pressed);
    assert.equal(h.w.document.activeElement, h.nav()[index]);
    assert.deepEqual(h.active(), [globalPages[index]]);
    assert.equal(h.nav().filter(b => b.tabIndex === 0).length, 1);
  }
  key(h.nav()[7], 'Tab');
  assert.equal(h.w.document.activeElement, h.q('#sv-activity-trace'));
});

test('page memory is scope-specific and unknown or unavailable storage is safe', async t => {
  const h = setup(t);
  await h.open();
  h.click('remote');
  assert.equal(h.w.localStorage.getItem('settingsSection:global'), 'remote');
  await h.open('project');
  h.click('project');
  await h.open();
  assert.deepEqual(h.active(), ['remote']);
  await h.open('project');
  assert.deepEqual(h.active(), ['project']);
  h.w.localStorage.setItem('settingsSection:global', '<unknown>');
  await h.open();
  assert.deepEqual(h.active(), ['general']);
  Object.defineProperty(h.w, 'localStorage', { get() { throw new Error('blocked storage'); } });
  await h.open();
  h.click('keyboard');
  assert.doesNotThrow(() => h.w.closeSettingsViewer());
});

test('an explicit Archived deep link wins and is remembered; unknown links fall back', async t => {
  const h = setup(t);
  h.w.localStorage.setItem('settingsSection:global', 'remote');
  await h.open('global', { section: 'archived' });
  assert.deepEqual(h.active(), ['archived']);
  assert.equal(h.w.localStorage.getItem('settingsSection:global'), 'archived');
  await h.open('global', { section: 'missing' });
  assert.deepEqual(h.active(), ['archived']);
  h.w.localStorage.setItem('settingsSection:global', 'missing-too');
  await h.open('global', { section: 'missing' });
  assert.deepEqual(h.active(), ['general']);
});

test('one Save persists edits on multiple pages, resets the counter and stays open', async t => {
  const h = setup(t);
  await h.open();
  h.click('sessions');
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  h.click('general');
  h.q('#sv-restore-startup').value = 'auto';
  h.q('#sv-restore-startup').dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.match(h.q('#sv-unsaved').textContent, /2 unsaved changes/);
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.equal(h.saved.global.restoreOnStartup, 'auto');
  assert.equal(h.q('#sv-unsaved').textContent, '');
  assert.ok(h.q('#sv-save-btn').classList.contains('saved'));
  assert.ok(h.timers.some(timer => timer.ms === 1500));
  h.timers.forEach(timer => timer.fn());
  assert.equal(h.q('#settings-viewer').style.display, 'flex');
  assert.equal(h.q('#sv-save-btn').textContent, 'Save Settings');
  await h.open();
  assert.equal(h.q('#sv-visible-count').value, '42');
});

test('all existing controls retain their ids, scope, groups and inheritance', async t => {
  const h = setup(t);
  const common = ['perm-mode', 'worktree', 'worktree-name', 'browser-mode', 'sandbox', 'pre-launch', 'add-dirs', 'save-btn', 'cancel-btn'];
  const global = ['terminal-theme', 'right-click', 'restore-startup', 'shell-profile', 'visible-count', 'max-age', 'hide-sdk', 'schedules-tab', 'mcp-emulation', 'auto-update', 'receive-beta-versions', 'current-version', 'check-updates-btn', 'update-status', 'remote-hosts', 'remote-add', 'remote-status', 'remote-refresh', 'activity-reporting', 'activity-reporting-status', 'activity-trace', 'activity-trace-list', 'archived-projects', 'codex-sandbox', 'codex-approval', 'codex-model', 'codex-effort'];
  await h.open();
  for (const id of [...common, ...global]) assert.ok(h.q('#sv-' + id), id);
  assert.equal(h.q('#sv-pre-launch').closest('.settings-page')?.dataset.section, 'sessions');
  assert.equal(h.q('#sv-schedules-tab').closest('.settings-page')?.dataset.section, 'automation');
  assert.equal(h.q('#sv-codex-model').closest('.settings-section').querySelector('h3')?.textContent, 'Codex');
  assert.equal(h.w.document.querySelectorAll('.settings-shortcut-btn').length, 8);
  for (const id of ['changesToggle', 'diffToggle', 'touchedToggle', 'shellToggle', 'sessionNavArrows', 'sessionNavBrackets', 'gridToggle', 'agentsToggle']) {
    assert.ok(h.q('#sv-sc-' + id), id);
  }
  assert.equal(h.w.document.querySelectorAll('.settings-page details').length, 2);
  await h.open('project');
  for (const id of [...common, 'archive-btn', 'delete-btn']) assert.ok(h.q('#sv-' + id), id);
  for (const id of global) assert.equal(h.q('#sv-' + id), null, id);
  assert.equal(h.q('#sv-worktree').disabled, true);
  h.q('[data-field="worktree"]').click();
  assert.equal(h.q('#sv-worktree').disabled, false);
});

test('ResizeObserver alone switches the narrow layout at 720px and is cleaned up', async t => {
  const h = setup(t);
  await h.open();
  assert.equal(h.observers.length, 1, 'viewer observes its own width');
  const observer = h.observers[0];
  assert.equal(observer.target, h.q('#settings-viewer'));
  for (const [width, narrow] of [[719, true], [720, false], [480, true], [1000, false]]) {
    observer.callback([{ target: observer.target, contentRect: { width } }]);
    assert.equal(observer.target.classList.contains('settings-narrow'), narrow);
  }
  await h.open();
  assert.equal(observer.disconnected, true);
  h.w.closeSettingsViewer();
  assert.equal(h.observers[1].disconnected, true);
});

test('dirty tracking handles host edits, removal, shortcuts, reversions and live switches', async t => {
  const h = setup(t);
  await h.open();
  assert.ok(h.q('#sv-unsaved'), 'footer has an unsaved counter');
  h.click('remote');
  h.q('#sv-remote-add').click();
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  h.q('.rh-remove').click();
  assert.equal(h.q('#sv-unsaved').textContent, '');
  h.click('integrations');
  h.q('#sv-activity-reporting').click();
  assert.equal(h.q('#sv-unsaved').textContent, '');
  h.click('keyboard');
  const shortcut = h.q('.settings-shortcut-btn');
  shortcut.click();
  shortcut.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'q', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('remote host defaults come from the shared defaults and keep the five-minute fallback', async t => {
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  assert.deepEqual(SETTING_DEFAULTS.remoteHosts, []);
  assert.equal(SETTING_DEFAULTS.remoteRefreshMs, 300000);
  const h = setup(t);
  await h.open();
  assert.equal(h.q('#sv-remote-refresh').value, '5');
  h.q('#sv-remote-refresh').value = '';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.remoteRefreshMs, 300000);
});

test('consecutive saves apply both directions of SDK filtering and IDE notices', async t => {
  const h = setup(t);
  let reloads = 0;
  h.w.loadProjects = async () => { reloads++; };
  await h.open();
  h.q('#sv-hide-sdk').click();
  h.q('#sv-mcp-emulation').click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(reloads, 1);
  h.q('#sv-hide-sdk').click();
  h.q('#sv-mcp-emulation').click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(reloads, 2, 'saving the second toggle reloads filtered project data');
  assert.equal(h.w.document.querySelectorAll('.settings-notice').length, 2, 'both IDE changes are announced');
});

test('edits made while Save is pending remain dirty after the submitted values are saved', async t => {
  const h = setup(t);
  await h.open();
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(typeof release, 'function');
  h.q('#sv-visible-count').value = '43';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  release();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('a rejected host alias remains visibly unsaved', async t => {
  const h = setup(t);
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = 'invalid alias';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved.global.remoteHosts.length, 0);
  assert.match(h.q('#sv-remote-status').textContent, /Not saved/);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
  assert.match(h.q('#sv-save-btn').textContent, /not saved/);
});

test('Save cannot overlap another Save while fields remain editable', async t => {
  const h = setup(t);
  await h.open();
  let release;
  let applies = 0;
  h.w.api.remoteHostsApply = () => { applies++; return new Promise(resolve => { release = resolve; }); };
  h.q('#sv-visible-count').value = '42';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.q('#sv-save-btn').disabled, true, 'Save is disabled until its work completes');
  h.q('#sv-visible-count').value = '43';
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(applies, 1);
  release();
  await settle();
  assert.equal(h.saved.global.visibleSessionCount, 42);
  assert.equal(h.q('#sv-save-btn').disabled, false);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('Save displays normalized values and a clean baseline in global and project forms', async t => {
  for (const scope of ['global', 'project']) {
    await t.test(scope, async t => {
      const h = setup(t);
      await h.open(scope);
      if (scope === 'project') {
        for (const field of ['worktreeName', 'preLaunchCmd', 'addDirs']) h.q(`[data-field="${field}"]`).click();
      }
      const fields = [['worktree-name', '  branch  ', 'branch'], ['pre-launch', '  env  ', 'env'], ['add-dirs', '  /tmp  ', '/tmp']];
      if (scope === 'global') fields.push(['visible-count', '', '10'], ['max-age', '', '3'], ['remote-refresh', '0', '5']);
      if (scope === 'global') {
        h.q('#sv-remote-add').click();
        for (const [selector, value] of [['.rh-alias', '  myhost  '], ['.rh-label', ' Lab ']]) {
          h.q(selector).value = value;
          h.q(selector).dispatchEvent(new h.w.Event('input', { bubbles: true }));
        }
        h.q('#sv-remote-add').click();
      }
      for (const [id, value] of fields) h.q('#sv-' + id).value = value;
      h.q('#sv-save-btn').click();
      await settle();
      for (const [id, , expected] of fields) assert.equal(h.q('#sv-' + id).value, expected, `${scope}: ${id} shows saved value`);
      if (scope === 'global') {
        assert.equal(JSON.stringify(h.saved.global.remoteHosts), JSON.stringify([{ alias: 'myhost', label: 'Lab', enabled: true }]));
        assert.equal(h.w.document.querySelectorAll('.remote-host-row').length, 1, 'Save removes the empty host row');
        assert.equal(h.q('.rh-alias').value, 'myhost');
        assert.equal(h.q('.rh-label').value, 'Lab');
        assert.equal(h.q('.rh-enabled').checked, true);
      }
      assert.equal(h.q('#sv-unsaved').textContent, '');
      await h.open(scope);
      for (const [id, , expected] of fields) assert.equal(h.q('#sv-' + id).value, expected, `${scope}: ${id} survives reopen`);
    });
  }
});

test('saving Use global default displays inherited values and a clean baseline', async t => {
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  const h = setup(t);
  h.saved.global = { permissionMode: 'plan', worktree: false, worktreeName: 'global-branch', browserMode: 'off', sandbox: false, preLaunchCmd: 'global-env', addDirs: null };
  h.saved['project:/project'] = { permissionMode: 'auto', worktree: true, worktreeName: 'project-branch', browserMode: 'claude-in-chrome', sandbox: true, preLaunchCmd: 'project-env', addDirs: '/project-extra' };
  await h.open('project');
  const fields = { permissionMode: 'perm-mode', worktree: 'worktree', worktreeName: 'worktree-name', browserMode: 'browser-mode', sandbox: 'sandbox', preLaunchCmd: 'pre-launch', addDirs: 'add-dirs' };
  for (const field of Object.keys(fields)) h.q(`[data-field="${field}"]`).click();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(JSON.stringify(h.saved['project:/project']), '{}');
  for (const [field, id] of Object.entries(fields)) {
    const control = h.q('#sv-' + id);
    const expected = h.saved.global[field] ?? SETTING_DEFAULTS[field];
    assert.equal(control.disabled, true);
    assert.equal(control.type === 'checkbox' ? control.checked : control.value, expected, `${field} displays inherited value`);
  }
  assert.equal(h.q('#sv-unsaved').textContent, '');
});

test('a deferred normalized host save survives later edits and Cancel unchanged on disk', async t => {
  const h = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-deferred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'global.json');
  fs.writeFileSync(file, '{}');
  const read = async () => JSON.parse(fs.readFileSync(file, 'utf8'));
  h.w.api.getSetting = read;
  h.w.api.setSetting = async (_key, value) => fs.writeFileSync(file, JSON.stringify(value));
  const filename = path.join(root, 'public/sidebar.js');
  const source = fs.readFileSync(filename, 'utf8');
  const flush = source.match(/^window\.flushDeferredProjectDeletionWrites = \(\) => \{[\s\S]*?^\};/m);
  assert.ok(flush, 'load the production deferred-write flush');
  vm.runInContext(flush[0], h.ctx, { filename });
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = '  myhost  ';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('.rh-label').value = ' Saved ';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.w.api.getSetting = async () => {
    h.w.projectDeletionWritesBlocked = true;
    return read();
  };
  h.q('#sv-save-btn').click();
  await settle();
  const patch = h.w.projectDeletionDeferredSettings.patch;
  const submitted = JSON.stringify(patch);
  assert.match(h.q('#sv-save-btn').textContent, /Applied/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  h.q('.rh-label').value = 'Cancelled';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-cancel-btn').click();
  assert.equal(JSON.stringify(patch), submitted, 'Cancel must not mutate the queued save patch');
  h.w.api.getSetting = read;
  h.w.projectDeletionWritesBlocked = false;
  h.w.flushDeferredProjectDeletionWrites();
  await settle();
  assert.deepEqual((await read()).remoteHosts, [{ alias: 'myhost', label: 'Saved', enabled: true }]);
  assert.equal(h.w.projectDeletionDeferredSettings, null);
});

test('editing a normalized host after Save leaves app-wide labels at the saved value', async t => {
  const h = setup(t);
  h.saved.global = { remoteHosts: [{ alias: 'myhost', label: ' Saved ', enabled: true }] };
  await h.open();
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved');
  h.q('.rh-label').value = 'Unsaved';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved', 'typing must not publish an unsaved host label');
  h.q('#sv-cancel-btn').click();
  assert.equal(h.w.remoteHostLabel('myhost'), 'Saved');
});

for (const pending of [false, true]) {
  test(`an unrelated Save preserves a ${pending ? 'pending' : 'completed'} Check host result`, async t => {
    const h = setup(t);
    h.saved.global = { remoteHosts: [{ alias: 'myhost', label: 'Lab', enabled: true }] };
    await h.open();
    let release;
    const result = { ok: true, items: [{ status: 'ok', label: 'SSH', detail: 'Connected' }] };
    h.w.api.remoteHostEnrolCheck = () => pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve(result);
    h.q('.rh-check').click();
    await settle();
    if (!pending) assert.equal(h.q('.enrol-detail').textContent, 'Connected');
    h.q('#sv-visible-count').value = '42';
    h.q('#sv-save-btn').click();
    await settle();
    if (pending) {
      release(result);
      await settle();
    }
    assert.equal(h.q('.remote-host-enrol .enrol-detail')?.textContent, 'Connected', 'Check host result must remain visible after unrelated Save');
    assert.equal(h.q('.rh-check').disabled, false);
    assert.equal(h.q('#sv-unsaved').textContent, '');
  });
}

for (const [field, id, inherited, override, expected] of [
  ['permissionMode', 'perm-mode', null, 'plan', ''],
  ['browserMode', 'browser-mode', 'managed', 'claude-in-chrome', 'off'],
]) {
  test(`Use global Save displays inherited ${field} ${inherited} with a clean counter`, async t => {
    const h = setup(t);
    h.saved.global = { [field]: inherited };
    h.saved['project:/project'] = { [field]: override };
    await h.open('project');
    h.q(`[data-field="${field}"]`).click();
    h.q('#sv-save-btn').click();
    await settle();
    assert.equal(Object.hasOwn(h.saved['project:/project'], field), false);
    assert.equal(h.q('#sv-' + id).value, expected, 'inherited value must use the same display mapping as initial render');
    assert.equal(h.q('#sv-unsaved').textContent, '', 'inherited display must match the saved baseline');
  });
}

test('host normalization preserves edits made while Save is pending', async t => {
  const h = setup(t);
  await h.open();
  h.q('#sv-remote-add').click();
  h.q('.rh-alias').value = '  myhost  ';
  h.q('.rh-alias').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-save-btn').click();
  await settle();
  h.q('.rh-label').value = 'pending label';
  h.q('.rh-label').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.q('#sv-remote-add').click();
  release();
  await settle();
  assert.equal(h.saved.global.remoteHosts[0].label, '');
  assert.equal(h.q('.rh-alias').value, '  myhost  ');
  assert.equal(h.q('.rh-label').value, 'pending label');
  assert.equal(h.w.document.querySelectorAll('.remote-host-row').length, 2);
  assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
});

test('normalization preserves pending edits and compares them with the saved baseline', async t => {
  const h = setup(t);
  await h.open();
  let release;
  h.w.api.remoteHostsApply = () => new Promise(resolve => { release = resolve; });
  h.q('#sv-visible-count').value = '';
  h.q('#sv-worktree-name').value = '  branch  ';
  h.q('#sv-remote-refresh').value = '0';
  h.q('#sv-save-btn').click();
  await settle();
  h.q('#sv-visible-count').value = '11';
  h.q('#sv-worktree-name').value = 'new branch';
  release();
  await settle();
  assert.equal(h.q('#sv-visible-count').value, '11');
  assert.equal(h.q('#sv-worktree-name').value, 'new branch');
  assert.equal(h.q('#sv-remote-refresh').value, '5');
  assert.match(h.q('#sv-unsaved').textContent, /2 unsaved changes/);
  h.q('#sv-visible-count').value = '10';
  h.q('#sv-worktree-name').value = 'branch';
  h.q('#sv-visible-count').dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.q('#sv-unsaved').textContent, '', 'returning to persisted normalized values clears the counter');
});

test('unlisted template rows remain reachable in both settings scopes', async t => {
  for (const scope of ['global', 'project']) {
    await t.test(scope, async t => {
      const h = setup(t);
      const body = h.q('#settings-viewer-body');
      const descriptor = Object.getOwnPropertyDescriptor(h.w.Element.prototype, 'innerHTML');
      Object.defineProperty(body, 'innerHTML', {
        set(html) {
          descriptor.set.call(this, html);
          const row = h.w.document.createElement('div');
          row.className = 'settings-field';
          row.innerHTML = '<label>Future option<input id="sv-future-option" value="kept"></label>';
          this.querySelector('.settings-section').append(row);
        },
        get() { return descriptor.get.call(this); },
      });
      await h.open(scope);
      const control = h.q('#sv-future-option');
      assert.ok(control, `${scope}: an unlisted row is not deleted`);
      const page = control.closest('.settings-page');
      assert.ok(page, 'fallback belongs to a navigable page');
      h.click(page.dataset.section);
      assert.equal(page.hidden, false);
      control.value = 'changed';
      control.dispatchEvent(new h.w.Event('input', { bubbles: true }));
      assert.match(h.q('#sv-unsaved').textContent, /1 unsaved change/);
    });
  }
});

test('opening a narrow strip brings the remembered or explicit active item into view', async t => {
  const h = setup(t);
  const scrolled = [];
  h.w.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ id: this.dataset.section, options }); };
  h.w.localStorage.setItem('settingsSection:global', 'advanced');
  for (const options of [undefined, { section: 'archived' }]) {
    await h.open('global', options);
    const observer = h.observers.at(-1);
    observer.callback([{ target: observer.target, contentRect: { width: 480 } }]);
    assert.equal(scrolled.at(-1)?.id, options?.section || 'advanced');
    assert.equal(scrolled.at(-1).options.inline, 'nearest');
    assert.equal(scrolled.at(-1).options.block, 'nearest');
  }
});

test('reporting row retains its bottom corners and spacing before its disclosure', async t => {
  const h = setup(t);
  await h.open();
  const row = h.q('#sv-activity-reporting').closest('.settings-field');
  assert.equal(row.nextElementSibling.tagName, 'DETAILS');
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule = rules.find(([, selector, body]) => selector.includes('.settings-section > .settings-field') && body.includes('border-bottom-left-radius'));
  assert.ok(rule && row.matches(rule[1].trim()), 'reporting matches the production last-row rule');
  assert.match(rule[2], /border-bottom-left-radius:\s*10px/);
  assert.match(rule[2], /border-bottom-right-radius:\s*10px/);
  assert.match(rule[2], /margin-bottom:\s*20px/);
});
