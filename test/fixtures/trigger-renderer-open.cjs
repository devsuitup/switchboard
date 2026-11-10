'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('../dom-setup');
const { loadAppFunctions } = require('../app-source');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER = '11234567-89ab-cdef-0123-456789abcdef';
const request = extra => ({ requestId: OTHER, documentEpoch: OTHER, mode: 'resume', requestedSessionId: ID, tabKey: ID,
  generation: null, project: '/project', session: { sessionId: ID, projectPath: '/project' }, deadline: Date.now() + 2000, ...extra });
function fixture(t) {
  assert.match(fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8'), /async function handleTriggerSessionAction\(/,
    'renderer must have the ordinary lifecycle action handler');
  const dom = setupSidebarDom(); t.after(() => dom.destroy());
  const w = dom.window; const calls = [];
  Object.assign(w, { openSessions: new Map(), pendingSessions: new Map(), sessionMap: new Map(),
    cachedProjects: [], cachedAllProjects: [], restoreInFlight: new Map(), restoreSavedIndex: new Map(),
    dormantWorkingSet: new Map(), skippedWorkingSetEntries: new Map(), gridViewActive: false,
    sessionOpenedOutsideRestore: false, sessionActionNoticeId: () => '', clearAppNotice() {},
    showSessionActionFailure: (...args) => calls.push(['notice', ...args]),
    clearDormantRow: () => false, cleanDisplayName: x => x,
    resolveResumeSession: () => { throw new Error('continuation chooser must not run'); },
    prepareBackgroundRestore: () => { throw new Error('background override must not run'); },
    guardResume: async (_s, flags) => { calls.push(['guard', flags]); return true; },
    resolveDefaultSessionOptions: async project => { calls.push(['defaults', project]); return { chrome: true, permissionMode: 'plan' }; },
    encodeProjectPath: () => 'folder', refreshSidebar() {},
    createTerminalEntry: session => { const entry = { session, initialSize: { cols: 80, rows: 24 }, terminal: { write() {} } }; w.openSessions.set(session.sessionId, entry); return entry; },
    rowOpenId: s => w.openSessions.has(s.sessionId) ? s.sessionId : null,
    destroySession: id => w.openSessions.delete(id), showSession: () => calls.push(['focus']),
    syncPtySizeAfterOpen() {}, setSessionMcpState() {}, setSessionSandboxed() {}, forgetSessionExit() {},
    pollActiveSessions() {}, schedulePersistWorkingSet: () => calls.push(['persist']),
    wrapInGridCard: id => calls.push(['card', id]), updateGridColumns() {}, gridCards: new Map(), gridViewerCount: {},
    api: { triggerSessionActionResult: ack => calls.push(['ack', ack]),
      openTerminal: async (...args) => { calls.push(['open', args]); return { ok: true, generation: 7 }; } },
  });
  const f = loadAppFunctions(dom.context, { declarations: ['openingSessions', 'restoreRunDepth', 'continuationRetryCancelled', 'ptyGenerations', 'pendingOpens'],
    functions: ['handleTriggerSessionAction', 'openSession', 'openSessionNow', 'launchNewSession', 'beginPtyOpen', 'settlePtyOpen'] });
  return { w, calls, f, context: dom.context };
}

module.exports = { fixture, ID, OTHER, request };
