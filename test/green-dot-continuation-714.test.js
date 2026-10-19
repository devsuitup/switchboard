'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

for (const ptyId of ['a', 'b', 'c']) {
  test(`#714 a #721 rolled continuation with its PTY on ${ptyId} keeps sidebar/grid waiting parity`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'green-rollup-714-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = encodeProjectPath(dir);
    const rows = ['a', 'b', 'c'].map((sessionId, i) => ({ sessionId, folder, projectPath: dir,
      modified: `2026-10-19T00:00:0${i}.000Z`, summary: 'prompt', messageCount: 1,
      fileMtime: 'now', continuationIndex: JSON.stringify({ format: 3, complete: true, mtime: 'now', ids: i < 2 ? [['b', 'c'][i]] : [] }) }));
    cache.init({ PROJECTS_DIR: dir, activeSessions: new Map(), getMainWindow: () => null, log: console,
      db: { getAllCached: () => rows, getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(), getSetting: () => null } });
    const projects = cache.buildProjectsFromCache(false);
    const session = projects[0].sessions[0];
    assert.equal(projects[0].sessions.length, 1);
    assert.equal(session.sessionId, 'a');
    assert.equal(session.headSessionId, 'c');
    assert.deepEqual(session.mergedMemberIds, ['c', 'b']);
    const ctx = setupSidebarDom();
    t.after(() => ctx.destroy());
    const style = ctx.document.createElement('style');
    style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    ctx.document.head.appendChild(style);
    ctx.window.sessionMap.set('a', session);
    ctx.window.activePtyIds.add(ptyId);
    ctx.window.activeSessionId = 'c';
    ctx.sidebar.renderProjects(projects, true);
    Object.assign(ctx.window, { terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
      replayHiddenBuffer() {}, renderDefaultStatus() {} });
    ctx.evalPublic('shortcuts.js');
    ctx.evalPublic('grid-view.js');
    loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
    ctx.window.openSessions.set(ptyId, { session: { sessionId: ptyId, projectPath: dir, modified: session.modified },
      element: ctx.document.createElement('div'), terminal: { focus() {}, buffer: { active: { viewportY: 0, baseY: 0 } } } });
    ctx.window.wrapInGridCard(ptyId);
    const parity = expected => {
      for (const selector of ['.session-item .session-icon', '.grid-card-dot']) {
        const icon = ctx.document.querySelector(selector);
        assert.ok(icon.classList.contains(`session-icon--${expected}`), `${selector}: ${icon.className}`);
        assert.equal(ctx.window.getComputedStyle(icon).backgroundColor, expected === 'idle' ? 'rgb(62, 207, 90)' : 'rgba(0, 0, 0, 0)');
      }
    };
    parity('idle');
    ctx.setActivity(ptyId, true, 'onCliBusyState');
    ctx.setActivity(ptyId, false, 'onCliBusyState');
    parity('waiting');
    ctx.sidebar.renderProjects(projects, true);
    parity('waiting');
    ctx.setActivity(ptyId, true, 'onCliBusyState');
    parity('idle');
  });
}
