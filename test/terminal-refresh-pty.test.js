'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTmuxAttachAdapter } = require('../remote-attach');

function handler() {
  return require('../terminal-resize').createTerminalResizeHandler;
}

function fixture() {
  const calls = [];
  const tasks = new Map();
  let token = 0;
  const session = { pty: { resize(cols, rows) { calls.push({ cols, rows }); } }, exited: false };
  const sessions = new Map([['s', session]]);
  const resize = handler()(sessions, {
    setTimeout(cb) { tasks.set(++token, cb); return token; },
    clearTimeout(id) { tasks.delete(id); },
  });
  const flush = () => { for (const [id, cb] of [...tasks]) { tasks.delete(id); cb(); } };
  return { calls, tasks, session, sessions, resize, flush };
}

test('one refresh request nudges and finishes at the fitted PTY size', () => {
  const ctx = fixture();
  ctx.resize('s', 120, 40, true);
  assert.deepEqual(ctx.calls, [{ cols: 120, rows: 40 }, { cols: 119, rows: 40 }]);
  assert.equal(ctx.tasks.size, 1);
  ctx.flush();
  assert.deepEqual(ctx.calls.at(-1), { cols: 120, rows: 40 });
  assert.equal(ctx.tasks.size, 0);
});

test('a lost final resize is retried without another renderer request', () => {
  const ctx = fixture();
  let size;
  let lose = false;
  ctx.session.pty.resize = (cols, rows) => {
    if (lose) { lose = false; throw new Error('lost resize'); }
    size = { cols, rows };
  };
  ctx.resize('s', 120, 40, true);
  assert.deepEqual(size, { cols: 119, rows: 40 });
  lose = true;
  ctx.flush();
  assert.deepEqual(size, { cols: 120, rows: 40 });
});

test('a later fit supersedes the nudge and its stale restoration', () => {
  const ctx = fixture();
  ctx.resize('s', 120, 40, true);
  assert.equal(ctx.tasks.size, 1);
  ctx.resize('s', 150, 35);
  ctx.flush();
  assert.deepEqual(ctx.calls.at(-1), { cols: 150, rows: 35 });
  assert.equal(ctx.tasks.size, 0);
});

test('a lost newer fit during a nudge is retried at the newest fitted size', () => {
  const ctx = fixture();
  ctx.resize('s', 120, 40, true);
  let lost = false;
  ctx.session.pty.resize = (cols, rows) => {
    if (!lost) { lost = true; throw new Error('lost newer fit'); }
    ctx.calls.push({ cols, rows });
  };
  ctx.resize('s', 150, 35);
  ctx.flush();
  assert.deepEqual(ctx.calls.at(-1), { cols: 150, rows: 35 });
});

test('a pending first-open nudge cannot overwrite a newer fit or double a refresh', () => {
  const ctx = fixture();
  ctx.session.firstResize = true;
  ctx.resize('s', 120, 40);
  ctx.resize('s', 150, 35, true);
  ctx.flush();
  ctx.flush();
  assert.deepEqual(ctx.calls, [{ cols: 120, rows: 40 }, { cols: 150, rows: 35 }, { cols: 149, rows: 35 }, { cols: 150, rows: 35 }]);
});

test('a one-column terminal still receives a real size change and returns to one column', () => {
  const ctx = fixture();
  ctx.resize('s', 1, 2, true);
  assert.deepEqual(ctx.calls.at(-1), { cols: 2, rows: 2 });
  ctx.flush();
  assert.deepEqual(ctx.calls.at(-1), { cols: 1, rows: 2 });
});

test('invalid sizes, exited sessions and replaced PTYs receive no deferred resize', () => {
  const ctx = fixture();
  for (const cols of [0, -1, NaN, Infinity, 1.5]) ctx.resize('s', cols, 40, true);
  for (const rows of [0, -1, NaN, Infinity, 1.5]) ctx.resize('s', 120, rows, true);
  ctx.resize('missing', 120, 40, true);
  assert.deepEqual(ctx.calls, []);
  ctx.resize('s', 120, 40, true);
  const count = ctx.calls.length;
  ctx.sessions.set('s', { pty: { resize() { throw new Error('replacement touched'); } } });
  ctx.flush();
  assert.equal(ctx.calls.length, count);
  ctx.session.exited = true;
  ctx.sessions.set('s', ctx.session);
  ctx.resize('s', 120, 40, true);
  assert.equal(ctx.calls.length, count);
});

test('a PTY exit during the nudge prevents deferred restoration', () => {
  const ctx = fixture();
  ctx.resize('s', 120, 40, true);
  const count = ctx.calls.length;
  ctx.session.exited = true;
  ctx.flush();
  assert.equal(ctx.calls.length, count);
});

