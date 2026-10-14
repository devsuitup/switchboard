// see .ai/contexts/session-state.md ("Proven continuation re-key")
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transitions = require('../session-transitions');
const cli = require('../cli-session-state');
const { createTriggerContext } = require('../trigger-context');
const { start } = require('../trigger-watcher');
const log = { info() {}, debug() {}, warn() {}, error() {} };
const ft = n => String(134360000000000000n + BigInt(n) * 1000n);

function fixture(t, { owner, platform = 'linux' } = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-continued-')));
  const folder = path.join(tmp, 'project');
  const descriptors = path.join(tmp, 'descriptors');
  fs.mkdirSync(folder);
  fs.mkdirSync(descriptors);
  const write = (id, entries) => fs.writeFileSync(path.join(folder, id + '.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const prompt = id => ({ type: 'user', sessionId: id, message: { content: 'hello' } });
  write('A', [prompt('A')]);
  const written = [], events = [], timers = [], rekeys = [], activity = [];
  const session = { pty: { pid: 10, write: data => written.push(data) }, projectFolder: 'project', cwd: tmp,
    knownJsonlFiles: new Set(['A.jsonl']), composerState: { pending: 0, lastInputAt: 0 } };
  const activeSessions = new Map([['A', session]]);
  const clock = { now: Date.now() };
  const parents = new Map([[10, 1], [20, 10], [30, 20], [40, 1]]);
  const starts = new Map([...parents.keys()].map(pid => [pid, ft(pid)]));
  const dead = new Set();
  let tableReads = 0;
  cli.init({ dir: descriptors, activeSessions, log, onIdle() {}, platform,
    now: () => clock.now, isProcessAlive: pid => !dead.has(pid), readProcStart: pid => starts.get(pid) ?? null,
    ...(platform === 'linux' ? { readParentPid: pid => parents.get(pid) ?? null } : {}),
    readProcessTable: async () => {
      tableReads++;
      return new Map([...parents].map(([pid, ppid]) => [pid, { ppid, created: starts.get(pid) }]));
    } });
  let calls = 0;
  transitions.init({ PROJECTS_DIR: tmp, activeSessions, log,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    rekeyMcpServer: (...args) => rekeys.push(args), rekeyActivity: (...args) => activity.push(args),
    clearOwner: (...args) => { calls++; return owner ? owner(...args) : cli.clearOwner(...args); },
    getDescriptorIdentity: (...args) => cli.getDescriptorIdentity(...args),
    setTimeout: fn => { timers.push(fn); return { unref() {} }; } });
  t.after(() => {
    transitions.init({ PROJECTS_DIR: tmp, activeSessions: new Map(), log, getMainWindow: () => null, rekeyMcpServer() {} });
    cli.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, folder, descriptors, session, activeSessions, written, events, timers, rekeys, activity, clock, parents, starts, dead,
    get calls() { return calls; }, get tableReads() { return tableReads; },
    write, prompt,
    descriptor(id, pid, status = 'idle', fields = {}) {
      fs.writeFileSync(path.join(descriptors, pid + '.json'), JSON.stringify({ sessionId: id, pid, status,
        ...(platform === 'win32' ? { pidDomain: 'win32:anchor' } : {}), procStart: ft(pid), ...fields }));
      clock.now = Math.max(clock.now, Math.ceil(fs.statSync(path.join(descriptors, pid + '.json')).mtimeMs));
    },
    continueTo(...ids) {
      fs.appendFileSync(path.join(folder, 'A.jsonl'), ids.map(id => JSON.stringify({ type: 'continued-in', sessionId: 'A', continuedInSessionId: id })).join('\n') + '\n');
    },
    detect: () => transitions.detectSessionTransitions('project') };
}

test('continued-in: a trigger for B reaches the PTY opened as A after a proven re-key', async t => {
  const f = fixture(t);
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.descriptor('B', 20);
  f.detect();
  const triggers = path.join(f.tmp, 'triggers');
  fs.mkdirSync(triggers);
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  const ctx = createTriggerContext({ activeSessions: f.activeSessions, log, isPtyAlive: () => true,
    resolveSessionId: transitions.currentSessionId });
  const watcher = start(ctx);
  t.after(() => {
    watcher.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
  });
  fs.writeFileSync(path.join(triggers, 'continued.json'), JSON.stringify({ sessionId: 'B', command: 'hello', wait: 'none', timeout_ms: 2000 }));
  const resultPath = path.join(triggers, 'processed', 'continued.result.json');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(resultPath)) {
    assert.ok(Date.now() < deadline, 'trigger result must be written');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.written.filter(data => data !== '\r'), ['hello']);
  assert.ok(f.written.includes('\r'));
  assert.equal(f.activeSessions.get('B'), f.session);
  assert.equal(f.activeSessions.has('A'), false);
  assert.equal(transitions.currentSessionId('A'), 'B');
  assert.deepEqual(f.events, [['session-forked', 'A', 'B', 'continuation']]);
  assert.deepEqual(f.rekeys, [['A', 'B']]);
  assert.deepEqual(f.activity, [['A', 'B', 'continuation']]);
});

test('continued-in: pending ownership rechecks through the existing timer then re-keys', t => {
  let owner = 'pending';
  const f = fixture(t, { owner: () => owner });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.timers.length, 1);
  owner = 'mine';
  f.timers.shift()();
  assert.equal(f.activeSessions.get('B'), f.session);
});

for (const owner of ['unknown', 'other', 'error']) {
  test(`continued-in: ${owner} ownership cannot re-key a foreign target`, t => {
    const f = fixture(t, { owner: () => { if (owner === 'error') throw new Error('unreadable'); return owner; } });
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.detect();
    assert.equal(f.calls, 1);
    assert.equal(f.activeSessions.get('A'), f.session);
    assert.equal(f.events.length, 0);
  });
}

test('continued-in: two records include a pre-existing B owned by the PTY', t => {
  const f = fixture(t);
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.continueTo('C', 'B');
  f.write('C', [f.prompt('C')]);
  f.descriptor('C', 40);
  f.descriptor('B', 20);
  f.detect();
  assert.equal(f.activeSessions.get('B'), f.session);
  assert.equal(f.activeSessions.has('C'), false);
});

test('continued-in: ten unchanged win32 passes cache other despite status flips and table refreshes', async t => {
  const f = fixture(t, { platform: 'win32' });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.descriptor('B', 40);
  for (let i = 0; i < 10; i++) {
    f.clock.now += 4000;
    f.descriptor('B', 40, i % 2 ? 'busy' : 'idle');
    await cli.refreshProcessTable();
    f.detect();
  }
  assert.equal(f.tableReads, 10);
  assert.equal(f.calls, 1);
  assert.equal(f.activeSessions.get('A'), f.session);
  const file = path.join(f.folder, 'B.jsonl');
  const changed = new Date(fs.statSync(file).mtimeMs + 1000);
  fs.utimesSync(file, changed, changed);
  f.detect();
  assert.equal(f.calls, 2, 'file mtime invalidates other');
  f.descriptor('B', 20);
  f.detect();
  assert.equal(f.calls, 3, 'descriptor id/pid set invalidates other');
  assert.equal(f.activeSessions.get('B'), f.session);
});

test('continued-in: a nested CLI cannot become the tab writer; legacy clearOwner stays unchanged', t => {
  const f = fixture(t);
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.descriptor('A', 20);
  f.descriptor('B', 30);
  assert.equal(cli.clearOwner('B', 10), 'mine', 'legacy callers retain their policy');
  assert.equal(cli.clearOwner('B', 10, { closestWriter: true }), 'other');
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
});

for (const platform of ['linux', 'win32']) {
  test(`continued-in: a nested CLI cannot steal a tab whose PTY is the CLI on ${platform}`, async t => {
    const f = fixture(t, { platform });
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.session.knownJsonlFiles.add('B.jsonl');
    f.descriptor('A', 10);
    f.descriptor('B', 30);
    await cli.refreshProcessTable();
    f.detect();
    assert.equal(f.activeSessions.get('A'), f.session, 'nested B must leave the tab on A');
    assert.equal(f.activeSessions.has('B'), false);
    assert.deepEqual(f.events, []);
  });

  test(`continued-in: the CLI at the PTY pid can continue as B on ${platform}`, async t => {
    const f = fixture(t, { platform });
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.session.knownJsonlFiles.add('B.jsonl');
    f.descriptor('B', 10);
    await cli.refreshProcessTable();
    f.detect();
    assert.equal(f.activeSessions.get('B'), f.session);
    assert.equal(f.activeSessions.has('A'), false);
    assert.deepEqual(f.events, [['session-forked', 'A', 'B', 'continuation']]);
  });

  test(`continued-in: a nested descriptor does not change the closest writer verdict on ${platform}`, async t => {
    const f = fixture(t, { platform });
    f.continueTo('B', 'C');
    f.write('B', [f.prompt('B')]);
    f.write('C', [f.prompt('C')]);
    f.descriptor('B', 20);
    f.descriptor('C', 30);
    await cli.refreshProcessTable();
    assert.equal(cli.clearOwner('B', 10, { closestWriter: true }), 'mine');
    assert.equal(cli.clearOwner('C', 10, { closestWriter: true }), 'other');
    f.detect();
    assert.equal(f.activeSessions.get('B'), f.session);
  });
}

test('continued-in: a stale pending target does not keep the recheck timer alive', t => {
  const f = fixture(t, { owner: () => 'pending' });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  const old = new Date(Date.now() - 61000);
  fs.utimesSync(path.join(f.folder, 'B.jsonl'), old, old);
  f.detect();
  assert.equal(f.calls, 1);
  assert.equal(f.timers.length, 0);
  assert.equal(f.activeSessions.get('A'), f.session);
});

test('continued-in: a fresh B written before its descriptor switches re-keys without another transcript write', t => {
  const f = fixture(t);
  f.descriptor('A', 20);
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.timers.length, 1, 'a fresh absent target must schedule a recheck');
  const before = fs.statSync(path.join(f.folder, 'B.jsonl'));
  f.descriptor('B', 20);
  f.timers.shift()();
  assert.equal(f.activeSessions.get('B'), f.session);
  assert.deepEqual(f.events, [['session-forked', 'A', 'B', 'continuation']]);
  assert.equal(fs.statSync(path.join(f.folder, 'B.jsonl')).mtimeMs, before.mtimeMs);
});

