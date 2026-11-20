'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { encodeProjectPath } = require('../encode-project-path');
const cache = require('../session-cache');
const { groupedHiddenMatcher } = require('../archived-projects');
const { isProjectHidden, projectHiddenMatcher } = require('../public/worktree-nesting');
const { resolveWorktreePath } = require('../derive-project-path');
const supported = { skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI' };
const plain = value => JSON.parse(JSON.stringify(value));

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-compat-'));
  const repo = path.join(root, 'repo'), cwd = path.join(repo, '.work-files', 'worktrees', 'old');
  fs.mkdirSync(cwd, { recursive: true });
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore();
  const worker = require('./fixtures/project-deletion-worker.cjs').createWorker(db);
  const writer = createSessionIndexWriter({ workerFactory: () => worker, readonlyBackend: { ...db, applySettingsAcknowledgment() {} } }, {});
  await writer.ready;
  t.after(async () => { await writer.terminate(); db.closeDb(); process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const at = '2026-11-20T10:00:00Z';
  const own = { sessionId: 'own', runtime: 'claude', folder: encodeProjectPath(repo), cwd: repo, projectPath: repo };
  const claude = { sessionId: 'claude', runtime: 'claude', folder: encodeProjectPath(cwd), cwd: repo, projectPath: repo, modified: '2026-11-19T10:00:00Z' };
  const codex = { sessionId: 'codex', runtime: 'codex', cwd, projectPath: repo, modified: claude.modified };
  const projects = [{ projectPath: repo, sessions: [own, claude, codex] }];
  const record = { archivedAt: at, knownSessionIds: [] };
  return { root, repo, cwd, db, writer, projects, record, own, claude, codex };
}

test('worktree tombstones filter only source sessions in both cache and writer', supported, async t => {
  const h = await setup(t);
  h.db.setSetting('global', { hiddenProjects: [h.cwd], hiddenProjectKinds: { [h.cwd]: 'delete' } });
  const shown = await h.writer.applyAndPersistArchived(h.projects, true);
  assert.deepEqual(shown.flatMap(p => p.sessions.map(s => s.sessionId)), ['own'], 'W delete must retain repository sessions');
  h.db.upsertCachedSessions([h.own, h.claude, { ...h.codex, projectPath: h.cwd, folder: 'codex:source' }]);
  cache.init({ PROJECTS_DIR: path.join(h.root, 'projects'), db: h.db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  assert.deepEqual(cache.buildProjectsFromCache(true).flatMap(p => p.sessions.map(s => s.sessionId)), ['own']);
});

test('hidden exact checks agree across Windows spellings without collapsing W onto R', supported, async t => {
  const h = await setup(t), alternate = h.cwd.replaceAll('\\', '/') + '/';
  for (const match of [groupedHiddenMatcher([h.cwd]), (alias, target) => isProjectHidden([h.cwd], alias, target)]) {
    assert.equal(match(null, h.repo), false, 'W never hides R');
    assert.equal(match(null, alternate), true, 'equivalent local paths match');
    assert.equal(match(null, h.cwd + '-other'), false);
  }
});

test('W tombstone does not hide a Claude sibling whose name extends W', supported, async t => {
  const h = await setup(t);
  h.db.setSetting('global', { hiddenProjects: [h.cwd] });
  h.projects[0].sessions = [{ ...h.claude, folder: encodeProjectPath(h.cwd + '-other') }];
  const shown = await h.writer.applyAndPersistArchived(h.projects, false);
  assert.equal(shown.length, 1, 'encoded worktree sibling must remain visible');
});

for (const kind of ['claude', 'codex']) test(`repository archive recognizes old and undated regrouped ${kind} without writing compatibility state`, supported, async t => {
  const h = await setup(t);
  const archived = { [h.repo]: { ...h.record, knownSessionIds: ['own'] } };
  h.db.setSetting('archivedProjects', archived);
  const session = h[kind];
  h.projects[0].sessions = [h.own, session];
  assert.deepEqual(await h.writer.applyAndPersistArchived(h.projects, false), [], 'old regrouped sessions stay archived');
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), archived, 'listing never persists compatibility');
  delete session.modified;
  assert.deepEqual(await h.writer.applyAndPersistArchived(h.projects, false), [], 'undated regrouped sessions stay known on every listing');
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), archived);
  session.created = '2026-11-01T10:00:00Z'; session.modified = '2026-11-21T10:00:00Z';
  assert.equal((await h.writer.applyAndPersistArchived(h.projects, false)).length, 1, 'last activity after archive reopens R');
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), {});
});

test('worktree archive keeps R visible, retires W on new activity, and offers its schedules', supported, async t => {
  const h = await setup(t), file = path.join(h.cwd, 'schedule-nightly.md');
  fs.writeFileSync(file, '---\nname: nightly\nenabled: false\ncron: * * * * *\n---\nhello');
  const archived = { [h.cwd]: { ...h.record, knownSessionIds: ['claude', 'codex'], disabledSchedules: [file] } };
  h.db.setSetting('archivedProjects', archived);
  const shown = await h.writer.applyAndPersistArchived(h.projects, false);
  assert.deepEqual(shown.flatMap(p => p.sessions.map(s => s.sessionId)), ['own'], 'archive W must not archive R');
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), archived);
  h.projects[0].sessions.push({ ...h.codex, sessionId: 'new', modified: '2026-11-21T10:00:00Z' });
  const reopened = await h.writer.applyAndPersistArchived(h.projects, false);
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), {}, 'writer must retire original W key');
  assert.deepEqual(reopened[0].reenableOffer.names, ['nightly']);
  const result = await h.writer.reenableOfferedSchedules(h.repo, encodeProjectPath(h.repo), { reenable: files => ({ enabled: files, failed: [] }), notify() {} });
  assert.deepEqual(result.enabled, [file], 'visible repository offer must reenable W files');
  assert.deepEqual(plain(h.db.getSetting('scheduleReenableOffers')), {});
});

