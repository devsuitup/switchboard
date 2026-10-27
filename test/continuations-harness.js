'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function setup(t, graph, { live = {}, answer = false, savedEntries, chunkBytes, metadata = {}, choice, active = new Map() } = {}) {
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
    getSetting: () => ({}), getAllFolderMeta: () => folderMeta, getFolderMeta: id => folderMeta.get(id), getAllMeta: () => new Map(Object.entries(metadata)),
    getAllCached: () => [...rows.values()],
    getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.has(id) ? { ...rows.get(id) } : undefined,
    upsertCachedSessions: entries => entries.forEach(row => rows.set(row.sessionId, row)),
    setCachedContinuationIndex(id, index) { if (rows.has(id)) rows.set(id, { ...rows.get(id), continuationIndex: index }); },
    setFolderMeta(id, projectPath, mtime) { folderMeta.set(id, { projectPath, mtime }); }, getMeta: id => metadata[id], setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  cache.init({ PROJECTS_DIR: root, db, activeSessions: active, getMainWindow: () => null, log: console });
  cache.refreshFolder(folder);
  const dom = new JSDOM('<body><div id="app-notices"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app-notices.js'), 'utf8'), ctx, { filename: path.join(__dirname, '../public/app-notices.js') });
  const settingsFile = path.join(root, 'settings.json');
  const saved = savedEntries || [{ sessionId: 'old', projectPath: root, active: true }];
  fs.writeFileSync(settingsFile, JSON.stringify({ openWorkingSet: saved }));
  const settings = new Map([['global', JSON.parse(fs.readFileSync(settingsFile, 'utf8'))]]);
  const spawned = [], prompts = [];
  dom.window.appConfirm = async ({ message: message }) => { prompts.push(message); return typeof answer === 'function' ? answer(message) : answer; };
  dom.window.appAlert = async ({ message }) => { prompts.push(message); };
  dom.window.appChoose = async question => {
    prompts.push(question);
    return choice !== undefined ? { choice } : answer === true ? { choice: question.selectedId } : null;
  };
  dom.window.api = {
    getSetting: async key => key === 'global' ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : settings.get(key) ?? null,
    setSetting: async (key, value) => {
      settings.set(key, value);
      if (key === 'global') fs.writeFileSync(settingsFile, JSON.stringify(value));
    },
    deleteSetting: async key => { settings.delete(key); },
    getSettingsByPrefix: async prefix => Object.fromEntries([...settings].filter(([key]) => key.startsWith(prefix))),
    getSessionContinuations: async id => typeof cache.resolveSessionContinuations === 'function'
      ? cache.resolveSessionContinuations(id, { chunkBytes, getSessionLiveElsewhere: async target => ({ known: true, live: live[target] || null }) }) : { candidates: [], unresolved: false },
    getSessionLiveElsewhere: async id => live[id] || null,
    getSessionsLiveElsewhere: async ids => Object.fromEntries(ids.filter(id => live[id]).map(id => [id, live[id]])),
    restoreBackgroundJob: async id => live[id]?.kind === 'bg'
      ? { action: 'attach', sessionId: id, jobId: live[id].jobId }
      : { action: 'refuse', reason: 'fixture has no live background descriptor' },
    openTerminal: async (id, project, isNew, options) => { spawned.push({ id, project, options }); return { ok: true }; },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/resume-guard.js'), 'utf8'), ctx, { filename: path.join(__dirname, '../public/resume-guard.js') });
  ctx._continuationChoices = new Map();
  vm.runInContext(`
    var openSessions = new Map(), sessionMap = new Map(), pendingSessions = new Map(), localMergedMemberRows = new Map();
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
  `, ctx, { filename: __filename });
  ctx.rows = [...rows.values()];
  vm.runInContext('rows.forEach(row => sessionMap.set(row.sessionId, row));', ctx, { filename: __filename });
  dom.window.showRestoreNotice = (_, text) => { dom.window.notice = text; };
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(__dirname, '../public/session-activity-dom.js'),
  });
  loadAppFunctions(ctx, {
    functions: ['rowHeadSession'], sourcePath: path.join(__dirname, '../public/sidebar.js'),
  });
  dom.window.SETTING_DEFAULTS = require('../public/setting-defaults').SETTING_DEFAULTS;
  const app = loadAppFunctions(ctx, {
    declarations: ['restoreRunDepth', 'restoreMode', 'openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'exitingApp', 'persistSkippedWhileExiting', 'dormantWorkingSet'],
    functions: ['runRestore', 'openSession', 'openSessionNow', 'persistWorkingSet', 'pendingRestoreEntries', 'showLiveElsewhereNotice', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow', 'prepareBackgroundRestore'],
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
