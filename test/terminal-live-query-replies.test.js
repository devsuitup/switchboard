'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTerminalDom } = require('./terminal-manager-harness');

const DA2_QUERY = '\x1b[>0c';
const DA2_REPLY = '\x1b[>0;276;0c';

function setup(t) {
  const sent = [];
  const ctx = setupTerminalDom({ api: { sendInput: (id, data) => sent.push({ id, data }) } });
  t.after(ctx.destroy);
  let now = 0;
  ctx.window.performance.now = () => now;
  const entry = ctx.window.createTerminalEntry({ sessionId: 'live' });
  ctx.window.activeSessionId = 'live';
  return {
    ...ctx, entry, sent,
    input: data => entry.terminal._onData(data),
    output: data => ctx.window.handleTerminalData(entry.session.sessionId, data),
    time: value => { now = value; },
  };
}

test('DA2 reply without a live query is dropped', t => {
  const ctx = setup(t);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [], 'unsolicited DA2 must not reach the PTY');
});

test('timely DA2 replies pass through the 4000 ms boundary, then expire', t => {
  const ctx = setup(t);
  ctx.output(DA2_QUERY);
  ctx.time(4000);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [{ id: 'live', data: DA2_REPLY }]);
  ctx.sent.length = 0;
  ctx.time(4001);
  ctx.input(DA2_REPLY);
  ctx.time(5000);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [], 'late DA2 must not reach the PTY');
});

const replies = [
  '\x1b[?1;2c', DA2_REPLY, '\x1b[12;34R', '\x1b[0n',
  '\x1b]10;rgb:ffff/ABCD/0000\x07', '\x1b]11;rgb:ff/aa/00\x1b\\',
  '\x1b[?2026;1$y', '\x1b[4;2$y',
];

test('all supported reply forms and concatenated replies are dropped only when stale', t => {
  const ctx = setup(t);
  for (const reply of [...replies, replies.join('')]) ctx.input(reply);
  assert.deepEqual(ctx.sent, []);
  ctx.output(DA2_QUERY);
  for (const reply of [...replies, replies.join('')]) ctx.input(reply);
  assert.deepEqual(ctx.sent.map(item => item.data), [...replies, replies.join('')]);
});

test('normal input, keys, paste, incomplete replies and mixed bytes pass unchanged', t => {
  const ctx = setup(t);
  const inputs = [
    'hello', ';276;0c', '\x1b[A', '\x1b[200~pasted ;276;0c\x1b[201~',
    '\x1b[200~' + DA2_REPLY + '\x1b[201~', DA2_REPLY + 'x', 'x' + DA2_REPLY,
    DA2_REPLY + '\n', DA2_REPLY + '\r', DA2_REPLY.slice(0, -1), '',
    '\x1b[?12;34R', '\x1b]12;rgb:ff/aa/00\x07', '\x1b[1n',
  ];
  for (const input of inputs) ctx.input(input);
  assert.deepEqual(ctx.sent.map(item => item.data), inputs);
});

test('focus reports retain their existing exact-chunk filtering', t => {
  const ctx = setup(t);
  ctx.input('\x1b[I');
  ctx.input('\x1b[O');
  ctx.input('\x1b[Ix');
  assert.deepEqual(ctx.sent, [{ id: 'live', data: '\x1b[Ix' }]);
});

const queries = [
  '\x1b[c', '\x1b[0c', '\x1b[>c', DA2_QUERY, '\x1b[>q', '\x1b[>0q',
  '\x1b[6n', '\x1b[?6n', '\x1b[5n', '\x1b[?2026$p', '\x1b[4$p',
  '\x1b]10;?\x07', '\x1b]11;?\x1b\\',
];

test('every recognised live query arms replies whole, at every split and byte by byte', t => {
  const ctx = setup(t);
  let now = 0;
  for (const query of queries) {
    const partitions = [[query], [...query]];
    for (let i = 1; i < query.length; i++) partitions.push([query.slice(0, i), query.slice(i)]);
    for (const parts of partitions) {
      ctx.time(now += 5000);
      for (const part of parts) ctx.output(part);
      ctx.input(DA2_REPLY);
      assert.deepEqual(ctx.sent.splice(0), [{ id: 'live', data: DA2_REPLY }], JSON.stringify(parts));
    }
  }
});

test('only complete queries refresh the window; ordinary output and replies do not', t => {
  const ctx = setup(t);
  ctx.output(DA2_QUERY);
  ctx.time(5000);
  ctx.output('output\x1b[>0');
  ctx.input(DA2_REPLY);
  ctx.output(DA2_REPLY);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, []);
  ctx.output(DA2_QUERY);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [{ id: 'live', data: DA2_REPLY }]);
});

test('query windows belong to terminal entries and survive session rekeying', t => {
  const ctx = setup(t);
  const other = ctx.window.createTerminalEntry({ sessionId: 'other' });
  ctx.output(DA2_QUERY);
  other.terminal._onData(DA2_REPLY);
  assert.deepEqual(ctx.sent, []);
  ctx.window.openSessions.delete('live');
  ctx.entry.session.sessionId = 'renamed';
  ctx.window.openSessions.set('renamed', ctx.entry);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [{ id: 'renamed', data: DA2_REPLY }]);
  ctx.sent.length = 0;
  ctx.window.destroySession('renamed');
  ctx.window.createTerminalEntry({ sessionId: 'renamed' }).terminal._onData(DA2_REPLY);
  assert.deepEqual(ctx.sent, [], 'replacement terminals must not inherit a window');
});

test('replay writes cannot arm a live query window', t => {
  const ctx = setup(t);
  ctx.entry.terminal.write(DA2_QUERY);
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, []);
});

test('query carry is bounded and cannot bridge a long unrelated output chunk', t => {
  const ctx = setup(t);
  ctx.output('\x1b[?');
  ctx.output('1'.repeat(10000));
  assert.ok(ctx.entry.liveQueryTail.length <= 256, 'retained query carry must stay bounded');
  ctx.output('$p');
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, []);
  ctx.output('\x1b[');
  ctx.output('>0c');
  ctx.input(DA2_REPLY);
  assert.deepEqual(ctx.sent, [{ id: 'live', data: DA2_REPLY }]);
});

test('dropped replies trace kind and age only when tracing is enabled', t => {
  const ctx = setup(t);
  const traces = [];
  ctx.window.atrace = (kind, id, details) => traces.push({ kind, id, details });
  ctx.input(DA2_REPLY);
  assert.deepEqual(traces, []);
  ctx.window.ATRACE = true;
  ctx.input(DA2_REPLY);
  ctx.output(DA2_QUERY);
  ctx.time(5000);
  ctx.input(DA2_REPLY);
  assert.equal(traces.length, 2);
  assert.equal(traces[0].kind, 'terminal.query-reply.drop');
  assert.equal(traces[0].id, 'live');
  assert.equal(traces[0].details.kind, 'DA2');
  assert.equal(traces[0].details.age, null);
  assert.equal(traces[1].details.age, 5000);
  const kinds = ['DA1', 'DA2', 'CPR', 'DSR', 'OSC 10', 'OSC 11', 'DECRQM', 'DECRQM'];
  for (const [index, reply] of replies.entries()) {
    ctx.input(reply);
    assert.equal(traces.at(-1).details.kind, kinds[index]);
    assert.equal(traces.at(-1).details.age, 5000);
  }
  assert.deepEqual(ctx.sent, []);
});
