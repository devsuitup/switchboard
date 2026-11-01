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
  const modes = [], requests = [];
  let nextRead = null, projectsChanged;
  w.api.readSessionJsonl = (_id, options) => {
    modes.push(options?.mode || 'ordinary');
    requests.push(options);
    if (options?.mode === 'stop') return Promise.resolve({ ok: true });
    reads++;
    if (nextRead) return nextRead();
    if (options?.mode === 'follow' && !options.checkpoint) { offset = entries.length; return Promise.resolve({ entries: [...entries], token: 'follow-token' }); }
    if (options?.mode === 'follow' && options.checkpoint) { const added = entries.slice(offset); offset = entries.length; return Promise.resolve({ entries: added, token: 'follow-token', append: true }); }
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
  return { ctx, w, tick, modes, requests, get reads() { return reads; }, set live(value) { live = value; },
    append(text) { entries.push(turn(text)); }, set nextRead(value) { nextRead = value; },
    appendEntry(entry) { entries.push(entry); },
    projectsChanged: () => projectsChanged?.(),
    activity: id => ctx.emitSessionTranscriptActivity({ sessionId: id || 'run', at: Date.now() }),
  };
}

test('re-arm sends its byte checkpoint and never serializes retained renderer history', async t => {
  const h = setup(t);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  const first = h.w.jsonlViewerBody.firstElementChild;
  h.live = null;
  h.projectsChanged();
  await h.tick();
  assert.ok(h.requests.some(options => options.mode === 'stop' && options.park === true));
  const stringify = h.w.JSON.stringify;
  let serializations = 0;
  h.w.JSON.stringify = (...args) => { serializations++; return stringify(...args); };
  try {
    h.live = { kind: 'schedule' };
    h.append('later');
    h.projectsChanged();
    await h.tick();
    assert.equal(h.requests.at(-1).checkpoint, 'follow-token');
    assert.equal(serializations, 0, 're-arm does not serialize the retained prefix');
    assert.equal(h.w.jsonlViewerBody.firstElementChild, first);
    assert.match(h.w.jsonlViewerBody.textContent, /first[\s\S]*later/);
  } finally { h.w.JSON.stringify = stringify; }
});

test('a command beginning in the initial snapshot merges through three refreshes', async t => {
  const h = setup(t);
  const local = text => ({ type: 'user', message: { content: text } });
  h.appendEntry(local('<local-command-caveat>local</local-command-caveat>'));
  await h.w.showJsonlViewer({ sessionId: 'run' });
  for (const text of ['<bash-input>echo hello</bash-input>', '<bash-stdout>hello</bash-stdout>', 'after command']) {
    h.appendEntry(local(text));
    h.activity();
    await h.tick();
  }
  const incremental = h.w.jsonlViewerBody.innerHTML;
  await h.w.showJsonlViewer({ sessionId: 'run' });
  assert.equal(h.w.jsonlViewerBody.innerHTML, incremental);
  assert.equal(h.w.jsonlViewerBody.querySelectorAll('.jsonl-tool-block').length, 1);
});

for (const prefix of ['<bash-input>echo hello</bash-input>', '<local-command-caveat>local</local-command-caveat>']) {
  for (const output of ['stdout', 'stderr']) {
    test(`split local command ${prefix} and ${output} matches a full render`, async t => {
      const h = setup(t);
      await h.w.showJsonlViewer({ sessionId: 'run' });
      const local = text => ({ type: 'user', message: { content: text } });
      h.appendEntry(local(prefix));
      h.activity();
      await h.tick();
      h.appendEntry(local((prefix.includes('caveat') ? '<bash-input>echo hello</bash-input>' : '')
        + `<bash-${output}>hello</bash-${output}>`));
      h.activity();
      await h.tick();
      const body = h.w.jsonlViewerBody;
      assert.equal(body.querySelectorAll('.jsonl-tool-block').length, 1, 'one command block');
      assert.match(body.querySelector('.jsonl-tool-block').textContent, /echo hello[\s\S]*hello/);
      assert.doesNotMatch(body.textContent, /<bash-|<local-command-caveat>/, 'no escaped command tags');
      const incremental = body.innerHTML;
      await h.w.showJsonlViewer({ sessionId: 'run' });
      assert.equal(body.innerHTML, incremental, 'incremental DOM equals full rendering');
    });
  }
}

