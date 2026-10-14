'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionState } = require('../public/session-state');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');

test('written activity survives busy, completion and attention; an older seen watermark cannot consume a newer write', () => {
  const state = createSessionState('local-pty');
  state.apply({ type: 'writtenActivity', watermark: 1 });
  assert.equal(state.snapshot().unseenWrittenActivity, true);
  for (const event of [{ type: 'busy', active: true }, { type: 'busy', active: false }, { type: 'attention', active: true }, { type: 'attention', active: false }]) {
    state.apply(event);
    assert.equal(state.snapshot().unseenWrittenActivity, true);
  }
  state.apply({ type: 'writtenActivity', watermark: 2 });
  state.apply({ type: 'writtenActivitySeen', watermark: 1 });
  assert.equal(state.snapshot().unseenWrittenActivity, true);
  state.apply({ type: 'writtenActivitySeen', watermark: 2 });
  assert.equal(state.snapshot().unseenWrittenActivity, false);
});

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(ctx.destroy);
  const row = { sessionId: 's', status: 'busy', modified: new Date().toISOString() };
  const projects = [makeSampleProject({ sessions: [row] })];
  ctx.window.sessionMap.set('s', row);
  ctx.sidebar.renderProjects(projects, true);
  const item = () => ctx.document.querySelector('.session-item[data-session-id="s"]');
  const blue = () => item().classList.contains('unseen-written-activity');
  const written = () => ctx.window.noteWrittenActivity('s');
  return { ctx, row, projects, item, blue, written };
}

test('hidden writing during busy turns the title blue and attention clear restores blue without changing the glyph policy', t => {
  const h = setup(t);
  h.ctx.window.activePtyIds.add('s');
  h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: 1 });
  const watermark = h.written();
  assert.equal(h.blue(), true);
  h.ctx.window.setAttention('s', true);
  assert.equal(h.item().querySelector('.session-icon').dataset.glyph, '!');
  h.ctx.window.setAttention('s', false);
  assert.equal(h.blue(), true);
  h.ctx.window.clearUnread('s', 'explicit', watermark);
  assert.equal(h.blue(), false);
});

test('hidden completed output remains blue with continuing background work and the existing response-ready priority', t => {
  const h = setup(t);
  h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: 1 });
  h.written();
  h.ctx.window.taskRegistry.note('s', 'shell', 'cli-task', { kind: 'bash' });
  h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'closed', revision: 2 });
  assert.equal(h.blue(), true);
  assert.equal(h.item().querySelector('.session-icon').dataset.glyph, '●');
  h.ctx.window.setAttention('s', true);
  h.ctx.window.setAttention('s', false);
  assert.equal(h.item().querySelector('.session-icon').dataset.glyph, '⠿');
  assert.equal(h.blue(), true);
});

test('busy, unchanged watch, descriptor heartbeats, reads and background existence never create written unread', t => {
  const h = setup(t);
  h.ctx.setActivity('s', true);
  h.ctx.window.onLocalTranscriptActivity({ sessionId: 's', at: Date.now() });
  h.ctx.window.taskRegistry.note('s', 'shell', 'cli-task', { kind: 'bash' });
  for (let revision = 1; revision < 4; revision++) h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision, writtenOutput: 'same' });
  assert.equal(h.blue(), false);
  h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: 4, writtenOutput: 'new' });
  assert.equal(h.blue(), true);
});

test('a delayed older clear retains a newer write and a full sidebar rebuild retains the title state', t => {
  const h = setup(t);
  const first = h.written();
  h.written();
  h.ctx.window.clearUnread('s', 'delayed', first);
  assert.equal(h.blue(), true);
  h.ctx.sidebar.renderProjects(h.projects, true);
  assert.equal(h.blue(), true);
});

test('head identity excludes older members and head rekey preserves both seen and unseen watermarks', t => {
  const h = setup(t);
  h.row.headSessionId = 'head';
  h.row.mergedMemberIds = ['s', 'head'];
  h.ctx.sidebar.renderProjects(h.projects, true);
  h.written();
  assert.equal(h.blue(), false);
  const seen = h.ctx.window.noteWrittenActivity('head');
  h.ctx.window.clearUnread('head', 'explicit', seen);
  h.ctx.window.noteWrittenActivity('head');
  h.ctx.window.rekeyActivityState('head', 'next', false, true);
  h.row.headSessionId = 'next';
  h.row.mergedMemberIds = ['s', 'next'];
  h.ctx.sidebar.renderProjects(h.projects, true);
  assert.equal(h.blue(), true);
  const snapshot = h.ctx.window.writtenActivitySnapshot('next');
  assert.equal(snapshot.seenWrittenWatermark, seen);
  assert.ok(snapshot.writtenWatermark > seen);
});

function terminal(t) {
  const h = setupTerminalDom();
  t.after(h.destroy);
  const ctx = h.context;
  for (const file of ['session-state.js', 'session-activity-dom.js', 'session-activity.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), ctx);
  const entry = h.window.createTerminalEntry({ sessionId: 's' });
  h.window.activeSessionId = 's';
  h.window.activePtyIds.add('s');
  entry.element.classList.add('visible');
  h.window.document.hasFocus = () => true;
  let revision = 0;
  const write = text => {
    h.window.noteWrittenActivity('s');
    h.window.handleTerminalData('s', text);
    h.window.flushTerminalBuffer('s');
  };
  const unseen = () => h.window.writtenActivitySnapshot('s').unseenWrittenActivity;
  const head = output => h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: ++revision, writtenOutput: output });
  return { ...h, entry, write, unseen, head };
}

