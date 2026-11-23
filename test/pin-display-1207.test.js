'use strict';

const test = require('node:test');
require('./fixtures/isolated-codex-home.cjs')(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { setupSidebarDom } = require('./dom-setup');
const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '33333333-3333-4333-8333-333333333333';

for (const [label, withConversation, pinnedId] of [
  ['a: empty cache, descriptor-only row', false, HEAD],
  ['b: only the job session id', true, HEAD],
  ['c: only the original conversation id', true, OLD],
]) {
  test(`background row displays its pin after projection rebuilds (${label})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-display-1207-'));
    const ctx = setupSidebarDom();
    ctx.window.refreshSidebar = () => {};
    t.after(() => { ctx.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
    const folder = encodeProjectPath(root), modified = new Date().toISOString();
    const rows = withConversation ? [{ sessionId: OLD, folder, projectPath: root, modified, messageCount: 2,
      summary: 'conversation', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [HEAD] }) }] : [];
    const meta = new Map();
    cache.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions: new Map(), getMainWindow: () => null, log: console,
      getLocalDescriptors: () => [{ kind: 'bg', jobId: '33333333', sessionId: HEAD, cwd: root, startedAt: Date.now() }],
      getLocalJobs: () => new Map([['33333333', { state: 'working', sessionId: HEAD }]]),
      db: { getAllCached: () => rows, getAllMeta: () => meta, getAllFolderMeta: () => new Map([[folder, { projectPath: root }]]),
        getSetting: () => null } });
    const render = () => {
      const projects = cache.buildProjectsFromCache(false);
      ctx.window.sessionMap.clear();
      for (const row of projects.flatMap(p => p.sessions)) ctx.window.sessionMap.set(row.sessionId, row);
      ctx.sidebar.renderProjects(projects, false);
      return projects.flatMap(p => p.sessions);
    };
    ctx.window.api.setStar = async (_id, value) => {
      meta.set(pinnedId, { starred: value ? 1 : 0 });
      return { starred: value ? 1 : 0 };
    };
    assert.equal(render().length, 1);
    const pin = ctx.document.querySelector('.session-pin');
    assert.equal(pin.classList.contains('pinned'), false);
    await pin.onclick({ stopPropagation() {} });
    for (let restart = 0; restart < 3; restart++) {
      const visible = render();
      assert.equal(visible.length, 1);
      assert.equal(visible[0].sessionId, HEAD);
      if (!withConversation) assert.equal(visible[0].descriptorOnly, true);
      assert.ok(ctx.document.querySelector('.session-pin.pinned'), 'the rebuilt background row displays its pin');
    }
    assert.deepEqual([...meta.keys()], [pinnedId]);
  });
}
