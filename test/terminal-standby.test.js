const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTerminalDom } = require('./terminal-manager-harness');

function setup() {
  const intervals = [];
  const reports = [];
  let requestBacklog;
  const h = setupTerminalDom({ beforeLoad: window => {
    window.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  }, api: {
    onTerminalBacklogRequest: callback => { requestBacklog = callback; },
    reportTerminalBacklog: report => reports.push(report),
  } });
  const timers = new Map();
  const frames = new Map();
  let id = 10000;
  h.window.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  h.window.clearTimeout = key => timers.delete(key);
  h.window.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  h.window.cancelAnimationFrame = key => frames.delete(key);
  h.window.activeSessionId = 'session-123456789';
  h.window.createTerminalEntry({ sessionId: h.window.activeSessionId });
  return { ...h, timers, frames, intervals, reports, requestBacklog: () => requestBacklog?.(), send: data => h.window.handleTerminalData(h.window.activeSessionId, data) };
}

test('visible backlog is bounded and retains the last safe redraw', () => {
  const h = setup();
  try {
    h.send('x'.repeat(3 * 1024 * 1024));
    h.send('\x1b[2Jfinal screen');
    h.send('y'.repeat(2 * 1024 * 1024));
    const pending = h.inCtx('terminalWriteBuffers.get(activeSessionId).chunks.join(\'\')');
    assert.ok(pending.length <= 2 * 1024 * 1024, 'visible backlog stays within 4 MiB of UTF-16 storage');
    h.send('\x1b[2Jnewest');
    h.window.flushTerminalBuffer(h.window.activeSessionId);
    assert.match(h.spies.writes.at(-1), /\x1b\[2Jnewest(?:\x1b\[\?2026l)?$/);
  } finally { h.destroy(); }
});

test('a stalled animation frame drains once from a bounded timer', () => {
  const h = setup();
  try {
    h.send('pending');
    const fallback = [...h.timers.values()].find(t => t.ms <= 1000);
    assert.ok(fallback, 'stalled rAF has a timer fallback within one second');
    fallback.fn();
    assert.deepEqual(h.spies.writes, ['pending']);
    assert.equal(h.frames.size, 0);
  } finally { h.destroy(); }
});

test('continuous chunks do not postpone the stalled-frame deadline', () => {
  const h = setup();
  try {
    h.send('a');
    const first = [...h.timers.keys()][0];
    h.send('b');
    h.send('c');
    assert.ok(h.timers.has(first), 'new chunks retain the original fallback deadline');
    h.timers.get(first).fn();
    assert.deepEqual(h.spies.writes, ['abc']);
  } finally { h.destroy(); }
});

test('overflow without a redraw resets and keeps an ANSI-safe tail', () => {
  const h = setup();
  try {
    h.send('x'.repeat(3 * 1024 * 1024) + '\x1b]0;' + 'z'.repeat(3 * 1024 * 1024) + '\x07tail');
    h.window.flushTerminalBuffer(h.window.activeSessionId);
    assert.equal(h.spies.reset, 1, 'unsafe overflow resets xterm before replay');
    assert.match(h.spies.writes.at(-1), /tail(?:\x1b\[\?2026l)?$/);
    assert.ok(h.spies.writes.at(-1).length <= 2 * 1024 * 1024);
  } finally { h.destroy(); }
});

test('a main request reports bounded pending counts without terminal contents or polling', () => {
  const h = setup();
  try {
    h.send('secret');
    h.send('123');
    h.window.createTerminalEntry({ sessionId: 'hidden-123456789' });
    h.window.handleTerminalData('hidden-123456789', 'hidden secret');
    h.requestBacklog();
    assert.equal(h.reports.length, 1, 'main request produces one backlog summary');
    assert.equal(h.reports[0].sessions[0].id, 'session-');
    assert.equal(h.reports[0].sessions[0].chunks, 2);
    assert.equal(h.reports[0].sessions[0].chars, 9);
    assert.equal(h.reports[0].sessions[1].id, 'hidden-1');
    assert.equal(h.reports[0].sessions[1].chunks, 1);
    assert.equal(h.reports[0].sessions[1].chars, 13);
    assert.ok(!JSON.stringify(h.reports).includes('secret'));
    assert.equal(h.intervals.length, 0, 'backlog diagnostics install no polling interval');
  } finally { h.destroy(); }
});

test('overflow at a full redraw preserves the latest frame without resetting xterm', () => {
  const h = setup();
  try {
    h.send('old'.repeat(1024 * 1024) + '\x1b[2J\x1b[Hlatest frame');
    h.window.flushTerminalBuffer(h.window.activeSessionId);
    assert.equal(h.spies.reset, 0);
    assert.match(h.spies.writes[0], /\x1b\[2J\x1b\[Hlatest frame/);
    assert.ok(h.spies.writes[0].length < 100, 'only the self-contained latest frame is written');
  } finally { h.destroy(); }
});

test('tiny chunks coalesce without moving the fallback deadline or losing data', () => {
  const h = setup();
  try {
    for (let i = 0; i < 5000; i++) h.send('a');
    assert.ok(h.inCtx('terminalWriteBuffers.get(activeSessionId).chunks.length') <= 4096);
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0].fn();
    assert.deepEqual(h.spies.writes, ['a'.repeat(5000)]);
  } finally { h.destroy(); }
});

test('a trimmed sync update stays buffered until its end, with its original safety timer', () => {
  const h = setup();
  try {
    h.send('\x1b[?2026hbefore');
    const timer = [...h.timers.keys()][0];
    h.send('x'.repeat(3 * 1024 * 1024) + '\x1b[2Jframe');
    assert.equal(h.frames.size, 0);
    assert.ok(h.timers.has(timer));
    assert.equal(h.timers.get(timer).ms, 500);
    assert.equal(h.spies.write, 0);
    const pending = h.inCtx('terminalWriteBuffers.get(activeSessionId).chunks.join(\'\')');
    assert.ok(pending.includes('\x1b[?2026h'), 'retained frame keeps synchronized-update start');
    assert.ok(!pending.endsWith('\x1b[?2026l'), 'open update remains open');
    h.send('finished\x1b[?2026l');
    assert.equal(h.frames.size, 1);
    [...h.frames.values()][0]();
    assert.equal(h.spies.write, 1);
    assert.match(h.spies.writes[0], /framefinished\x1b\[\?2026l$/);
  } finally { h.destroy(); }
});

test('a trimmed visible queue carries its reset into hidden replay', () => {
  const h = setup();
  try {
    h.send('x'.repeat(3 * 1024 * 1024) + '\x1b]0;' + 'z'.repeat(3 * 1024 * 1024) + '\x07safe-tail');
    h.window.activeSessionId = 'other';
    h.window.handleTerminalData('session-123456789', 'hidden-tail');
    assert.equal(h.spies.write, 0);
    assert.equal(h.timers.size, 0);
    h.window.activeSessionId = 'session-123456789';
    h.window.replayHiddenBuffer('session-123456789');
    assert.equal(h.spies.reset, 1);
    assert.ok(h.spies.writes[0].endsWith('hidden-tail'));
  } finally { h.destroy(); }
});

test('rekey preserves a stalled-frame fallback and destruction cancels both callbacks', () => {
  const h = setup();
  try {
    h.send('retained');
    const entry = h.window.openSessions.get(h.window.activeSessionId);
    h.window.openSessions.delete(h.window.activeSessionId);
    h.window.openSessions.set('new-id', entry);
    h.window.rekeyTerminalBuffers(h.window.activeSessionId, 'new-id');
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0].fn();
    assert.deepEqual(h.spies.writes, ['retained']);
    h.window.activeSessionId = 'new-id';
    h.send('cancelled');
    h.window.destroySession('new-id');
    assert.equal(h.timers.size, 0);
    assert.equal(h.frames.size, 0);
    assert.deepEqual(h.spies.writes, ['retained']);
  } finally { h.destroy(); }
});

test('ordinary animation frames preserve cadence and cancel their fallback', () => {
  const h = setup();
  try {
    let now = 100;
    h.window.performance.now = () => now;
    h.send('a');
    [...h.frames.values()][0]();
    assert.equal(h.timers.size, 0);
    now = 110;
    h.send('b');
    const throttle = [...h.timers.values()][0];
    assert.equal(throttle.ms, 23);
    now = 133;
    throttle.fn();
    [...h.frames.values()][0]();
    assert.deepEqual(h.spies.writes, ['a', 'b']);
  } finally { h.destroy(); }
});

test('grid and panel sessions share the visible payload bound', () => {
  for (const mode of ['grid', 'panel']) {
    const h = setup();
    try {
      if (mode === 'grid') h.inCtx('gridViewActive = true');
      else {
        h.window.openSessions.get(h.window.activeSessionId).panelMounted = true;
        h.window.activeSessionId = 'other';
      }
      h.window.handleTerminalData('session-123456789', 'x'.repeat(3 * 1024 * 1024));
      const pending = h.inCtx('terminalWriteBuffers.get("session-123456789").chunks.join(\'\')');
      assert.ok(pending.length <= 2 * 1024 * 1024, `${mode} backlog stays bounded`);
    } finally { h.destroy(); }
  }
});

test('backlog summaries include at most twenty sessions and count omitted sessions', () => {
  const h = setup();
  try {
    h.inCtx(`for (let i = 0; i < 30; i++) terminalWriteBuffers.set('session-' + i, { chunks: ['abc'], chars: 3 })`);
    h.requestBacklog();
    assert.equal(h.reports.length, 1, 'main request produces a bounded summary');
    assert.equal(h.reports[0].sessions.length, 20);
    assert.equal(h.reports[0].omitted, 10);
    assert.ok(JSON.stringify(h.reports[0]).length < 2048);
  } finally { h.destroy(); }
});

for (const mode of ['visible', 'hidden']) {
  test(`${mode} overflow amortizes trim work across subsequent chunks`, () => {
    const h = setup();
    try {
      if (mode === 'hidden') h.window.activeSessionId = 'other';
      const send = data => h.window.handleTerminalData('session-123456789', data);
      send('x'.repeat(2 * 1024 * 1024));
      let trims = 0;
      const trim = h.window.trimHiddenBuffer;
      h.window.trimHiddenBuffer = (...args) => { trims++; return trim(...args); };
      for (let i = 0; i < 256; i++) send('y'.repeat(4096));
      assert.ok(trims <= 4, `${mode}: at most four trims per Mi units appended, got ${trims}`);
      if (mode === 'visible') h.window.flushTerminalBuffer('session-123456789');
      else h.window.replayHiddenBuffer('session-123456789');
      assert.ok(h.spies.writes.at(-1).includes('y'.repeat(4096)), 'recent output survives amortized trimming');
    } finally { h.destroy(); }
  });

  test(`${mode} reset restores enabled DEC modes before the retained tail`, () => {
    const h = setup();
    try {
      h.send('\x1b[?2004;1004;1000;1002;1003;1006;1;1049;47;25h');
      h.window.flushTerminalBuffer(h.window.activeSessionId);
      h.spies.writes.length = 0;
      if (mode === 'hidden') h.window.activeSessionId = 'other';
      h.window.handleTerminalData('session-123456789', 'x'.repeat(3 * 1024 * 1024) + 'retained-tail');
      if (mode === 'visible') h.window.flushTerminalBuffer('session-123456789');
      else h.window.replayHiddenBuffer('session-123456789');
      assert.equal(h.spies.reset, 1);
      const written = h.spies.writes.join('');
      for (const decMode of [2004, 1004, 1000, 1002, 1003, 1006, 1, 1049, 47]) {
        assert.ok(written.includes(`\x1b[?${decMode}h`), `reset restores DEC mode ${decMode}`);
        assert.ok(written.indexOf(`\x1b[?${decMode}h`) < written.indexOf('x'), 'mode restoration precedes retained output');
      }
      assert.ok(!written.includes('\x1b[?25h'), 'only allowlisted modes are restored');
    } finally { h.destroy(); }
  });
}

test('a reset respects the latest split DEC reset and per-session mode state', () => {
  const h = setup();
  try {
    h.send('\x1b[?2004;1000h');
    h.window.flushTerminalBuffer(h.window.activeSessionId);
    h.send('\x1b[?200');
    h.send('4l\x1b[?1006h');
    h.send('x'.repeat(3 * 1024 * 1024));
    h.window.flushTerminalBuffer(h.window.activeSessionId);
    const written = h.spies.writes.at(-1);
    assert.ok(written.includes('\x1b[?1000h'), 'mouse tracking remains enabled');
    assert.ok(written.includes('\x1b[?1006h'), 'newest mode state is restored');
    assert.ok(!written.includes('\x1b[?2004h'), 'a split reset keeps bracketed paste disabled');
    h.window.createTerminalEntry({ sessionId: 'other' });
    h.window.handleTerminalData('other', 'x'.repeat(3 * 1024 * 1024));
    h.window.replayHiddenBuffer('other');
    assert.ok(!h.spies.writes.at(-1).includes('\x1b[?1000h'), 'mode state does not leak across sessions');
  } finally { h.destroy(); }
});

test('visibility reports once after more than sixty seconds hidden and never polls', () => {
  const h = setup();
  try {
    let now = 1000;
    let hidden = false;
    h.window.Date.now = () => now;
    Object.defineProperty(h.window.document, 'hidden', { get: () => hidden, configurable: true });
    const change = () => h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
    change();
    assert.equal(h.reports.length, 0);
    hidden = true;
    change();
    now += 60000;
    hidden = false;
    change();
    assert.equal(h.reports.length, 0, 'sixty seconds exactly is below the reporting threshold');
    hidden = true;
    change();
    now += 60001;
    hidden = false;
    change();
    assert.equal(h.reports.length, 1, 'a long hidden period produces one summary');
    assert.equal(h.reports[0].gapMs, 60001);
    change();
    assert.equal(h.reports.length, 1, 'duplicate visible events do not repeat the summary');
    assert.equal(h.intervals.length, 0, 'visibility diagnostics install no polling interval');
  } finally { h.destroy(); }
});

test('entering a sync block replaces the pending fallback with its safety timer', () => {
  const h = setup();
  try {
    h.send('ordinary');
    const fallback = [...h.timers.keys()][0];
    h.send('\x1b[?2026hframe');
    assert.ok(!h.timers.has(fallback));
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, 500);
  } finally { h.destroy(); }
});
