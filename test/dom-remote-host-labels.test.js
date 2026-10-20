'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const alias = 'planificator';
const folder = 'planificator::-srv-app';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, hosts = [{ alias, label: 'VPS', enabled: true }]) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const { window, document } = ctx;
  const session = { sessionId: 'remote-label', remoteAlias: alias, projectPath: '/srv/app',
    summary: 'Remote work', modified: new Date().toISOString(), remoteAttachable: true, remoteDescriptorSeen: true };
  const project = { folder, projectPath: '/srv/app', remoteAlias: alias, sessions: [session],
    remoteHostProfile: { tiers: [{ tier: 'launch', available: true }] } };
  const settings = { remoteHosts: hosts, hiddenProjects: [] };
  window.loadingStatus = document.createElement('div');
  window.reportActivityFocus = () => {};
  window.reportActivityTitles = () => {};
  window.renderDefaultStatus = () => {};
  window.api.getSetting = async () => settings;
  window.api.getProjects = async () => ({ defaultProjects: [project], allProjects: [project] });
  window.api.getActiveTerminals = async () => [];
  window.refreshSidebar = () => ctx.sidebar.renderProjects(window.cachedProjects, true);
  const app = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects', 'confirmAndStopSession', 'launchRemoteSession'] });
  await app.loadProjects();
  window.sessionMap.set(session.sessionId, session);
  return { ...ctx, session, project, settings, app };
}

test('saved host label names sidebar projects, badges and actions; reconnect still uses the alias', async t => {
  const h = await setup(t);
  const calls = [];
  h.window.api.remoteHostRefresh = async value => { calls.push(value); };
  assert.equal(h.document.querySelector('.project-name').textContent, 'VPS: srv/app');
  const row = h.document.querySelector('#si-remote-label');
  assert.equal(row.querySelector('.remote-badge').textContent, 'VPS');
  assert.equal(row.querySelector('.remote-badge').title, 'Live session on VPS — click to attach');
  assert.equal(row.dataset.remoteAlias, alias);
  const reconnect = h.document.querySelector('.remote-host-refresh-btn');
  assert.equal(reconnect.title, 'Reconnect VPS now');
  assert.equal(h.document.querySelector('.project-new-btn').title, 'New session on VPS');
  await reconnect.onclick({ stopPropagation() {} });
  await settle();
  assert.deepEqual(calls, [alias]);
  assert.equal(h.project.folder, folder);
  assert.equal(h.project.remoteAlias, alias);
});

test('label edits and removal refresh displays without changing folder, session or hidden keys', async t => {
  const h = await setup(t);
  h.settings.remoteHosts[0].label = 'Production';
  await h.app.loadProjects();
  assert.equal(h.document.querySelector('.remote-badge').textContent, 'Production');
  h.settings.remoteHosts = [];
  await h.app.loadProjects();
  assert.equal(h.document.querySelector('.remote-badge').textContent, alias);
  assert.equal(h.project.folder, folder);
  assert.equal(h.session.remoteAlias, alias);
  h.window.pendingSessions.set('pending', { session: { ...h.session, sessionId: 'pending' }, folder, projectPath: '/srv/app' });
  h.settings.hiddenProjects = [alias + '::/srv/app'];
  await h.app.loadProjects();
  assert.ok(!h.project.sessions.some(s => s.sessionId === 'pending'));
  assert.deepEqual(h.settings.hiddenProjects, [alias + '::/srv/app']);
});

test('blank or unknown labels fall back to alias and disabled hosts retain their label', async t => {
  const h = await setup(t, [{ alias, label: '   ', enabled: false }]);
  assert.equal(h.document.querySelector('.remote-badge').textContent, alias);
  h.settings.remoteHosts[0].label = 'Disabled VPS';
  await h.app.loadProjects();
  assert.equal(h.document.querySelector('.remote-badge').textContent, 'Disabled VPS');
});

test('read-only badges and disabled launch actions use the label', async t => {
  const h = await setup(t);
  h.session.remoteAttachable = false;
  h.session.remoteAttachBlocked = 'host needs tmux';
  h.project.remoteHostProfile.tiers[0] = { tier: 'launch', available: false, reason: 'host needs tmux' };
  h.window.refreshSidebar();
  assert.match(h.document.querySelector('.remote-badge').title, /^Session on VPS — attach unavailable:/);
  assert.equal(h.document.querySelector('.project-new-btn').title, 'New session unavailable on VPS: host needs tmux');
  h.session.remoteAttachBlocked = null;
  h.project.remoteHostProfile = null;
  h.window.refreshSidebar();
  assert.match(h.document.querySelector('.remote-badge').title, /^Session on VPS — no live process/);
  assert.match(h.document.querySelector('.project-new-btn').title, /^Read-only mirror of VPS/);
});

