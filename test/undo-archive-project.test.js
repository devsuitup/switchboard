'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const archive = require('../archived-projects');
const { createWriterCommands } = require('../session-index-commands');
const { createSessionIndexWriter } = require('../session-index-writer');
const { setScheduleEnabled, parseFrontmatter } = require('../schedule-runner');

const group = (projectPath, folderKey = '-p') => ({ projectPath, folderKey });
const entry = archive.archivedEntry(null, '/p');
const X = '/p/.claude/commands/schedule-x.md';
const Y = '/p/.claude/commands/schedule-y.md';
const Z = '/p/.claude/commands/schedule-z.md';
const priorOffer = { archivedAt: 'T0', disabledSchedules: [Y], failed: [{ name: 'y', error: 'EACCES' }] };

function fixture() {
  const settings = { scheduleReenableOffers: { [entry]: structuredClone(priorOffer), other: { disabledSchedules: ['other'] } } };
  const files = new Map([[X, 'true'], [Y, 'false'], [Z, 'false']]);
  const writes = [], enabledCalls = [];
  let notifications = 0;
  const deps = {
    getSetting: key => structuredClone(settings[key] ?? null),
    setSetting: (key, value) => { writes.push(key); settings[key] = structuredClone(value); },
    isInitialScanComplete: () => true,
    getAllCached: () => [], resolveFolderDir: () => null, refreshFolder() {},
    buildProjects: () => [], activeSessions: new Map(), now: () => 'T1',
    readEnabled: file => files.get(file),
    plan: () => [{ name: 'x', filePath: X, disableable: true }],
    setEnabled: (file, value) => { files.set(file, String(value)); return { ok: true }; },
    reenable: (paths, root) => {
      enabledCalls.push([paths, root]);
      for (const file of paths) files.set(file, 'true');
      return { enabled: paths.map(file => path.basename(file)), failed: [] };
    },
    notify: () => { notifications++; },
  };
  const runArchive = () => archive.archiveProjectFolders([group('/p')], { disableSchedules: [X] }, deps);
  return { settings, files, writes, enabledCalls, deps, runArchive, notifications: () => notifications };
}

test('folder Undo: Archive records its timestamp, exact disables and consumed prior offer', () => {
  const h = fixture();
  const result = h.runArchive();
  assert.equal(result.archivedAt, 'T1');
  assert.deepEqual(h.settings.archivedProjects[entry].disabledByArchive, [X]);
  assert.deepEqual(h.settings.archivedProjects[entry].priorOffer, priorOffer);
  assert.deepEqual(h.settings.archivedProjects[entry].disabledSchedules, [Y, X]);
});