test('incremental appends preserve expanded blocks, nested watches and earlier DOM objects', async t => {
  const h = setup(t);
  h.appendEntry({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'reasoning' },
    { type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'child', subagent_type: 'Explore' } },
    { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'echo hello' } },
  ] } });
  h.w.api.listSubagents = async () => [{ agentId: 'child', sessionId: 'child-session', description: 'child', subagentType: 'Explore' }];
  h.w.api.readSubagentJsonl = async () => ({ entries: [turn('nested')] });
  h.w.api.startSubagentWatch = async () => ({ watchId: 'watch' });
  let stopped = 0;
  h.w.api.stopSubagentWatch = async () => { stopped++; };
  h.w.api._subagentSpawnedCb({ parentSessionId: 'run', agentId: 'child' });
  await h.w.showJsonlViewer({ sessionId: 'run' });
  const first = h.w.jsonlViewerBody.firstElementChild;
  const thinking = h.w.jsonlViewerBody.querySelector('.jsonl-thinking');
  thinking.querySelector('.jsonl-toggle').click();
  const agent = h.w.jsonlViewerBody.querySelector('.jsonl-agent-expandable');
  agent.click();
  await flush();
  const nested = h.w.jsonlViewerBody.querySelector('.jsonl-subagent-nested');
  assert.ok(nested);
  h.append('second');
  h.activity();
  await h.tick();
  assert.equal(h.w.jsonlViewerBody.firstElementChild, first, 'append keeps earlier DOM objects');
  assert.equal(thinking.querySelector('.jsonl-tool-body').style.display, '');
  assert.equal(h.w.jsonlViewerBody.querySelector('.jsonl-subagent-nested'), nested);
  assert.equal(stopped, 0, 'append keeps the nested watch');
  h.appendEntry({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'hello result' }] } });
  h.activity();
  await h.tick();
  assert.match(h.w.jsonlViewerBody.querySelectorAll('.jsonl-tool-block')[1].textContent, /hello result/);
  assert.equal(h.w.jsonlViewerBody.querySelector('.jsonl-agent-expandable'), agent);
  assert.equal(h.w.jsonlViewerBody.querySelector('.jsonl-subagent-nested'), nested);
  assert.equal(stopped, 0);
  h.live = null;
  h.projectsChanged();
  await h.tick();
  assert.ok(h.modes.includes('stop'), 'idle releases the main-side cursor');
  h.live = { kind: 'schedule' };
  h.append('next run');
  h.projectsChanged();
  await h.tick();
  assert.match(h.w.jsonlViewerBody.textContent, /next run/);
  assert.equal(h.w.jsonlViewerBody.firstElementChild, first, 're-arming preserves an unchanged history prefix');
  assert.equal(h.w.jsonlViewerBody.querySelector('.jsonl-subagent-nested'), nested);
  assert.equal(stopped, 0);
});

test('a history reset replaces obsolete DOM and releases nested watches', async t => {
  const h = setup(t);
  await h.w.showJsonlViewer({ sessionId: 'run' });
  const first = h.w.jsonlViewerBody.firstElementChild;
  let stopped = 0;
  h.w.__activeViewerWatches.add(() => { stopped++; });
  h.nextRead = async () => ({ entries: [turn('replaced history')], append: true, reset: true, token: 'follow-token' });
  h.activity();
  await h.tick();
  assert.notEqual(h.w.jsonlViewerBody.firstElementChild, first);
  assert.match(h.w.jsonlViewerBody.textContent, /replaced history/);
  assert.doesNotMatch(h.w.jsonlViewerBody.textContent, /first/);
  assert.equal(stopped, 1);
});

for (const trigger of ['projects', 'activity']) {
  test(`an idle visible view re-arms when a run starts through ${trigger}`, async t => {
    const h = setup(t);
    h.live = null;
    await h.w.showJsonlViewer({ sessionId: 'run' });
    h.projectsChanged();
    await h.tick();
    h.projectsChanged();
    await h.tick();
    const reads = h.reads;
    h.live = { kind: 'schedule' };
    h.append('later scheduled run');
    if (trigger === 'projects') h.projectsChanged(); else h.activity();
    await h.tick();
    assert.match(h.w.jsonlViewerBody.textContent, /later scheduled run/, 'visible idle transcript follows a later run');
    assert.equal(h.reads, reads + 1);
    h.w.hideAllViewers();
    h.activity();
    await h.tick();
    assert.equal(h.reads, reads + 1);
  });
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
