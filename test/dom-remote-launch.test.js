'use strict';

// Issue #218 / #222: the remote New session dialog (public/dialogs.js) and
// the renderer flow that follows it (launchRemoteSession in public/app.js,
// extracted from the shipped source). Only the outside edges are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const plain = (value) => JSON.parse(JSON.stringify(value));
const DIALOGS_PATH = path.join(__dirname, '..', 'public', 'dialogs.js');

function remoteProject(alias, projectPath) {
  return { folder: `${alias}::${projectPath.replace(/\//g, '-')}`, projectPath, remoteAlias: alias, sessions: [] };
}

function harness() {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const launched = [];
  window.launchRemoteSession = (project, request) => { launched.push({ project, request }); };
  window.cachedAllProjects = [
    remoteProject('box', '/srv/app'),
    remoteProject('box', '/srv/api'),
    remoteProject('box', '/srv/app'),
    remoteProject('other', '/srv/elsewhere'),
    { folder: '-home-dev-local', projectPath: '/home/dev/local', sessions: [] },
  ];
  vm.runInContext(fs.readFileSync(DIALOGS_PATH, 'utf8'), ctx.context, { filename: DIALOGS_PATH });
  return { ctx, window, document: window.document, launched };
}

test('the dialog lists the known paths of that host only, once each, and pre-fills the project path', () => {
  const { ctx, window, document } = harness();
  try {
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    const options = [...document.querySelectorAll('#rld-paths option')].map(o => o.value);
    assert.deepEqual(options, ['/srv/api', '/srv/app']);
    assert.equal(document.querySelector('#rld-path').value, '/srv/app');
    assert.match(document.querySelector('.new-session-dialog h3').textContent, /box/);
  } finally { ctx.destroy(); }
});

test('Start launches with the typed path and the default options', () => {
  const { ctx, window, document, launched } = harness();
  try {
    const project = remoteProject('box', '/srv/app');
    window.showRemoteLaunchDialog(project);
    document.querySelector('#rld-path').value = '  /srv/brand/new  ';
    document.querySelector('.new-session-start-btn').click();
    assert.equal(launched.length, 1);
    assert.equal(launched[0].project, project);
    assert.deepEqual(plain(launched[0].request), { cwd: '/srv/brand/new', options: {} });
    assert.equal(document.querySelector('.new-session-overlay'), null, 'the dialog closes');
  } finally { ctx.destroy(); }
});

test('a chosen permission mode and Dangerous Skip map to the launch options', () => {
  const { ctx, window, document, launched } = harness();
  try {
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.querySelector('#rld-mode-grid [data-mode="plan"]').click();
    document.querySelector('.new-session-start-btn').click();
    assert.deepEqual(plain(launched[0].request.options), { permissionMode: 'plan' });

    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.querySelector('#rld-mode-grid [data-mode="plan"]').click();
    document.querySelector('#rld-mode-grid [data-mode="dangerous-skip"]').click();
    document.querySelector('.new-session-start-btn').click();
    assert.deepEqual(plain(launched[1].request.options), { dangerouslySkipPermissions: true });
  } finally { ctx.destroy(); }
});

test('an empty or relative path is refused in the dialog and nothing launches', () => {
  const { ctx, window, document, launched } = harness();
  try {
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    for (const bad of ['', '   ', 'relative/dir', '/srv/$(id)']) {
      document.querySelector('#rld-path').value = bad;
      document.querySelector('.new-session-start-btn').click();
      assert.equal(launched.length, 0, JSON.stringify(bad));
      assert.ok(document.querySelector('.new-session-overlay'), 'the dialog stays open');
      assert.notEqual(document.querySelector('#rld-error').textContent, '');
    }
  } finally { ctx.destroy(); }
});

test('Cancel and Escape close the dialog without launching', () => {
  const { ctx, window, document, launched } = harness();
  try {
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.querySelector('.new-session-cancel-btn').click();
    assert.equal(document.querySelector('.new-session-overlay'), null);
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(document.querySelector('.new-session-overlay'), null);
    assert.equal(launched.length, 0);
  } finally { ctx.destroy(); }
});

