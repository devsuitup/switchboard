// Revealing a hidden tab must not recreate its WebGL context every time (#526):
// recently shown terminals keep their addon within a small cap, and an addon
// that has to be (re)created is loaded once the container is visible. The
// reveal also reports its per-step timings to the activity trace.
// See .ai/contexts/terminal-refresh.md, "WebGL contexts across tab switches".
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

function setup({ trace = false, sessions = ['A', 'B'] } = {}) {
  const h = setupTerminalDom();
  const { window } = h;
  const log = { created: [], disposed: [], loads: [], clears: 0, lossCallbacks: new Map(), clearIds: [] };
  let nextId = 0;
  class GlAddon {
    constructor() { this.id = ++nextId; log.created.push(this.id); }
    dispose() { log.disposed.push(this.id); }
    onContextLoss(cb) { log.lossCallbacks.set(this.id, cb); }
    onChangeTextureAtlas() {}
    onAddTextureAtlasCanvas() {}
    clearTextureAtlas() { log.clears++; log.clearIds.push(this.id); }
  }
  window.WebglAddon = { WebglAddon: GlAddon };
  window.Terminal.prototype.open = function open(el) { this._el = el; };
  window.Terminal.prototype.loadAddon = function loadAddon(addon) {
    if (addon instanceof GlAddon) log.loads.push({ id: addon.id, visible: this._el.classList.contains('visible') });
  };
  window.setActiveSession = (id) => { window.activeSessionId = id; };

  const traced = [];
  window.ATRACE = trace;
  window.atrace = (cat, sid, fields) => { traced.push({ cat, sid, fields }); };

  for (const sid of sessions) window.createTerminalEntry({ sessionId: sid });
  const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  const frames = async (n = 3) => { for (let i = 0; i < n; i++) await frame(); };
  const show = async (sid) => { window.showSession(sid); await frames(); };
  const cap = () => h.inCtx('typeof WEBGL_WARM_CAP === "number" ? WEBGL_WARM_CAP : -1');
  return { ...h, log, traced, frames, show, cap };
}

test('switching A -> B -> A -> B -> A creates at most one WebGL addon per terminal and disposes none', async () => {
  const t = setup();
  try {
    for (const sid of ['A', 'B', 'A', 'B', 'A']) await t.show(sid);
    assert.strictEqual(t.log.created.length, 2, 'one addon each, made when the entries were created');
    assert.strictEqual(t.log.disposed.length, 0, 'a tab switch disposes nothing within the cap');
    assert.ok(t.window.openSessions.get('A').webglAddon, 'A still renders with WebGL');
    assert.ok(t.window.openSessions.get('B').webglAddon, 'B still renders with WebGL');
  } finally {
    t.destroy();
  }
});

test('the warm cap is a small number, well under the ~16 contexts Chromium allows', () => {
  const t = setup();
  try {
    const cap = t.cap();
    assert.ok(cap >= 2 && cap <= 4, `cap is ${cap}`);
  } finally {
    t.destroy();
  }
});

test('beyond the cap the least recently shown terminal drops its WebGL addon', async () => {
  const t = setup({ sessions: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] });
  try {
    const cap = t.cap();
    const order = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    for (const sid of order) await t.show(sid);
    const live = order.filter((sid) => t.window.openSessions.get(sid).webglAddon);
    assert.deepStrictEqual(live, order.slice(-cap), 'only the most recently shown keep a context');
    assert.strictEqual(t.log.created.length - t.log.disposed.length, cap, 'live contexts equal the cap');
  } finally {
    t.destroy();
  }
});

