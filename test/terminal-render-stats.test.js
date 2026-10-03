const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

function setup({ on }) {
  const h = setupTerminalDom();
  const { window } = h;
  const traced = [];
  const timers = [];
  let atlasCb = null;
  let canvasCb = null;
  window.ATRACE = on;
  window.atrace = (cat, sid, fields) => { traced.push({ cat, sid, fields }); };
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms) => {
    if (ms !== 1000) return realSetTimeout(fn, ms);
    timers.push({ fn, ms });
    return timers.length;
  };
  window.WebglAddon = {
    WebglAddon: class {
      dispose() {}
      onContextLoss() {}
      onChangeTextureAtlas(cb) { atlasCb = cb; }
      onAddTextureAtlasCanvas(cb) { canvasCb = cb; }
    },
  };
  window.activeSessionId = 's1';
  window.createTerminalEntry({ sessionId: 's1' });
  const stats = () => traced.filter((t) => t.cat === 'render.stats');
  return {
    ...h, traced, timers, stats, realSetTimeout,
    fireAtlas: () => atlasCb(),
    fireCanvas: () => canvasCb(),
  };
}

test('with the trace on, writes, batch size and chars are counted and reported once per interval', () => {
  const t = setup({ on: true });
  try {
    t.window.handleTerminalData('s1', 'abc');
    t.window.handleTerminalData('s1', 'de');
    t.window.flushTerminalBuffer('s1');
    t.window.handleTerminalData('s1', 'f');
    t.window.flushTerminalBuffer('s1');

    assert.strictEqual(t.stats().length, 0, 'nothing is sent before the interval ends');
    assert.strictEqual(t.timers.length, 1, 'one interval timer is armed for all of it');
    t.timers[0].fn();

    const lines = t.stats();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].sid, 's1');
    const f = lines[0].fields;
    assert.strictEqual(f.chunks, 3);
    assert.strictEqual(f.chars, 6);
    assert.strictEqual(f.writes, 2);
    assert.strictEqual(f.writeChars, 6);
    assert.strictEqual(f.maxBatchChunks, 2);
    assert.strictEqual(f.maxBatchChars, 5);
    assert.strictEqual(f.hiddenChunks, 0);
    assert.strictEqual(typeof f.ms, 'number');
  } finally {
    t.destroy();
  }
});

test('atlas rebuilds and added atlas canvases are counted separately', () => {
  const t = setup({ on: true });
  try {
    t.fireAtlas();
    t.fireAtlas();
    t.fireCanvas();
    t.timers[0].fn();
    const f = t.stats()[0].fields;
    assert.strictEqual(f.atlasChanges, 2);
    assert.strictEqual(f.atlasCanvases, 1);
  } finally {
    t.destroy();
  }
});

test('a chunk for a hidden session is counted as hidden and writes nothing', () => {
  const t = setup({ on: true });
  try {
    t.window.activeSessionId = 'other';
    t.window.handleTerminalData('s1', 'zz');
    t.timers[0].fn();
    const f = t.stats()[0].fields;
    assert.strictEqual(f.hiddenChunks, 1);
    assert.strictEqual(f.chunks, 1);
    assert.strictEqual(f.writes, 0);
  } finally {
    t.destroy();
  }
});

test('a new interval starts after a report, and an empty interval reports nothing', () => {
  const t = setup({ on: true });
  try {
    t.window.handleTerminalData('s1', 'a');
    t.timers[0].fn();
    assert.strictEqual(t.timers.length, 1, 'no timer is re-armed while nothing happens');
    t.window.handleTerminalData('s1', 'b');
    assert.strictEqual(t.timers.length, 2);
    t.timers[1].fn();
    assert.strictEqual(t.stats().length, 2);
    assert.strictEqual(t.stats()[1].fields.chunks, 1, 'counters restart from zero');
  } finally {
    t.destroy();
  }
});

test('with the trace off nothing is counted, no timer is armed, and the data still flows', () => {
  const t = setup({ on: false });
  try {
    t.window.handleTerminalData('s1', 'abc');
    t.window.flushTerminalBuffer('s1');
    t.fireAtlas();
    assert.strictEqual(t.timers.length, 0, 'no timer');
    assert.strictEqual(t.inCtx('renderStats.size'), 0, 'no per-session record allocated');
    assert.strictEqual(t.traced.length, 0);
    assert.deepStrictEqual(t.spies.writes, ['abc'], 'the write itself is unchanged');
  } finally {
    t.destroy();
  }
});

test('a trace switched off mid-interval drops the report instead of sending it', () => {
  const t = setup({ on: true });
  try {
    t.window.handleTerminalData('s1', 'a');
    t.window.ATRACE = false;
    t.timers[0].fn();
    assert.strictEqual(t.stats().length, 0);
    assert.strictEqual(t.inCtx('renderStats.size'), 0);
  } finally {
    t.destroy();
  }
});

test('revealing a hidden session counts the replay write', () => {
  const t = setup({ on: true });
  try {
    t.window.activeSessionId = 'other';
    t.window.handleTerminalData('s1', 'hidden-data');
    t.window.replayHiddenBuffer('s1');
    t.timers[0].fn();
    const f = t.stats()[0].fields;
    assert.strictEqual(f.writes, 1);
    assert.strictEqual(f.writeChars, 'hidden-data'.length);
    assert.strictEqual(f.hiddenChunks, 1);
  } finally {
    t.destroy();
  }
});

test('two sessions in one window report two lines with separate counts', () => {
  const t = setup({ on: true });
  try {
    t.window.createTerminalEntry({ sessionId: 's2' });
    t.window.handleTerminalData('s1', 'a');
    t.window.handleTerminalData('s2', 'bb');
    t.window.handleTerminalData('s2', 'cc');
    t.timers[0].fn();
    const lines = t.stats();
    assert.strictEqual(t.timers.length, 1, 'one timer serves both sessions');
    assert.strictEqual(lines.length, 2);
    const bySid = Object.fromEntries(lines.map((l) => [l.sid, l.fields]));
    assert.strictEqual(bySid.s1.chunks, 1);
    assert.strictEqual(bySid.s1.chars, 1);
    assert.strictEqual(bySid.s2.chunks, 2);
    assert.strictEqual(bySid.s2.chars, 4);
  } finally {
    t.destroy();
  }
});

test('data for a session with no entry does not throw, is counted as received and never as hidden', () => {
  const t = setup({ on: true });
  try {
    t.window.activeSessionId = 'other';
    assert.doesNotThrow(() => t.window.handleTerminalData('ghost', 'xyz'));
    t.timers[0].fn();
    const f = t.stats()[0].fields;
    assert.strictEqual(t.stats()[0].sid, 'ghost');
    assert.strictEqual(f.chunks, 1);
    assert.strictEqual(f.chars, 3);
    assert.strictEqual(f.hiddenChunks, 0);
    assert.strictEqual(f.writes, 0);
  } finally {
    t.destroy();
  }
});