test('folder Undo: re-enables exactly this Archive disables, preserving offered and user-disabled files', () => {
  const h = fixture();
  h.runArchive();
  const result = archive.undoArchiveProjectFolders([group('/p')], 'T1', h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(h.enabledCalls, [[[X], '/p']]);
  assert.deepEqual([...h.files], [[X, 'true'], [Y, 'false'], [Z, 'false']]);
  assert.equal(h.notifications(), 2);
});

test('folder Undo: restores the full prior offer without offering newly disabled X', () => {
  const h = fixture();
  h.runArchive();
  archive.undoArchiveProjectFolders([group('/p')], 'T1', h.deps);
  assert.deepEqual(h.settings.archivedProjects, {});
  assert.deepEqual(h.settings.scheduleReenableOffers, { [entry]: priorOffer, other: { disabledSchedules: ['other'] } });
});

test('folder Undo: no prior offer means removal without creating a re-enable offer', () => {
  const h = fixture();
  delete h.settings.scheduleReenableOffers[entry];
  h.runArchive();
  assert.equal(h.settings.archivedProjects[entry].priorOffer, null);
  archive.undoArchiveProjectFolders([group('/p')], 'T1', h.deps);
  assert.deepEqual(h.settings.scheduleReenableOffers, { other: { disabledSchedules: ['other'] } });
});

test('folder Undo: a later Archive refuses stale Undo with no settings, file or notification effects', () => {
  const h = fixture();
  h.runArchive();
  h.deps.now = () => 'T2';
  h.runArchive();
  const before = structuredClone(h.settings), writes = h.writes.length, notifications = h.notifications();
  const result = archive.undoArchiveProjectFolders([group('/p')], 'T1', h.deps);
  assert.match(result.error, /stale/i);
  assert.deepEqual(h.settings, before);
  assert.equal(h.writes.length, writes);
  assert.equal(h.notifications(), notifications);
  assert.deepEqual(h.enabledCalls, []);
});

test('folder Undo: checks every parent and worktree record before any effect, including retired entries', () => {
  for (const record of [undefined, { archivedAt: 'T2' }]) {
    const h = fixture();
    h.runArchive();
    const child = group('/p/.claude/worktrees/child');
    const key = archive.archivedEntry(null, child.projectPath);
    if (record) h.settings.archivedProjects[key] = record;
    const before = structuredClone(h.settings), writes = h.writes.length;
    assert.match(archive.undoArchiveProjectFolders([group('/p'), child], 'T1', h.deps).error, /stale/i);
    assert.deepEqual(h.settings, before);
    assert.equal(h.writes.length, writes);
    assert.deepEqual(h.enabledCalls, []);
  }
});

test('folder Undo: parent and worktree reverse together with their own roots and prior offers', () => {
  const h = fixture();
  h.runArchive();
  const child = group('/p/.claude/worktrees/child');
  const key = archive.archivedEntry(null, child.projectPath);
  h.settings.archivedProjects[key] = { archivedAt: 'T1', disabledByArchive: ['child.md'], priorOffer: { disabledSchedules: ['old.md'] } };
  h.settings.archivedProjects.other = { archivedAt: 'T0' };
  archive.undoArchiveProjectFolders([group('/p'), child], 'T1', h.deps);
  assert.deepEqual(h.settings.archivedProjects, { other: { archivedAt: 'T0' } });
  assert.deepEqual(h.enabledCalls, [[[X], '/p'], [['child.md'], child.projectPath]]);
  assert.deepEqual(h.settings.scheduleReenableOffers[key], { disabledSchedules: ['old.md'] });
});

test('folder Undo: remote entries stay scoped to their host', () => {
  const h = fixture();
  h.runArchive();
  const remote = archive.archivedEntry('box', '/p');
  h.settings.archivedProjects[remote] = { archivedAt: 'T1', disabledByArchive: [], priorOffer: null };
  archive.undoArchiveProjectFolders([group('/p', 'box::-p')], 'T1', h.deps);
  assert.ok(h.settings.archivedProjects[entry]);
  assert.equal(h.settings.archivedProjects[remote], undefined);
  assert.deepEqual(h.enabledCalls, [[[], '/p']]);
});

test('folder Undo: malformed groups and missing timestamp cannot partially undo a valid group', () => {
  const h = fixture();
  h.runArchive();
  for (const groups of [null, [], [null], [group('/p'), { projectPath: 7 }]]) {
    assert.ok(archive.undoArchiveProjectFolders(groups, 'T1', h.deps).error);
  }
  assert.ok(archive.undoArchiveProjectFolders([group('/p')], undefined, h.deps).error);
  assert.ok(h.settings.archivedProjects[entry]);
  assert.deepEqual(h.enabledCalls, []);
});

test('folder Undo: changed and deleted files are left alone by the real re-enable helper', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-undo-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = path.join(root, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const files = ['off', 'edited', 'gone'].map(name => path.join(commands, `schedule-${name}.md`));
  const content = name => `---\nname: ${name}\ncron: 0 * * * *\nenabled: false\n---\nPrompt\n`;
  for (const [i, file] of files.entries()) fs.writeFileSync(file, content(['off', 'edited', 'gone'][i]));
  fs.writeFileSync(files[1], content('edited').replace('enabled: false', 'enabled: true'));
  fs.unlinkSync(files[2]);
  const userDisabled = path.join(commands, 'schedule-user-disabled.md');
  fs.writeFileSync(userDisabled, content('user-disabled'));
  const h = fixture();
  const key = archive.archivedEntry(null, root);
  h.settings.archivedProjects = { [key]: { archivedAt: 'T1', disabledByArchive: files, priorOffer: null } };
  delete h.deps.reenable;
  const editedBefore = fs.statSync(files[1]).mtimeMs;
  const result = archive.undoArchiveProjectFolders([group(root)], 'T1', h.deps);
  assert.deepEqual(result, { ok: true, enabled: ['off'], failed: [] });
  assert.match(fs.readFileSync(files[0], 'utf8'), /enabled: true/);
  assert.equal(fs.statSync(files[1]).mtimeMs, editedBefore);
  assert.equal(fs.existsSync(files[2]), false);
  assert.match(fs.readFileSync(userDisabled, 'utf8'), /enabled: false/);
});

test('folder Undo: re-enable failures are returned without inventing an offer', () => {
  const h = fixture();
  h.runArchive();
  h.deps.reenable = () => ({ enabled: [], failed: [{ name: 'x', filePath: X, error: 'linked file or directory' }] });
  assert.deepEqual(archive.undoArchiveProjectFolders([group('/p')], 'T1', h.deps), {
    ok: true, enabled: [], failed: [{ name: 'x', error: 'linked file or directory' }],
  });
  assert.deepEqual(h.settings.scheduleReenableOffers[entry], priorOffer);
});

function writerFixture() {
  const h = fixture();
  const commands = createWriterCommands(h.deps);
  const requests = [];
  const client = { ready: Promise.resolve(), request: async (name, ...args) => {
    requests.push(name);
    return commands[name](...args);
  } };
  const backend = { ...h.deps, searchFtsRecreated: false };
  const cache = { buildProjectsFromCache: () => [], resolveFolderDir: () => null };
  const writer = createSessionIndexWriter({ client, readonlyBackend: backend }, cache);
  h.deps.mergeProjects = projects => projects;
  h.deps.seedProjects = () => [];
  h.deps.scan = () => [];
  return { ...h, commands, requests, writer };
}

test('folder Undo writer: Archive disables X while prior offered Y stays disabled through Undo', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-undo-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = path.join(root, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const [x, y, z] = ['x', 'y', 'z'].map(name => path.join(commands, `schedule-${name}.md`));
  for (const [name, file, enabled] of [['x', x, true], ['y', y, false], ['z', z, false]]) {
    fs.writeFileSync(file, `---\nname: ${name}\ncron: 0 * * * *\nenabled: ${enabled}\n---\nPrompt\n`);
  }
  const key = archive.archivedEntry(null, root);
  const offer = { ...priorOffer, disabledSchedules: [y] };
  const h = writerFixture();
  h.settings.scheduleReenableOffers = { [key]: structuredClone(offer), other: { disabledSchedules: ['other'] } };
  h.deps.seedProjects = () => [root];
  h.deps.scan = () => [{ name: 'x', filePath: x }, { name: 'y', filePath: y }, { name: 'z', filePath: z }];
  h.deps.realpath = fs.realpathSync;
  h.deps.setEnabled = setScheduleEnabled;
  delete h.deps.reenable;
  const enabled = file => parseFrontmatter(fs.readFileSync(file, 'utf8')).meta.enabled;
  const archived = await h.writer.archiveProjectFolders([group(root)], { disableSchedules: [x] }, h.deps);
  assert.deepEqual(archived, { ok: true, archivedAt: 'T1', disabled: ['x'], failed: [] });
  assert.deepEqual(h.requests.filter(name => /^(begin|complete)Archive$/.test(name)), ['beginArchive', 'completeArchive']);
  assert.deepEqual(h.settings.archivedProjects[key], {
    archivedAt: 'T1', knownSessionIds: [], disabledSchedules: [y, x], disabledByArchive: [x], priorOffer: offer,
  });
  assert.equal(h.settings.scheduleReenableOffers[key], undefined);
  assert.deepEqual([x, y, z].map(enabled), ['false', 'false', 'false']);
  const yBefore = fs.readFileSync(y, 'utf8'), zBefore = fs.readFileSync(z, 'utf8');
  const undone = await h.writer.undoArchiveProjectFolders([group(root)], archived.archivedAt, h.deps);
  assert.deepEqual(undone, { ok: true, enabled: ['x'], failed: [] });
  assert.deepEqual([x, y, z].map(enabled), ['true', 'false', 'false']);
  assert.equal(fs.readFileSync(y, 'utf8'), yBefore);
  assert.equal(fs.readFileSync(z, 'utf8'), zBefore);
  assert.deepEqual(h.settings.archivedProjects, {});
  assert.deepEqual(h.settings.scheduleReenableOffers, { [key]: offer, other: { disabledSchedules: ['other'] } });
  assert.equal(h.notifications(), 2);
});

for (const useWriter of [false, true]) {
  test(`folder Undo${useWriter ? ' writer' : ''}: legacy records refuse Undo without any effects`, async () => {
    for (const legacyIndex of [0, 1]) {
      const h = useWriter ? writerFixture() : fixture();
      h.runArchive();
      const child = group('/p/.claude/worktrees/child');
      const childEntry = archive.archivedEntry(null, child.projectPath);
      h.settings.archivedProjects[childEntry] = {
        archivedAt: 'T1', disabledSchedules: ['child.md'], disabledByArchive: ['child.md'], priorOffer: null,
      };
      delete h.settings.archivedProjects[[entry, childEntry][legacyIndex]].disabledByArchive;
      const before = structuredClone(h.settings), filesBefore = [...h.files];
      const writes = h.writes.length, notifications = h.notifications();
      const groups = [group('/p'), child];
      const result = useWriter
        ? await h.writer.undoArchiveProjectFolders(groups, 'T1', h.deps)
        : archive.undoArchiveProjectFolders(groups, 'T1', h.deps);
      assert.deepEqual(result, { error: 'stale archive Undo' });
      assert.deepEqual(h.settings, before);
      assert.deepEqual([...h.files], filesBefore);
      assert.equal(h.writes.length, writes);
      assert.equal(h.notifications(), notifications);
      assert.deepEqual(h.enabledCalls, []);
    }
  });
}

test('folder Undo writer: archive command records exact successful disables and the consumed offer', async () => {
  const h = writerFixture();
  const result = await h.writer.archiveProjectFolders([group('/p')], {}, h.deps);
  assert.equal(result.archivedAt, 'T1');
  assert.deepEqual(h.settings.archivedProjects[entry].disabledByArchive, []);
  assert.deepEqual(h.settings.archivedProjects[entry].priorOffer, priorOffer);
  const records = h.commands.beginArchive([{ entry, record: { archivedAt: 'T2' }, disabledFiles: [] }]);
  h.commands.completeArchive(records, { [entry]: [X] });
  assert.deepEqual(h.settings.archivedProjects[entry].disabledByArchive, [X]);
});

test('folder Undo writer: validates and restores on the writer before main applies exact file effects', async () => {
  const h = writerFixture();
  h.runArchive();
  const reenable = h.deps.reenable;
  h.deps.reenable = (files, root) => {
    assert.equal(h.settings.archivedProjects[entry], undefined);
    assert.deepEqual(h.settings.scheduleReenableOffers[entry], priorOffer);
    return reenable(files, root);
  };
  const result = await h.writer.undoArchiveProjectFolders([group('/p')], 'T1', h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(h.enabledCalls, [[[X], '/p']]);
  assert.ok(h.requests.includes('undoArchiveProjectFolders'));
  const before = structuredClone(h.settings);
  assert.match((await h.writer.undoArchiveProjectFolders([group('/p')], 'T1', h.deps)).error, /stale/i);
  assert.deepEqual(h.settings, before);
  assert.equal(h.enabledCalls.length, 1);
});

test('folder Undo IPC: preload forwards both arguments and main returns the writer response', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    process: { platform: 'win32', argv: [], env: {} },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); } } }),
  });
  const groups = [group('/p')];
  api.undoArchiveProject(groups, 'T1');
  assert.deepEqual(calls, [['undo-archive-project', groups, 'T1']]);
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('archive-project',");
  const end = source.indexOf("ipcMain.handle('dismiss-schedule-reenable-offer',", start);
  const response = { ok: true, archivedAt: 'T1', disabled: [], failed: [] };
  const undoResponse = { ok: true, enabled: ['x'], failed: [] };
  const deps = {};
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, archiveDeps: () => deps,
    writer: {
      archiveProjectFolders: async () => response,
      undoArchiveProjectFolders: async (...args) => { assert.deepEqual(args, [groups, 'T1', deps]); return undoResponse; },
    }, log: { info() {}, warn() {} },
  });
  assert.equal(await handlers.get('archive-project')(null, groups, {}), response);
  assert.equal(await handlers.get('undo-archive-project')(null, groups, 'T1'), undoResponse);
});
