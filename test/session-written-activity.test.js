'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  return { ...h, document: h.window.document, entry, write, unseen, head };
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

for (const [name, frame] of [
  ['spinner', '\x1b[2K\x1b[1G✻ Thinking… (3s · esc to interrupt)'],
  ['spinner redraw', '\x1b[1A\x1b[2K\x1b[G✶'],
  ['timer tick', '\x1b[5C\x1b[1A4s'],
  ['resize repaint', '\x1b[2J\x1b[H> previous answer'],
  ['restore replay', '\x1b[2J\x1b[HClaude Code\r\n> previous answer'],
  ['bracketed paste echo', '\x1b[200~my own input\x1b[201~'],
]) {
  test(`a fully seen inactive PTY stays seen after ${name}`, t => {
    const h = terminal(t);
    h.head('baseline');
    h.write('previous answer');
    assert.equal(h.unseen(), false);
    h.window.activeSessionId = 'elsewhere';
    h.window.handleTerminalData('s', frame);
    h.window.flushTerminalBuffer('s');
    assert.equal(h.unseen(), false);
  });
}

test('new transcript assistant and tool output marks an inactive attached head unseen', t => {
  const h = terminal(t);
  const { createTranscriptTurnReader } = require('../transcript-turn');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sb-626b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const reader = createTranscriptTurnReader();
  const digest = text => { fs.writeFileSync(file, text); return reader.read(file).writtenOutput; };
  let transcript = JSON.stringify({ type: 'assistant', uuid: 'old', message: { content: 'previous answer' } }) + '\n';
  h.head(digest(transcript));
  h.window.activeSessionId = 'elsewhere';
  for (const entry of [
    { type: 'assistant', uuid: 'new', message: { content: 'new answer' } },
    { type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] } },
  ]) {
    transcript += JSON.stringify(entry) + '\n';
    h.head(digest(transcript));
    assert.equal(h.unseen(), true);
    h.window.clearUnread('s');
    assert.equal(h.unseen(), false);
  }
});

for (const notification of ['attention', 'response-ready']) {
  test(`rendering a visible unfocused grid card preserves ${notification}`, t => {
    const h = terminal(t);
    h.window.gridViewActive = true;
    h.window.activeSessionId = 'elsewhere';
    const card = h.document.createElement('div');
    card.className = 'grid-card';
    card.dataset.outputVisible = 'true';
    h.entry.element.parentNode.appendChild(card);
    card.appendChild(h.entry.element);
    h.head('baseline');
    if (notification === 'attention') h.window.setAttention('s', true);
    else h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'closed', revision: 2 });
    h.write('answer');
    assert.equal(h.unseen(), false);
    assert.equal(notification === 'attention' ? h.window.storedActivitySnapshot('s').attention : h.inCtx("headTurns.get('s').ready"), true);
  });
}

test('a visible window without keyboard focus sees rendered terminal and transcript output', t => {
  const h = terminal(t);
  h.document.hasFocus = () => false;
  h.write('answer');
  assert.equal(h.unseen(), false);
  const body = h.document.createElement('div');
  h.document.body.appendChild(body);
  const watermark = h.window.noteWrittenActivity('s');
  h.window.markTranscriptOutputSeen('s', body, watermark);
  assert.equal(h.unseen(), false);
});

test('a terminal with no unseen writing skips layout queries', t => {
  const h = terminal(t);
  let queries = 0;
  h.window.getComputedStyle = () => { queries++; return { display: 'block', visibility: 'visible' }; };
  h.window.markTerminalOutputSeen(h.entry);
  assert.equal(queries, 0);
});

