'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { setupSidebarDom } = require('./dom-setup');

for (const variant of ['indexed head', 'bridge union', 'unindexed head']) {
test(`an existing background merge exposes part names and own dates (${variant})`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-parts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ids = [1, 2, 3].map(n => `${n}${'0'.repeat(7)}-0000-4000-8000-000000000000`);
  const rows = ids.map((sessionId, i) => ({
    sessionId, folder: encodeProjectPath(dir), projectPath: dir, summary: `Part ${i + 1}`, messageCount: 1,
    modified: `2026-10-${10 + i}T09:00:00Z`,
    continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ids.slice(i + 1, i + 2) }),
  }));
  if (variant === 'unindexed head') rows.pop();
  if (variant === 'bridge union') rows.push({
    sessionId: '40000000-0000-4000-8000-000000000000', mergedIntoSessionId: ids[0],
    folder: encodeProjectPath(dir), projectPath: dir, summary: 'Mirror', messageCount: 1, modified: '2026-10-10T10:00:00Z',
  });
  const meta = new Map([[ids[1], { name: 'Middle name' }]]);
  cache.init({ PROJECTS_DIR: dir, activeSessions: new Map(), getMainWindow: () => null, log: console,
    getLocalDescriptors: () => [{ sessionId: ids[2], kind: 'bg', jobId: '1234abcd', cwd: dir,
      name: 'Background head', startedAt: Date.parse('2026-10-13T09:00:00Z') }],
    getLocalJobs: () => new Map([['1234abcd', { state: 'working', sessionId: ids[2] }]]),
    db: { getAllCached: () => rows, getAllMeta: () => meta, getAllFolderMeta: () => new Map(), getSetting: () => ({}) },
  });
  const projects = cache.buildProjectsFromCache(false);
  const sessions = projects.flatMap(project => project.sessions);
  assert.equal(sessions.length, 1, 'existing merge policy is exercised');
  assert.equal(sessions[0].mergedMemberIds.length, variant === 'bridge union' ? 3 : 2);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set(sessions[0].sessionId, sessions[0]);
  ctx.window.showSessionContextMenu({ clientX: 20, clientY: 20 }, sessions[0].sessionId);
  [...ctx.document.querySelectorAll('.session-context-menu button')].find(button => button.textContent === 'Parts').click();
  const expected = [...rows].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .map(part => `${meta.get(part.sessionId)?.name || part.summary} · last active ${ctx.window.formatDate(new Date(part.modified))}`);
  if (variant === 'unindexed head') expected.unshift(`Background head · last active ${ctx.window.formatDate(new Date('2026-10-13T09:00:00Z'))}`);
  assert.deepEqual([...ctx.document.querySelectorAll('.session-part-label')].map(label => label.textContent), expected);
});
}
