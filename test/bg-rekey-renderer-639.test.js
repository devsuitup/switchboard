'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');

function fixture(t) {
  const h = setupTerminalDom({ filePanel: true });
  t.after(h.destroy);
  const w = h.window;
  let receive;
  w.api.onSessionForked = callback => { receive = callback; };
  w.loadProjects = () => Promise.resolve();
  w.pollActiveSessions = () => {};
  w.schedulePersistWorkingSet = () => {};
  w.showRestoreNotice = () => {};
  w.setActiveSession = id => { w.activeSessionId = id; };
  w.terminalHeaderId = w.document.createElement('span');
  w.terminalHeaderName = w.document.createElement('span');
  w.pendingSessions = new Map();
  loadAppFunctions(h.context, {
    declarations: ['lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'],
    functions: ['rekeySessionEnvironment', 'attachBackgroundContinuation', 'beginPtyOpen', 'settlePtyOpen', 'handleProcessExited'],
  });
  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = src.indexOf('window.api.onSessionForked(');
  h.inCtx(src.slice(start, src.indexOf('\n});', start) + '\n});'.length));
  const session = { sessionId: 'old', name: 'original', projectPath: '/project', modified: new Date().toISOString() };
  w.sessionMap.set('old', session);
  const entry = w.createTerminalEntry(session);
  w.activeSessionId = 'old';
  w.activePtyIds.add('old');
  w.switchPanel('old');
  h.inCtx("lastActivityTime.set('old', 123); sandboxedSessions.set('old', false); ptyGenerations.set('old', 7); pendingOpens.set('old', []);");
  return { ...h, w, entry, receive };
}

test('shipped rekey preserves the terminal, panel owner and every outstanding session map', t => {
  const h = fixture(t);
  const panel = h.inCtx("filePanelState.get('old')");
  const shell = { panelSessionId: 'panel:old', ownerSessionId: 'old' };
  h.window.shell639 = shell;
  h.inCtx("panelTerminals.set('old', shell639); panelSpawnsInFlight.add('old'); panelReopenAfterSpawn.add('old');");
  h.receive('old', 'bg', 'background');
  assert.equal(h.w.openSessions.get('bg'), h.entry);
  assert.equal(h.w.toolBarOwner(), 'bg');
  assert.equal(h.inCtx("filePanelState.get('bg')"), panel);
  assert.equal(h.inCtx("filePanelState.has('old')"), false);
  assert.equal(h.inCtx("lastActivityTime.get('bg')"), 123);
  assert.equal(h.inCtx("ptyGenerations.get('bg')"), 7);
  assert.equal(h.inCtx("pendingOpens.has('bg')"), true);
  assert.equal(h.inCtx("sandboxedSessions.get('bg')"), false);
  assert.equal(h.inCtx("panelTerminals.get('bg')"), shell);
  assert.equal(h.inCtx("panelReopenAfterSpawn.has('bg')"), true);
  assert.equal(h.inCtx("panelSpawnsInFlight.has('bg')"), true);
  assert.equal(h.w.activePtyIds.has('old'), false);
});

test('background rekey retains the original working-set position', t => {
  const h = fixture(t);
  h.w.createTerminalEntry({ sessionId: 'other', projectPath: '/other' });
  h.receive('old', 'bg', 'background');
  assert.deepEqual([...h.w.openSessions.keys()], ['bg', 'other']);
});

test('the preserved grid card sends Stop to the new background UUID', t => {
  const h = fixture(t);
  h.w.sortedOrder = [];
  h.w.wrapInGridCard('old');
  const card = h.inCtx("gridCards.get('old')");
  const stops = [];
  h.w.confirmAndStopSession = id => stops.push(id);
  h.receive('old', 'bg', 'background');
  card.querySelector('.grid-card-stop-btn').click();
  assert.equal(h.inCtx("gridCards.get('bg')"), card);
  assert.deepEqual(stops, ['bg']);
});

