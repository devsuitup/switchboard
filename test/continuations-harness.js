'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function setup(t, graph, { live = {}, answer = false, savedEntries, chunkBytes } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continuations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  fs.mkdirSync(path.join(root, folder));
  for (const [id, children] of Object.entries(graph)) {
    const records = [
      { type: 'user', cwd: root, timestamp: '2026-10-09T12:00:00Z', message: { content: 'hello' } },
      ...children.map(child => ({ type: 'continued-in', sessionId: id, continuedInSessionId: child, timestamp: '2026-10-09T12:01:00Z' })),
      { type: 'assistant', timestamp: '2026-10-09T12:02:00Z', message: { content: 'after continuation' } },
    ];
    fs.writeFileSync(path.join(root, folder, id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  }
  const rows = new Map(), folderMeta = new Map();
  const db = {
    getSetting: () => ({}), getAllFolderMeta: () => folderMeta, getFolderMeta: id => folderMeta.get(id), getAllMeta: () => new Map(),
    getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.has(id) ? { ...rows.get(id) } : undefined,
    upsertCachedSessions: entries => entries.forEach(row => rows.set(row.sessionId, row)),
    setCachedContinuationIndex(id, index) { if (rows.has(id)) rows.set(id, { ...rows.get(id), continuationIndex: index }); },
    setFolderMeta(id, projectPath, mtime) { folderMeta.set(id, { projectPath, mtime }); }, getMeta() {}, setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  cache.init({ PROJECTS_DIR: root, db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  cache.refreshFolder(folder);
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  const settingsFile = path.join(root, 'settings.json');
  const saved = savedEntries || [{ sessionId: 'old', projectPath: root, active: true }];
  fs.writeFileSync(settingsFile, JSON.stringify({ openWorkingSet: saved }));
  const spawned = [], prompts = [];
  dom.window.confirm = message => { prompts.push(message); return typeof answer === 'function' ? answer(message) : answer; };
  dom.window.api = {
    getSetting: async () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    setSetting: async (_, value) => fs.writeFileSync(settingsFile, JSON.stringify(value)),
    getSessionContinuations: async id => typeof cache.resolveSessionContinuations === 'function'
      ? cache.resolveSessionContinuations(id, { chunkBytes, getSessionLiveElsewhere: async target => ({ known: true, live: live[target] || null }) }) : { candidates: [], unresolved: false },
    getSessionLiveElsewhere: async id => live[id] || null,
    getSessionsLiveElsewhere: async ids => Object.fromEntries(ids.filter(id => live[id]).map(id => [id, live[id]])),
    openTerminal: async (id, project, isNew, options) => { spawned.push({ id, project, options }); return { ok: true }; },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/resume-guard.js'), 'utf8'), ctx);
  vm.runInContext(`
    var openSessions = new Map(), sessionMap = new Map();
    var activeSessionId = null, restoringWorkingSet = true, restorePlanner = null;
    var sessionOpenedOutsideRestore = false, _persistChain = Promise.resolve();
    var RESTORE_STAGGER_MS = 0;
    function createTerminalEntry(session) {
      const entry = { session, terminal: { write() {} }, initialSize: {} };
      openSessions.set(session.sessionId, entry); return entry;
    }
    function showSession(id) { activeSessionId = id; }
    function destroySession(id) { openSessions.delete(id); }
    async function resolveDefaultSessionOptions() { return {}; }
    function syncPtySizeAfterOpen() {} function setSessionSandboxed() {}
    function forgetSessionExit() {} function beginPtyOpen() {} function settlePtyOpen() {}
    function schedulePersistWorkingSet() {} function pollActiveSessions() {}
    function cleanDisplayName(value) { return value || ''; }
  `, ctx);
  ctx.rows = [...rows.values()];
  vm.runInContext('rows.forEach(row => sessionMap.set(row.sessionId, row));', ctx);
  dom.window.showRestoreNotice = (_, text) => { dom.window.notice = text; };
  const app = loadAppFunctions(ctx, {
    declarations: ['openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled'],
    functions: ['runRestore', 'openSession', 'openSessionNow', 'persistWorkingSet', 'pendingRestoreEntries', 'showLiveElsewhereNotice'],
  });
  return {
    spawned, prompts, rows, root, db, folder, ctx,
    app, dom, saved,
    restore: async () => { await app.runRestore(saved); await app.persistWorkingSet(); },
    click: async () => { await app.openSession(rows.get('old')); await app.persistWorkingSet(); },
    settings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
  };
}

module.exports = { setup };