for (const target of ['repo', 'cwd']) test(`explicit unarchive of ${target} works through writer`, supported, async t => {
  const h = await setup(t);
  h.db.setSetting('archivedProjects', { [h[target]]: { ...h.record, knownSessionIds: ['own', 'claude', 'codex'] } });
  await h.writer.applyAndPersistArchived(h.projects, false);
  assert.equal(await h.writer.clearArchivedEntry(null, h[target]), true);
  assert.deepEqual(plain(h.db.getSetting('archivedProjects')), {});
});

for (const layout of ['.worktrees', '.claude-worktrees', '.claude/worktrees', '.work-files/worktrees']) {
  for (const mode of ['hide', 'delete', 'archive']) test(`legacy ${layout} ${mode} retains only its former group membership`, supported, async t => {
    const h = await setup(t);
    const cwd = path.join(h.repo, layout, 'lane');
    fs.mkdirSync(cwd, { recursive: true });
    const claude = { ...h.claude, sourceFolder: encodeProjectPath(cwd), recordedCwd: cwd };
    const codex = { ...h.codex, cwd };
    h.projects[0].sessions = [h.own, claude, codex];
    const both = layout === '.work-files/worktrees';
    const expected = both ? ['own'] : ['own', 'claude'];
    if (mode === 'archive') h.db.setSetting('archivedProjects', { [cwd]: { ...h.record, knownSessionIds: ['codex', 'claude'] } });
    else h.db.setSetting('global', { hiddenProjects: [cwd], hiddenProjectKinds: { [cwd]: mode } });
    const shown = await h.writer.applyAndPersistArchived(h.projects, false);
    assert.deepEqual(shown.flatMap(p => p.sessions.map(s => s.sessionId)), expected, 'legacy W affects only its pre-upgrade runtime group');
    if (mode !== 'archive') {
      h.db.upsertCachedSessions([h.own, { ...claude, folder: encodeProjectPath(cwd) }, { ...codex, projectPath: cwd, folder: 'codex:source' }]);
      cache.init({ PROJECTS_DIR: path.join(h.root, 'projects'), db: h.db, activeSessions: new Map(), getMainWindow: () => null, log: console });
      assert.deepEqual(cache.buildProjectsFromCache(true).flatMap(p => p.sessions.map(s => s.sessionId)).sort(), expected.slice().sort());
    } else if (!both) {
      h.projects[0].sessions.push({ ...claude, sessionId: 'new-claude', modified: '2026-11-21T10:00:00Z' });
      await h.writer.applyAndPersistArchived(h.projects, false);
      assert.ok(h.db.getSetting('archivedProjects')[cwd], 'new Claude session cannot retire a former Codex-only W archive');
    }
  });
}

for (const layout of ['.worktrees', '.claude-worktrees', '.claude/worktrees']) {
  for (const kind of ['hide', 'delete']) test(`missing repository preserves exact Claude ${layout} ${kind}`, supported, async t => {
    const h = await setup(t);
    const repo = path.join(h.root, 'gone'), cwd = path.join(repo, layout, 'lane');
    assert.equal(fs.existsSync(repo), false);
    assert.equal(resolveWorktreePath(cwd), cwd, 'missing R leaves Claude grouped at W');
    const claude = { ...h.claude, folder: encodeProjectPath(cwd), cwd, projectPath: cwd };
    const siblingPath = cwd + '-other';
    const sibling = { ...claude, sessionId: 'sibling', folder: encodeProjectPath(siblingPath), cwd: siblingPath, projectPath: siblingPath };
    assert.equal(projectHiddenMatcher([cwd])(null, cwd, claude), true, 'exact W group must remain hidden with Claude session evidence');
    h.db.setSetting('global', { hiddenProjects: [cwd], hiddenProjectKinds: { [cwd]: kind } });
    const projects = [
      { projectPath: h.repo, sessions: [h.own] },
      { projectPath: cwd, sessions: [claude] },
      { projectPath: siblingPath, sessions: [sibling] },
    ];
    const shown = await h.writer.applyAndPersistArchived(projects, true);
    assert.deepEqual(shown.flatMap(p => p.sessions.map(s => s.sessionId)).sort(), ['own', 'sibling']);
    h.db.upsertCachedSessions([h.own, claude, sibling]);
    cache.init({ PROJECTS_DIR: path.join(h.root, 'projects'), db: h.db, activeSessions: new Map(), getMainWindow: () => null, log: console });
    assert.deepEqual(cache.buildProjectsFromCache(true).flatMap(p => p.sessions.map(s => s.sessionId)).sort(), ['own', 'sibling']);
  });
}