test('an addon that must be recreated is loaded once the container is visible, never on a display:none element', async () => {
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const t = setup({ sessions });
  try {
    for (const sid of sessions) await t.show(sid);
    assert.strictEqual(t.window.openSessions.get('s1').webglAddon, null, 'precondition: s1 was evicted');
    t.log.loads.length = 0;
    await t.show('s1');
    assert.ok(t.log.loads.length >= 1, 'the evicted terminal gets a context back on reveal');
    assert.ok(t.log.loads.every((l) => l.visible), 'every load happened with .visible set');
    assert.ok(t.window.openSessions.get('s1').webglAddon, 'revealed terminal renders with WebGL');
  } finally {
    t.destroy();
  }
});

test('a context loss falls back to the DOM renderer and the next reveal recreates it once, visible', async () => {
  const t = setup();
  try {
    await t.show('A');
    const entryA = t.window.openSessions.get('A');
    const idA = entryA.webglAddon.id;
    t.log.lossCallbacks.get(idA)();
    assert.strictEqual(entryA.webglAddon, null, 'the lost addon is dropped');
    assert.ok(t.log.disposed.includes(idA), 'and disposed');
    await t.show('B');
    t.log.loads.length = 0;
    await t.show('A');
    assert.strictEqual(t.log.loads.length, 1, 'one new context');
    assert.strictEqual(t.log.loads[0].visible, true);
    assert.ok(entryA.webglAddon);
  } finally {
    t.destroy();
  }
});

test('the reveal frame clears the atlas of a kept-alive addon (#103) but not of one created that frame', async () => {
  const t = setup();
  try {
    await t.show('A');
    await t.show('B');
    t.log.clears = 0;
    await t.show('A');
    assert.strictEqual(t.log.clears, 1, 'a surviving atlas can be stale after display:none');

    await t.show('B');
    const entryB = t.window.openSessions.get('B');
    t.log.lossCallbacks.get(entryB.webglAddon.id)();
    await t.show('A');
    t.log.clears = 0;
    await t.show('B');
    assert.ok(entryB.webglAddon, 'precondition: B got a new addon');
    assert.strictEqual(t.log.clears, 0, 'a new atlas is already clean');
  } finally {
    t.destroy();
  }
});

test('with the trace on, each reveal emits one reveal.timing event with a duration per step', async () => {
  const t = setup({ trace: true });
  try {
    await t.show('A');
    await t.show('B');
    t.traced.length = 0;
    await t.show('A');
    const events = t.traced.filter((e) => e.cat === 'reveal.timing');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sid, 'A');
    const f = events[0].fields;
    for (const key of ['suspendMs', 'replayMs', 'restoreMs', 'visibleMs', 'focusMs', 'rafWaitMs', 'fitMs', 'webglMs', 'repaintMs', 'totalMs']) {
      assert.strictEqual(typeof f[key], 'number', key);
      assert.ok(f[key] >= 0, key);
    }
    assert.strictEqual(typeof f.webglCreated, 'boolean');
    assert.strictEqual(f.webglCreated, false, 'A kept its addon');
    assert.strictEqual(typeof f.webglDisposed, 'number');
  } finally {
    t.destroy();
  }
});

test('the reveal.timing event says whether the reveal created the WebGL context', async () => {
  const t = setup({ trace: true });
  try {
    await t.show('A');
    t.log.lossCallbacks.get(t.window.openSessions.get('A').webglAddon.id)();
    await t.show('B');
    t.traced.length = 0;
    await t.show('A');
    const events = t.traced.filter((e) => e.cat === 'reveal.timing');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].fields.webglCreated, true);
  } finally {
    t.destroy();
  }
});

test('without the trace a reveal emits nothing and reads no clock', async () => {
  const t = setup({ trace: false });
  try {
    await t.show('A');
    let clockReads = 0;
    const realNow = t.window.performance.now.bind(t.window.performance);
    t.window.performance.now = () => { clockReads++; return realNow(); };
    t.traced.length = 0;
    await t.show('B');
    await t.show('A');
    assert.deepStrictEqual(t.traced, []);
    assert.strictEqual(clockReads, 0);
  } finally {
    t.destroy();
  }
});
