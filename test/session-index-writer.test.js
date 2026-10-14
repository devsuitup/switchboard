'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSessionIndexWriter } = require('../session-index-writer');

test('cache initialization exposes only its explicit backend dependencies', () => {
  let injected;
  const read = () => 'read';
  const write = () => 'write';
  const backend = { getSetting: read, setSetting: write, newWriter() {}, prepare() {}, toggleStar() {} };
  const writer = createSessionIndexWriter(backend, { init: ctx => { injected = ctx; } });
  writer.initializeCache({ PROJECTS_DIR: 'fixture' });
  assert.notEqual(injected.db, backend);
  assert.equal(injected.db.getSetting, read);
  assert.equal(injected.db.setSetting, write);
  assert.equal(injected.db.newWriter, undefined);
  assert.equal(injected.db.prepare, undefined);
  assert.equal(injected.db.toggleStar, undefined);
  assert.equal(injected.writer, writer);
});

test('compound commands finish their reads and writes before yielding, and failures reject', async () => {
  const values = { global: { openWorkingSet: ['kept'] } };
  const writer = createSessionIndexWriter({
    getSetting: key => structuredClone(values[key]),
    setSetting: (key, value) => { values[key] = value; },
    toggleStar: () => { throw new Error('sqlite failure'); },
  });
  const first = writer.patchGlobal({ windowBounds: { x: 1 } });
  const second = writer.patchGlobal({ activityTrace: true });
  assert.deepEqual(values.global, { openWorkingSet: ['kept'], windowBounds: { x: 1 }, activityTrace: true });
  await Promise.all([first, second]);
  await assert.rejects(writer.toggleStar('id'), /sqlite failure/);
});

test('facade preserves real SQLite scan, title/body, metrics, file FTS and cleanup results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-writer-6165-'));
  try {
    const code = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const db = require('./db');
      const cache = require('./session-cache');
      const { createSessionIndexWriter } = require('./session-index-writer');
      const { encodeProjectPath } = require('./encode-project-path');
      const writer = createSessionIndexWriter(db, cache);
      (async () => {
        const root = process.env.SWITCHBOARD_DATA_DIR;
        const projects = path.join(root, 'projects');
        const folder = encodeProjectPath(root);
        fs.mkdirSync(path.join(projects, folder), { recursive: true });
        const id = '11111111-1111-4111-8111-111111111111';
        fs.writeFileSync(path.join(projects, folder, id + '.jsonl'), JSON.stringify({
          type: 'user', sessionId: id, cwd: root, uuid: 'message-1',
          timestamp: '2026-10-14T00:00:00.000Z', message: { content: 'fixture body words' },
        }) + '\\n');
        writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(),
          getMainWindow: () => null, log: { warn() {} } });
        await writer.refreshFolder(folder);
        assert.equal(db.getCachedSession(id).summary, 'fixture body words');
        assert.equal(db.getTotalCounts().totalMessages, 1);
        assert.deepEqual(await writer.renameSession(id, 'renamedtitle'), { name: 'renamedtitle' });
        assert.equal(db.getMeta(id).name, 'renamedtitle');
        assert.equal(db.searchByType('session', 'renamedtitle').length, 1);
        assert.equal(db.searchByType('session', 'fixture body words').length, 1);
        await writer.renameSession(id, '');
        assert.equal(db.getMeta(id).name, null);
        assert.equal(db.searchByType('session', 'renamedtitle').length, 0);
        await writer.applySearchFileBatch('memory', [], [{ id: '/memory.md', type: 'memory', title: 'memorytitle', body: 'memorybody' }]);
        assert.equal(db.searchByType('memory', 'memorybody').length, 1);
        await writer.applySearchFileBatch('memory', ['/memory.md'], []);
        assert.equal(db.searchByType('memory', 'memorybody').length, 0);
        await writer.setSetting('global', { hiddenProjects: [root, '/other'], openWorkingSet: ['kept'] });
        const removed = await writer.cleanupWorktree(root, { warn() {} });
        assert.equal(removed, 1);
        assert.equal(db.getCachedSession(id), null);
        assert.equal(db.getTotalCounts().totalMessages, 0);
        assert.equal(db.searchByType('session', 'fixture body words').length, 0);
        assert.deepEqual(db.getSetting('global'), { hiddenProjects: ['/other'], openWorkingSet: ['kept'] });
        await writer.closeDb();
        console.log('facade SQLite verified');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(require('electron'), ['-e', code], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /facade SQLite verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