test('continued-in: absent ownership retries only while the target is fresh, then caches it', t => {
  const f = fixture(t);
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.detect();
  assert.equal(f.timers.length, 1);
  f.timers.shift()();
  assert.equal(f.calls, 2, 'fresh absent ownership must not be cached');
  assert.equal(f.timers.length, 1);
  const old = new Date(Date.now() - 61000);
  fs.utimesSync(path.join(f.folder, 'B.jsonl'), old, old);
  f.timers.shift()();
  assert.equal(f.calls, 3);
  assert.equal(f.timers.length, 0, 'the freshness window bounds retries');
  f.detect();
  assert.equal(f.calls, 3, 'stale absent ownership is cached');
  assert.equal(f.activeSessions.get('A'), f.session);
});

test('continued-in: ownership alone without a continuation record cannot re-key', t => {
  const f = fixture(t, { owner: () => 'mine' });
  f.write('B', [f.prompt('B')]);
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.calls, 0);
});

test('continued-in: an old source larger than one scan resumes to its continuation without another file write', t => {
  const f = fixture(t, { owner: () => 'mine' });
  f.write('A', Array.from({ length: 1100 }, () => ({ type: 'system', text: 'x'.repeat(1024) })));
  f.continueTo('B');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(f.folder, 'A.jsonl'), old, old);
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.timers.length, 1, 'unfinished indexing must schedule the next bounded scan');
  f.timers.shift()();
  assert.equal(f.activeSessions.get('B'), f.session);
});

