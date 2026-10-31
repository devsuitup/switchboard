'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCanvas } = require('@napi-rs/canvas');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { appendToOutputBuffer, MAX_BUFFER_SIZE } = require('../src/main/terminals/output-buffer');
const { removeCursorPositionQueries, splitReplayQuery } = require('../public/terminal-replay-queries');

const queries = [
  ['CPR', '\x1b[6n', true],
  ['DECXCPR', '\x1b[?6n', true],
  ['DA1', '\x1b[c', true],
  ['DA1 zero', '\x1b[0c', true],
  ['DA2', '\x1b[>c', true],
  ['DA2 zero', '\x1b[>0c', true],
  ['XTVERSION', '\x1b[>q', false],
  ['XTVERSION zero', '\x1b[>0q', false],
  ['DSR status', '\x1b[5n', true],
  ['DECRQM private', '\x1b[?2026$p', true],
  ['DECRQM ANSI', '\x1b[4$p', true],
  ['DECRQM unknown mode', '\x1b[?123456789$p', true],
  ...[10, 11, 12].flatMap(code => [
    [`OSC ${code} BEL`, `\x1b]${code};?\x07`, true],
    [`OSC ${code} ST`, `\x1b]${code};?\x1b\\`, true],
  ]),
  ...['4;1;?', '4;1;?;255;?', '10;?;?', '10;?;?;?', '11;?;?'].flatMap(params => [
    [`OSC ${params} BEL`, `\x1b]${params}\x07`, true],
    [`OSC ${params} ST`, `\x1b]${params}\x1b\\`, true],
  ]),
  ...['m', 'r', ' q', '"q', '"p', 'unknown'].map(selector => [
    `DECRQSS ${selector}`, `\x1bP$q${selector}\x1b\\`, true,
  ]),
];

test('split replay search scans at most 256 code units of accumulated output per append', t => {
  const lastIndexOf = String.prototype.lastIndexOf;
  let scanned = 0;
  const spy = t.mock.method(String.prototype, 'lastIndexOf', function (...args) {
    scanned += this.length;
    return lastIndexOf.apply(this, args);
  });
  try {
    for (const previous of [
      '\x1b[0m' + 'x'.repeat(2 * 1024 * 1024),
      ['\x1b[0m' + 'x'.repeat(MAX_BUFFER_SIZE)],
      ['\x1b[0m', ...Array(64).fill('x'.repeat(80))],
    ]) {
      scanned = 0;
      assert.equal(splitReplayQuery(previous, 'x'.repeat(80)), null);
      assert.ok(scanned <= 256, `backward search scanned ${scanned} code units`);
    }
  } finally { spy.mock.restore(); }
});

test('split replay queries at the 256-unit boundary are filtered and longer prefixes are retained', () => {
  for (const prefix of ['\x1b[?' + '1'.repeat(252) + '$', '\x1bP$q' + 'm'.repeat(251) + '\x1b']) {
    const next = prefix.startsWith('\x1b[') ? 'p' : '\\';
    for (const previous of [prefix, [...prefix]]) {
      assert.deepEqual(splitReplayQuery(previous, next), { prefix: 256, remainder: 1 });
    }
    const longer = prefix.slice(0, 4) + '1' + prefix.slice(4);
    for (const previous of [longer, [...longer]]) {
      assert.equal(splitReplayQuery(previous, next), null);
    }
  }
});

function realTerminal() {
  const ctx = setupTerminalDom();
  const canvases = new WeakMap();
  ctx.window.HTMLCanvasElement.prototype.getContext = function (type) {
    if (!canvases.has(this)) canvases.set(this, createCanvas(this.width, this.height));
    return canvases.get(this).getContext(type);
  };
  ctx.window.matchMedia = () => Object.assign(new ctx.window.EventTarget(), {
    matches: false, addListener() {}, removeListener() {},
  });
  vm.runInContext(fs.readFileSync(require.resolve('@xterm/xterm'), 'utf8'), ctx.context);
  const terminal = new ctx.window.Terminal({ cols: 80, rows: 24 });
  const element = ctx.window.document.createElement('div');
  ctx.window.document.body.append(element);
  terminal.open(element);
  ctx.window.openSessions.set('replay', {
    terminal, element, session: { sessionId: 'replay' }, pendingWrittenRenders: 0, renderedWrittenWatermark: 0,
  });
  ctx.window.activeSessionId = 'other';
  const answers = [];
  terminal.onData(data => answers.push(data));
  const written = [];
  const write = terminal.write.bind(terminal);
  terminal.write = (data, callback) => { written.push(data); write(data, callback); };
  return {
    ...ctx, terminal, answers, written,
    settle: () => new Promise(resolve => write('\x1b[0m', resolve)),
    destroy() { terminal.dispose(); ctx.destroy(); },
  };
}