test('launch dialog escapes the label and launch IPC and pending folder retain the alias', async t => {
  const label = 'VPS <img src=x> "prod"';
  const h = await setup(t, [{ alias, label }]);
  h.evalPublic('dialogs.js');
  h.window.launchRemoteSession = h.app.launchRemoteSession;
  const calls = [];
  h.window.createTerminalEntry = () => ({ initialSize: { cols: 80, rows: 24 }, terminal: { write() {} } });
  h.window.syncPtySizeAfterOpen = () => {};
  h.window.schedulePersistWorkingSet = () => {};
  h.window.api.remoteLaunchSession = async request => { calls.push(request); return { ok: true }; };
  h.window.showRemoteLaunchDialog(h.project);
  assert.equal(h.document.querySelector('.new-session-dialog h3').textContent, 'New Session on ' + label);
  assert.equal(h.document.querySelector('.new-session-dialog .settings-label').textContent, 'Directory on ' + label);
  assert.equal(h.document.querySelector('.new-session-dialog img'), null);
  h.document.querySelector('.new-session-start-btn').click();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].alias, alias);
  const pending = h.window.pendingSessions.get(calls[0].sessionId);
  assert.equal(pending.folder, folder);
  assert.equal(pending.session.remoteAlias, alias);
});

test('send dialog names the label and sends the alias', async t => {
  const h = await setup(t);
  h.evalPublic('dialogs.js');
  const calls = [];
  h.window.api.remoteSendPrompt = async (...args) => { calls.push(args); return { ok: true }; };
  h.window.showSendPromptDialog(h.session);
  assert.equal(h.document.querySelector('.new-session-dialog h3').textContent, 'Send a prompt — VPS');
  h.document.querySelector('textarea').value = 'check';
  h.document.querySelector('.send-prompt-send-btn').click();
  await settle();
  assert.deepEqual(calls, [[alias, h.session.sessionId, 'check']]);
});

test('stop confirmation names the label but stop IPC keeps the alias', async t => {
  const h = await setup(t);
  const confirmations = [];
  const calls = [];
  h.window.appConfirm = async options => { confirmations.push(options); return true; };
  h.window.gridViewActive = true;
  h.window.api.remoteStopSession = async (...args) => { calls.push(args); return { ok: true }; };
  await h.app.confirmAndStopSession(h.session.sessionId);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /Stop this session\?.*Remote work.*on VPS/s);
  assert.match(confirmations[0].message, /process ends; the conversation is kept and can be resumed/);
  assert.doesNotMatch(confirmations[0].message, /planificator/);
  assert.doesNotMatch(confirmations[0].message, /\bpart\b|remote-label/);
  assert.deepEqual(calls, [[alias, h.session.sessionId]]);
});

test('archive and action failure notices use labels while notice IDs keep the alias', async t => {
  const h = await setup(t);
  h.window.announceNotStopped([{ alias, session: h.session, error: 'timeout' }]);
  const notice = h.document.querySelector('[data-notice-id="Archive:planificator:not-stopped"]');
  assert.match(notice.textContent, /Archived, but not stopped: VPS did not answer/);
  assert.match(notice.textContent, /VPS:\/srv\/app/);
  assert.doesNotMatch(notice.textContent, /planificator/);
  h.window.showSessionActionFailure('Stop', h.session, 'refused');
  const failure = h.document.querySelector('[data-notice-id="Stop:planificator:remote-label"]');
  assert.match(failure.textContent, /VPS:\/srv\/app/);
});

