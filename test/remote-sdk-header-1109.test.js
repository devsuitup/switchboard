'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { setupSidebarDom } = require('./dom-setup');
const { computeHostProfile } = require('../src/main/remote/remote-host-profile');

test('SDK-only remote project keeps its launch header and hides parent and child rows', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-header-1109-'));
  t.after(() => { cache.setRemoteRoots(new Map()); fs.rmSync(dir, { recursive: true, force: true }); });
  const local = path.join(dir, 'local');
  const remote = path.join(dir, 'remote');
  const folder = '-srv-app';
  for (const root of [local, remote]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const row = (sessionId, folder, extra = {}) => ({ sessionId, folder, projectPath: '/srv/app', entrypoint: 'sdk-cli',
    summary: sessionId, messageCount: 1, modified: '2026-11-16T12:00:00Z', ...extra });
  let global = {};
  cache.init({ PROJECTS_DIR: local, activeSessions: new Map(), getMainWindow: () => null,
    log: { info() {}, debug() {}, warn() {}, error() {} }, db: {
      getAllCached: () => [row('sdk', 'box::' + folder), row('child', 'box::' + folder, { parentSessionId: 'sdk' }), row('local-sdk', folder)],
      getAllMeta: () => new Map(),
      getAllFolderMeta: () => new Map([[folder, { projectPath: '/srv/app' }], ['box::' + folder, { projectPath: '/srv/app' }]]),
      getSetting: key => key === 'global' ? global : {},
    } });
  cache.setRemoteRoots(new Map([['box', remote]]));
  const projects = cache.buildProjectsFromCache(false);
  assert.equal(projects.length, 1, 'remote SDK-only project keeps a header; local SDK-only project stays hidden');
  assert.equal(projects[0].remoteAlias, 'box');
  assert.equal(projects[0].projectPath, '/srv/app');
  assert.deepEqual(projects[0].sessions, [], 'SDK parent and subagent remain hidden');
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  projects[0].remoteHostProfile = computeHostProfile({ at: Date.now(), tools: { tmux: true } });
  h.sidebar.renderProjects(projects, true);
  const header = h.document.getElementById('ph-' + h.sidebar.folderId('/srv/app', 'box'));
  assert.ok(header, 'remote project has a sidebar header');
  assert.equal(header.querySelector('.project-new-btn').disabled, false);
  assert.equal(h.document.querySelectorAll('.session-item').length, 0);
  const opened = [];
  h.window.showRemoteLaunchDialog = project => opened.push(project);
  header.querySelector('.project-new-btn').click();
  assert.equal(opened[0], projects[0]);
  global = { hiddenProjects: ['box::/srv/app'] };
  assert.equal(cache.buildProjectsFromCache(false).length, 0, 'archived remote projects remain hidden');
});
