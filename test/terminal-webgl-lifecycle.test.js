// Lifecycle of the WebGL addon kept across tab switches (#526): session
// re-keying, destruction and grid suspension before the reveal frame, process
// exit, and the reveal.timing long-frame attribution. Frames and timers are
// driven by hand, so nothing here waits on a real clock.
// See .ai/contexts/terminal-refresh.md, "WebGL contexts across tab switches".
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTerminalDom } = require('./terminal-manager-harness');

function fixture({ trace = false } = {}) {
  const h = setupTerminalDom();
  const w = h.window;
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  const log = { created: [], disposed: [], events: [] };
  let seq = 0;
  let glSeq = 0;
  let clock = 100;
  w.requestAnimationFrame = (cb) => { const id = ++seq; frames.set(id, cb); return id; };
  w.cancelAnimationFrame = (id) => { frames.delete(id); };
  w.setTimeout = (cb, ms) => { const id = ++seq; timers.set(id, { cb, ms }); return id; };
  w.clearTimeout = (id) => { timers.delete(id); };
  w.performance.now = () => clock;
  w.PerformanceObserver = class {
    static get supportedEntryTypes() { return ['long-animation-frame', 'longtask']; }
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  };
  class Gl {
    constructor() { this.id = ++glSeq; log.created.push(this.id); }
    dispose() { log.disposed.push(this.id); }
    onContextLoss(cb) { this.loss = cb; }
    onChangeTextureAtlas() {}
    onAddTextureAtlasCanvas() {}
    clearTextureAtlas() {}
  }
  w.WebglAddon = { WebglAddon: Gl };
  w.setActiveSession = (id) => { w.activeSessionId = id; };
  w.sortedOrder = [];
  w.ATRACE = trace;
  w.atrace = (cat, sid, fields) => log.events.push({ cat, sid, fields });
  const frame = (advance = 16) => {
    clock += advance;
    const batch = [...frames];
    frames.clear();
    for (const [, cb] of batch) cb(clock);
  };
  const settle = () => {
    clock += 200;
    const batch = [...timers];
    timers.clear();
    for (const [, t] of batch) t.cb();
  };
  const create = (id) => w.createTerminalEntry({ sessionId: id });
  const show = (id) => { w.showSession(id); frame(); };
  const live = () => [...w.openSessions.values()].filter((e) => e.webglAddon).length;
  const cap = () => h.inCtx('typeof WEBGL_WARM_CAP === "number" ? WEBGL_WARM_CAP : 0');
  return { ...h, w, log, frames, timers, observers, frame, settle, create, show, live, cap, now: () => clock };
}

function loadShippedListener(f, listener) {
  let receive;
  f.w.api[listener] = (cb) => { receive = cb; };
  f.w.rekeyActivityState = () => {};
  f.w.rekeyFilePanelState = () => {};
  f.w.loadProjects = () => Promise.resolve();
  f.w.pollActiveSessions = () => {};
  f.w.schedulePersistWorkingSet = () => {};
  f.w.pendingSessions = new Map();
  f.w.terminalHeaderId = f.w.document.createElement('span');
  f.w.terminalHeaderName = f.w.document.createElement('span');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = src.indexOf(`window.api.${listener}(`);
  assert.ok(start >= 0, `${listener} found in app.js`);
  const end = src.indexOf('\n});', start) + '\n});'.length;
  f.inCtx(src.slice(start, end));
  return receive;
}

