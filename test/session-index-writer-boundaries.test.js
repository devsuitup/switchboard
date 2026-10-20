'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function characterize(name, scenario) {
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-boundaries-6166-'));
    try {
      const result = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const fs = require('node:fs');
        const { createSessionIndexWriter } = require('./session-index-writer');
        const { archivedEntry } = require('./archived-projects');
        const { encodeProjectPath } = require('./encode-project-path');
        const root = process.env.SWITCHBOARD_DATA_DIR;
        const project = path.join(root, 'project');
        const other = path.join(root, 'other');
        const folder = encodeProjectPath(project);
        const entry = archivedEntry(null, project);
        const otherEntry = archivedEntry(null, other);
        const writer = createSessionIndexWriter();
        (async () => {
          try { await writer.ready; const db = require('./db'); ${scenario} }
          finally { await writer.closeDb(); }
          console.log('boundary verified');
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /boundary verified/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

characterize('global field patches preserve accepted working-set and bounds changes', `
  await writer.setSetting('global', { openWorkingSet: ['original'], activityReporting: true });
  const bounds = writer.patchGlobal({ windowBounds: { x: 20, y: 30 } });
  const tabs = writer.patchGlobal({ openWorkingSet: ['latest'] });
  await Promise.all([bounds, tabs]);
  assert.deepEqual(db.getSetting('global'), {
    openWorkingSet: ['latest'], activityReporting: true, windowBounds: { x: 20, y: 30 },
  });
`);

characterize('rename of a missing cache row preserves metadata without creating a search body', `
  await writer.renameSession('missing', 'new title');
  assert.equal(db.getMeta('missing').name, 'new title');
  assert.equal(db.getCachedSession('missing'), null);
  assert.equal(db.searchByType('session', 'new title').length, 0);
  await writer.renameSession('missing', '');
  assert.equal(db.getMeta('missing').name, null);
`);

characterize('star and archive commands retain a name and return the existing value shapes', `
  await writer.renameSession('metadata', 'kept name');
  assert.equal(await writer.toggleStar('metadata'), 1);
  assert.equal(await writer.toggleStar('metadata'), 0);
  assert.equal(await writer.setArchived('metadata', true), undefined);
  assert.equal(await writer.setArchived('metadata', false), undefined);
  assert.deepEqual(db.getMeta('metadata'), {
    sessionId: 'metadata', name: 'kept name', starred: 0, archived: 0,
  });
`);

characterize('unhide retires only its archive into an offer and preserves unrelated global fields', `
  const schedule = path.join(root, 'schedule.md');
  await writer.setSetting('global', { hiddenProjects: [entry, otherEntry],
    hiddenProjectKinds: { [entry]: 'archive', [otherEntry]: 'delete' }, openWorkingSet: ['kept'] });
  await writer.setSetting('archivedProjects', {
    [entry]: { archivedAt: 12, knownSessionIds: ['old'], disabledSchedules: [schedule] },
    [otherEntry]: { archivedAt: 13 },
  });
  await writer.setSetting('scheduleReenableOffers', { [otherEntry]: { disabledSchedules: ['other.md'] } });
  await writer.unhideProject(entry, null, project);
  assert.deepEqual(db.getSetting('global'), { hiddenProjects: [otherEntry],
    hiddenProjectKinds: { [otherEntry]: 'delete' }, openWorkingSet: ['kept'] });
  assert.deepEqual(db.getSetting('archivedProjects'), { [otherEntry]: { archivedAt: 13 } });
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
    [entry]: { archivedAt: 12, disabledSchedules: [schedule] },
    [otherEntry]: { disabledSchedules: ['other.md'] },
  });
`);

characterize('hide deduplicates visibility entries and updates the kind without losing settings', `
  await writer.setSetting('global', { hiddenProjects: [otherEntry], openWorkingSet: ['kept'] });
  await writer.hideProject(entry, 'archive');
  await writer.hideProject(entry, 'archive');
  await writer.hideProject(entry, 'delete');
  assert.deepEqual(db.getSetting('global'), { hiddenProjects: [otherEntry, entry],
    hiddenProjectKinds: { [entry]: 'delete' }, openWorkingSet: ['kept'] });
`);

characterize('add reveals the local project while preserving the same path on a remote host', `
  const remoteEntry = archivedEntry('host', project.replaceAll('\\\\', '/'));
  await writer.setSetting('global', { hiddenProjects: [project, remoteEntry],
    hiddenProjectKinds: { [project]: 'archive', [remoteEntry]: 'archive' }, openWorkingSet: ['kept'] });
  await writer.setSetting('archivedProjects', { [entry]: { archivedAt: 10 }, [remoteEntry]: { archivedAt: 11 } });
  await writer.revealAddedProject(project);
  assert.deepEqual(db.getSetting('global'), { hiddenProjects: [remoteEntry],
    hiddenProjectKinds: { [remoteEntry]: 'archive' }, openWorkingSet: ['kept'] });
  assert.deepEqual(db.getSetting('archivedProjects'), { [remoteEntry]: { archivedAt: 11 } });
`);

characterize('archive reappearance retires only groups with a new unarchived parent', `
  await writer.setSetting('archivedProjects', { [entry]: { archivedAt: 10, knownSessionIds: ['known'] },
    [otherEntry]: { archivedAt: 11, knownSessionIds: ['other-known'] } });
  const projects = [
    { projectPath: project, sessions: [{ sessionId: 'known' }, { sessionId: 'new-parent' }] },
    { projectPath: other, sessions: [{ sessionId: 'other-known' }, { sessionId: 'child', parentSessionId: 'other-known' }] },
  ];
  const visible = await writer.applyAndPersistArchived(projects, false);
  assert.deepEqual(visible.map(p => p.projectPath), [project]);
  assert.deepEqual(db.getSetting('archivedProjects'), { [otherEntry]: { archivedAt: 11, knownSessionIds: ['other-known'] } });
`);

characterize('reenable completion retains failed schedules and preserves another offer', `
  const first = path.join(root, 'first.md');
  const second = path.join(root, 'second.md');
  await writer.setSetting('scheduleReenableOffers', {
    [entry]: { archivedAt: 20, disabledSchedules: [first, second] },
    [otherEntry]: { disabledSchedules: ['other.md'] },
  });
  let notifications = 0;
  const result = await writer.reenableOfferedSchedules(project, folder, {
    notify: () => { notifications++; },
    reenable: (files, target) => {
      assert.deepEqual(files, [first, second]);
      assert.equal(target, project);
      return { enabled: ['first'], failed: [{ name: 'second', filePath: second, error: 'write denied' }] };
    },
  });
  assert.deepEqual(result, { ok: true, enabled: ['first'], failed: [{ name: 'second', error: 'write denied' }] });
  assert.equal(notifications, 1);
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
    [entry]: { archivedAt: 20, disabledSchedules: [second], failed: [{ name: 'second', error: 'write denied' }] },
    [otherEntry]: { disabledSchedules: ['other.md'] },
  });
`);

characterize('offer dismissal targets one entry and invalid input changes nothing', `
  const offers = { [entry]: { disabledSchedules: ['first.md'] }, [otherEntry]: { disabledSchedules: ['other.md'] } };
  await writer.setSetting('scheduleReenableOffers', offers);
  let notifications = 0;
  const deps = { notify: () => { notifications++; } };
  assert.deepEqual(await writer.dismissReenableOffer('', folder, deps), { error: 'invalid project path' });
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), offers);
  assert.deepEqual(await writer.dismissReenableOffer(project, folder, deps), { ok: true });
  assert.equal(notifications, 1);
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), { [otherEntry]: offers[otherEntry] });
`);

characterize('remote folder removal deletes cache metrics and search while retaining another repair gate', `
  const remoteFolder = 'host:' + folder;
  await writer.upsertCachedSessions([{ sessionId: 'remote', folder: remoteFolder, projectPath: project },
    { sessionId: 'other', folder: 'other-folder', projectPath: other }]);
  await writer.replaceSessionMetrics('remote', [{ date: '2026-10-15', model: 'fixture', messageCount: 3 }]);
  await writer.replaceSessionMetrics('other', [{ date: '2026-10-15', model: 'fixture', messageCount: 7 }]);
  await writer.upsertSearchEntries([{ id: 'remote', type: 'session', folder: remoteFolder, title: 'remotetitle', body: 'remotebody' }]);
  await writer.setSetting('bridge_uuid_reindex_folders', [remoteFolder, 'other-folder']);
  await writer.dropRemoteFolder(remoteFolder);
  assert.equal(db.getCachedSession('remote'), null);
  assert.equal(db.getCachedSession('other').sessionId, 'other');
  assert.equal(db.searchByType('session', 'remotebody').length, 0);
  assert.equal(db.getTotalCounts().totalMessages, 7);
  assert.deepEqual(db.getSetting('bridge_uuid_reindex_folders'), ['other-folder']);
`);

characterize('registry normalizes its seed once and merges later adds and removes against current state', `
  let seeds = 0;
  const registry = writer.scheduleRegistry(() => { seeds++; return [project, project, other]; });
  assert.deepEqual(await registry.list(), [project, other]);
  const extra = path.join(root, 'extra');
  await registry.add(extra);
  await registry.add(project);
  await registry.add('relative-path');
  await registry.remove(other);
  assert.deepEqual(await registry.list(), [project, extra]);
  assert.equal(seeds, 1);
  assert.deepEqual(db.getSetting('scheduleProjects'), [project, extra]);
`);

characterize('Whats New startup and dismissal patch the current global setting', `
  const readChangelog = () => '## v0.0.95 — 2026-10-15\\n\\n- Fixture change.\\n';
  const whatsNew = writer.createWhatsNew({ currentVersion: '0.0.95', existingInstall: false,
    readChangelog, log: { warn() {} } });
  await writer.setSetting('global', { openWorkingSet: ['kept'] });
  assert.equal(await whatsNew.startup(), null);
  assert.deepEqual(db.getSetting('global'), { openWorkingSet: ['kept'], lastSeenVersion: '0.0.95' });
  await writer.patchGlobal({ windowBounds: { x: 50 } });
  await whatsNew.dismissed();
  assert.deepEqual(db.getSetting('global'), { openWorkingSet: ['kept'], lastSeenVersion: '0.0.95', windowBounds: { x: 50 } });
  assert.equal(whatsNew.forMenu().sections[0].version, '0.0.95');
`);

characterize('remap records an independent folder key and rewrites only matching transcript cwd values', `
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(transcripts);
  const file = path.join(transcripts, 'session.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ cwd: project, type: 'user' }),
    JSON.stringify({ cwd: other, type: 'user' }), 'malformed'].join('\\n') + '\\n');
  await writer.setSetting('projectRemaps', { 'other-folder': other });
  await writer.remapProjectTranscripts({ folder, folderPath: transcripts, oldPath: project, newPath: root });
  assert.deepEqual(db.getSetting('projectRemaps'), { 'other-folder': other, [folder]: root });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\\n');
  assert.equal(JSON.parse(lines[0]).cwd, root);
  assert.equal(JSON.parse(lines[1]).cwd, other);
  assert.equal(lines[2], 'malformed');
  assert.equal(fs.existsSync(file + '.tmp'), false);
`);

characterize('archive records known parents and only successful schedule disables', `
  const first = path.join(project, '.claude', 'commands', 'first.md');
  const second = path.join(project, '.claude', 'commands', 'second.md');
  await writer.setInitialScanComplete();
  await writer.setSetting('archivedProjects', { [otherEntry]: { archivedAt: 9 } });
  const cache = { resolveFolderDir: () => null, refreshFolder() {},
    buildProjectsFromCache: () => [{ projectPath: project, sessions: [
      { sessionId: 'parent' }, { sessionId: 'child', parentSessionId: 'parent' },
    ] }] };
  const archivalWriter = writer.withCache(cache);
  await archivalWriter.ready;
  let notifications = 0;
  const result = await archivalWriter.archiveProjectFolders([{ projectPath: project, folderKey: folder }],
    { disableSchedules: [first, second] }, {
      seedProjects: () => [project], mergeProjects: projects => projects, activeSessions: new Map(),
      now: () => 30, notify: () => { notifications++; }, realpath: value => value,
      scan: () => [{ name: 'first', filePath: first }, { name: 'second', filePath: second }],
      setEnabled: (file, enabled, options) => {
        assert.equal(enabled, false);
        assert.equal(options.projectRoot, project);
        return file === first ? { ok: true } : { ok: false, error: 'write denied' };
      },
    });
  assert.deepEqual(result, { ok: true, archivedAt: 30, disabled: ['first'], failed: [{ name: 'second', error: 'write denied' }] });
  assert.equal(notifications, 1);
  assert.deepEqual(db.getSetting('archivedProjects'), {
    [otherEntry]: { archivedAt: 9 },
    [entry]: { archivedAt: 30, knownSessionIds: ['parent'], disabledSchedules: [first],
      disabledByArchive: [first], priorOffer: null },
  });
`);

characterize('worktree cleanup retires offers and removes matching rows outside its encoded folder', `
  const schedule = path.join(root, 'schedule.md');
  await writer.upsertCachedSessions([{ sessionId: 'removed', folder: 'legacy-folder', projectPath: project },
    { sessionId: 'survivor', folder: 'other-folder', projectPath: other }]);
  await writer.replaceSessionMetrics('removed', [{ date: '2026-10-15', model: 'fixture', messageCount: 3 }]);
  await writer.upsertSearchEntries([{ id: 'removed', type: 'session', folder: 'legacy-folder', title: 'removedtitle', body: 'removedbody' }]);
  await writer.setSetting('global', { hiddenProjects: [project, other],
    hiddenProjectKinds: { [project]: 'archive', [other]: 'delete' }, openWorkingSet: ['kept'] });
  await writer.setSetting('archivedProjects', { [entry]: { archivedAt: 40, disabledSchedules: [schedule] } });
  assert.equal(await writer.cleanupWorktree(project, { warn() { throw new Error('unexpected cleanup failure'); } }), 1);
  assert.equal(db.getCachedSession('removed'), null);
  assert.equal(db.getCachedSession('survivor').sessionId, 'survivor');
  assert.equal(db.getTotalCounts().totalMessages, 0);
  assert.equal(db.searchByType('session', 'removedbody').length, 0);
  assert.deepEqual(db.getSetting('global'), { hiddenProjects: [other],
    hiddenProjectKinds: { [other]: 'delete' }, openWorkingSet: ['kept'] });
  assert.deepEqual(db.getSetting('archivedProjects'), {});
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
    [entry]: { archivedAt: 40, disabledSchedules: [schedule] },
  });
`);
