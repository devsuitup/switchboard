'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { archivedEntry, applyAndPersistArchived } = require('../archived-projects');
const { parseFolderKey } = require('../src/main/remote/remote-hosts');

function setup(t, alias = null, rootPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unarchive-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = rootPath || (alias ? '/srv/project' : path.join(root, 'project'));
  const entry = archivedEntry(alias, projectPath);
  const file = path.join(root, 'schedule-audit.md');
  fs.writeFileSync(file, '---\nname: Audit\ncron: 0 * * * *\nenabled: false\n---\nAudit\n');
  const settingsFile = path.join(root, 'settings.json');
  const originalOffer = { archivedAt: 'old', disabledSchedules: ['other.md'], failed: [{ name: 'other', error: 'offline' }] };
  fs.writeFileSync(settingsFile, JSON.stringify({
    archivedProjects: { [entry]: { archivedAt: '2026-11-19T10:00:00Z', knownSessionIds: ['one'], disabledSchedules: [file] }, untouched: { archivedAt: 'old' } },
    scheduleReenableOffers: { untouched: originalOffer },
  }));
  const getSetting = key => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))[key];
  const setSetting = (key, value) => {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings[key] = value;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
  };
  const row = { sessionId: 'one', archived: 1, created: '2026-11-18T10:00:00Z' };
  const writer = memoryWriter({ getSetting, setSetting, getAllCached: () => [row],
    setArchived: (_id, value) => { row.archived = value; } }, {});
  const handlers = new Map(), notifications = [];
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('unarchive-folder',");
  if (start !== -1) vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    writer, getSetting, parseFolderKey,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    notifyRendererProjectsChanged: reason => notifications.push(reason),
  }, { filename });
  const invoke = async value => {
    assert.ok(handlers.has('unarchive-folder'), 'plain folder restore IPC must be registered');
    return handlers.get('unarchive-folder')(null, value);
  };
  return { root, entry, projectPath, alias, file, row, writer, invoke, getSetting, setSetting, notifications, originalOffer };
}

for (const alias of [null, 'vps']) test(`plain folder restore preserves sessions and disabled files, seeds the sidebar offer: ${alias || 'local'}`, async t => {
  const h = setup(t, alias);
  const before = fs.readFileSync(h.file);
  assert.equal((await h.invoke(h.entry)).ok, true);
  assert.equal(h.getSetting('archivedProjects')[h.entry], undefined);
  assert.deepEqual(h.getSetting('archivedProjects').untouched, { archivedAt: 'old' });
  assert.deepEqual(h.getSetting('scheduleReenableOffers').untouched, h.originalOffer);
  assert.deepEqual(h.getSetting('scheduleReenableOffers')[h.entry], { archivedAt: '2026-11-19T10:00:00Z', disabledSchedules: [h.file] });
  assert.equal(h.row.archived, 1);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.deepEqual(h.notifications, ['archive']);
  const projects = applyAndPersistArchived([{ projectPath: h.projectPath, remoteAlias: alias, folder: '-project', sessions: [h.row] }], false, h);
  assert.deepEqual(projects[0].reenableOffer, { names: ['Audit'] });
});

test('remote root folder restore uses its exact stored identity', async t => {
  const h = setup(t, 'vps', '/');
  assert.equal(h.entry, 'vps::');
  assert.equal((await h.invoke(h.entry)).ok, true);
  assert.equal(h.getSetting('archivedProjects')[h.entry], undefined);
});

test('unknown folder restore refuses without writes or notifications', async t => {
  const h = setup(t);
  const before = h.getSetting('archivedProjects');
  const offers = h.getSetting('scheduleReenableOffers');
  const result = await h.invoke('vps::/unknown');
  assert.equal(result.code, 'NOT_ARCHIVED');
  assert.match(result.error, /not archived/i);
  assert.deepEqual(h.getSetting('archivedProjects'), before);
  assert.deepEqual(h.getSetting('scheduleReenableOffers'), offers);
  assert.deepEqual(h.notifications, []);
});

test('folder restore reports a rejected writer without announcing success', async t => {
  const h = setup(t);
  h.writer.clearArchivedEntry = async () => { throw new Error('writer unavailable'); };
  const result = await h.invoke(h.entry);
  assert.equal(result.error, 'writer unavailable');
  assert.ok(h.getSetting('archivedProjects')[h.entry]);
  assert.deepEqual(h.notifications, []);
});

test('preload forwards the exact folder archive entry on its own channel', async () => {
  const filename = path.join(__dirname, '../preload.js');
  const source = fs.readFileSync(filename, 'utf8');
  const property = source.match(/^\s*unarchiveFolder:\s*(.+),\s*$/m);
  assert.ok(property, 'preload exposes unarchiveFolder');
  const calls = [];
  const context = vm.createContext({ ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } });
  const forward = vm.runInContext(property[1], context, { filename });
  assert.equal((await forward('vps::/srv/éxact')).ok, true);
  assert.deepEqual(calls, [['unarchive-folder', 'vps::/srv/éxact']]);
});
