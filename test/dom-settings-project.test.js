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

function setup(t, projects = []) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const saved = { global: { permissionMode: 'plan', remoteHosts: [{ alias: 'box', label: 'Build <server>' }] } };
  w.cachedAllProjects = projects;
  w.api = new Proxy({
    platform: 'linux', getSetting: async key => saved[key] || {},
    setSetting: async (key, value) => { saved[key] = value; },
    getShellProfiles: async () => [], getHarnesses: async () => [],
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  loadAppFunctions(ctx, { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  loadAppFunctions(ctx, { sourcePath: path.join(root, 'public/sidebar.js'), functions: ['folderId', 'isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  for (const file of ['setting-defaults.js', 'utils.js', 'modal-stack.js', 'choice-dialog.js', 'app-dialogs.js', 'app-notices.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'archived-manager.js', 'settings-panel.js']) {
    const filename = path.join(root, 'public', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  const q = selector => w.document.querySelector(selector);
  const open = (projectPath = '/srv/<repo>', folder = 'box::folder') => w.openSettingsViewer('project', projectPath, folder);
  const projectPage = () => q('.settings-nav [data-section="project"]').click();
  return { w, ctx, q, open, projectPage, saved };
}

test('project actions live only in This project, outside the Save and Cancel footer', async t => {
  const h = setup(t);
  await h.open();
  assert.deepEqual([...h.w.document.querySelectorAll('.settings-nav button')].map(b => b.textContent), ['Launch', 'This project']);
  assert.equal(h.q('#settings-page-launch').hidden, false);
  assert.deepEqual([...h.q('.settings-btn-row').querySelectorAll('button')].map(b => b.id), ['sv-cancel-btn', 'sv-save-btn']);
  h.projectPage();
  const zone = h.q('#settings-page-project .settings-danger-zone');
  assert.ok(zone, 'This project contains the danger zone');
  assert.equal(zone.querySelector('h3').textContent, 'Danger zone');
  for (const action of ['archive', 'delete']) {
    assert.equal(h.w.document.querySelectorAll('#sv-' + action + '-btn').length, 1);
    assert.ok(zone.contains(h.q('#sv-' + action + '-btn')));
  }
  const nav = h.q('.settings-nav [data-section="project"]');
  nav.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(h.w.document.activeElement, h.q('#sv-archive-btn'));
  await h.w.openSettingsViewer('global');
  assert.equal(h.q('.settings-danger-zone'), null);
  assert.equal(h.q('#sv-archive-btn'), null);
});

test('This project identifies the exact remote folder and its session rows as text', async t => {
  const project = { projectPath: '/srv/<repo>', folder: 'box::folder', remoteAlias: 'box', sessions: [
    { sessionId: 'a' }, { sessionId: 'b', archived: 1 }, { sessionId: 'c' },
    { sessionId: 'child', parentSessionId: 'c' },
    { sessionId: 'archived-child', parentSessionId: 'b', archived: 1 },
    { sessionId: 'shell', type: 'terminal' },
    { sessionId: 'archived-shell', type: 'terminal', archived: 1 },
  ] };
  const h = setup(t, [{ ...project, remoteAlias: null, folder: 'local', sessions: [] }, project]);
  await h.open();
  h.projectPage();
  assert.equal(h.q('#sv-project-name')?.textContent, 'srv/<repo>');
  assert.equal(h.q('#sv-project-path')?.textContent, '/srv/<repo>');
  assert.equal(h.q('#sv-project-host')?.textContent, 'Build <server>');
  assert.equal(h.q('#sv-project-folder')?.textContent, 'box::folder');
  assert.equal(h.q('#sv-project-sessions')?.textContent, '3 sessions · 1 archived');
  assert.equal(h.q('#settings-page-project repo'), null);
  assert.equal(h.q('#settings-page-project server'), null);
});

test('This project falls back to the remote alias when the label helper is unavailable', async t => {
  const h = setup(t);
  h.w.remoteHostLabel = undefined;
  await assert.doesNotReject(h.open(), 'project settings must open without the optional host-label helper');
  assert.equal(h.q('#sv-project-host')?.textContent, 'box');
});

test('Delete uses the project refreshed while shell profiles were loading', async t => {
  const stale = { projectPath: '/srv/<repo>', folder: 'box::folder', remoteAlias: 'box', sessions: [] };
  const fresh = { ...stale, sessions: [{ sessionId: 'new-session' }] };
  const h = setup(t, [stale]);
  let releaseProfiles;
  let profilesRequested;
  const requested = new Promise(resolve => { profilesRequested = resolve; });
  h.w.api.getShellProfiles = () => new Promise(resolve => {
    releaseProfiles = resolve;
    profilesRequested();
  });
  const deleted = [];
  h.w.confirmAndDeleteProjectFolder = async project => { deleted.push(project); return false; };
  const opening = h.open();
  await requested;
  h.w.cachedAllProjects = [fresh];
  releaseProfiles([]);
  await opening;
  h.q('#sv-delete-btn').click();
  await settle();
  assert.equal(deleted[0], fresh, 'Delete must receive the refreshed project object');
  assert.equal(h.q('#sv-project-sessions')?.textContent, '1 session · 0 archived');
});

test('failed Settings Archive shows an OK-only alert and retains the project', async t => {
  const h = setup(t);
  let reloads = 0;
  h.w.loadProjects = async () => { reloads++; };
  h.w.api.archiveProjectSettings = async () => ({ error: 'disk <full>' });
  await h.open();
  h.projectPage();
  const button = h.q('#sv-archive-btn');
  button.focus();
  button.click();
  await settle();
  assert.equal(h.q('#choice-dialog-title')?.textContent, 'Could not archive project');
  assert.match(h.q('.choice-dialog')?.textContent || '', /disk <full>/);
  assert.equal(h.q('.choice-dialog full'), null);
  assert.equal(h.q('.choice-dialog-confirm')?.textContent, 'OK');
  assert.equal(h.q('.choice-dialog-cancel:not([hidden])'), null, 'failure must be an OK-only appAlert');
  h.q('.choice-dialog-confirm').click();
  await settle();
  assert.equal(h.q('.choice-dialog-overlay'), null);
  assert.equal(h.q('#settings-viewer').style.display, 'flex');
  assert.equal(h.w.document.activeElement, button);
  assert.equal(h.q('#app-notices .app-notice-action'), null);
  assert.equal(reloads, 0);
});

test('local identity uses the cached folder when none was supplied and reports zero rows', async t => {
  const h = setup(t, [{ projectPath: 'C:\\repo', folder: 'C-repo', sessions: [] }]);
  await h.open('C:\\repo', null);
  assert.equal(h.q('#sv-project-host')?.textContent, 'Local');
  assert.equal(h.q('#sv-project-path')?.textContent, 'C:\\repo');
  assert.equal(h.q('#sv-project-folder')?.textContent, 'C-repo');
  assert.equal(h.q('#sv-project-sessions')?.textContent, '0 sessions · 0 archived');
});

test('a missing cached project retains supplied identity without inventing session counts', async t => {
  const h = setup(t);
  await h.open();
  assert.equal(h.q('#sv-project-host')?.textContent, 'Build <server>');
  assert.equal(h.q('#sv-project-folder')?.textContent, 'box::folder');
  assert.equal(h.q('#sv-project-sessions')?.textContent, 'Unavailable');
  await h.open('/missing', null);
  assert.equal(h.q('#sv-project-folder')?.textContent, 'Unavailable');
});

test('Launch inheritance survives visiting This project and saving from its footer', async t => {
  const h = setup(t);
  await h.open();
  const control = h.q('#sv-perm-mode');
  assert.equal(control.closest('.settings-page').dataset.section, 'launch');
  assert.equal(control.disabled, true);
  assert.equal(control.value, 'plan');
  h.q('[data-field="permissionMode"]').click();
  assert.equal(control.disabled, false);
  control.value = 'auto';
  control.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  h.projectPage();
  assert.ok(h.q('#settings-page-project .settings-danger-zone'), 'actions are separated from Launch fields');
  h.q('#sv-save-btn').click();
  await settle();
  assert.equal(h.saved['project:/srv/<repo>'].permissionMode, 'auto');
  assert.equal(h.q('#sv-unsaved').textContent, '');
});

test('moved actions retain exact archive arguments, Undo, delete target and busy guards', async t => {
  const p = { projectPath: '/srv/<repo>', folder: 'box::folder', remoteAlias: 'box', sessions: [] };
  const h = setup(t, [p]);
  const calls = [];
  h.w.api.archiveProjectSettings = async (...args) => { calls.push(args); return { entry: 'box::/srv/<repo>' }; };
  h.w.showProjectArchiveUndo = (...args) => calls.push(args);
  h.w.confirmAndDeleteProjectFolder = async (project, button) => { calls.push([project, button]); return false; };
  await h.open();
  h.projectPage();
  assert.ok(h.q('.settings-danger-zone')?.contains(h.q('#sv-archive-btn')), 'archive is reachable in the danger zone');
  h.q('#sv-archive-btn').click();
  await settle();
  assert.deepEqual(calls, [['/srv/<repo>', 'box::folder'], ['box::/srv/<repo>', 'srv/<repo>']]);
  await h.open();
  h.q('#sv-delete-btn').click();
  await settle();
  assert.equal(calls[2][0], p);
  assert.equal(calls[2][1], h.q('#sv-delete-btn'));
  vm.runInContext('deletingProjectKeys.add(projectDeletionKey(cachedAllProjects[0])); paintProjectDeletionBusy();', h.ctx, { filename: __filename });
  assert.equal(h.q('#sv-delete-btn').disabled, true);
  assert.equal(h.q('#sv-archive-btn').disabled, true);
});
