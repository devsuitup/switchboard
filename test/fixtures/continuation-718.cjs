'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('../app-source');
const cache = require('../../session-cache');
const { encodeProjectPath } = require('../../encode-project-path');
const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const tick = () => new Promise(resolve => setImmediate(resolve));
const line = value => JSON.stringify(value) + '\n';
function barrier() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-718-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root), dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const file = id => path.join(dir, id + '.jsonl');
  const rows = new Map(), meta = new Map([[OLD, { name: 'JB rename' }]]), folders = new Map(), effects = [], logs = [];
  const db = {
    getAllCached: () => [...rows.values()], getCachedByFolder: f => [...rows.values()].filter(row => row.folder === f),
    getCachedSession: id => rows.get(id), getAllMeta: () => meta, getMeta: id => meta.get(id),
    getAllFolderMeta: () => folders, getFolderMeta: f => folders.get(f), getSetting: () => null,
    getProjectsRevision: () => 'fixture', isInitialScanComplete: () => true,
    upsertCachedSessions: entries => { effects.push(['upsert', entries]); for (const row of entries) rows.set(row.sessionId, { ...row }); },
    setCachedContinuationIndex: (id, index) => { if (rows.has(id)) rows.set(id, { ...rows.get(id), continuationIndex: index }); },
    setCachedFileSize: (id, fileSize) => { effects.push(['size', id]); if (rows.has(id)) rows.set(id, { ...rows.get(id), fileSize }); },
    setFolderMeta: (f, projectPath, indexMtimeMs) => folders.set(f, { folder: f, projectPath, indexMtimeMs }),
    touchCachedModified: (id, modified) => { effects.push(['touch', id]); Object.assign(rows.get(id), { modified, fileMtime: modified }); },
    deleteCachedSession: id => { effects.push(['delete', id]); rows.delete(id); },
    deleteCachedFolder: f => { for (const row of rows.values()) if (row.folder === f) rows.delete(row.sessionId); },
    setName: (id, name) => meta.set(id, { ...meta.get(id), name }),
    deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {}, replaceSessionMetrics() {},
  };
  const descriptors = [{ sessionId: HEAD, kind: 'bg', jobId: '1234abcd', cwd: root }];
  const activeSessions = new Map();
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => { if (level !== 'debug') logs.push([level, ...args]); }]));
  const init = (writer = db) => cache.init({ PROJECTS_DIR: root, activeSessions, getMainWindow: () => null, log, db, writer,
    getLocalDescriptors: () => descriptors, getLocalJobs: () => new Map() });
  const write = (id, suffix = '') => fs.writeFileSync(file(id), line({ type: 'user', sessionId: id, cwd: root, timestamp: '2026-10-19T08:00:00.000Z', message: { content: 'hello' } }) + suffix);
  const link = (target = HEAD) => line({ type: 'continued-in', sessionId: OLD, continuedInSessionId: target });
  const padding = line({ type: 'assistant', padding: 'x'.repeat(4000) }).repeat(800);
  const append = (id, suffix = line({ type: 'cost-state', padding: 'x'.repeat(1670) })) => fs.appendFileSync(file(id), suffix);
  const views = () => cache.buildProjectsFromCache(false).flatMap(p => p.sessions).filter(s => s.sessionId !== OTHER);
  init();
  return { root, folder, dir, file, rows, meta, folders, effects, logs, log, db, init, write, link, append, padding, views, activeSessions, descriptors };
}
function helper(context = {}) {
  const events = [], warned = [], stamp = { dev: '1', ino: '2', birthtimeNs: '3', size: '4', mtimeNs: '9007199254740992' };
  const ctx = vm.createContext({ path, fs, PROJECTS_DIR: 'projects', continuationStamp: require('../../session-continuations').continuationStamp,
    sessionCache: { resolveSessionContinuations: async id => events.push('resolve:' + id) },
    writer: { refreshFolder: async (folder, opts) => events.push('refresh:' + folder + ':' + [...opts.files]) },
    notifyRendererProjectsChanged: cause => events.push('notify:' + cause),
    cliSessionState: { liveElsewhereChecked: async () => ({ known: true }) }, sessionHasPty() {}, ptyPids: new Set(),
    log: { warn: (...args) => warned.push(args) }, ...context });
  const api = loadAppFunctions(ctx, { sourcePath: path.join(__dirname, '../../main.js'),
    declarations: ['backgroundHandoffs'], functions: ['readBackgroundHandoffStamp', 'persistBackgroundHandoff'] });
  vm.runInContext('readBackgroundHandoffStamp = () => stampValue;', Object.assign(ctx, { stampValue: stamp }), { filename: 'stamp-718-fixture.js' });
  const drain = barrier();
  const request = { session: {}, sourceKey: 'tab', sourceId: OLD, targetId: HEAD, jobId: '1234abcd', projectFolder: 'folder', exitDrain: drain.promise };
  return { ...api, events, warned, stamp, ctx, request, drain };
}
module.exports = { fixture, helper, OLD, HEAD, OTHER, tick, line, barrier };
