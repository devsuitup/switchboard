'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('../app-source');

function setup({ rows = {}, effective = {}, platform = 'linux' } = {}) {
  const dom = new JSDOM('<!doctype html><body>' + [
    'settings-viewer', 'settings-viewer-title', 'settings-viewer-body',
    'terminal-area', 'terminal-header', 'placeholder', 'stats-viewer', 'memory-viewer', 'jsonl-viewer',
  ].map(id => `<div id="${id}"></div>`).join(''), {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const launched = [];
  window.api = new Proxy({
    platform,
    getSetting: async key => structuredClone(rows[key] || {}),
    setSetting: async (key, value) => { rows[key] = structuredClone(value); calls.push(['save', key, value]); return { ok: true }; },
    getEffectiveSettings: async () => effective,
    getShellProfiles: async () => [],
    getAppVersion: async () => '0.0.0',
    getActivityTraceState: async () => ({ enabled: false, dir: '/fixture' }),
    createScheduleSession: async () => ({ sessionId: 'creator', systemPrompt: 'schedule' }),
    openTerminal: async (...args) => { calls.push(['open', ...args]); return { ok: true }; },
  }, { get: (target, key) => key in target ? target[key] : (...args) => { calls.push([key, ...args]); return Promise.resolve({ ok: true }); } });
  Object.assign(window, {
    launchNewSession: (...args) => launched.push(args),
    openSession: (...args) => launched.push(args),
    cachedProjects: [], cachedAllProjects: [], sessionMap: new Map(), pendingSessions: new Map(),
    openSessions: new Map(), activePtyIds: new Set(), refreshSidebar() {}, pollActiveSessions() {},
    createTerminalEntry: () => ({ initialSize: {}, terminal: { write() {} } }),
    syncPtySizeAfterOpen() {}, showSession() {},
  });
  loadAppFunctions(dom.getInternalVMContext(), { functions: ['saveGlobalSettings'], declarations: ['_persistChain'] });
  loadAppFunctions(dom.getInternalVMContext(), { sourcePath: path.join(__dirname, '../../public/sidebar.js'),
    functions: ['isProjectDeleting', 'projectDeletionKey', 'paintProjectDeletionBusy'], declarations: ['deletingProjectKeys', 'projectDeletionUnavailable'] });
  for (const name of ['modal-stack', 'setting-defaults', 'utils', 'shortcuts', 'terminal-themes', 'settings-panel', 'dialogs']) {
    const filename = path.join(__dirname, '../../public', name + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
  return { window, context: dom.getInternalVMContext(), document: window.document, rows, calls, launched,
    flush: () => new Promise(resolve => window.setTimeout(resolve, 0)), destroy: () => window.close() };
}

module.exports = { setup };
