// What the session header's status dot and the exit banners say about a
// session's process. see .ai/contexts/window-frame.md ("The session header's controls")
//
// app.js cannot be evaluated whole in jsdom, so the shipped onProcessExited
// handler, updateTerminalHeader and openSession are cut out of its source and
// run against stubs: a change to any of them changes what these tests run.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const { ptyExitSignalName } = require('../pty-ops');
const { processExitLabel, exitBannerPhrase, exitBannerColour } = require('../public/process-exit');
const { setupTerminalDom } = require('./terminal-manager-harness');

// The source from `marker` to the brace that closes the block opened at the
// first `{` that ends a line after it, plus `tail` (the `);` of a call).
function sliceBlock(marker, tail = '') {
  const start = APP_SRC.indexOf(marker);
  assert.notEqual(start, -1, `app.js must contain ${marker}`);
  const lineEndingBrace = /\{\r?\n/g;
  lineEndingBrace.lastIndex = start;
  const open = lineEndingBrace.exec(APP_SRC);
  assert.ok(open, `a block must open after ${marker}`);
  let depth = 0;
  for (let i = open.index; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}' && --depth === 0) return APP_SRC.slice(start, i + 1) + tail;
  }
  throw new Error(`unbalanced block after ${marker}`);
}

const PRELUDE = `
  let activeSessionId = 's1';
  let activePtyIds = new Set();
  let gridViewActive = false;
  let restoringWorkingSet = false;
  let sessionOpenedOutsideRestore = false;
  const openSessions = new Map();
  const sessionMap = new Map();
  const pendingSessions = new Map();
  const skippedWorkingSetEntries = new Set();
  const cachedProjects = [];
  const cachedAllProjects = [];
  const gridCards = new Map();
  const gridViewerCount = document.createElement('span');
  const terminalHeader = document.createElement('div');
  const placeholder = document.createElement('div');
  const terminalHeaderStatus = document.createElement('span');
  const terminalStopBtn = document.createElement('button');
  const calls = { writes: [], opened: [], dropped: [] };
  let openResult = { ok: true };
  function updatePtyTitle() {}
  function isPanelTerminalSession() { return false; }
  function notePanelTerminalExit() {}
  function destroySession(id) { openSessions.delete(id); }
  function setActiveSession() {}
  function refreshSidebar() {}
  function dropLocalPtySession(id) { calls.dropped.push(id); }
  function sessionItemEl() { return null; }
  const ptyGenerations = new Map();
  const pendingOpens = new Map();
  function updateRunningIndicators() {}
  function schedulePersistWorkingSet() {}
  function pollActiveSessions() { updateTerminalHeader(); }
  async function guardResume() { return true; }
  async function resolveDefaultSessionOptions() { return {}; }
  function syncPtySizeAfterOpen() {}
  function setSessionMcpState() {}
  function setSessionSandboxed() {}
  function showSession() { updateTerminalHeader(); }
  function makeEntry() { return { closed: false, initialSize: null, terminal: { write: (d) => calls.writes.push(d) } }; }
  function createTerminalEntry(session) { const e = makeEntry(); openSessions.set(session.sessionId, e); return e; }
`;

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  let exitHandler = null;
  const h = { whileOpening: null };
  window.api = {
    onProcessExited: (cb) => { exitHandler = cb; },
    openTerminal: async () => {
      if (h.whileOpening) h.whileOpening();
      return vm.runInContext('calls.opened.push(1); openResult', ctx);
    },
  };
  const ctx = dom.getInternalVMContext();
  const run = (src, filename) => vm.runInContext(src, ctx, { filename });
  run(PRELUDE, 'prelude.js');
  run(fs.readFileSync(path.join(ROOT, 'public', 'process-exit.js'), 'utf8'), 'process-exit.js');
  run(sliceBlock('function updateTerminalHeader() {'), 'app.js#updateTerminalHeader');
  run(sliceBlock('async function openSession(session'), 'app.js#openSession');
  run(sliceBlock('function applyProcessExit('), 'app.js#applyProcessExit');
  run(sliceBlock('function handleProcessExited('), 'app.js#handleProcessExited');
  run(sliceBlock('function beginPtyOpen('), 'app.js#beginPtyOpen');
  run(sliceBlock('function settlePtyOpen('), 'app.js#settlePtyOpen');
  run(sliceBlock('window.api.onProcessExited((', ');'), 'app.js#onProcessExited');
  run(`sessionMap.set('s1', { sessionId: 's1', projectPath: '/p', type: 'claude' }); openSessions.set('s1', makeEntry());`, 'fixture.js');
  const read = (expr) => run(expr, 'read.js');
  return Object.assign(h, {
    exit: (code, signal, stopped, generation) => exitHandler('s1', code, signal, stopped, generation),
    exitOf: (id, code) => exitHandler(id, code, null, false),
    poll: (running) => { read(running ? "activePtyIds.add('s1')" : "activePtyIds.delete('s1')"); read('updateTerminalHeader()'); },
    title: () => read('terminalHeaderStatus.title'),
    aria: () => read("terminalHeaderStatus.getAttribute('aria-label')"),
    lastWrite: () => read('calls.writes.at(-1)'),
    read,
  });
}