test('plain terminals skip the automatic first nudge but accept an explicit refresh', () => {
  const ctx = fixture();
  ctx.session.firstResize = true;
  ctx.session.isPlainTerminal = true;
  ctx.resize('s', 120, 40);
  assert.equal(ctx.tasks.size, 0);
  ctx.resize('s', 120, 40, true);
  ctx.flush();
  assert.deepEqual(ctx.calls.slice(1), [{ cols: 120, rows: 40 }, { cols: 119, rows: 40 }, { cols: 120, rows: 40 }]);
});

test('remote refresh nudges solo attach and never resizes shared attach', async () => {
  for (const clientCount of [0, 1]) {
    const calls = [];
    const raw = { resize(cols, rows) { calls.push({ cols, rows }); }, onExit() {}, onData() {}, write() {}, kill() {} };
    const adapter = createTmuxAttachAdapter({
      spawnPty: () => raw,
      runRemoteCommand: async () => ({ code: 0, stdout: ['/tmp/tmux-0/fixture', '200x50', 'status off', 'mouse on', 'window-size latest', '', '', String(clientCount), '1'].join('\u0001'), stderr: '' }),
    });
    const attached = await adapter.attach('fixture', { pid: 42, tmux: 'main:@0.%0' }, { cols: 120, rows: 40 });
    assert.equal(attached.ok, true);
    const tasks = [];
    const resize = handler()(new Map([['s', { pty: attached.ptyProcess }]]), { setTimeout: (cb) => { tasks.push(cb); return tasks.length; }, clearTimeout() {} });
    resize('s', 120, 40, true);
    tasks.shift()();
    assert.deepEqual(calls, clientCount === 0 ? [{ cols: 120, rows: 40 }, { cols: 119, rows: 40 }, { cols: 120, rows: 40 }] : [], `clientCount=${clientCount}`);
  }
});

test('a thrown remote restoration reaches the guarded retry and restores the attach PTY', async () => {
  let size;
  let attempts = 0;
  const raw = { resize(cols, rows) {
    if (++attempts === 3) throw new Error('lost remote restoration');
    size = { cols, rows };
  }, onExit() {}, onData() {}, write() {}, kill() {} };
  const adapter = createTmuxAttachAdapter({ spawnPty: () => raw,
    runRemoteCommand: async () => ({ code: 0, stdout: ['/tmp/tmux-0/fixture', '200x50', 'status off', '', '', '', '', '0', '1'].join('\u0001') }),
  });
  const attached = await adapter.attach('fixture', { pid: 42, tmux: 'main:@0.%0' }, { cols: 120, rows: 40 });
  assert.equal(attached.ok, true);
  const tasks = [];
  const resize = handler()(new Map([['s', { pty: attached.ptyProcess }]]), { setTimeout: (cb) => { tasks.push(cb); return tasks.length; }, clearTimeout() {} });
  resize('s', 120, 40, true);
  tasks.shift()();
  assert.equal(attempts, 4);
  assert.deepEqual(size, { cols: 120, rows: 40 });
});

test('PTY resize rejects dimensions above the existing allocation bounds', () => {
  const { MAX_COLS, MAX_ROWS } = require('../pty-size');
  const ctx = fixture();
  for (const refresh of [false, true]) {
    ctx.resize('s', MAX_COLS + 1, 40, refresh);
    ctx.resize('s', 120, MAX_ROWS + 1, refresh);
    ctx.resize('s', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, refresh);
  }
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.tasks.size, 0);
  ctx.resize('s', MAX_COLS, MAX_ROWS, true);
  ctx.flush();
  assert.deepEqual(ctx.calls.at(-1), { cols: MAX_COLS, rows: MAX_ROWS });
});

test('the first-open nudge stays inside the PTY column upper bound', () => {
  const { MAX_COLS, MAX_ROWS } = require('../pty-size');
  const ctx = fixture();
  ctx.session.firstResize = true;
  ctx.resize('s', MAX_COLS, MAX_ROWS);
  ctx.flush();
  ctx.flush();
  assert.ok(ctx.calls.every(({ cols, rows }) => cols <= MAX_COLS && rows <= MAX_ROWS));
  assert.deepEqual(ctx.calls, [{ cols: MAX_COLS, rows: MAX_ROWS }, { cols: MAX_COLS - 1, rows: MAX_ROWS }, { cols: MAX_COLS, rows: MAX_ROWS }]);
});

test('only boolean true requests a refresh nudge and forced retry', () => {
  for (const refresh of [1, 'true', {}, [], false, null, undefined]) {
    const ctx = fixture();
    ctx.resize('s', 120, 40, refresh);
    assert.deepEqual(ctx.calls, [{ cols: 120, rows: 40 }]);
    assert.equal(ctx.tasks.size, 0);
    ctx.resize('s', 150, 35, true);
    ctx.flush();
    assert.deepEqual(ctx.calls.slice(1), [{ cols: 150, rows: 35 }, { cols: 149, rows: 35 }, { cols: 150, rows: 35 }]);
  }
});