test('continued-in: incomplete win32 ancestry stays pending until the table fills in', async t => {
  const f = fixture(t, { platform: 'win32' });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.descriptor('B', 20);
  f.parents.delete(10);
  await cli.refreshProcessTable();
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.timers.length, 1, 'missing parent evidence must be retried, not cached as other');
  f.parents.set(10, 1);
  f.clock.now += 4000;
  await cli.refreshProcessTable();
  f.timers.shift()();
  assert.equal(f.calls, 2);
  assert.equal(f.activeSessions.get('B'), f.session);
});

test('continued-in: an old malformed EOF does not start an endless indexing timer', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.folder, 'A.jsonl'), '{"type":"continued-in"');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(f.folder, 'A.jsonl'), old, old);
  f.detect();
  assert.equal(f.timers.length, 0);
  assert.equal(f.activeSessions.get('A'), f.session);
});

for (const pid of [10, 20]) {
  test(`continued-in: a stale Linux descriptor on reused ancestor pid ${pid} cannot steal the tab`, t => {
    const f = fixture(t);
    f.parents.set(11, pid);
    f.starts.set(11, ft(11));
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.session.knownJsonlFiles.add('B.jsonl');
    f.descriptor('A', 11);
    f.descriptor('B', pid);
    f.starts.set(pid, 'reused');
    f.detect();
    assert.equal(f.activeSessions.get('A'), f.session);
    assert.equal(f.activeSessions.has('B'), false);
    assert.equal(f.events.length, 0);
    assert.equal(cli.clearOwner('B', 10, { closestWriter: true }), 'pending');
  });
}

