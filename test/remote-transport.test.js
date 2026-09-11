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

const {
  createSshTransport, parseInventory, parseSessions, splitListOutput,
  LIST_COMMAND, ALIVE_MARKER_PREFIX, SESSIONS_MARKER, MAX_SESSION_DESCRIPTORS, MAX_SESSION_DESCRIPTOR_BYTES,
} = require('../remote-transport');

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

// issue #244: readSubagentMeta() needs the sidecar mirrored next to its
// transcript. parseInventory is the first gate the sidecar has to clear —
// see .ai/contexts/session-cache.md ("Remote hosts — meta.json sidecars").
test('parseInventory keeps a .meta.json sidecar alongside its transcript', () => {
  const out = [
    '1757200000.0\t10\t-srv-x/uuid/subagents/agent-1.jsonl',
    '1757200000.0\t42\t-srv-x/uuid/subagents/agent-1.meta.json',
    '1757200000.0\t10\t../escape.meta.json',
    '1757200000.0\t10\t-srv-x/notes.meta.txt',
  ].join('\n') + '\n';

  assert.deepEqual(parseInventory(out), [
    { rel: '-srv-x/uuid/subagents/agent-1.jsonl', size: 10, mtimeMs: 1757200000000 },
    { rel: '-srv-x/uuid/subagents/agent-1.meta.json', size: 42, mtimeMs: 1757200000000 },
  ]);
});

test('listFiles spawns one bounded ssh with the alias as an operand, never as a shell string', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('1757200000.0\t9\t-srv-a/a.jsonl\n');
    child.stdout.push(SESSIONS_MARKER + '\n');
    child.stdout.push('{"pid":123,"sessionId":"abc"}\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn });

  const result = await t.listFiles('planificator');

  assert.equal(spawn.calls.length, 1, 'exactly one ssh call — the inventory and the sessions ride together');
  const { cmd, args } = spawn.calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('BatchMode=yes'), 'must never prompt for a passphrase');
  // The alias is its own argv element and the remote command is the last one:
  // nothing the user typed is ever concatenated into a local shell string.
  assert.equal(args[args.length - 2], 'planificator');
  const command = args[args.length - 1];
  assert.match(command, /^find \.claude\/projects /);
  assert.ok(command.includes('find .claude/projects'), 'the inventory half must still run');
  assert.ok(command.includes('find .claude/sessions'), 'the session descriptors must ride the same command');
  assert.deepEqual(result, {
    files: [{ rel: '-srv-a/a.jsonl', size: 9, mtimeMs: 1757200000000 }],
    sessions: [{ pid: 123, sessionId: 'abc' }],
  });
  assert.equal(t.liveCount(), 0, 'the child is unregistered once it closes');
});

// issue #211: -name '[0-9]*.json' is the ONLY thing standing between this
// feature and reading a '*.key' secret file dropped in the same directory.
test('LIST_COMMAND is pinned exactly — any widening of the sessions glob must fail this test', () => {
  const expected =
    `find .claude/projects -type f \\( -name '*.jsonl' -o -name '*.meta.json' \\) -printf '%T@\\t%s\\t%P\\n' || exit $?; ` +
    `printf '\\001SWITCHBOARD-SESSIONS\\001\\n'; ` +
    `find .claude/sessions -maxdepth 1 -type f -name '[0-9]*.json' 2>/dev/null | LC_ALL=C sort | ` +
    `head -n ${MAX_SESSION_DESCRIPTORS} | while IFS= read -r f; do head -c ${MAX_SESSION_DESCRIPTOR_BYTES} "$f"; printf '\\n'; ` +
    `pid=$(basename "$f" .json); printf '\\002ALIVE:%s\\n' "$( [ -d "/proc/$pid" ] && echo 1 || echo 0 )"; done`;
  assert.equal(LIST_COMMAND, expected);
});


// issue #244: the projects find must list both the transcript and its sidecar.
test('LIST_COMMAND lists .meta.json sidecars alongside .jsonl transcripts', () => {
  assert.ok(LIST_COMMAND.includes("-name '*.jsonl' -o -name '*.meta.json'"));
});

test('LIST_COMMAND can never match a .key file, independent of exact wording', () => {
  assert.ok(!LIST_COMMAND.includes('.key'));
});

test('a host with no sessions dir yields zero descriptors without failing the cycle', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('1757200000.0\t9\t-srv-a/a.jsonl\n');
    child.stdout.push(SESSIONS_MARKER + '\n');
    // Nothing after the marker — exactly what the real command produces when
    // ~/.claude/sessions is missing or empty (the while-loop still exits 0).
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn });

  const result = await t.listFiles('vps');

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.files, [{ rel: '-srv-a/a.jsonl', size: 9, mtimeMs: 1757200000000 }]);
});

