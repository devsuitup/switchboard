// The main-process side of Archive folder and of the re-enable offer, with
// every effect injected: archive-project, reenable-project-schedules and
// dismiss-schedule-reenable-offer in main.js only wire these.
// See .ai/contexts/session-cache.md ("Archived projects").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  archivedEntry, archiveProjectFolders, reenableOfferedSchedules, dismissReenableOffer,
} = require('../archived-projects');

const A = '/p/.claude/commands/schedule-a.md';
const B = '/p/.claude/commands/schedule-b.md';

function harness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-archive-assembly-'));
  const settings = { ...(overrides.settings || {}) };
  const calls = { setEnabled: [], refreshFolder: [], notify: 0, writes: [] };
  const deps = {
    isInitialScanComplete: () => true,
    plan: () => [],
    setEnabled: (filePath, enabled, opts) => {
      calls.setEnabled.push({ filePath, enabled, projectRoot: opts.projectRoot, entryAtCall: settings.archivedProjects });
      return { ok: true };
    },
    readEnabled: () => undefined,
    getAllCached: () => [],
    resolveFolderDir: (folder) => path.join(root, folder),
    refreshFolder: (folder) => { calls.refreshFolder.push(folder); },
    buildProjects: () => [],
    activeSessions: new Map(),
    getSetting: (k) => (k in settings ? settings[k] : null),
    setSetting: (k, v) => { calls.writes.push(k); settings[k] = JSON.parse(JSON.stringify(v)); },
    notify: () => { calls.notify++; },
    now: () => 'T1',
    ...overrides.deps,
  };
  return { root, settings, calls, deps, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const group = (projectPath, folderKey = '-p') => ({ projectPath, folderKey });
const schedule = (name, filePath, disableable = true) => ({ name, filePath, disableable });

test('archive assembly: only confirmed, disableable schedules are disabled', () => {
  const h = harness({ deps: { plan: () => [schedule('a', A), schedule('b', B), schedule('c', '/p/c', false)] } });
  try {
    const res = archiveProjectFolders([group('/p')], { disableSchedules: [A, '/p/c'] }, h.deps);
    assert.deepEqual(h.calls.setEnabled.map(c => [c.filePath, c.enabled]), [[A, false]]);
    assert.deepEqual(res, { ok: true, disabled: ['a'], failed: [] });
    assert.deepEqual(h.settings.archivedProjects[archivedEntry(null, '/p')].disabledSchedules, [A]);
  } finally { h.cleanup(); }
});

test('archive assembly: each schedule is disabled against its own group\'s root', () => {
  const plan = ([g]) => [schedule(g.projectPath, g.projectPath + '/.claude/commands/schedule-x.md')];
  const h = harness({ deps: { plan } });
  try {
    archiveProjectFolders([group('/p', '-p'), group('/q', '-q')],
      { disableSchedules: ['/p/.claude/commands/schedule-x.md', '/q/.claude/commands/schedule-x.md'] }, h.deps);
    assert.deepEqual(h.calls.setEnabled.map(c => [c.filePath, c.projectRoot]), [
      ['/p/.claude/commands/schedule-x.md', '/p'],
      ['/q/.claude/commands/schedule-x.md', '/q'],
    ]);
  } finally { h.cleanup(); }
});

test('archive assembly: a refused or throwing disable is reported and not recorded, the others go on', () => {
  const setEnabled = (filePath) => {
    if (filePath === A) return { ok: false, error: 'linked file or directory' };
    if (filePath === B) throw new Error('EACCES');
    return { ok: true };
  };
  const h = harness({ deps: { setEnabled, plan: () => [schedule('a', A), schedule('b', B), schedule('c', '/p/c')] } });
  try {
    const res = archiveProjectFolders([group('/p')], { disableSchedules: [A, B, '/p/c'] }, h.deps);
    assert.deepEqual(res.failed, [{ name: 'a', error: 'linked file or directory' }, { name: 'b', error: 'EACCES' }]);
    assert.deepEqual(res.disabled, ['c']);
    assert.deepEqual(h.settings.archivedProjects[archivedEntry(null, '/p')].disabledSchedules, ['/p/c']);
  } finally { h.cleanup(); }
});

test('archive assembly: known ids come from the listing, the running sessions and the transcripts on disk, after a re-index', () => {
  const h = harness({
    deps: {
      getAllCached: () => [
        { folder: '-p-legacy', projectPath: '/p' },
        { folder: 'box::-p', projectPath: '/p' },
        { folder: '-q', projectPath: '/q' },
      ],
      buildProjects: () => [{ projectPath: '/p', remoteAlias: null, sessions: [{ sessionId: 'listed' }] }],
      activeSessions: new Map([['running', { projectPath: '/p', host: null, realSessionId: 'real' }]]),
    },
  });
  try {
    fs.mkdirSync(path.join(h.root, '-p'));
    fs.writeFileSync(path.join(h.root, '-p', 'on-disk.jsonl'), '');
    fs.writeFileSync(path.join(h.root, '-p', 'notes.txt'), '');
    fs.mkdirSync(path.join(h.root, '-p-legacy'));
    fs.writeFileSync(path.join(h.root, '-p-legacy', 'legacy.jsonl'), '');
    const res = archiveProjectFolders([group('/p')], {}, h.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(h.calls.refreshFolder.sort(), ['-p', '-p-legacy']);
    const record = h.settings.archivedProjects[archivedEntry(null, '/p')];
    assert.deepEqual([...record.knownSessionIds].sort(), ['legacy', 'listed', 'on-disk', 'real', 'running']);
    assert.equal(record.archivedAt, 'T1');
    assert.equal(h.calls.notify, 1);
  } finally { h.cleanup(); }
});

test('archive assembly: malformed groups are ignored', () => {
  const h = harness();
  try {
    archiveProjectFolders([null, { projectPath: 5 }, { projectPath: '' }, { projectPath: '/x', folderKey: 3 }, group('/p')], {}, h.deps);
    assert.deepEqual(Object.keys(h.settings.archivedProjects), [archivedEntry(null, '/p')]);
    assert.deepEqual(archiveProjectFolders('nope', {}, h.deps), { ok: true, disabled: [], failed: [] });
  } finally { h.cleanup(); }
});

test('archive assembly: refused while indexing, with nothing written or disabled', () => {
  const h = harness({ deps: { isInitialScanComplete: () => false, plan: () => [schedule('a', A)] } });
  try {
    assert.deepEqual(archiveProjectFolders([group('/p')], { disableSchedules: [A] }, h.deps), { error: 'indexing' });
    assert.deepEqual(h.calls.setEnabled, []);
    assert.deepEqual(h.calls.writes, []);
  } finally { h.cleanup(); }
});

test('archive assembly: synchronous, and the entry is written before any schedule is disabled', () => {
  const h = harness({ deps: { plan: () => [schedule('a', A)] } });
  try {
    const res = archiveProjectFolders([group('/p')], { disableSchedules: [A] }, h.deps);
    assert.equal(typeof (res && res.then), 'undefined');
    assert.ok(h.calls.setEnabled[0].entryAtCall && h.calls.setEnabled[0].entryAtCall[archivedEntry(null, '/p')],
      'the archived entry must exist when the first schedule is disabled');
  } finally { h.cleanup(); }
});

test('archive assembly: a failure while taking the snapshot disables nothing', () => {
  const h = harness({ deps: { plan: () => [schedule('a', A)], refreshFolder: () => { throw new Error('EIO'); } } });
  try {
    fs.mkdirSync(path.join(h.root, '-p'));
    const res = archiveProjectFolders([group('/p')], { disableSchedules: [A] }, h.deps);
    assert.deepEqual(res, { error: 'EIO', disabled: [] });
    assert.deepEqual(h.calls.setEnabled, []);
  } finally { h.cleanup(); }
});

test('archive assembly: a failure after disabling names what was turned off', () => {
  const h = harness({ deps: { plan: () => [schedule('a', A)] } });
  let archivedWrites = 0;
  const setSetting = h.deps.setSetting;
  h.deps.setSetting = (k, v) => {
    if (k === 'archivedProjects' && ++archivedWrites === 2) throw new Error('SQLITE_BUSY');
    setSetting(k, v);
  };
  try {
    const res = archiveProjectFolders([group('/p')], { disableSchedules: [A] }, h.deps);
    assert.deepEqual(res, { error: 'SQLITE_BUSY', disabled: ['a'] });
  } finally { h.cleanup(); }
});

test('archive assembly: archiving again carries the offered schedules still off, and replaces the offer', () => {
  const entry = archivedEntry(null, '/p');
  const h = harness({
    settings: { scheduleReenableOffers: { [entry]: { archivedAt: 'T0', disabledSchedules: [A, B] }, other: { disabledSchedules: ['/o'] } } },
    deps: { readEnabled: (filePath) => (filePath === A ? 'false' : 'true') },
  });
  try {
    archiveProjectFolders([group('/p')], {}, h.deps);
    assert.deepEqual(h.settings.archivedProjects[entry].disabledSchedules, [A]);
    assert.deepEqual(Object.keys(h.settings.scheduleReenableOffers), ['other']);
  } finally { h.cleanup(); }
});

// --- reenable-project-schedules / dismiss-schedule-reenable-offer ---

function offerHarness(offer, reenable) {
  const entry = archivedEntry(null, '/p');
  const h = harness({ settings: { scheduleReenableOffers: offer ? { [entry]: offer } : {} } });
  h.deps.reenable = reenable || (() => ({ enabled: [], failed: [] }));
  return { ...h, entry };
}

test('re-enable assembly: a full success deletes the offer and refreshes the sidebar', () => {
  const seen = [];
  const h = offerHarness({ archivedAt: 'T0', disabledSchedules: [A] }, (files, root) => { seen.push([files, root]); return { enabled: ['a'], failed: [] }; });
  try {
    const res = reenableOfferedSchedules('/p', '-p', h.deps);
    assert.deepEqual(seen, [[[A], '/p']]);
    assert.deepEqual(res, { ok: true, enabled: ['a'], failed: [] });
    assert.deepEqual(h.settings.scheduleReenableOffers, {});
    assert.equal(h.calls.notify, 1);
  } finally { h.cleanup(); }
});

test('re-enable assembly: failures stay in the offer, with their errors', () => {
  const h = offerHarness({ archivedAt: 'T0', disabledSchedules: [A, B] },
    () => ({ enabled: ['a'], failed: [{ name: 'b', filePath: B, error: 'linked file or directory' }] }));
  try {
    const res = reenableOfferedSchedules('/p', '-p', h.deps);
    assert.deepEqual(res.failed, [{ name: 'b', error: 'linked file or directory' }]);
    assert.deepEqual(h.settings.scheduleReenableOffers[h.entry], {
      archivedAt: 'T0', disabledSchedules: [B], failed: [{ name: 'b', error: 'linked file or directory' }],
    });
  } finally { h.cleanup(); }
});

test('re-enable assembly: no offer, nothing to do; a malformed path is refused', () => {
  let called = 0;
  const h = offerHarness(null, () => { called++; return { enabled: [], failed: [] }; });
  try {
    assert.deepEqual(reenableOfferedSchedules('/p', '-p', h.deps), { ok: true, enabled: [], failed: [] });
    assert.equal(reenableOfferedSchedules(5, '-p', h.deps).error, 'invalid project path');
    assert.equal(reenableOfferedSchedules('', '-p', h.deps).error, 'invalid project path');
    assert.equal(called, 0);
  } finally { h.cleanup(); }
});

test('dismiss assembly: deletes the folder\'s offer only; a malformed path is refused', () => {
  const h = offerHarness({ archivedAt: 'T0', disabledSchedules: [A] });
  h.settings.scheduleReenableOffers.other = { disabledSchedules: ['/o'] };
  try {
    assert.deepEqual(dismissReenableOffer('/p', '-p', h.deps), { ok: true });
    assert.deepEqual(Object.keys(h.settings.scheduleReenableOffers), ['other']);
    assert.equal(h.calls.notify, 1);
    assert.equal(dismissReenableOffer(null, '-p', h.deps).error, 'invalid project path');
  } finally { h.cleanup(); }
});
