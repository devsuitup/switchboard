const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTerminalDom } = require('./terminal-manager-harness');

function setup() {
  const intervals = [];
  const h = setupTerminalDom({ beforeLoad: window => {
    window.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
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
  return { ...h, timers, frames, intervals, send: data => h.window.handleTerminalData(h.window.activeSessionId, data) };
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

test('a renderer timer gap reports bounded pending counts without terminal contents', () => {
  const h = setup();
  try {
    const reports = [];
    h.window.api.reportTerminalGap = report => reports.push(report);
    h.send('secret');
    h.send('123');
    h.window.Date.now = () => 1000000000000000;
    const interval = h.intervals.find(t => t.ms === 1000);
    assert.ok(interval, 'renderer installs a timer-gap observer');
    interval.fn();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sessions[0].id, 'session-');
    assert.equal(reports[0].sessions[0].chunks, 2);
    assert.equal(reports[0].sessions[0].chars, 9);
    assert.ok(reports[0].gapMs > 5000);
    assert.ok(!JSON.stringify(reports).includes('secret'));
    interval.fn();
    assert.equal(reports.length, 1);
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

test('gap summaries include at most twenty sessions and count omitted sessions', () => {
  const h = setup();
  try {
    const reports = [];
    h.window.api.reportTerminalGap = report => reports.push(report);
    h.inCtx(`for (let i = 0; i < 30; i++) terminalWriteBuffers.set('session-' + i, { chunks: ['abc'], chars: 3 })`);
    h.window.Date.now = () => 1000000000000000;
    assert.equal(typeof h.window.checkTerminalTimerGap, 'function');
    h.window.checkTerminalTimerGap();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sessions.length, 20);
    assert.equal(reports[0].omitted, 10);
    assert.ok(JSON.stringify(reports[0]).length < 2048);
  } finally { h.destroy(); }
});