test('Archive folder names the host label in its running-session choice and stops with the alias', async t => {
  const h = await setup(t);
  const calls = [];
  h.window.api.getProjectArchivePlan = async () => ({ schedules: [] });
  h.window.api.remoteStopSession = async (...args) => { calls.push(args); return { ok: true }; };
  h.window.api.archiveSession = async () => ({ archived: 1 });
  h.window.api.archiveProject = async () => ({ ok: true, disabled: [], failed: [] });
  const button = h.document.querySelector('.project-archive-btn');
  const done = button.onclick(new h.window.MouseEvent('click'));
  await settle();
  const choice = h.document.querySelector('[data-choice-id="archiveSessions"]').closest('label');
  assert.equal(choice.textContent, 'Archive the 1 session — stopped first: Remote work on VPS');
  assert.doesNotMatch(choice.textContent, /planificator/);
  h.document.querySelector('.choice-dialog-confirm').click();
  await done;
  assert.deepEqual(calls, [[alias, h.session.sessionId]]);
  assert.equal(h.project.folder, folder);
});

async function settingsPanel(h) {
  for (const id of ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body', 'terminal-area',
    'terminal-header', 'stats-viewer', 'memory-viewer', 'jsonl-viewer']) {
    const el = h.document.createElement('div');
    el.id = id;
    h.document.body.append(el);
  }
  h.window.api.platform = 'win32';
  h.window.api.getShellProfiles = async () => [];
  h.window.api.setSetting = async (_key, value) => Object.assign(h.settings, value);
  for (const file of ['setting-defaults.js', 'shortcuts.js', 'terminal-themes.js', 'remote-enrol-panel.js', 'settings-panel.js']) h.evalPublic(file);
  await h.window.openSettingsViewer('global');
}

test('Settings displays archived host labels and unarchives with the original alias key', async t => {
  const h = await setup(t);
  h.settings.hiddenProjects = ['planificator::/srv/<app>', 'removed::/srv/old', '/srv/local'];
  await settingsPanel(h);
  const list = h.document.querySelector('#sv-archived-projects');
  assert.match(list.textContent, /VPS::\/srv\/<app>/);
  assert.match(list.textContent, /removed::\/srv\/old/);
  assert.match(list.textContent, /\/srv\/local/);
  assert.equal(list.querySelector('app'), null);
  const calls = [];
  h.window.api.unarchiveProject = async key => { calls.push(key); return { ok: true }; };
  list.querySelector('button').click();
  await settle();
  assert.deepEqual(calls, ['planificator::/srv/<app>']);
});

test('Settings refreshes archived host names while editing the label and preserves the unarchive key', async t => {
  const h = await setup(t);
  h.settings.hiddenProjects = ['planificator::/srv/<app>'];
  await settingsPanel(h);
  const list = h.document.querySelector('#sv-archived-projects');
  assert.match(list.textContent, /VPS::\/srv\/<app>/);
  const input = h.document.querySelector('.rh-label');
  input.value = 'Renamed VPS <img src=x>';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.match(list.textContent, /Renamed VPS <img src=x>::\/srv\/<app>/);
  assert.equal(list.querySelector('img'), null);
  input.value = '   ';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.match(list.textContent, /planificator::\/srv\/<app>/);
  const calls = [];
  h.window.api.unarchiveProject = async key => { calls.push(key); return { ok: true }; };
  list.querySelector('button').click();
  await settle();
  assert.deepEqual(calls, ['planificator::/srv/<app>']);
  assert.deepEqual(h.settings.hiddenProjects, ['planificator::/srv/<app>']);
});

test('Settings Check host uses the edited label but keeps the trimmed SSH alias for IPC', async t => {
  const h = await setup(t);
  await settingsPanel(h);
  const input = h.document.querySelector('.rh-label');
  input.value = 'Renamed VPS';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const calls = [];
  h.window.api.remoteHostEnrolCheck = value => { calls.push(value); return new Promise(() => {}); };
  h.document.querySelector('.rh-check').click();
  assert.equal(h.document.querySelector('.enrol-pending').textContent, 'Checking Renamed VPS…');
  assert.deepEqual(calls, [alias]);
  assert.equal(h.document.querySelector('.rh-alias').value, alias);
});

test('saving a label refreshes the sidebar immediately and preserves saved alias and hidden keys', async t => {
  const h = await setup(t);
  h.settings.hiddenProjects = ['planificator::/srv/archived'];
  await settingsPanel(h);
  const input = h.document.querySelector('.rh-label');
  input.value = 'Saved VPS';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.document.querySelector('#sv-save-btn').click();
  await settle();
  assert.equal(h.document.querySelector('.remote-badge').textContent, 'Saved VPS');
  assert.equal(h.settings.remoteHosts[0].alias, alias);
  assert.deepEqual(h.settings.hiddenProjects, ['planificator::/srv/archived']);
});