for (const listener of ['onSessionDetected', 'onSessionForked']) {
  test(`a session re-keyed by ${listener} still counts against the warm cap`, async () => {
    const f = fixture();
    try {
      const receive = loadShippedListener(f, listener);
      for (let i = 0; i < 6; i++) {
        f.create(`old${i}`);
        f.show(`old${i}`);
        receive(`old${i}`, `new${i}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(f.live() <= f.cap(), `${f.live()} live addons, cap ${f.cap()}`);
      assert.ok(f.w.openSessions.get('new5').webglAddon, 'the newest keeps its addon');
      assert.strictEqual(f.w.openSessions.get('new0').webglAddon, null, 'the oldest was disposed');
    } finally { f.destroy(); }
  });
}

test('a terminal created and never shown holds no WebGL context', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 14; i++) f.create(`s${i}`);
    assert.strictEqual(f.live(), 0);
    assert.strictEqual(f.log.created.length, 0);
  } finally { f.destroy(); }
});

test('destroying a terminal before its reveal frame cancels the frame and creates no addon', () => {
  const f = fixture();
  try {
    f.create('A');
    f.w.suspendTerminalWebgl('A');
    f.w.showSession('A');
    f.w.destroySession('A');
    assert.strictEqual(f.frames.size, 0, 'the reveal frame is cancelled');
    f.frame();
    assert.strictEqual(f.log.created.length, 0);
  } finally { f.destroy(); }
});

test('a reveal frame that still runs after the entry left openSessions creates no addon', () => {
  const f = fixture();
  try {
    f.create('A');
    f.w.showSession('A');
    const entry = f.w.openSessions.get('A');
    f.w.openSessions.delete('A');
    f.frame();
    assert.strictEqual(f.log.created.length, 0);
    assert.strictEqual(entry.webglAddon, null);
  } finally { f.destroy(); }
});

test('a grid card suspended offscreen is not given its addon back by an earlier single-view reveal', () => {
  const f = fixture();
  try {
    f.create('A');
    f.w.suspendTerminalWebgl('A');
    let io;
    f.w.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; io = this; }
      observe() {}
      unobserve() {}
    };
    f.w.initGridObservers();
    f.w.showSession('A');
    f.w.gridViewActive = true;
    f.w.wrapInGridCard('A');
    io.cb([{ target: f.inCtx('gridCards.get("A")'), isIntersecting: false }]);
    f.frame();
    assert.strictEqual(f.w.openSessions.get('A').webglAddon, null);
    assert.strictEqual(f.log.created.length, 0);
  } finally { f.destroy(); }
});

test('suspending a terminal cancels the creation its reveal had queued', () => {
  const f = fixture();
  try {
    f.create('A');
    f.w.suspendTerminalWebgl('A');
    f.w.showSession('A');
    f.w.suspendTerminalWebgl('A');
    f.frame();
    assert.strictEqual(f.w.openSessions.get('A').webglAddon, null);
  } finally { f.destroy(); }
});

test('a terminal whose process exited gets its addon back on reveal, like any retained terminal', () => {
  const f = fixture();
  try {
    f.create('A');
    f.create('B');
    f.show('A');
    f.w.openSessions.get('A').closed = true;
    f.show('B');
    f.w.suspendTerminalWebgl('A');
    f.show('A');
    assert.ok(f.w.openSessions.get('A').webglAddon);
  } finally { f.destroy(); }
});

test('only long entries overlapping the reveal are attributed to it, and the line waits for delivery', () => {
  const f = fixture({ trace: true });
  try {
    f.create('A');
    const t0 = f.now();
    f.w.showSession('A');
    const observer = f.observers[f.observers.length - 1];
    f.frame(16);
    assert.strictEqual(f.log.events.length, 0, 'held back until the settle delay');
    observer.cb({ getEntries: () => [
      { duration: 60, startTime: t0 + 2, scripts: [] },
      { duration: 9000, startTime: t0 + 70, scripts: [{ duration: 8900, invoker: 'next-tab' }] },
    ] });
    f.settle();
    assert.strictEqual(f.log.events.length, 1);
    const fields = f.log.events[0].fields;
    assert.strictEqual(fields.longType, 'long-animation-frame');
    assert.strictEqual(fields.longMs, 60);
    assert.strictEqual(fields.longScript, undefined);
    assert.ok(observer.disconnected);
  } finally { f.destroy(); }
});

test('the longest overlapping long-animation-frame names its heaviest script', () => {
  const f = fixture({ trace: true });
  try {
    f.create('A');
    const t0 = f.now();
    f.w.showSession('A');
    const observer = f.observers[f.observers.length - 1];
    f.frame(16);
    observer.cb({ getEntries: () => [
      { duration: 60, startTime: t0 + 2, scripts: [] },
      { duration: 900, startTime: t0 - 800, scripts: [{ duration: 20, invoker: 'small' }, { duration: 800, invoker: 'IMG.onload', sourceFunctionName: 'heavy', sourceURL: 'app.js' }] },
    ] });
    f.settle();
    const fields = f.log.events[0].fields;
    assert.strictEqual(fields.longMs, 900);
    assert.strictEqual(fields.longScript, 'IMG.onload heavy app.js');
  } finally { f.destroy(); }
});

test('an exception in the reveal frame still releases the trace observer', () => {
  const f = fixture({ trace: true });
  try {
    f.create('A');
    f.w.openSessions.get('A').terminal.refresh = () => { throw new Error('refresh failed'); };
    f.w.showSession('A');
    const observer = f.observers[f.observers.length - 1];
    assert.throws(() => f.frame(), /refresh failed/);
    assert.ok(observer.disconnected);
    assert.strictEqual(f.log.events.length, 0);
  } finally { f.destroy(); }
});

test('destroying a terminal before its reveal frame releases the trace observer and its timer', () => {
  const f = fixture({ trace: true });
  try {
    f.create('A');
    f.w.showSession('A');
    const observer = f.observers[f.observers.length - 1];
    f.w.destroySession('A');
    assert.ok(observer.disconnected);
    f.frame();
    f.settle();
    assert.strictEqual(f.log.events.length, 0);
  } finally { f.destroy(); }
});

test('a newer reveal of the same terminal releases the older trace observer', () => {
  const f = fixture({ trace: true });
  try {
    f.create('A');
    f.create('B');
    f.w.showSession('A');
    const first = f.observers[f.observers.length - 1];
    f.w.showSession('B');
    f.w.showSession('A');
    assert.ok(first.disconnected);
  } finally { f.destroy(); }
});