test('a merged background rekey keeps sidebar, grid and Agents on the migrated conversation head', t => {
  const h = fixture(t);
  for (const file of ['agents-view.js']) {
    h.inCtx(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'));
  }
  h.w.activeSessionId = 'other';
  Object.assign(h.entry.session, { headSessionId: 'old', mergedMemberIds: ['prior', 'old'] });
  h.w.sessionMap.set('old', { ...h.entry.session });
  h.w.document.body.insertAdjacentHTML('beforeend', '<div class="session-item" data-session-id="old" data-head-session-id="old" data-merged-member-ids="prior old"><span class="session-icon"></span></div>');
  h.w.sortedOrder = [];
  h.w.wrapInGridCard('old');
  h.w.applyHeadTurnSnapshot({ sessionId: 'old', state: 'open', revision: 1 });
  h.receive('old', 'bg', 'background');
  loadAppFunctions(h.context, { declarations: ['_lastPtySignature'], functions: ['updateRunningIndicators'] });
  h.w.localTranscriptPtyTakeover = () => {};
  h.w.renderDefaultStatus = () => {};
  h.w.updateRunningIndicators();
  const card = h.inCtx("gridCards.get('bg')");
  assert.equal(h.w.sessionMap.get('bg').headSessionId, 'bg');
  assert.equal(h.w.document.querySelector('[data-session-id="bg"] .session-icon').dataset.glyph, '⠋');
  assert.equal(card.querySelector('.grid-card-dot').classList.contains('session-icon--busy'), true);
  const entry = { kind: 'background', sessionId: 'bg', state: 'working', hosted: true, name: 'original (1)', nameSource: 'collision' };
  assert.equal(h.w.agentDisplayName(entry), 'original');
  assert.equal(h.w.agentRowIcon(entry).glyph, '⠋');
  h.w.applyHeadTurnSnapshot({ sessionId: 'bg', state: 'closed', revision: 2 });
  assert.equal(h.w.document.querySelector('[data-session-id="bg"] .session-icon').dataset.glyph, '●');
  assert.equal(h.w.agentRowIcon(entry).glyph, '●');
  h.w.updateRunningIndicators();
  assert.equal(card.querySelector('.grid-card-dot').classList.contains('session-icon--busy'), false);
  assert.equal(card.querySelector('.grid-card-dot').dataset.glyph, '●');
});

test('a buffered terminal write survives the background rekey', t => {
  const h = fixture(t);
  h.w.handleTerminalData('old', 'last interactive output');
  h.receive('old', 'bg', 'background');
  h.w.flushTerminalBuffer('bg');
  assert.ok(h.spies.writes.includes('last interactive output'));
});

test('typed background continuation attaches once in the preserved xterm and buffers the new generation', async t => {
  const h = fixture(t);
  let resolve;
  const calls = [];
  h.w.api.openTerminal = (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); };
  h.receive('old', 'bg', 'background', { kind: 'bg', jobId: '1234abcd', cwd: '/worktree' });
  assert.equal(h.w.openSessions.get('bg'), h.entry);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][3])), { type: 'attach', jobId: '1234abcd', cwd: '/worktree' });
  resolve({ ok: true, generation: 8 });
  await h.entry.backgroundAttach;
  assert.equal(h.entry.attach, true);
  assert.equal(h.entry.bgRestore, true);
  assert.equal(h.inCtx("ptyGenerations.get('bg')"), 8);
  assert.equal(h.inCtx("pendingOpens.has('bg')"), false);
  assert.equal(h.spies.dispose, 0);
});

test('a new attach that exits before its open response stays closed after that response', async t => {
  const h = fixture(t);
  let resolve;
  h.w.api.openTerminal = () => new Promise(done => { resolve = done; });
  h.w.applyProcessExit = id => { h.w.openSessions.get(id).closed = true; };
  h.receive('old', 'bg', 'background', { kind: 'bg', jobId: '1234abcd' });
  h.w.handleProcessExited('bg', 1, null, false, 8);
  resolve({ ok: true, generation: 8 });
  await h.entry.backgroundAttach;
  assert.equal(h.entry.closed, true);
});

test('a late attach response cannot change a replacement tabs pending generation', async t => {
  const h = fixture(t);
  let resolve;
  h.w.api.openTerminal = () => new Promise(done => { resolve = done; });
  h.receive('old', 'bg', 'background', { kind: 'bg', jobId: '1234abcd' });
  const pending = [];
  h.window.pending639 = pending;
  h.inCtx("pendingOpens.set('bg', pending639); ptyGenerations.set('bg', 9);");
  const replacement = { session: { sessionId: 'bg' } };
  h.w.openSessions.set('bg', replacement);
  resolve({ ok: true, generation: 8 });
  await h.entry.backgroundAttach;
  assert.equal(h.inCtx("pendingOpens.get('bg')"), pending);
  assert.equal(h.inCtx("ptyGenerations.get('bg')"), 9);
});