test('Enter in the path field starts, a click on the backdrop cancels, and choosing Default clears a mode', () => {
  const { ctx, window, document, launched } = harness();
  try {
    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.querySelector('#rld-mode-grid [data-mode="plan"]').click();
    document.querySelector('#rld-mode-grid [data-mode="null"]').click();
    document.querySelector('#rld-path').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(launched.length, 1);
    assert.deepEqual(plain(launched[0].request.options), {});

    window.showRemoteLaunchDialog(remoteProject('box', '/srv/app'));
    document.querySelector('.new-session-overlay').click();
    assert.equal(document.querySelector('.new-session-overlay'), null);
    assert.equal(launched.length, 1);
  } finally { ctx.destroy(); }
});

function flowHarness({ launchResult }) {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const calls = { ipc: [], written: [], shown: [], synced: 0, polled: 0, persisted: 0, refreshed: 0 };
  const entry = { initialSize: { cols: 90, rows: 25 }, closed: false, terminal: { write: (t) => calls.written.push(t) } };
  window.encodeProjectPath = (p) => p.replace(/\//g, '-');
  window.createTerminalEntry = () => entry;
  window.syncPtySizeAfterOpen = () => { calls.synced++; };
  window.showSession = (id) => calls.shown.push(id);
  window.schedulePersistWorkingSet = () => { calls.persisted++; };
  window.pollActiveSessions = () => { calls.polled++; };
  window.refreshSidebar = () => { calls.refreshed++; };
  window.api = { remoteLaunchSession: async (req) => { calls.ipc.push(req); return launchResult; } };
  window.cachedProjects = [];
  window.cachedAllProjects = [];
  const { launchRemoteSession } = loadAppFunctions(ctx.context, { functions: ['launchRemoteSession'] });
  return { ctx, window, calls, entry, launchRemoteSession };
}

test('launchRemoteSession adds a pending row under the host, launches over IPC and shows the session', async () => {
  const { ctx, window, calls, launchRemoteSession } = flowHarness({ launchResult: { ok: true, remote: true } });
  try {
    await launchRemoteSession({ remoteAlias: 'box', projectPath: '/srv/app' }, { cwd: '/srv/api', options: { permissionMode: 'plan' } });
    assert.equal(calls.ipc.length, 1);
    const sessionId = calls.ipc[0].sessionId;
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(plain(calls.ipc[0]), {
      alias: 'box',
      sessionId,
      cwd: '/srv/api',
      options: { permissionMode: 'plan' },
      initialSize: { cols: 90, rows: 25 },
    });
    const proj = window.cachedProjects[0];
    assert.equal(proj.remoteAlias, 'box');
    assert.equal(proj.projectPath, '/srv/api');
    assert.equal(proj.folder, 'box::-srv-api');
    assert.equal(proj.sessions[0].remoteAlias, 'box');
    assert.equal(proj.sessions[0].sessionId, sessionId);
    assert.equal(window.pendingSessions.has(sessionId), true);
    assert.deepEqual(calls.shown, [sessionId]);
    assert.equal(calls.synced, 1);
    assert.equal(calls.polled, 1);
  } finally { ctx.destroy(); }
});

test('launchRemoteSession writes the refusal into the terminal and closes the entry when the host refuses', async () => {
  const { ctx, calls, entry, launchRemoteSession } = flowHarness({ launchResult: { ok: false, error: 'directory /srv/api does not exist on box' } });
  try {
    await launchRemoteSession({ remoteAlias: 'box', projectPath: '/srv/app' }, { cwd: '/srv/api', options: {} });
    assert.match(calls.written.join(''), /directory \/srv\/api does not exist on box/);
    assert.equal(entry.closed, true);
    assert.equal(calls.synced, 0);
    assert.equal(calls.polled, 0);
  } finally { ctx.destroy(); }
});