test('fully viewed busy output is seen only after rendering; a newer write during the callback remains unseen', t => {
  const h = terminal(t);
  h.head('baseline');
  let callback;
  h.entry.terminal.write = (_text, done) => { callback = done; };
  h.write('first');
  assert.equal(h.unseen(), true);
  h.window.noteWrittenActivity('s');
  callback();
  assert.equal(h.unseen(), true);
  h.write('second');
  callback();
  assert.equal(h.unseen(), false);
});

for (const mode of ['scrolled-up', 'hidden-window', 'inactive', 'offscreen-grid', 'visible-grid']) {
  test(`${mode}: focus consumes only output actually rendered at its latest position`, t => {
    const h = terminal(t);
    if (mode === 'scrolled-up') h.entry.terminal.buffer.active.baseY = 10;
    if (mode === 'hidden-window') Object.defineProperty(h.window.document, 'hidden', { value: true, configurable: true });
    if (mode === 'inactive') h.window.activeSessionId = 'elsewhere';
    if (mode.includes('grid')) {
      h.window.gridViewActive = true;
      const card = h.window.document.createElement('div');
      card.className = 'grid-card';
      card.dataset.outputVisible = String(mode === 'visible-grid');
      h.entry.element.parentNode.appendChild(card);
      card.appendChild(h.entry.element);
    }
    h.write('output');
    assert.equal(h.unseen(), mode !== 'visible-grid');
    if (mode === 'scrolled-up') {
      h.entry.terminal.buffer.active.viewportY = 10;
      h.window.markTerminalOutputSeen(h.entry);
      assert.equal(h.unseen(), false);
    }
  });
}

test('transcript scrolling and a render race clear only the captured watermark in a visible head transcript', t => {
  const h = setup(t);
  const body = h.ctx.document.createElement('div');
  h.ctx.document.body.appendChild(body);
  h.ctx.document.hasFocus = () => true;
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
  const first = h.written();
  h.written();
  h.ctx.window.markTranscriptOutputSeen('s', body, first);
  assert.equal(h.blue(), true);
  body.scrollTop = 200;
  h.ctx.window.markTranscriptOutputSeen('s', body, first);
  assert.equal(h.blue(), true);
  h.ctx.window.markTranscriptOutputSeen('s', body, h.ctx.window.writtenActivitySnapshot('s').writtenWatermark);
  assert.equal(h.blue(), false);
});

test('title CSS depends only on unseen writing and preserves attention priority', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /\.session-item\.unseen-written-activity:not\(\.needs-attention\) \.session-summary/);
  assert.doesNotMatch(css, /\.session-item\.(?:cli-busy|response-ready)[^{]*\.session-(?:name|summary)\s*\{/);
});

test('PTY receipt validates printable output across fragmented escape sequences and does not treat OSC busy as writing', t => {
  const h = terminal(t);
  h.window.activeSessionId = 'elsewhere';
  for (const chunk of ['\x1b]0;busy', '\x07', '\x1b[', '2J', ' \r\n']) h.window.handleTerminalData('s', chunk);
  assert.equal(h.unseen(), false);
  h.window.handleTerminalData('s', 'new output');
  assert.equal(h.unseen(), true);
});

test('session environment rekey carries the written watermark before the PTY environment moves', t => {
  const h = terminal(t);
  h.window.noteWrittenActivity('s');
  for (const name of ['lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions']) h.window[name] = new Map();
  loadAppFunctions(h.context, { functions: ['rekeySessionEnvironment'] });
  h.window.rekeySessionEnvironment('s', 'next');
  assert.equal(h.window.writtenActivitySnapshot('next').unseenWrittenActivity, true);
  assert.equal(h.window.writtenActivitySnapshot('s').unseenWrittenActivity, false);
});

test('selecting a session retains the existing glyph clearing policy while pending written output stays unseen', t => {
  const h = terminal(t);
  h.window.activeSessionId = 'elsewhere';
  h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: 1 });
  h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'closed', revision: 2 });
  h.window.noteWrittenActivity('s');
  loadAppFunctions(h.context, { functions: ['clearNotifications'] });
  h.window.setActiveSession = id => { h.window.activeSessionId = id; };
  h.window.showSession('s');
  assert.equal(h.inCtx("headTurns.get('s').ready"), false);
  assert.equal(h.unseen(), true);
});

test('an empty transcript read cannot consume written output that it did not display', async t => {
  const h = setup(t);
  h.ctx.evalPublic('jsonl-viewer.js');
  h.ctx.document.hasFocus = () => true;
  for (const name of ['terminalArea', 'jsonlViewer', 'jsonlViewerTitle', 'jsonlViewerSessionId', 'jsonlViewerBody']) {
    h.ctx.window[name] = h.ctx.document.createElement('div');
    h.ctx.document.body.appendChild(h.ctx.window[name]);
  }
  h.ctx.window.hideAllViewers = () => {};
  h.ctx.window.api.readSessionJsonl = async () => ({ entries: [] });
  let frame;
  h.ctx.window.requestAnimationFrame = callback => { frame = callback; return 1; };
  h.written();
  await h.ctx.window.showJsonlViewer(h.row);
  frame();
  assert.equal(h.blue(), true);
});