for (const value of [null, 'stale']) {
  test(`continued-in: ${value} procStart on an intermediate descriptor leaves ownership pending`, t => {
    const f = fixture(t);
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.session.knownJsonlFiles.add('B.jsonl');
    f.descriptor('B', 30);
    f.descriptor('A', 20, 'idle', { procStart: value });
    assert.equal(cli.clearOwner('B', 10, { closestWriter: true }), 'pending');
    f.detect();
    assert.equal(f.activeSessions.get('A'), f.session);
  });
}

test('continued-in: an unreadable live Linux process start never proves ownership', t => {
  const f = fixture(t);
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.descriptor('B', 20);
  f.starts.delete(20);
  assert.equal(cli.clearOwner('B', 10, { closestWriter: true }), 'pending');
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
});

for (const platform of ['win32', 'darwin']) {
  test(`continued-in: ten unchanged stale dead-writer passes on ${platform} cost one owner call and one listing per pass`, async t => {
    const f = fixture(t, { platform });
    f.continueTo('B');
    f.write('B', [f.prompt('B')]);
    f.session.knownJsonlFiles.add('B.jsonl');
    const old = new Date(Date.now() - 61000);
    fs.utimesSync(path.join(f.folder, 'B.jsonl'), old, old);
    f.descriptor('B', 40);
    f.dead.add(40);
    let reads = 0;
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (...args) => {
      if (args[0] === f.descriptors) reads++;
      return readdir(...args);
    });
    for (let i = 0; i < 10; i++) {
      f.clock.now += 4000;
      f.detect();
      await Promise.resolve();
    }
    assert.equal(f.calls, 1);
    assert.equal(f.tableReads, 0);
    assert.equal(reads, 10, 'one shared descriptor listing per detection pass');
    assert.equal(f.timers.length, 0);
    assert.equal(f.activeSessions.get('A'), f.session);
    f.dead.delete(40);
    f.descriptor('B', 20);
    f.detect();
    await Promise.resolve();
    f.detect();
    if (platform === 'win32') assert.equal(f.activeSessions.get('B'), f.session);
  });
}

test('continued-in: macOS native descriptors give up without a process-table recheck loop', async t => {
  const f = fixture(t, { platform: 'darwin' });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.descriptor('B', 20);
  for (let i = 0; i < 10; i++) {
    f.clock.now += 4000;
    f.detect();
    await Promise.resolve();
  }
  assert.equal(f.calls, 1);
  assert.equal(f.tableReads, 0);
  assert.equal(f.timers.length, 0);
  assert.equal(f.activeSessions.get('A'), f.session);
});

test('continued-in: a table older than a descriptor cannot permanently cache other', async t => {
  const f = fixture(t, { platform: 'win32' });
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  await cli.refreshProcessTable();
  f.starts.set(20, ft(50));
  f.descriptor('B', 20, 'idle', { procStart: ft(50) });
  const changed = new Date(f.clock.now + 1000);
  fs.utimesSync(path.join(f.descriptors, '20.json'), changed, changed);
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  assert.equal(f.timers.length, 1);
  f.clock.now += 4000;
  await cli.refreshProcessTable();
  f.detect();
  assert.equal(f.activeSessions.get('B'), f.session);
});

test('continued-in: descriptors beyond 1000 invalidate the same identity used for ownership', t => {
  const f = fixture(t);
  for (let pid = 1000; pid < 2001; pid++) f.descriptor('unrelated', pid);
  f.descriptor('B', 99999);
  f.parents.set(99999, 1);
  f.starts.set(99999, ft(99999));
  f.continueTo('B');
  f.write('B', [f.prompt('B')]);
  f.session.knownJsonlFiles.add('B.jsonl');
  f.detect();
  assert.equal(f.activeSessions.get('A'), f.session);
  const before = cli.getDescriptorIdentity();
  f.descriptor('C', 99999);
  f.descriptor('B', 20);
  const after = cli.getDescriptorIdentity();
  assert.notEqual(after, before);
  f.detect();
  assert.equal(f.activeSessions.get('B'), f.session);
});