test('the dot reports the exit code, then Running once a poll sees the process, then Stopped with no new exit', () => {
  const h = setup();
  h.exit(3, null);
  assert.equal(h.title(), 'Exited (code 3)', 'the exit event records the code (mutation target: the noteSessionExit call)');
  assert.equal(h.aria(), 'Exited (code 3)');
  assert.match(h.lastWrite(), /session exited \(code 3\)/);

  h.poll(true);
  assert.equal(h.title(), 'Running');

  h.poll(false);
  assert.equal(h.title(), 'Stopped', 'running again cleared the old code (mutation target: the forget in updateTerminalHeader)');
});

test('a relaunch that fails to open shows no exit code from the process before it', async () => {
  const h = setup();
  h.exit(1, null);
  assert.equal(h.title(), 'Exited (code 1)');
  h.read("openResult = { ok: false, error: 'boom' }");
  await h.read("openSession(sessionMap.get('s1'))");
  assert.equal(h.read('calls.opened.length'), 1, 'the relaunch reached openTerminal');
  assert.equal(h.title(), 'Stopped');
});

test('a stale exit that arrives after the reply of the relaunch leaves the new pty alone', async () => {
  const h = setup();
  h.exit(1, null, false, 1);
  h.read("openResult = { ok: true, generation: 2 }");
  await h.read("openSession(sessionMap.get('s1'))");
  h.read("activePtyIds.add('s1')");
  const writes = h.read('calls.writes.length');
  const dropped = h.read('calls.dropped.length');
  h.exit(9, null, false, 1);
  assert.equal(h.read("openSessions.get('s1').closed"), false, 'the new pty is not marked closed');
  assert.equal(h.read('calls.writes.length'), writes, 'no banner for the old pty');
  assert.equal(h.read("activePtyIds.has('s1')"), true, 'the new pty stays in the running set');
  assert.equal(h.read('calls.dropped.length'), dropped, 'its live state is not purged');
});

test('a stale exit that arrives before the reply is discarded once the reply names a newer generation', async () => {
  const h = setup();
  h.exit(1, null, false, 1);
  h.read("openResult = { ok: true, generation: 2 }");
  h.whileOpening = () => h.exit(9, null, false, 1);
  await h.read("openSession(sessionMap.get('s1'))");
  h.read("activePtyIds.add('s1')");
  assert.equal(h.read("openSessions.get('s1').closed"), false, 'the new pty is not marked closed');
  assert.equal(h.read("activePtyIds.has('s1')"), true);
});

