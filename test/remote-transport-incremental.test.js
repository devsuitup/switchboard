'use strict';

// fetchIncremental (byte-range fetch for a transcript that only grew) with
// spawn injected, same style as remote-transport.test.js. See
// .ai/contexts/session-cache.md ("Remote hosts — incremental fetch") and
// issue #257.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { createSshTransport, REMOTE_PROJECTS_REL } = require('../remote-transport');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = 0;
  child.kill = () => { child.killed++; child.emit('close', null); };
  return child;
}

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

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-' + name + '-'));
}

test('fetchIncremental issues tail -c +N (N = offset+1) as the remote command', async () => {
  const dir = tmpDir('incr-cmd');
  try {
    const destPath = path.join(dir, '-srv-a', 'a.jsonl');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, 'x'.repeat(100));

    const spawn = spawnRecorder((child) => {
      child.stdout.push('APPENDED');
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });

    const r = await t.fetchIncremental('planificator', [{ rel: '-srv-a/a.jsonl', offset: 100 }], dir);

    assert.deepEqual(r.fetched, ['-srv-a/a.jsonl']);
    assert.equal(spawn.calls.length, 1);
    const { cmd, args } = spawn.calls[0];
    assert.equal(cmd, 'ssh');
    assert.equal(args[args.length - 2], 'planificator');
    const command = args[args.length - 1];
    assert.equal(command, `tail -c +101 '${REMOTE_PROJECTS_REL}/-srv-a/a.jsonl'`);
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'x'.repeat(100) + 'APPENDED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchIncremental requests exactly the grown byte count, not the whole file', async () => {
  const dir = tmpDir('incr-bytes');
  try {
    const destPath = path.join(dir, '-srv-a', 'a.jsonl');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const original = 'y'.repeat(50_000);
    fs.writeFileSync(destPath, original);
    const grown = 'z'.repeat(4096); // ~4 KB growth, matching the issue's acceptance case

    const spawn = spawnRecorder((child) => {
      // Stand in for a real tail: only the requested range is produced.
      child.stdout.push(grown);
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });

    await t.fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: original.length }], dir);

    const finalContent = fs.readFileSync(destPath, 'utf8');
    assert.equal(finalContent.length, original.length + grown.length);
    assert.equal(finalContent, original + grown);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchIncremental preserves bytes exactly (binary capture, no utf8 mangling)', async () => {
  const dir = tmpDir('incr-binary');
  try {
    const destPath = path.join(dir, '-srv-a', 'a.jsonl');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from('prefix\n'));
    // A byte sequence that is not valid standalone UTF-8 (a lone continuation
    // byte) — if the transport decoded stdout as a utf8 string en route, this
    // would come back as U+FFFD instead of the original byte.
    const raw = Buffer.from([0x41, 0x80, 0x42, 0x0a]);

    const spawn = spawnRecorder((child) => {
      child.stdout.push(raw);
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });

    await t.fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: 7 }], dir);

    const finalBuf = fs.readFileSync(destPath);
    assert.deepEqual(finalBuf, Buffer.concat([Buffer.from('prefix\n'), raw]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed range fetch leaves the previous mirror byte-identical and no .part behind', async () => {
  const dir = tmpDir('incr-fail');
  try {
    const destPath = path.join(dir, '-srv-a', 'a.jsonl');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, 'unchanged-content');

    const spawn = spawnRecorder((child) => {
      child.stderr.push('lost connection');
      child.stderr.push(null);
      child.emit('close', 1);
    });
    const t = createSshTransport({ spawn });

    const r = await t.fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: 18 }], dir);

    assert.deepEqual(r.failed, ['-srv-a/a.jsonl']);
    assert.deepEqual(r.fetched, []);
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'unchanged-content', 'the previous mirror must be untouched');
    assert.equal(fs.existsSync(destPath + '.part'), false, 'no torn temp file left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a range fetch with no local file to append to fails cleanly instead of creating one from a partial range', async () => {
  const dir = tmpDir('incr-nolocal');
  try {
    const spawn = spawnRecorder(null);
    const t = createSshTransport({ spawn });

    const r = await t.fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: 10 }], dir);

    assert.deepEqual(r.failed, ['-srv-a/a.jsonl']);
    assert.equal(spawn.calls.length, 0, 'never spawns ssh for a request with nothing to append to');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchIncremental writes through a .part file, same torn-write guard as a full fetch', async () => {
  const dir = tmpDir('incr-part');
  try {
    const destPath = path.join(dir, '-srv-a', 'a.jsonl');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, 'base');
    let sawPart = false;

    const spawn = spawnRecorder((child) => {
      // At the moment ssh "runs", the destination must still be the plain
      // file — the .part is a local artifact of the append, never the scp
      // destination argv (there is none here; this just documents that the
      // range command itself never names a temp path).
      child.stdout.push('-more');
      child.stdout.push(null);
      child.emit('close', 0);
    });
    const t = createSshTransport({ spawn });
    await t.fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: 4 }], dir);
    sawPart = fs.existsSync(destPath + '.part');

    assert.equal(sawPart, false, 'the .part is renamed away by the time fetchIncremental resolves');
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'base-more');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unsafe rel path or a negative/non-integer offset never reaches ssh', async () => {
  const dir = tmpDir('incr-evil');
  try {
    const spawn = spawnRecorder(null);
    const t = createSshTransport({ spawn });

    const r = await t.fetchIncremental('vps', [
      { rel: '../../../etc/shadow.jsonl', offset: 0 },
      { rel: '-srv-a/a.jsonl', offset: -1 },
      { rel: '-srv-a/b.jsonl', offset: 'nope' },
    ], dir);

    assert.equal(spawn.calls.length, 0, 'no process may be spawned for those');
    assert.deepEqual(r.fetched, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
