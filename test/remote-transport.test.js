'use strict';

// The ssh/scp transport with `spawn` injected: argv shape, inventory parsing,
// and — the part that matters on this machine — that no child is ever left
// running. On Windows a child outlives its launcher; an unbounded fan-out has
// already left orphans at 100% CPU here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { createSshTransport, parseInventory } = require('../remote-transport');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = 0;
  child.kill = () => { child.killed++; child.emit('close', null); };
  return child;
}

/** spawn stub: records every call, hands the child back for the test to drive. */
function spawnRecorder(handler) {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = fakeChild();
    calls.push({ cmd, args, child });
    if (handler) setImmediate(() => handler(child, cmd, args));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('parseInventory keeps well-formed lines and drops everything else', () => {
  const out = [
    '1757200000.5000000\t1234\t-srv-supervision/a.jsonl',
    '1757200001.0000000\t10\t-srv-x/uuid/subagents/agent-1.jsonl',
    'garbage',
    '1757200002.0\t10\t../escape.jsonl',
    '1757200003.0\t10\t-srv-x/notes.txt',
  ].join('\n') + '\n';

  assert.deepEqual(parseInventory(out), [
    { rel: '-srv-supervision/a.jsonl', size: 1234, mtimeMs: 1757200000500 },
    { rel: '-srv-x/uuid/subagents/agent-1.jsonl', size: 10, mtimeMs: 1757200001000 },
  ]);
});

test('listFiles spawns one bounded ssh with the alias as an operand, never as a shell string', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('1757200000.0\t9\t-srv-a/a.jsonl\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn });

  const entries = await t.listFiles('planificator');

  assert.equal(spawn.calls.length, 1);
  const { cmd, args } = spawn.calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('BatchMode=yes'), 'must never prompt for a passphrase');
  // The alias is its own argv element and the remote command is the last one:
  // nothing the user typed is ever concatenated into a local shell string.
  assert.equal(args[args.length - 2], 'planificator');
  assert.match(args[args.length - 1], /^find \.claude\/projects /);
  assert.deepEqual(entries, [{ rel: '-srv-a/a.jsonl', size: 9, mtimeMs: 1757200000000 }]);
  assert.equal(t.liveCount(), 0, 'the child is unregistered once it closes');
});

test('a non-zero ssh exit is an error, not an empty inventory', async () => {
  const spawn = spawnRecorder((child) => {
    child.stderr.push('Permission denied (publickey).');
    child.stderr.push(null);
    child.emit('close', 255);
  });
  const t = createSshTransport({ spawn });
  await assert.rejects(() => t.listFiles('vps'), /exit 255/);
});

test('a hung ssh is killed at the timeout and reported, not awaited forever', async () => {
  // The child never closes on its own.
  const spawn = spawnRecorder(null);
  const t = createSshTransport({ spawn, listTimeoutMs: 30 });

  await assert.rejects(() => t.listFiles('vps'), /timed out/);

  assert.equal(spawn.calls[0].child.killed, 1, 'the hung child must be killed');
  assert.equal(t.liveCount(), 0, 'nothing is left registered');
});

test('dispose kills every child still in flight', async () => {
  const spawn = spawnRecorder(null);
  const t = createSshTransport({ spawn, listTimeoutMs: 5000 });

  const pending = t.listFiles('vps');
  await new Promise(r => setImmediate(r));
  assert.equal(t.liveCount(), 1);

  t.dispose();

  assert.equal(spawn.calls[0].child.killed, 1);
  await pending.catch(() => {});
});

test('fetchFiles writes through a .part file so a killed scp leaves no half transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scp-'));
  try {
    const spawn = spawnRecorder((child, cmd, args) => {
      // Stand in for scp: the destination is the last argv element.
      const dest = args[args.length - 1];
      assert.match(dest, /\.part$/, 'scp must never write the final name directly');
      fs.writeFileSync(dest, 'transferred', 'utf8');
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });

    const r = await t.fetchFiles('vps', ['-srv-a/uuid/subagents/agent-1.jsonl'], dir);

    assert.deepEqual(r.fetched, ['-srv-a/uuid/subagents/agent-1.jsonl']);
    assert.deepEqual(r.failed, []);
    const final = path.join(dir, '-srv-a', 'uuid', 'subagents', 'agent-1.jsonl');
    assert.equal(fs.readFileSync(final, 'utf8'), 'transferred');
    assert.equal(fs.existsSync(final + '.part'), false);
    assert.equal(spawn.calls[0].cmd, 'scp');
    assert.ok(spawn.calls[0].args.includes('vps:.claude/projects/-srv-a/uuid/subagents/agent-1.jsonl'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed scp reports the file instead of leaving a partial one behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scp-fail-'));
  try {
    const spawn = spawnRecorder((child, cmd, args) => {
      fs.writeFileSync(args[args.length - 1], 'half', 'utf8');
      child.stderr.push('lost connection');
      child.stderr.push(null);
      child.emit('close', 1);
    });
    const t = createSshTransport({ spawn });

    const r = await t.fetchFiles('vps', ['-srv-a/a.jsonl'], dir);

    assert.deepEqual(r.failed, ['-srv-a/a.jsonl']);
    assert.deepEqual(r.fetched, []);
    assert.equal(fs.existsSync(path.join(dir, '-srv-a', 'a.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '-srv-a', 'a.jsonl.part')), false, 'the partial is removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unsafe rel path never reaches scp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scp-evil-'));
  try {
    const spawn = spawnRecorder(null);
    const t = createSshTransport({ spawn });

    const r = await t.fetchFiles('vps', ['../../../etc/shadow.jsonl', "a/x';id;'.jsonl"], dir);

    assert.equal(spawn.calls.length, 0, 'no process may be spawned for those');
    assert.deepEqual(r.fetched, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
