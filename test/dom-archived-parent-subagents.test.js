// A subagent whose parent is archived follows its parent; only a parent with
// no cache row makes an orphan. See .ai/contexts/subagent-observability.md
// ("A subagent follows its archived parent").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { setupSidebarDom } = require('./dom-setup');

const PROJECT_PATH = '/home/dev/archived-parent-proj';
const FOLDER = '-home-dev-archived-parent-proj';

function row(sessionId, modified, extra = {}) {
  return {
    sessionId, folder: FOLDER, projectPath: PROJECT_PATH,
    summary: sessionId, firstPrompt: sessionId,
    modified, created: modified, messageCount: 1,
    parentSessionId: null, agentId: null, subagentType: null,
    description: null, slug: null, aiTitle: null,
    ...extra,
  };
}

function sub(sessionId, parentSessionId, modified) {
  return row(sessionId, modified, {
    parentSessionId, agentId: sessionId, subagentType: 'explore', description: sessionId,
  });
}

// live: an unarchived top-level session, so the project renders either way.
// parent: archived, with two subagents.
// orphan: its parent has no row at all.
// ghost-kid: its parent has an archived meta entry but no row (transcript deleted).
const CACHED_ROWS = [
  row('live', '2026-09-30T10:00:00.000Z'),
  row('parent', '2026-09-30T09:00:00.000Z'),
  sub('parent-kid-1', 'parent', '2026-09-30T09:01:00.000Z'),
  sub('parent-kid-2', 'parent', '2026-09-30T09:02:00.000Z'),
  sub('orphan', 'gone', '2026-09-30T08:00:00.000Z'),
  sub('ghost-kid', 'ghost', '2026-09-30T07:00:00.000Z'),
];

function buildProjects({ parentArchived, showArchived }) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-apa-'));
  try {
    const metaEntries = new Map([
      ['parent', { name: null, starred: 0, archived: parentArchived ? 1 : 0 }],
      ['ghost', { name: null, starred: 0, archived: 1 }],
    ]);
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: {
        getAllFolderMeta: () => new Map(),
        getAllMeta: () => metaEntries,
        getAllCached: () => CACHED_ROWS.map(r => ({ ...r })),
        getSetting: () => ({}),
        setFolderMeta: () => {},
      },
    });
    return sessionCache.buildProjectsFromCache(showArchived);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
}

function sessionIdsOf(projects) {
  const proj = projects.find(p => p.projectPath === PROJECT_PATH);
  assert.ok(proj, 'project must be in the payload');
  return proj.sessions.map(s => s.sessionId).sort();
}

function render(projects) {
  const ctx = setupSidebarDom();
  ctx.sidebar.renderProjects(projects, true);
  const doc = ctx.document;
  const orphanGroup = doc.querySelector('.sidebar-orphan-subagents');
  const orphanIds = orphanGroup
    ? [...orphanGroup.querySelectorAll('[data-subagent]')].map(el => el.dataset.sessionId).sort()
    : [];
  const nestedUnder = (parentId) => {
    const container = doc.getElementById('subc-' + parentId);
    return container
      ? [...container.querySelectorAll('[data-subagent]')].map(el => el.dataset.sessionId).sort()
      : [];
  };
  const rendered = (id) => !!doc.querySelector(`[data-session-id="${id}"]`);
  return { ctx, orphanIds, nestedUnder, rendered };
}

test('buildProjectsFromCache: hides the subagents of an archived parent, keeps true orphans', () => {
  assert.deepEqual(sessionIdsOf(buildProjects({ parentArchived: true, showArchived: false })),
    ['ghost-kid', 'live', 'orphan'],
    'an archived parent takes its subagents out of the default payload; a missing parent does not');
});

test('buildProjectsFromCache: shows an archived parent with its subagents when archived sessions are shown', () => {
  assert.deepEqual(sessionIdsOf(buildProjects({ parentArchived: true, showArchived: true })),
    ['ghost-kid', 'live', 'orphan', 'parent', 'parent-kid-1', 'parent-kid-2']);
});

test('sidebar: archiving a parent adds nothing to the orphan group', () => {
  const { ctx, orphanIds, rendered } = render(buildProjects({ parentArchived: true, showArchived: false }));
  try {
    assert.deepEqual(orphanIds, ['ghost-kid', 'orphan'],
      'the orphan group must hold only subagents whose parent has no cache row');
    assert.equal(rendered('parent-kid-1'), false, 'a subagent of an archived parent must not render');
    assert.equal(rendered('parent-kid-2'), false, 'a subagent of an archived parent must not render');
  } finally {
    ctx.destroy();
  }
});

test('sidebar: with archived sessions shown, the archived parent carries its subagents', () => {
  const { ctx, orphanIds, nestedUnder, rendered } = render(buildProjects({ parentArchived: true, showArchived: true }));
  try {
    assert.equal(rendered('parent'), true, 'the archived parent must render');
    assert.deepEqual(nestedUnder('parent'), ['parent-kid-1', 'parent-kid-2'],
      'the subagents must nest under their archived parent');
    assert.deepEqual(orphanIds, ['ghost-kid', 'orphan']);
  } finally {
    ctx.destroy();
  }
});

test('sidebar: unarchiving restores the parent and its subagents together', () => {
  const { ctx, orphanIds, nestedUnder, rendered } = render(buildProjects({ parentArchived: false, showArchived: false }));
  try {
    assert.equal(rendered('parent'), true);
    assert.deepEqual(nestedUnder('parent'), ['parent-kid-1', 'parent-kid-2']);
    assert.deepEqual(orphanIds, ['ghost-kid', 'orphan']);
  } finally {
    ctx.destroy();
  }
});
