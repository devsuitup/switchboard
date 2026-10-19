'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const openStore = require('./fixtures/conversation-store.cjs');
const options = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-names-5645b-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  const h = { db: openStore(), projectsDir: path.join(root, 'projects') };
  t.after(() => {
    h.db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  h.id = '11111111-1111-4111-8111-111111111111';
  h.folder = encodeProjectPath(root);
  fs.mkdirSync(path.join(h.projectsDir, h.folder), { recursive: true });
  h.file = path.join(h.projectsDir, h.folder, h.id + '.jsonl');
  fs.writeFileSync(h.file, [
    { type: 'custom-title', sessionId: h.id, customTitle: 'launch (3)' },
    { type: 'user', sessionId: h.id, cwd: root, timestamp: '2026-10-14T00:00:00.000Z', message: { content: 'fixture prompt' } },
  ].map(JSON.stringify).join('\n') + '\n');
  h.descriptor = { sessionId: h.id, kind: 'interactive', name: 'registry rename', nameSource: 'user', cwd: root };
  h.jobs = new Map([['aaaaaaaa', { state: 'working', name: 'launch' }]]);
  h.init = () => cache.init({ PROJECTS_DIR: h.projectsDir, activeSessions: new Map(), getMainWindow: () => null,
    getLocalDescriptors: () => [h.descriptor], getLocalJobs: () => h.jobs, db: h.db, log: console });
  h.init();
  h.db.setFolderMeta(h.folder, root, 0);
  h.db.upsertCachedSessions([cache.readSessionFile(h.file, h.folder, root)]);
  h.name = () => cache.buildProjectsFromCache(false).flatMap(project => project.sessions)[0].name;
  return h;
}

test('631 case 1: a persisted launch title yields to interactive and background registry renames', options, t => {
  const h = fixture(t);
  for (const kind of ['interactive', 'bg']) {
    Object.assign(h.descriptor, { kind, jobId: kind === 'bg' ? 'aaaaaaaa' : null });
    h.db.setName(h.id, 'launch (3)');
    assert.equal(h.name(), 'registry rename');
    h.db.setName(h.id, 'Switchboard rename');
    assert.equal(h.name(), 'Switchboard rename');
  }
  assert.equal(h.db.getCachedSession(h.id).customTitle, 'launch (3)');
});

test('631 case 2: a legacy title backfilled by the Node worker yields without changing stored renames', options, async t => {
  const h = fixture(t);
  h.db.setName(h.id, 'launch (3)');
  h.db.setName('renamed', 'Switchboard rename');
  h.db.connection.exec('ALTER TABLE session_cache DROP COLUMN customTitle');
  h.db.closeDb();
  h.db = openStore();
  h.init();
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    assert.ok(!String(file).endsWith('.jsonl'), 'no main-thread transcript read');
    return read.call(this, file, ...args);
  };
  try {
    await cache.backfillCustomTitles();
    assert.equal(h.name(), 'registry rename');
    assert.equal(h.db.getMeta(h.id).name, 'launch (3)');
    assert.equal(h.db.getMeta('renamed').name, 'Switchboard rename');
    assert.equal(h.db.getCachedSession(h.id).customTitle, 'launch (3)');
  } finally { fs.readFileSync = read; }
});

test('631 case 7: the shipped projects worker reply overlays both views and preserves a Switchboard rename', options, async t => {
  const h = fixture(t);
  h.db.setName(h.id, 'launch (3)');
  Object.assign(h.descriptor, { kind: 'bg', jobId: 'aaaaaaaa' });
  const filename = path.join(__dirname, '../workers/projects-query.js');
  const nativeRequire = createRequire(filename);
  let receive;
  const replies = [];
  const port = { on: (_name, listener) => { receive = listener; }, postMessage: reply => replies.push(reply) };
  const Database = class { constructor() { return h.db.connection; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, console, structuredClone,
    require: id => id === 'better-sqlite3' ? Database : id === 'node:worker_threads'
      ? { parentPort: port, workerData: { dbPath: h.db.DB_PATH, projectsDir: h.projectsDir } } : nativeRequire(id) }, { filename });
  const request = async () => {
    await receive({ id: replies.length + 1, localDescriptors: [h.descriptor], localJobs: [...h.jobs] });
    const reply = replies.at(-1);
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  for (const name of ['registry rename', 'Switchboard rename']) {
    if (name === 'Switchboard rename') h.db.setName(h.id, name);
    const reply = await request();
    for (const projects of [reply.defaultProjects, reply.allProjects]) {
      const row = projects.flatMap(project => project.sessions).find(session => session.sessionId === h.id);
      assert.equal(row.name, name);
      assert.equal(row.bgJobId, 'aaaaaaaa');
    }
  }
});