test('grid intersection requires nearly the entire card before consuming latest output', t => {
  const h = terminal(t);
  let observer;
  h.window.IntersectionObserver = class {
    constructor(callback, options) { observer = { callback, options }; }
    observe() {}
  };
  h.window.initGridObservers();
  h.window.gridViewActive = true;
  const card = h.document.createElement('div');
  card.className = 'grid-card';
  card.dataset.sessionId = 's';
  h.entry.element.parentNode.appendChild(card);
  card.appendChild(h.entry.element);
  const watermark = h.window.noteWrittenActivity('s');
  h.entry.renderedWrittenWatermark = watermark;
  observer.callback([{ target: card, isIntersecting: true, intersectionRatio: 0.001 }]);
  assert.equal(h.unseen(), true);
  observer.callback([{ target: card, isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(h.unseen(), false);
  assert.ok([observer.options.threshold].flat().some(threshold => threshold >= 0.99));
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

for (const view of ['single', 'grid']) test(`${view} selection clears notifications but preserves scrolled-up output until viewed`, t => {
  const h = terminal(t);
  h.window.activeSessionId = 'elsewhere';
  h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision: 1 });
  h.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'closed', revision: 2 });
  h.window.noteWrittenActivity('s');
  loadAppFunctions(h.context, { functions: ['clearNotifications'] });
  h.window.setActiveSession = id => { h.window.activeSessionId = id; };
  h.window.Element.prototype.scrollIntoView = () => {};
  h.entry.terminal.buffer.active.baseY = 10;
  h.entry.terminal.buffer.active.viewportY = 2;
  h.entry.renderedWrittenWatermark = h.window.writtenActivitySnapshot('s').writtenWatermark;
  const select = () => view === 'single' ? h.window.showSession('s') : h.window.focusGridCard('s');
  select();
  assert.equal(h.inCtx("headTurns.get('s').ready"), false);
  assert.equal(h.unseen(), true);
  h.entry.terminal.buffer.active.viewportY = 10;
  h.window.markTerminalOutputSeen(h.entry);
  assert.equal(h.unseen(), false);
});

for (const mode of ['single', 'visible-grid', 'scrolled-up', 'hidden-window', 'inactive', 'offscreen-grid']) {
  test(`${mode}: rendered output followed by its digest needs no further PTY data`, t => {
    const h = terminal(t);
    h.head('baseline');
    if (mode === 'scrolled-up') h.entry.terminal.buffer.active.baseY = 10;
    if (mode === 'hidden-window') Object.defineProperty(h.document, 'hidden', { value: true });
    if (mode === 'inactive') h.window.activeSessionId = 'elsewhere';
    if (mode.includes('grid')) {
      h.window.gridViewActive = true;
      h.window.activeSessionId = 'elsewhere';
      const card = h.document.createElement('div');
      card.className = 'grid-card';
      card.dataset.outputVisible = String(mode === 'visible-grid');
      h.entry.element.parentNode.appendChild(card);
      card.appendChild(h.entry.element);
    }
    h.window.handleTerminalData('s', 'final answer');
    h.window.flushTerminalBuffer('s');
    h.head('final answer digest');
    assert.equal(h.unseen(), !['single', 'visible-grid'].includes(mode));
    h.window.markTerminalOutputSeen(h.entry);
    assert.equal(h.unseen(), !['single', 'visible-grid'].includes(mode));
  });
}

for (const order of ['digest-first', 'during-write']) test(`${order}: digest is seen only after the pending write finishes`, t => {
  const h = terminal(t);
  h.head('baseline');
  let done;
  h.entry.terminal.write = (_text, callback) => { done = callback; };
  h.window.handleTerminalData('s', 'answer');
  if (order === 'digest-first') h.head('answer digest');
  h.window.flushTerminalBuffer('s');
  if (order === 'during-write') h.head('answer digest');
  assert.equal(h.unseen(), true);
  done();
  assert.equal(h.unseen(), false);
});

for (const view of ['single', 'grid']) test(`${view} selection cannot consume a pending hidden replay`, t => {
  const h = terminal(t);
  h.head('baseline');
  h.window.activeSessionId = 'elsewhere';
  h.window.handleTerminalData('s', 'hidden answer');
  h.head('hidden digest');
  loadAppFunctions(h.context, { functions: ['clearNotifications'] });
  h.window.setActiveSession = id => { h.window.activeSessionId = id; };
  h.window.Element.prototype.scrollIntoView = () => {};
  let done;
  h.entry.terminal.write = (_text, callback) => { done = callback; };
  if (view === 'single') h.window.showSession('s');
  else {
    h.window.focusGridCard('s');
    h.window.replayHiddenBuffer('s');
  }
  assert.equal(h.unseen(), true);
  done();
  assert.equal(h.unseen(), false);
});

for (const order of ['render-first', 'digest-first', 'scrolled-up', 'hidden']) test(`transcript ${order}: a new digest cannot consume output absent from the static viewer`, async t => {
  const h = setup(t);
  h.ctx.evalPublic('jsonl-viewer.js');
  for (const name of ['terminalArea', 'jsonlViewer', 'jsonlViewerTitle', 'jsonlViewerSessionId', 'jsonlViewerBody']) {
    h.ctx.window[name] = h.ctx.document.createElement('div');
    h.ctx.document.body.appendChild(h.ctx.window[name]);
  }
  const body = h.ctx.window.jsonlViewerBody;
  h.ctx.window.jsonlViewer.appendChild(body);
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
  h.ctx.window.hideAllViewers = () => {};
  h.ctx.window.api.readSessionJsonl = async () => ({ entries: [{ type: 'assistant', message: { content: 'answer' } }] });
  let frame;
  h.ctx.window.requestAnimationFrame = callback => { frame = callback; return 1; };
  const head = (revision, writtenOutput) => h.ctx.window.applyHeadTurnSnapshot({ sessionId: 's', state: 'open', revision, writtenOutput });
  head(1, 'baseline');
  const captured = h.written();
  await h.ctx.window.showJsonlViewer(h.row);
  const rendered = body.innerHTML;
  body.scrollTop = 200;
  if (order === 'digest-first') {
    head(2, 'answer digest');
    assert.equal(h.blue(), true);
    frame();
    assert.equal(h.blue(), true);
  } else {
    frame();
    assert.equal(h.blue(), false);
    if (order === 'scrolled-up') body.scrollTop = 0;
    if (order === 'hidden') h.ctx.window.jsonlViewer.style.display = 'none';
    head(2, 'answer digest');
    assert.equal(h.blue(), true);
  }
  assert.equal(body.innerHTML, rendered);
  assert.equal(body.writtenActivity.watermark, captured);
  body.onscroll();
  h.ctx.window.dispatchEvent(new h.ctx.window.Event('focus'));
  assert.equal(h.blue(), true);
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