test('a fast-failing launch whose exit lands during the await is applied after the reply', async () => {
  const h = setup();
  h.exit(1, null, false, 1);
  h.read("openResult = { ok: true, generation: 2 }");
  h.whileOpening = () => h.exit(3, null, false, 2);
  const droppedBefore = h.read('calls.dropped.length');
  await h.read("openSession(sessionMap.get('s1'))");
  assert.equal(h.read("openSessions.get('s1').closed"), true, 'the exit of the current pty closes its entry');
  assert.equal(h.title(), 'Exited (code 3)');
  assert.match(h.lastWrite(), /session exited \(code 3\)/);
  assert.equal(h.read('calls.dropped.length'), droppedBefore + 1, 'and drops its state');
});

test('a relaunch that opens shows no old exit code before its first poll', async () => {
  const h = setup();
  h.exit(1, null);
  await h.read("openSession(sessionMap.get('s1'))");
  assert.equal(h.read('lastSessionExit("s1")'), null);
});

test('an exit that lands while the relaunch is still opening is kept, not forgotten after it', async () => {
  const h = setup();
  h.exit(3, null);
  h.whileOpening = () => h.exit(1, null);
  h.read("openResult = { ok: false, error: 'pre-launch command failed' }");
  await h.read("openSession(sessionMap.get('s1'))");
  assert.equal(h.title(), 'Exited (code 1)', 'the forget runs before openTerminal, so the new process\'s exit survives it');
  assert.match(h.read('calls.writes.join("")'), /session exited \(code 1\)/);
});

test('a plain terminal that exits is torn down; a Claude session stays mounted with its banner', () => {
  const h = setup();
  h.read("sessionMap.set('t1', { sessionId: 't1', projectPath: '/p', type: 'terminal' }); openSessions.set('t1', makeEntry());");
  h.exitOf('t1', 0);
  assert.equal(h.read("openSessions.has('t1')"), false, 'a plain terminal is ephemeral (mutation target: its destroySession)');

  h.exitOf('s1', 0);
  assert.equal(h.read("openSessions.has('s1')"), true, 'a Claude session keeps its terminal so the banner can be read');
  assert.equal(h.read("openSessions.get('s1').closed"), true);
  assert.match(h.lastWrite(), /session exited \(code 0\)/);
  assert.ok(h.lastWrite().startsWith('\r\n\x1b[2m'), 'a clean exit is dim');
});

test('a Stop the user asked for reads Stopped, dim, and not Killed by the signal it sends', () => {
  const h = setup();
  h.exit(0, 'SIGHUP', true);
  assert.equal(h.title(), 'Stopped');
  assert.match(h.lastWrite(), /── session stopped — /);
  assert.ok(h.lastWrite().startsWith('\r\n\x1b[2m'), 'a requested stop is dim');
});

test('a process killed by a signal reads Killed, in the dot and in the banner', () => {
  const h = setup();
  h.exit(0, 'SIGKILL');
  assert.equal(h.title(), 'Killed (SIGKILL)', 'not "Exited (code 0)"');
  assert.match(h.lastWrite(), /session killed \(SIGKILL\)/);
  assert.ok(h.lastWrite().startsWith('\r\n\x1b[33m'), 'a kill is not a clean exit: the banner is yellow');
});

test('the exit labels', () => {
  assert.equal(processExitLabel({ exitCode: 0, signal: null }), 'Exited (code 0)');
  assert.equal(processExitLabel({ exitCode: 0, signal: 'SIGTERM' }), 'Killed (SIGTERM)');
  assert.equal(processExitLabel({ exitCode: undefined, signal: null }), 'Exited');
  assert.equal(exitBannerPhrase({ exitCode: 2, signal: null }), 'exited (code 2)');
  assert.equal(exitBannerPhrase({ exitCode: 0, signal: 'SIGKILL' }), 'killed (SIGKILL)');
  assert.equal(exitBannerColour({ exitCode: 0, signal: null }), '\x1b[2m');
  assert.equal(exitBannerColour({ exitCode: 1, signal: null }), '\x1b[33m');
  assert.equal(processExitLabel({ exitCode: 0, signal: 'SIGHUP', stopped: true }), 'Stopped', 'a requested stop outranks the signal it sends');
  assert.equal(exitBannerPhrase({ exitCode: 1, signal: null, stopped: true }), 'stopped');
  assert.equal(exitBannerColour({ exitCode: 0, signal: 'SIGHUP', stopped: true }), '\x1b[2m');
});