for (const path of ['reattach', 'hidden']) {
  for (const [name, query, answered] of queries) {
    test(`${path}: ${name} replay never makes real xterm answer, whole or split`, async () => {
      const ctx = realTerminal();
      try {
        ctx.terminal.write(query);
        await ctx.settle();
        assert.equal(ctx.answers.length > 0, answered, 'raw xterm capability control');
        ctx.answers.length = 0;
        const partitions = [[query], [...query]];
        for (let split = 1; split < query.length; split++) {
          partitions.push([query.slice(0, split), query.slice(split)]);
        }
        for (const parts of partitions) {
          const chunks = ['A', ...parts, 'B'];
          ctx.written.length = 0;
          if (path === 'reattach') {
            const state = { outputBuffer: [], outputBufferSize: 0 };
            for (const chunk of chunks) appendToOutputBuffer(state, chunk, MAX_BUFFER_SIZE);
            for (const chunk of state.outputBuffer) ctx.terminal.write(chunk);
            assert.equal(state.outputBufferSize, state.outputBuffer.join('').length);
          } else {
            for (const chunk of chunks) ctx.window.handleTerminalData('replay', chunk);
            ctx.window.replayHiddenBuffer('replay');
          }
          await ctx.settle();
          assert.deepEqual(ctx.answers, [], `${name}, chunks ${JSON.stringify(parts)} must not reply into PTY`);
          assert.equal(ctx.written.join(''), 'AB', 'only the query is removed');
        }
      } finally { ctx.destroy(); }
    });
  }
}

test('pending live output replies once, but its hidden reveal drain never replies again', async () => {
  const ctx = realTerminal();
  try {
    const data = queries.map(([, query]) => query).join('');
    ctx.window.activeSessionId = 'replay';
    ctx.window.handleTerminalData('replay', data);
    ctx.window.flushTerminalBuffer('replay');
    await ctx.settle();
    assert.ok(ctx.answers.includes('\x1b[>0;276;0c'), 'live DA2 reaches the current requester');
    const liveAnswers = [...ctx.answers];
    ctx.answers.length = 0;
    ctx.window.handleTerminalData('replay', data);
    ctx.window.activeSessionId = 'other';
    ctx.window.replayHiddenBuffer('replay');
    await ctx.settle();
    assert.deepEqual(ctx.answers, [], 'stale pending output never replies');
    ctx.window.activeSessionId = 'replay';
    ctx.window.handleTerminalData('replay', data);
    ctx.window.flushTerminalBuffer('replay');
    await ctx.settle();
    assert.deepEqual(ctx.answers, liveAnswers, 'live output still answers after replay');
  } finally { ctx.destroy(); }
});

test('replay keeps non-query sequences, responses, colour setters and unhandled kitty detection intact', () => {
  const data = [
    '\x1b[>1c', '\x1b[>1q', '\x1b[10c', '\x1b[16n', '\x1b[?5n', '\x1b[?u',
    '\x1b[6;1H', '\x1b[?2026h', '\x1b[?2026;1$y', '\x1b[?1;2c', '\x1b[>0;276;0c',
    '\x1b[?73;3R', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b]11;#112233\x1b\\',
    '\x1b]12;#abcdef\x07', '\x1b]0;title?\x07', '\x1bP1$rm\x1b\\',
    '\x1b]4;1;#112233\x07', '\x1b]4;1;rgb:ffff/ffff/ffff\x1b\\',
    '\x1b]10;#112233;?\x07', '\x1b]4;1;?;2;#112233\x1b\\',
    '\x1b[?2026$', '\x1b]10;?', '\x1bP$qm',
  ].join('');
  assert.equal(removeCursorPositionQueries(data), data);
  for (let split = 1; split < data.length; split++) {
    const state = { outputBuffer: [], outputBufferSize: 0 };
    appendToOutputBuffer(state, data.slice(0, split), MAX_BUFFER_SIZE);
    appendToOutputBuffer(state, data.slice(split), MAX_BUFFER_SIZE);
    assert.equal(state.outputBuffer.join(''), data);
    assert.equal(state.outputBufferSize, data.length);
  }
});

test('unhandled kitty keyboard detection produces no xterm data event', async () => {
  const ctx = realTerminal();
  try {
    ctx.terminal.write('\x1b[?u');
    await ctx.settle();
    assert.deepEqual(ctx.answers, []);
  } finally { ctx.destroy(); }
});
