'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const turn = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const w = ctx.window;
  for (const key of ['jsonlViewer', 'jsonlViewerTitle', 'jsonlViewerSessionId', 'jsonlViewerBody', 'terminalArea',
    'statsViewer', 'memoryViewer', 'workFilesViewer', 'settingsViewer']) {
    w[key] = w.document.createElement('div');
    w.document.body.appendChild(w[key]);
  }
  w.focusMessageViewer = () => {};
  loadAppFunctions(ctx.context, { functions: ['hideAllViewers'], sourcePath: path.join(__dirname, '../public/memory-workfiles-view.js') });
  let reads = 0, live = { kind: 'schedule' }, entries = [turn('first')], offset = 0;
  const modes = [];
  let nextRead = null, projectsChanged;
  w.api.readSessionJsonl = (_id, options) => {
    modes.push(options?.mode || 'ordinary');
    if (options?.mode === 'stop') return Promise.resolve({ ok: true });
    reads++;
    if (nextRead) return nextRead();
    if (options?.mode === 'follow') { offset = entries.length; return Promise.resolve({ entries: [...entries], token: 'follow-token' }); }
    if (options?.mode === 'next') { const added = entries.slice(offset); offset = entries.length; return Promise.resolve({ entries: added, token: 'follow-token', append: true }); }
    return Promise.resolve({ entries: [...entries] });
  };
  w.api.getSessionLiveElsewhere = async () => live;
  w.api.onProjectsChanged = callback => { projectsChanged = callback; };
  ctx.evalPublic('jsonl-viewer.js');
  const timers = new Map();
  let serial = 0;
  w.setTimeout = (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; };
  w.clearTimeout = id => timers.delete(id);
  async function tick() {
    for (const [id, timer] of [...timers]) {
      if (timer.ms >= 20000) continue;
      timers.delete(id);
      await timer.callback();
    }
    await flush();
  }
  return { ctx, w, tick, modes, get reads() { return reads; }, set live(value) { live = value; },
    append(text) { entries.push(turn(text)); }, set nextRead(value) { nextRead = value; },
    projectsChanged: () => projectsChanged?.(),
    activity: id => ctx.emitSessionTranscriptActivity({ sessionId: id || 'run', at: Date.now() }),
  };
}

for (const kind of ['schedule', 'cli']) {
  test(`an open ${kind} transcript follows watcher writes, coalesces bursts and stops when no longer live`, async t => {
    const h = setup(t);
    h.live = { kind };
    await h.w.showJsonlViewer({ sessionId: 'run', summary: 'Run' });
    assert.match(h.w.jsonlViewerBody.textContent, /first/);
    h.append('second');
    for (let i = 0; i < 30; i++) h.activity();
    await h.tick();
    assert.match(h.w.jsonlViewerBody.textContent, /first[\s\S]*second/, 'watcher growth refreshes while keeping earlier messages');
    assert.equal(h.reads, 2, 'a burst produces one read');
    assert.deepEqual(h.modes.slice(0, 2), ['follow', 'next'], 'the viewer uses the incremental IPC mode');
    h.live = null;
    h.projectsChanged();
    await h.tick();
    h.append('after stop');
    h.activity();
    await h.tick();
    assert.equal(h.reads, 3, 'end takes one final snapshot and then stops reading');
    assert.doesNotMatch(h.w.jsonlViewerBody.textContent, /after stop/);
  });
}

test('closing the view cancels a queued refresh and a reply in flight cannot overwrite another view', async t => {
  const h = setup(t);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  h.activity();
  h.w.hideAllViewers();
  await h.tick();
  assert.equal(h.reads, 1);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  let finish;
  h.nextRead = () => new Promise(resolve => { finish = resolve; });
  h.activity();
  const pending = h.tick();
  await flush();
  assert.equal(typeof finish, 'function', 'growth starts the read');
  h.w.hideAllViewers();
  h.w.jsonlViewerBody.textContent = 'another view';
  finish({ entries: [turn('stale reply')] });
  await pending;
  assert.equal(h.w.jsonlViewerBody.textContent, 'another view');
});

test('unrelated writes and a closed view do no work; refresh preserves a reader scrolled above the bottom', async t => {
  const h = setup(t);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  h.activity('other');
  await h.tick();
  assert.equal(h.reads, 1);
  h.projectsChanged();
  await h.tick();
  assert.equal(h.reads, 1, 'project changes check liveness without rereading an unchanged live transcript');
  Object.defineProperty(h.w.jsonlViewerBody, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(h.w.jsonlViewerBody, 'clientHeight', { value: 100, configurable: true });
  h.w.jsonlViewerBody.scrollTop = 50;
  h.append('second');
  h.activity();
  await h.tick();
  assert.match(h.w.jsonlViewerBody.textContent, /second/);
  assert.equal(h.w.jsonlViewerBody.scrollTop, 50);
  h.w.hideAllViewers();
  h.activity();
  await h.tick();
  assert.equal(h.reads, 2);
});

test('switching to the shipped grid view cancels a queued transcript read', async t => {
  const h = setup(t);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  for (const name of ['terminalHeader', 'terminalsEl', 'gridViewer', 'gridViewerCount']) {
    h.w[name] = h.w.document.createElement('div');
    h.w.document.body.appendChild(h.w[name]);
  }
  h.w.gridViewActive = false;
  h.w.openGridSessionIds = () => [];
  h.w.layoutGridCards = () => [];
  h.w.syncGridGroupToggleBtn = () => {};
  h.w.refitOpenTerminals = () => {};
  loadAppFunctions(h.ctx.context, { functions: ['showGridView'], sourcePath: path.join(__dirname, '../public/grid-view.js') });
  h.activity();
  h.w.showGridView();
  assert.equal(h.w.jsonlViewer.style.display, 'none');
  await h.tick();
  assert.equal(h.reads, 1, 'grid dismissal must stop transcript work immediately');
});
