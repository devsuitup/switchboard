'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./conversation-store.cjs');
const cache = require('../../session-cache');
const { createSessionIndexWriter } = require('../../session-index-writer');
const { encodeProjectPath } = require('../../encode-project-path');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-1144-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore(), worker = require('./project-deletion-worker.cjs')(db);
  const calls = [], logs = [], descriptors = [], statuses = [], activeSessions = new Map();
  const writer = createSessionIndexWriter({ readonlyBackend: db, client: {
    ready: Promise.resolve(), request: async (name, ...args) => {
      calls.push({ name, args });
      return worker.client.request(name, ...args);
    },
  } });
  const projects = path.join(root, 'projects'), folder = encodeProjectPath(root), dir = path.join(projects, folder);
  fs.mkdirSync(dir, { recursive: true });
  await writer.ready;
  const initialize = () => writer.initializeCache({ PROJECTS_DIR: projects, activeSessions, getMainWindow: () => null,
    getLocalDescriptors: () => descriptors, log: { info: line => { logs.push(line); statuses.push(line); }, warn() {}, error() {} } });
  initialize();
  t.after(async () => {
    await cache.shutdownProducers();
    db.closeDb();
    process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (id, content = id, extra = []) => {
    const file = path.join(dir, id + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', cwd: root, uuid: id,
      timestamp: '2024-01-01T00:00:00.000Z', message: { content } }), ...extra.map(row => JSON.stringify(row))].join('\n') + '\n');
    return file;
  };
  const scans = () => logs.filter(line => line.startsWith('[session-cache] folder-indexed '))
    .map(line => JSON.parse(line.slice('[session-cache] folder-indexed '.length)));
  const restart = async (opts) => {
    logs.length = 0;
    calls.length = 0;
    initialize();
    return cache.populateCacheViaWorker(opts);
  };
  return { root, projects, dir, folder, db, writer, worker, cache, calls, logs, descriptors, statuses, activeSessions, write, scans, restart };
}

function logicalIndex(db) {
  const rows = sql => JSON.parse(JSON.stringify(db.connection.prepare(sql).all()));
  const sessions = rows('SELECT * FROM session_cache ORDER BY sessionId');
  for (const row of sessions) for (const key of ['continuationIndex', 'messageCountIndex', 'fullReadStamp']) {
    if (row[key]) row[key] = JSON.parse(row[key]);
  }
  return {
    sessions,
    metrics: rows('SELECT * FROM session_metrics ORDER BY sessionId, date, model'),
    search: rows('SELECT m.id, m.type, m.folder, f.title, f.body FROM search_map m JOIN search_fts f ON f.rowid = m.rowid ORDER BY m.type, m.id, m.folder'),
    meta: rows('SELECT * FROM session_meta ORDER BY sessionId'),
    fields: rows('SELECT sessionId, field, source, transcriptTitle FROM session_meta_fields ORDER BY sessionId, field'),
    folders: rows('SELECT * FROM cache_meta ORDER BY folder'),
  };
}

module.exports = { fixture, logicalIndex, supported: openStore.supported };