test('listFiles degrades to zero sessions when the marker is unexpectedly absent from stdout', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('1757200000.0\t9\t-srv-a/a.jsonl\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn });

  const result = await t.listFiles('vps');

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.files, [{ rel: '-srv-a/a.jsonl', size: 9, mtimeMs: 1757200000000 }]);
});

// Regression guard: built from the literal wire bytes the real remote
// `printf '\001SWITCHBOARD-SESSIONS\001\n'` produces, NOT from the
// SESSIONS_MARKER export — so this test would catch the constant and the
// real command drifting out of sync with each other, which a fixture built
// from the same constant used by the code under test cannot catch.
test('the real wire-format marker (raw SOH-framed bytes) is recognized with zero warnings', async () => {
  const warnings = [];
  const log = { info() {}, warn: (m) => warnings.push(m), error() {} };
  const spawn = spawnRecorder((child) => {
    child.stdout.push('1757200000.0\t9\t-srv-a/a.jsonl\n');
    child.stdout.push('\x01SWITCHBOARD-SESSIONS\x01\n');
    child.stdout.push(JSON.stringify({ pid: 1, sessionId: 'x' }) + '\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn, log });

  const result = await t.listFiles('vps');

  assert.deepEqual(result.sessions, [{ pid: 1, sessionId: 'x' }]);
  assert.deepEqual(warnings, [], 'a well-formed descriptor after the real marker must never warn');
});

test('splitListOutput: marker present splits inventory from sessions', () => {
  const stdout = 'inv-line\n' + SESSIONS_MARKER + '\n{"a":1}\n';
  assert.deepEqual(splitListOutput(stdout), {
    inventoryBlock: 'inv-line\n',
    sessionsBlock: '{"a":1}\n',
  });
});

test('splitListOutput: marker absent degrades to the full stdout as the inventory block', () => {
  const stdout = 'inv-line-1\ninv-line-2\n';
  assert.deepEqual(splitListOutput(stdout), { inventoryBlock: stdout, sessionsBlock: '' });
});

// Real remote output always has a trailing '\n' after the marker (it's part of
// the printf format), and this is the legitimate zero-descriptors case: the
// marker is on its own line with nothing following it.
test('splitListOutput: marker present with nothing after it yields an empty, not undefined, sessionsBlock', () => {
  const stdout = 'inv-line\n' + SESSIONS_MARKER + '\n';
  const result = splitListOutput(stdout);
  assert.equal(result.inventoryBlock, 'inv-line\n');
  assert.equal(result.sessionsBlock, '');
  assert.notEqual(result.sessionsBlock, undefined);
});

// The offset-0 legitimate case: .claude/projects found zero files, so the
// marker is the very first thing in stdout with no preceding newline.
test('splitListOutput: marker at byte offset 0 (empty inventory) splits normally', () => {
  const stdout = SESSIONS_MARKER + '\n{"a":1}\n';
  assert.deepEqual(splitListOutput(stdout), {
    inventoryBlock: '',
    sessionsBlock: '{"a":1}\n',
  });
});

// A marker-like substring embedded mid-line (not preceded by '\n'/start, or
// not followed by '\n') is not a legitimate marker line: degrade rather than
// mis-split on it.
test('splitListOutput: marker not preceded by a newline degrades instead of splitting', () => {
  const stdout = 'inv-line' + SESSIONS_MARKER + '\n{"a":1}\n';
  assert.deepEqual(splitListOutput(stdout), { inventoryBlock: stdout, sessionsBlock: '' });
});

test('splitListOutput: marker not followed by a newline degrades instead of splitting', () => {
  const stdout = 'inv-line\n' + SESSIONS_MARKER + 'trailing-garbage\n';
  assert.deepEqual(splitListOutput(stdout), { inventoryBlock: stdout, sessionsBlock: '' });
});

test('parseSessions preserves every field verbatim, including arrays and nested objects', () => {
  const descriptor = {
    pid: 4242,
    sessionId: 'sess-abc',
    peerFeatures: ['a', 'b', 'c'],
    nested: { model: 'claude-opus-5', extra: { deep: true } },
  };
  const { sessions, warnings } = parseSessions(JSON.stringify(descriptor) + '\n');
  assert.deepEqual(sessions, [descriptor]);
  assert.deepEqual(warnings, []);
});

test('parseSessions drops invalid JSON without logging its content, keeping the valid neighbors', () => {
  const block = [
    JSON.stringify({ pid: 1, sessionId: 'one' }),
    'not valid json {{{',
    JSON.stringify({ pid: 2, sessionId: 'two' }),
  ].join('\n');
  const { sessions, warnings } = parseSessions(block);
  assert.deepEqual(sessions, [{ pid: 1, sessionId: 'one' }, { pid: 2, sessionId: 'two' }]);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('not valid json'), 'the raw malformed line must never be logged');
  assert.ok(!warnings[0].includes('{{{'), 'no fragment of the malformed content may leak into the warning');
});

test('parseSessions drops a descriptor missing sessionId', () => {
  const { sessions, warnings } = parseSessions(JSON.stringify({ pid: 1 }) + '\n');
  assert.deepEqual(sessions, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sessionId/);
});

test('parseSessions drops a descriptor with a missing or non-integer pid', () => {
  const r1 = parseSessions(JSON.stringify({ sessionId: 'x' }) + '\n');
  assert.deepEqual(r1.sessions, []);
  assert.equal(r1.warnings.length, 1);

  const r2 = parseSessions(JSON.stringify({ pid: 'not-a-number', sessionId: 'x' }) + '\n');
  assert.deepEqual(r2.sessions, []);
  assert.equal(r2.warnings.length, 1);

  const r3 = parseSessions(JSON.stringify({ pid: -1, sessionId: 'x' }) + '\n');
  assert.deepEqual(r3.sessions, []);
  assert.equal(r3.warnings.length, 1);
});

test('parseSessions on a blank/empty block returns no sessions and no warnings', () => {
  assert.deepEqual(parseSessions(''), { sessions: [], warnings: [], dropped: 0 });
  assert.deepEqual(parseSessions('\n\n'), { sessions: [], warnings: [], dropped: 0 });
});

// F9 (audit-fable-2026-09-11): a block with one alive and one dead descriptor
// keeps only the alive one, dropped is counted.
test('parseSessions drops a descriptor marked dead by ALIVE_MARKER_PREFIX, keeps the alive one', () => {
  const block = [
    JSON.stringify({ pid: 1, sessionId: 'alive-one' }),
    `${ALIVE_MARKER_PREFIX}1`,
    JSON.stringify({ pid: 2, sessionId: 'dead-one' }),
    `${ALIVE_MARKER_PREFIX}0`,
  ].join('\n');
  const { sessions, warnings, dropped } = parseSessions(block);
  assert.deepEqual(sessions, [{ pid: 1, sessionId: 'alive-one' }]);
  assert.deepEqual(warnings, []);
  assert.equal(dropped, 1);
});

// Backward compatible: an older host script with no ALIVE marker at all must
// keep behaving exactly as before this fix.
test('parseSessions keeps a descriptor when the ALIVE marker is absent (older host script)', () => {
  const block = JSON.stringify({ pid: 1, sessionId: 'no-marker' }) + '\n';
  const { sessions, warnings, dropped } = parseSessions(block);
  assert.deepEqual(sessions, [{ pid: 1, sessionId: 'no-marker' }]);
  assert.deepEqual(warnings, []);
  assert.equal(dropped, 0);
});

test('parseSessions: the ALIVE marker line is consumed and never itself warns as invalid JSON', () => {
  const block = [
    JSON.stringify({ pid: 1, sessionId: 'a' }),
    `${ALIVE_MARKER_PREFIX}1`,
    JSON.stringify({ pid: 2, sessionId: 'b' }),
    `${ALIVE_MARKER_PREFIX}1`,
  ].join('\n');
  const { sessions, warnings } = parseSessions(block);
  assert.deepEqual(sessions, [{ pid: 1, sessionId: 'a' }, { pid: 2, sessionId: 'b' }]);
  assert.deepEqual(warnings, [], 'the marker lines must never be parsed as their own descriptor');
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

test('fetchFiles accepts a .meta.json sidecar rel path, not just .jsonl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scp-meta-'));
  try {
    const spawn = spawnRecorder((child, cmd, args) => {
      fs.writeFileSync(args[args.length - 1], '{"agentType":"Explore"}', 'utf8');
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });

    const r = await t.fetchFiles('vps', ['-srv-a/uuid/subagents/agent-1.meta.json'], dir);

    assert.deepEqual(r.fetched, ['-srv-a/uuid/subagents/agent-1.meta.json']);
    assert.deepEqual(r.failed, []);
    const final = path.join(dir, '-srv-a', 'uuid', 'subagents', 'agent-1.meta.json');
    assert.equal(fs.readFileSync(final, 'utf8'), '{"agentType":"Explore"}');
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
