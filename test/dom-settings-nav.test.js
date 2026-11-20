'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  for (const file of ['setting-defaults.js', 'utils.js', 'shortcuts.js', 'terminal-themes.js', 'settings-panel.js']) {
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
  return { w, q, nav, open, click, active, saved, timers, observers };
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