test('main names the signal node-pty reports and forwards it with the exit code', () => {
  assert.equal(ptyExitSignalName(9), 'SIGKILL');
  assert.equal(ptyExitSignalName(15), 'SIGTERM');
  assert.equal(ptyExitSignalName(0), null);
  assert.equal(ptyExitSignalName(undefined), null);
  assert.equal(ptyExitSignalName(999, {}), 'signal 999');

  assert.match(MAIN_SRC, /ptyProcess\.onExit\(\(\{ exitCode, signal \}\) => \{\s*const exitSignal = ptyExitSignalName\(signal\);/);
  const sends = MAIN_SRC.match(/webContents\.send\('process-exited', [^)]*\)/g);
  assert.equal(sends.length, 2);
  for (const send of sends) assert.match(send, /, exitCode, exitSignal, stopped, session\.generation\)$/);
  assert.match(MAIN_SRC, /const stopped = !!session\.stopRequested;/);
  const stopHandler = MAIN_SRC.slice(MAIN_SRC.indexOf("ipcMain.handle('stop-session'"), MAIN_SRC.indexOf("ipcMain.handle('remote-stop-session'"));
  assert.match(stopHandler, /session\.stopRequested = true;\s*killPty\(session, sessionId\);/, 'a Stop is recorded before the signal is sent');
  assert.match(MAIN_SRC, /attachedSession\.stopRequested = true;\s*killPty\(attachedSession, sessionId\);/);
  assert.ok(MAIN_SRC.includes('session.generation = ++ptyGenerationCounter;'), 'every wired pty gets the next generation');
  assert.equal(MAIN_SRC.match(/return \{\s*ok: true, reattached: (true|false), [^}]*generation: (session|remoteSession)\.generation,?\s*\}/g).length, 3, 'all three open-terminal replies carry the generation');
  assert.ok(PRELOAD_SRC.includes("'process-exited', (_event, sessionId, exitCode, signal, stopped, generation) => callback(sessionId, exitCode, signal, stopped, generation)"));
  assert.match(APP_SRC, /notePanelTerminalExit\(sessionId, exitCode, signal, stopped\)/);
});

test('the panel shell\'s banner says killed for a signal, like the session\'s', () => {
  const ctx = setupTerminalDom({ filePanel: true });
  try {
    ctx.window.createTerminalEntry({ sessionId: 'panel:x' });
    ctx.window.notePanelTerminalExit('panel:x', 0, 'SIGKILL');
    assert.match(ctx.spies.writes.at(-1), /shell killed \(SIGKILL\)/);
    ctx.window.createTerminalEntry({ sessionId: 'panel:y' });
    ctx.window.notePanelTerminalExit('panel:y', 1);
    assert.match(ctx.spies.writes.at(-1), /shell exited \(code 1\)/);
    ctx.window.createTerminalEntry({ sessionId: 'panel:z' });
    ctx.window.notePanelTerminalExit('panel:z', 0, 'SIGHUP', true);
    assert.match(ctx.spies.writes.at(-1), /shell stopped — /);
  } finally { ctx.destroy(); }
});

test('destroying a session drops its recorded exit', () => {
  const ctx = setupTerminalDom({ filePanel: true });
  try {
    ctx.window.createTerminalEntry({ sessionId: 's9' });
    ctx.inCtx("noteSessionExit('s9', 4, null)");
    ctx.window.destroySession('s9');
    assert.equal(ctx.inCtx("lastSessionExit('s9')"), null);
  } finally { ctx.destroy(); }
});
