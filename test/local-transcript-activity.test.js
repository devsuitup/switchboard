'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalTranscriptTracker, sessionIdFromWatchParts } = require('../local-transcript-activity');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const parent = ['folder', `${UUID_A}.jsonl`];
const child = ['folder', UUID_A, 'subagents', 'agent-7.jsonl'];

function fixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-621-'));
  const events = [];
  const tracker = createLocalTranscriptTracker({ projectsDir: root, ipcMinMs: 20, onActivity: e => events.push(e), ...opts });
  const file = parts => path.join(root, ...parts);
  function write(parts, content, mtime = 100) {
    fs.mkdirSync(path.dirname(file(parts)), { recursive: true });
    fs.writeFileSync(file(parts), content);
    fs.utimesSync(file(parts), mtime, mtime);
  }
  t.after(() => {
    tracker.dispose?.();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { tracker, events, file, write };
}

function timedFixture(t, opts = {}) {
  let at = 0;
  const timers = new Set();
  const f = fixture(t, {
    ...opts, ipcMinMs: 50, now: () => at,
    setTimeout: (fn, ms) => { const timer = { fn, at: at + ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  return { ...f, advance: async ms => {
    at += ms;
    for (const timer of [...timers]) {
      if (timer.at > at) continue;
      timers.delete(timer);
      await timer.fn();
    }
  } };
}

test('watch path attribution rejects non-transcripts and nested parent paths', () => {
  assert.equal(sessionIdFromWatchParts(parent), UUID_A);
  for (const parts of [child, ['folder', UUID_A, 'agent-7.jsonl'], ['folder', 'sessions-index.json'], ['folder', 'bad.jsonl'], ['folder'], null]) {
    assert.equal(sessionIdFromWatchParts(parts), null);
  }
});

test('bare paths without filesystem evidence never emit activity', async () => {
  assert.equal(await createLocalTranscriptTracker().record(parent), null);
});

test('startup and injected notifications after reading old parent and child stay quiet', async t => {
  const f = fixture(t);
  for (const parts of [parent, child]) {
    f.write(parts, 'old transcript\n');
    assert.equal(await f.tracker.record(parts), null, 'first sighting establishes a baseline');
    fs.readFileSync(f.file(parts));
    assert.equal(await f.tracker.record(parts), null, 'an unchanged read notification is not activity');
  }
  assert.deepEqual(f.events, [], 'no Working, unread, or subagent signal');
});

test('a new file is baselined and a later append emits once despite duplicate notifications', async t => {
  const f = fixture(t);
  assert.equal(await f.tracker.record(parent), null);
  f.write(parent, 'first\n');
  assert.equal(await f.tracker.record(parent), null);
  fs.appendFileSync(f.file(parent), 'second\n');
  const update = await f.tracker.record(parent);
  assert.equal(update.sessionId, UUID_A);
  assert.equal(await f.tracker.record(parent), null);
  assert.equal(f.events.length, 1);
});

test('growth with unchanged write mtime is activity', async t => {
  const f = fixture(t);
  f.write(parent, 'a');
  await f.tracker.record(parent);
  f.write(parent, 'ab');
  assert.ok(await f.tracker.record(parent));
  assert.equal(f.events.length, 1);
});

test('same-size content rewrite with advancing mtime emits once', async t => {
  const f = fixture(t);
  f.write(parent, 'alpha\n');
  await f.tracker.record(parent);
  f.write(parent, 'bravo\n', 300);
  assert.ok(await f.tracker.record(parent));
  assert.equal(await f.tracker.record(parent), null);
  assert.equal(f.events.length, 1);
});

test('a same-size rewrite outside the bounded tail is not ignored when write mtime advances', async t => {
  const f = fixture(t);
  const original = 'a' + 'x'.repeat(128 * 1024);
  f.write(parent, original);
  await f.tracker.record(parent);
  f.write(parent, 'b' + original.slice(1), 300);
  assert.ok(await f.tracker.record(parent), 'write mtime must cover rewrites outside the read window');
  assert.equal(f.events.length, 1);
});

test('preferred and legacy child layouts retain parent attribution and separate top-level throttle', async t => {
  const f = fixture(t);
  const legacy = ['folder', UUID_B, 'agent-9.jsonl'];
  for (const parts of [parent, child, legacy]) {
    f.write(parts, 'old\n');
    await f.tracker.record(parts);
    fs.appendFileSync(f.file(parts), 'new\n');
    assert.ok(await f.tracker.record(parts));
  }
  assert.equal(f.events[0].sessionId, UUID_A);
  assert.equal(f.events[1].parentSessionId, UUID_A);
  assert.equal(f.events[1].agentId, '7');
  assert.equal(f.events[1].kind, 'subagent');
  assert.equal(f.events[2].agentId, '9');
});

test('a live PTY owns both parent and child activity', async t => {
  const f = fixture(t, { hasPty: id => id === UUID_A });
  for (const parts of [parent, child]) {
    f.write(parts, 'old\n');
    await f.tracker.record(parts);
    fs.appendFileSync(f.file(parts), 'new\n');
    assert.equal(await f.tracker.record(parts), null);
  }
  assert.deepEqual(f.events, []);
});

test('truncation, replacement and deletion rebaseline quietly, then accept new growth', async t => {
  for (const mode of ['truncate', 'replace', 'delete']) {
    const f = fixture(t);
    f.write(parent, 'old history\n');
    await f.tracker.record(parent);
    if (mode === 'truncate') f.write(parent, 'x', 200);
    else {
      fs.renameSync(f.file(parent), f.file(parent) + '.old');
      if (mode === 'delete') assert.equal(await f.tracker.record(parent), null);
      f.write(parent, 'replacement history\n', 200);
    }
    assert.equal(await f.tracker.record(parent), null, `${mode} is not a turn`);
    assert.deepEqual(f.events, []);
    fs.appendFileSync(f.file(parent), 'new\n');
    assert.ok(await f.tracker.record(parent), 'growth after invalidation remains detectable');
  }
});

test('read failure invalidates the baseline without emitting or claiming completion', async t => {
  let deny = false;
  const f = fixture(t, { fs: { ...fs.promises, open: (...args) => {
    if (deny) return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    return fs.promises.open(...args);
  } } });
  f.write(parent, 'old\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'during failure\n');
  deny = true;
  assert.equal(await f.tracker.record(parent), null);
  deny = false;
  assert.equal(await f.tracker.record(parent), null, 'recovery establishes a fresh baseline');
  assert.deepEqual(f.events, []);
  fs.appendFileSync(f.file(parent), 'after recovery\n');
  assert.ok(await f.tracker.record(parent));
});

test('a final changed event inside the existing throttle window is eventually emitted once', async t => {
  const f = timedFixture(t);
  f.write(parent, 'old\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'first\n');
  assert.ok(await f.tracker.record(parent));
  fs.appendFileSync(f.file(parent), 'final\n');
  assert.equal(await f.tracker.record(parent), null);
  await f.advance(50);
  assert.equal(f.events.length, 2, 'the final validated change must survive throttling');
  assert.equal(await f.tracker.record(parent), null);
});

test('invalidation cancels pending activity and PTY takeover suppresses trailing delivery', async t => {
  for (const mode of ['truncate', 'pty']) {
    let pty = false;
    const f = timedFixture(t, { hasPty: () => pty });
    f.write(parent, 'old\n');
    await f.tracker.record(parent);
    fs.appendFileSync(f.file(parent), 'first\n');
    await f.tracker.record(parent);
    fs.appendFileSync(f.file(parent), 'final\n');
    await f.tracker.record(parent);
    if (mode === 'truncate') {
      f.write(parent, 'x', 300);
      await f.tracker.record(parent);
    } else pty = true;
    await f.advance(50);
    assert.equal(f.events.length, 1, `${mode} must suppress obsolete pending activity`);
  }
});

test('content reads are bounded and unchanged notifications do not reread content', async t => {
  const lengths = [];
  const f = fixture(t, { fs: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      read: (...readArgs) => { lengths.push(readArgs[2]); return handle.read(...readArgs); },
    };
  } } });
  f.write(parent, 'x'.repeat(256 * 1024));
  await f.tracker.record(parent);
  assert.deepEqual(lengths, [64 * 1024]);
  await f.tracker.record(parent);
  assert.deepEqual(lengths, [64 * 1024]);
  fs.appendFileSync(f.file(parent), 'new\n');
  assert.ok(await f.tracker.record(parent));
  assert.deepEqual(lengths, [64 * 1024, 64 * 1024]);
});

test('replacement during a bounded read rejects stale evidence and recovers quietly', async t => {
  let replace = false;
  let f;
  f = fixture(t, { fs: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (replace) {
          replace = false;
          fs.renameSync(f.file(parent), f.file(parent) + '.old');
          f.write(parent, 'replacement\n', 300);
        }
        return result;
      },
    };
  } } });
  f.write(parent, 'old\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'new\n');
  replace = true;
  assert.equal(await f.tracker.record(parent), null);
  assert.equal(await f.tracker.record(parent), null);
  assert.deepEqual(f.events, []);
  fs.appendFileSync(f.file(parent), 'fresh\n');
  assert.ok(await f.tracker.record(parent));
});

test('two parent sessions retain independent throttle state', async t => {
  const f = timedFixture(t);
  for (const parts of [parent, ['folder', `${UUID_B}.jsonl`]]) {
    f.write(parts, 'old\n');
    await f.tracker.record(parts);
    fs.appendFileSync(f.file(parts), 'new\n');
    assert.ok(await f.tracker.record(parts));
  }
  assert.equal(f.events.length, 2);
});

test('dispose cancels trailing work and prevents late asynchronous delivery', async t => {
  const f = timedFixture(t);
  f.write(parent, 'old\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'first\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'final\n');
  await f.tracker.record(parent);
  f.tracker.dispose();
  await f.advance(50);
  assert.equal(await f.tracker.record(parent), null);
  assert.equal(f.events.length, 1);
});

test('short reads and I/O failures invalidate content verification without activity', async t => {
  for (const mode of ['short', 'error']) {
    let fail = false;
    const f = fixture(t, { fs: { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        read: async (...readArgs) => {
          if (fail && mode === 'error') throw Object.assign(new Error('read failed'), { code: 'EIO' });
          const result = await handle.read(...readArgs);
          return fail ? { bytesRead: result.bytesRead - 1 } : result;
        },
      };
    } } });
    f.write(parent, 'old\n');
    await f.tracker.record(parent);
    fs.appendFileSync(f.file(parent), 'new\n');
    fail = true;
    assert.equal(await f.tracker.record(parent), null);
    fail = false;
    assert.equal(await f.tracker.record(parent), null);
    assert.deepEqual(f.events, []);
  }
});

test('dispose during a content read prevents in-flight activity from escaping', async t => {
  let hold = false;
  let release;
  let reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const f = fixture(t, { fs: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (hold) {
          reached();
          await new Promise(resolve => { release = resolve; });
        }
        return result;
      },
    };
  } } });
  f.write(parent, 'old\n');
  await f.tracker.record(parent);
  fs.appendFileSync(f.file(parent), 'new\n');
  hold = true;
  const work = f.tracker.record(parent);
  await entered;
  f.tracker.dispose();
  release();
  assert.equal(await work, null);
  assert.deepEqual(f.events, []);
});
