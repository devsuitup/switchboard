// see docs/decisions/0003-trigger-delivery-per-tab.md
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '15';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '100';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '5';
process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '5';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli-session-state');
const { createTriggerContext } = require('../trigger-context');
const { start } = require('../trigger-watcher');
const log = { info() {}, warn() {}, error() {}, debug() {} };
const iso = ms => new Date(ms).toISOString();

function fixture(t, platform = 'linux', key = 'direct', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-592-delivery-'));
  const dir = path.join(root, 'descriptors');
  const projectsDir = path.join(root, 'projects');
  const folder = path.join(projectsDir, 'proj');
  const triggers = path.join(root, 'triggers');
  for (const p of [dir, folder, triggers]) fs.mkdirSync(p, { recursive: true });
  let clock = Date.now() + 10000;
  const starts = new Map([[100, '100'], [200, '200'], [300, '300'], [400, '400']]);
  const parents = new Map([[100, 1], [200, 100], [300, 200], [400, 1]]);
  const created = pid => String(134000000000000000n + BigInt(pid * 1000));
  const table = () => new Map([...parents].map(([pid, ppid]) => [pid, { ppid, created: created(pid) }]));
  let tableReader = async () => table();
  let writer = key === 'alias' ? 'b' : 'a';
  let visible = true;
  let currentStatus = { status: 'idle', statusUpdatedAt: Date.now() - 60000 };
  const written = [];
  const timers = new Set();
  const f = { root, dir, folder, triggers, written, parents, starts, table, created };
  function later(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  }
  function transcript(id, entries = []) {
    fs.writeFileSync(path.join(folder, id + '.jsonl'), entries.map(JSON.stringify).join('\n') + '\n');
  }
  const user = (id, text, at) => ({ type: 'user', sessionId: id, timestamp: iso(at), message: { role: 'user', content: text } });
  function descriptor(id, pid = 200, kind = 'interactive', overrides = {}) {
    const raw = { pid, sessionId: id, kind, status: 'idle', procStart: starts.get(pid), ...overrides };
    if (platform === 'win32') { raw.procStart = created(pid); raw.pidDomain = 'win32:anchor'; }
    fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ ...raw, ...overrides }));
  }
  f.descriptor = descriptor;
  f.transcript = transcript;
  f.continueTo = (from, to) => {
    const file = path.join(folder, from + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: from, continuedInSessionId: to }) + '\n');
    if (!fs.existsSync(path.join(folder, to + '.jsonl'))) transcript(to);
  };
  f.setWriter = id => { writer = id; f.writerId = id; if (!fs.existsSync(path.join(folder, id + '.jsonl'))) transcript(id); if (visible) descriptor(id); };
  f.hide = () => { visible = false; fs.rmSync(path.join(dir, '200.json'), { force: true }); };
  f.show = () => { visible = true; descriptor(writer); };
  const session = {
    generation: 1, host: null, isPlainTerminal: false, isAttach: false,
    cwd: '/w', projectFolder: 'proj', exited: false, _cliBusy: false,
    composerState: { pending: 0, lastInputAt: 0 },
  };
  let text;
  session.pty = { pid: 100, write(data) {
    written.push(data);
    if (data !== '\r') { text = data; f.onText?.(data); return; }
    f.onEnter?.(text);
    session._cliBusy = true;
    currentStatus = { status: 'busy', statusUpdatedAt: Date.now() + 1 };
    fs.appendFileSync(path.join(folder, writer + '.jsonl'), JSON.stringify(user(writer, text, Date.now())) + '\n');
    later(() => {
      session._cliBusy = false;
      currentStatus = { status: 'idle', statusUpdatedAt: Date.now() };
      fs.appendFileSync(path.join(folder, writer + '.jsonl'), JSON.stringify({ type: 'assistant', sessionId: writer,
        timestamp: iso(Date.now()), message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }) + '\n');
    }, 25);
  } };
  const activeSessions = new Map([['a', session]]);
  f.session = session;
  f.activeSessions = activeSessions;
  transcript('a');
  f.setWriter(writer);
  cli.init({ dir, platform: platform === 'sandbox' ? 'linux' : platform, log,
    isProcessAlive: () => true,
    now: () => clock,
    ...(platform === 'linux' || platform === 'sandbox' ? {
      readParentPid: pid => platform === 'sandbox' && !f.hostComparable ? null : parents.get(pid) ?? null,
      readProcStart: pid => platform === 'sandbox' && !f.hostComparable ? null : starts.get(pid) ?? null,
    } : { readProcessTable: () => tableReader() }),
  });
  f.warm = () => cli.refreshProcessTable();
  f.expire = () => { clock += 4000; };
  f.deferTable = () => { let resolve; tableReader = () => new Promise(r => { resolve = r; }); return () => resolve?.(table()); };
  f.failTable = () => { tableReader = async () => { throw new Error('process table unavailable'); }; };
  f.ctx = createTriggerContext({ activeSessions, log, isPtyAlive: () => true, projectsDir,
    getCliStatus: () => visible ? { ...currentStatus } : undefined,
    getLiveDescriptor: id => cli.findLiveProcess(id),
    resolveSessionId: id => f.aliases?.get(id.toLowerCase()) || id,
    observeTabWriter: (...args) => f.observation ? f.observation(...args) : cli.observeTabWriter(...args),
    ...options,
  });
  let count = 0;
  f.run = async (trigger, timeout = 1600) => {
    const id = 'case-' + (++count);
    fs.writeFileSync(path.join(triggers, id + '.json'), JSON.stringify({ sessionId: key === 'alias' ? 'b' : 'a',
      command: 'prompt', wait: 'none', timeout_ms: timeout, ...trigger }));
    const file = path.join(triggers, 'processed', id + '.result.json');
    const deadline = performance.now() + timeout + 3000;
    while (!fs.existsSync(file)) {
      if (performance.now() > deadline) throw new Error('missing result ' + id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  const watcher = start(f.ctx);
  t.after(() => {
    watcher.close();
    cli.stop();
    for (const timer of timers) clearTimeout(timer);
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

function refused(result, bytes, expected = []) {
  assert.deepEqual(bytes, expected);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.internal, undefined);
  assert.equal(result.error, expected.length ? 'step not confirmed' : 'not sent', JSON.stringify(result));
  assert.match(result.reason, /ownership|writer|generation|binding|tab/i);
}

async function provenFixture(t, platform, key = 'direct') {
  const f = fixture(t, platform, key);
  if (platform === 'win32') await f.warm();
  if (platform === 'sandbox') f.hostComparable = true;
  if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: f.writerId, procStart: '200' }, identity: '200:200' });
  return f;
}

function changeAt(f, boundary, id, continued = false) {
  let changed = false;
  const change = () => {
    changed = true;
    f.changedAtBoundary = true;
    if (continued) f.continueTo(f.writerId, id);
    f.setWriter(id);
  };
  const original = f.ctx.isSessionBusy;
  const expectedLength = { text: 0, Enter: 1, 'recovery Enter': 2 }[boundary];
  f.ctx.isSessionBusy = (requested, binding) => {
    if (!changed && f.written.length === expectedLength) {
      change();
    }
    return original(requested, binding);
  };
  if (boundary === 'recovery Enter') f.session.pty.write = data => {
    f.written.push(data);
    if (!changed && f.written.length === 2) change();
  };
}

for (const platform of ['win32', 'linux', 'sandbox', 'darwin']) {
  for (const key of ['direct', 'alias']) {
    for (const boundary of ['text', 'Enter', 'recovery Enter']) {
      test(`ADR expanded ${platform}/${key}: unrelated writer at ${boundary} refuses the next bytes`, async t => {
        const f = await provenFixture(t, platform, key);
        changeAt(f, boundary, 'foreign');
        const result = await f.run({});
        assert.equal(f.changedAtBoundary, true);
        const expected = boundary === 'text' ? [] : boundary === 'Enter' ? ['prompt'] : ['prompt', '\r'];
        refused(result, f.written, expected);
        assert.equal(result.sessionId, key === 'alias' ? 'b' : 'a');
        assert.equal(result.written, boundary === 'recovery Enter');
        if (boundary !== 'text') {
          assert.equal(result.text_written, true);
          assert.equal(result.enter_written, boundary === 'recovery Enter');
          assert.equal(result.partial, true);
        }
      });

      test(`ADR expanded ${platform}/${key}: reachable successor at ${boundary} keeps the conversation`, async t => {
        const f = await provenFixture(t, platform, key);
        changeAt(f, boundary, 'successor', true);
        const result = await f.run({});
        assert.equal(f.changedAtBoundary, true);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.sessionId, key === 'alias' ? 'b' : 'a');
        assert.deepEqual(f.written, boundary === 'recovery Enter' ? ['prompt', '\r', '\r'] : ['prompt', '\r']);
      });
    }
  }

  for (const reset of ['/clear', '/new', '/reset', 'fork']) {
    for (const route of ['direct', 'historical']) {
      test(`ADR external ${platform}/${route}: ${reset} leaves the old conversation un-continued`, async t => {
        const f = await provenFixture(t, platform);
        f.setWriter('c');
        f.transcript('c', reset === 'fork' ? [{ type: 'user', sessionId: 'c', forkedFrom: 'a', message: { content: 'fork prompt' } }]
          : [{ type: 'user', sessionId: 'c', message: { content: `<command-name>${reset}</command-name>` } }]);
        if (route === 'historical') {
          f.activeSessions.delete('a'); f.activeSessions.set('c', f.session);
          f.session.realSessionId = 'c'; f.aliases = new Map([['a', 'c']]);
        }
        const result = await f.run({ sessionId: 'a' });
        refused(result, f.written);
        assert.equal(result.sessionId, 'a');
        f.hide();
        if (platform === 'darwin') f.observation = () => ({});
        const unknown = await f.run({ sessionId: 'a' }, route === 'direct' ? 1600 : 150);
        if (route === 'direct') {
          assert.equal(unknown.ok, true, JSON.stringify(unknown));
          assert.deepEqual(f.written, ['prompt', '\r']);
        } else refused(unknown, f.written);
        assert.equal(unknown.sessionId, 'a');
      });
    }
  }

  for (const reset of ['/clear', '/new', '/reset']) {
    test(`ADR alias reset ${platform}: ${reset} permits an unobservable successor without re-key`, async t => {
      const f = await provenFixture(t, platform, 'alias');
      f.onEnter = text => {
        if (text !== reset) return;
        f.setWriter('c'); f.hide();
        if (platform === 'win32') { f.expire(); f.deferTable(); }
        if (platform === 'sandbox') f.hostComparable = false;
        if (platform === 'darwin') f.observation = () => ({});
      };
      const result = await f.run({ command: undefined, chain: [{ command: reset }, { command: 'reply' }] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, [reset, '\r', 'reply', '\r']);
      assert.equal(f.activeSessions.get('a'), f.session);
      assert.equal(result.sessionId, 'b');
    });
    for (const key of ['direct', 'alias']) {
      test(`ADR descriptor lag ${platform}/${key}: ${reset} does not bind the old id as its successor`, async t => {
        const f = await provenFixture(t, platform, key);
        const preId = f.writerId;
        let lag = false;
        if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: lag ? preId : f.writerId, procStart: '200' }, identity: '200:200' });
        f.onEnter = command => {
          if (command === reset) { f.setWriter('c'); f.descriptor(preId); lag = true; }
          if (command === 'reply') { f.show(); lag = false; }
          if (command === 'bound') f.setWriter('d');
        };
        const result = await f.run({ command: undefined, chain: [{ command: reset }, { command: 'reply' }, { command: 'bound' }, { command: 'tail' }] }, 4500);
        refused(result, f.written, [reset, '\r', 'reply', '\r', 'bound', '\r']);
        assert.equal(result.steps[1].written, true);
        assert.equal(f.activeSessions.get('a'), f.session);
      });
    }
  }

  test(`ADR serialization ${platform}: descriptor alias shares the tab across re-key and independent tabs progress`, async t => {
    const f = await provenFixture(t, platform);
    f.continueTo('a', 'b'); f.setWriter('b'); f.session.composerState.pending = 1;
    let pinned;
    const firstPinned = new Promise(resolve => { pinned = resolve; });
    const original = f.ctx.getPtyForSession;
    f.ctx.getPtyForSession = (...args) => { const entry = original(...args); pinned(); return entry; };
    f.onEnter = command => {
      if (command !== 'first') return;
      f.activeSessions.delete('a'); f.activeSessions.set('b', f.session);
      f.session.realSessionId = 'b'; f.aliases = new Map([['a', 'b']]);
    };
    const otherBytes = [];
    f.activeSessions.set('other', { ...f.session, isPlainTerminal: true, composerState: { pending: 0, lastInputAt: 0 },
      pty: { pid: 401, write: data => otherBytes.push(data) } });
    const first = f.run({ sessionId: 'a', command: 'first' });
    await firstPinned;
    const alias = f.run({ sessionId: 'b', command: 'second' });
    const other = await f.run({ sessionId: 'other' });
    assert.equal(other.ok, true); assert.deepEqual(otherBytes.slice(0, 2), ['prompt', '\r']);
    assert.deepEqual(f.written, []);
    f.session.composerState.pending = 0;
    assert.equal((await first).ok, true); assert.equal((await alias).ok, true);
    assert.deepEqual(f.written, ['first', '\r', 'second', '\r']);
  });

  test(`ADR serialization ${platform}: normalized same-id FIFO waits outside the delivery budget`, async t => {
    const f = await provenFixture(t, platform);
    f.session.composerState.pending = 1;
    f.activeSessions.set('A', f.session);
    let pinned;
    let secondLookedUp = false;
    const firstPinned = new Promise(resolve => { pinned = resolve; });
    const original = f.ctx.getPtyForSession;
    f.ctx.getPtyForSession = (id) => { const entry = original(id); if (id === 'a') secondLookedUp = true; pinned(); return entry; };
    const first = f.run({ sessionId: 'A', command: 'first' });
    await firstPinned;
    const second = f.run({ sessionId: 'a', command: 'second' });
    await new Promise(resolve => setTimeout(resolve, 180));
    const lookedUpWhileQueued = secondLookedUp;
    assert.deepEqual(f.written, []);
    f.session.composerState.pending = 0;
    assert.equal((await first).ok, true); assert.equal((await second).ok, true);
    assert.equal(lookedUpWhileQueued, false);
    assert.deepEqual(f.written, ['first', '\r', 'second', '\r']);
  });

  test(`ADR serialization ${platform}: a reset chain keeps the tab lock when a new descriptor id appears`, async t => {
    const f = await provenFixture(t, platform);
    let separate;
    f.onEnter = command => {
      if (command !== '/clear') return;
      f.setWriter('c');
      separate = f.run({ sessionId: 'c', command: 'separate' });
    };
    const chain = await f.run({ command: undefined, chain: [{ command: '/clear' }, { command: 'reply' }] });
    assert.equal(chain.ok, true, JSON.stringify(chain));
    assert.equal((await separate).ok, true);
    assert.deepEqual(f.written, ['/clear', '\r', 'reply', '\r', 'separate', '\r']);
  });

  for (const hops of [1, 2]) {
    for (const route of ['old before re-key', 'current before re-key', 'old after re-key', 'current after re-key']) {
      test(`ADR successor ${platform}: ${hops}-hop continuation, ${route}`, async t => {
        const f = await provenFixture(t, platform);
        if (hops === 1) f.continueTo('a', 'b');
        else { f.continueTo('a', 'middle'); f.continueTo('middle', 'b'); }
        f.setWriter('b');
        if (route.endsWith('after re-key')) {
          f.activeSessions.delete('a'); f.activeSessions.set('b', f.session);
          f.session.realSessionId = 'b'; f.aliases = new Map([['a', 'b']]);
        }
        const requested = route.startsWith('old') ? 'a' : 'b';
        const result = await f.run({ sessionId: requested });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.sessionId, requested);
        assert.deepEqual(f.written, ['prompt', '\r']);
        assert.equal(f.activeSessions.get(route.endsWith('after re-key') ? 'b' : 'a'), f.session);
      });
    }
  }

  for (const key of ['direct', 'alias']) {
    for (const rekey of [false, true]) {
      for (const continued of [false, true]) {
        test(`ADR turn-end ${platform}/${key}: ${continued ? 'reachable' : 'unrelated'} successor, re-key=${rekey}`, async t => {
          const f = await provenFixture(t, platform, key);
          f.onEnter = text => {
            if (text !== 'first') return;
            if (continued) f.continueTo(f.writerId, 'c');
            f.setWriter('c');
            if (rekey) {
              f.activeSessions.delete('a'); f.activeSessions.set('c', f.session);
              f.session.realSessionId = 'c'; f.aliases = new Map([[key === 'alias' ? 'b' : 'a', 'c']]);
            }
          };
          const result = await f.run({ command: undefined, chain: [{ command: 'first' }, { command: 'tail' }] }, 4500);
          if (continued) {
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.deepEqual(f.written, ['first', '\r', 'tail', '\r']);
          } else refused(result, f.written, ['first', '\r']);
          assert.equal(result.steps[0].written, true);
          assert.equal(result.sessionId, key === 'alias' ? 'b' : 'a');
        });
      }
    }
  }
}

for (const platform of ['linux', 'win32']) {
  test(`ADR closest writer ${platform}: unrelated branches cannot pick a first ancestor`, async t => {
    const f = await provenFixture(t, platform, 'alias');
    f.parents.set(250, 100); f.starts.set(250, '250');
    f.parents.set(300, 250); f.descriptor('peer', 300);
    if (platform === 'win32') { f.expire(); await f.warm(); }
    const result = await f.run({});
    assert.equal(result.error, 'session not found', JSON.stringify(result));
    assert.deepEqual(f.written, []);
  });

  test(`ADR reset process ${platform}: a new writer generation cannot take the reset authorization`, async t => {
    const f = await provenFixture(t, platform);
    f.onEnter = command => {
      if (command !== '/clear') return;
      f.parents.set(300, 100); f.hide(); f.descriptor('c', 300); f.transcript('c');
    };
    const result = await f.run({ command: undefined, chain: [{ command: '/clear' }, { command: 'reply' }] });
    refused(result, f.written, ['/clear', '\r']);
    assert.equal(result.steps[0].written, true);
  });
}

test('ADR torn ancestor: direct remains unknown and a child alias gets only one bounded recheck', async t => {
  let refreshes = 0;
  const f = fixture(t, 'linux', 'direct', { cliSessionState: { ...cli, refreshProcessTable: async () => { refreshes++; } } });
  f.descriptor('child', 300);
  fs.writeFileSync(path.join(f.dir, '200.json'), '{');
  const direct = await f.run({});
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const child = await f.run({ sessionId: 'child' });
  assert.equal(child.error, 'session not found');
  assert.deepEqual(f.written, []);
  assert.equal(refreshes, 1);
});

test('ADR Windows failure: a failed table preserves direct delivery and a miss gets one refresh', async t => {
  let refreshes = 0;
  const f = fixture(t, 'win32', 'direct', { cliSessionState: { ...cli, refreshProcessTable: async () => { refreshes++; return cli.refreshProcessTable(); } } });
  f.failTable();
  await f.warm();
  const direct = await f.run({});
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  f.descriptor('hint', 300);
  const alias = await f.run({ sessionId: 'hint' });
  assert.equal(alias.error, 'session not found');
  assert.deepEqual(f.written, []);
  assert.equal(refreshes, 1);
});

for (const key of ['direct', 'alias']) {
  test(`ADR Windows ${key}: table expiry before text never postpones direct delivery`, async t => {
    const f = await provenFixture(t, 'win32', key);
    let expired = false;
    let textAt;
    let enterAt;
    const original = f.ctx.isSessionBusy;
    f.ctx.isSessionBusy = (id, binding) => {
      if (!expired && !f.written.length) { expired = true; f.expire(); f.deferTable(); }
      return original(id, binding);
    };
    f.onText = () => { textAt = Date.now(); };
    f.onEnter = () => { enterAt = Date.now(); };
    const result = await f.run({}, key === 'direct' ? 1600 : 150);
    assert.equal(expired, true);
    if (key === 'direct') {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, ['prompt', '\r']);
      assert.ok(enterAt - textAt < 180);
    } else refused(result, f.written);
  });
}

for (const graph of ['cycle', 'malformed', 'bounded index']) {
  for (const route of ['direct', 'historical']) {
    test(`ADR unresolved ${graph}/${route}: no continuation permission is manufactured`, async t => {
      const f = await provenFixture(t, 'linux');
      f.continueTo('a', 'b'); f.setWriter('b');
      if (graph === 'cycle') f.continueTo('b', 'a');
      if (graph === 'malformed') fs.appendFileSync(path.join(f.folder, 'a.jsonl'), '{"type":"continued-in",broken}\n');
      if (graph === 'bounded index') fs.appendFileSync(path.join(f.folder, 'a.jsonl'), JSON.stringify({ type: 'system', payload: 'x'.repeat(1024 * 1024) }) + '\n{"type":"continued-in",broken}\n');
      if (route === 'historical') {
        f.activeSessions.delete('a'); f.activeSessions.set('b', f.session); f.aliases = new Map([['a', 'b']]);
      }
      const result = await f.run({ sessionId: 'a' }, route === 'direct' ? 1600 : 150);
      if (route === 'direct') {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(f.written, ['prompt', '\r']);
      } else refused(result, f.written);
    });
  }
}

test('ADR metadata control: a record alone and a nested successor never replace the verified writer', async t => {
  const f = await provenFixture(t, 'linux');
  f.continueTo('a', 'b'); f.descriptor('b', 300);
  const direct = await f.run({});
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const nested = await f.run({ sessionId: 'b' });
  assert.equal(nested.error, 'session not found'); assert.deepEqual(f.written, []);
  f.setWriter('foreign');
  const unrelated = await f.run({});
  refused(unrelated, f.written);
});

for (const platform of ['win32', 'linux', 'sandbox', 'darwin']) {
  for (const key of ['direct', 'alias']) {
    test(`ADR matrix ${platform}/${key}: plain step byte/result ownership policy`, async t => {
      const f = fixture(t, platform, key);
      if (platform === 'win32') await f.warm();
      if (platform === 'sandbox') f.hostComparable = true;
      if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: key === 'alias' ? 'b' : 'a', procStart: '200' }, identity: '200:200', supported: true });
      const result = await f.run({});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, ['prompt', '\r']);
      f.written.length = 0;
      f.setWriter('c');
      if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: 'c', procStart: '200' }, identity: '200:200', supported: true });
      if (key === 'alias') {
        f.activeSessions.delete('a'); f.activeSessions.set('c', f.session); f.aliases = new Map([['b', 'c']]);
      }
      refused(await f.run({}), f.written);
    });

    for (const reset of ['/clear', '/new', '/reset']) {
      test(`ADR matrix ${platform}/${key}: ${reset} successor without re-key and later refusal`, async t => {
        const f = fixture(t, platform, key);
        if (platform === 'win32') await f.warm();
        if (platform === 'sandbox') f.hostComparable = true;
        if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: f.writerId || (key === 'alias' ? 'b' : 'a'), procStart: '200' }, identity: '200:200', supported: true });
        f.onEnter = text => {
          if (text === reset) { f.setWriter('c'); f.writerId = 'c'; }
          if (text === 'reply') { f.setWriter('d'); f.writerId = 'd'; }
        };
        const result = await f.run({ command: undefined, chain: [{ command: reset }, { command: 'reply' }, { command: 'tail' }] }, 4500);
        assert.equal(f.activeSessions.get('a'), f.session);
        refused(result, f.written, [reset, '\r', 'reply', '\r']);
        assert.equal(result.sessionId, key === 'alias' ? 'b' : 'a');
        assert.equal(result.steps[0].written, true);
        assert.equal(result.steps[1].written, true);
      });
    }

    test(`ADR matrix ${platform}/${key}: continuation reachability and unrelated movement`, async t => {
      const f = fixture(t, platform, key);
      if (platform === 'win32') await f.warm();
      if (platform === 'sandbox') f.hostComparable = true;
      const requested = key === 'alias' ? 'b' : 'a';
      f.continueTo(requested, 'c'); f.continueTo('c', 'd'); f.setWriter('c');
      if (key === 'alias') f.aliases = new Map([['b', 'a']]);
      if (platform === 'darwin') f.observation = () => ({ writer: { pid: 200, sessionId: f.writerId || 'c', procStart: '200' }, identity: '200:200', supported: true });
      const result = await f.run({});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, ['prompt', '\r']);
      f.written.length = 0; f.setWriter('foreign'); f.writerId = 'foreign';
      refused(await f.run({}), f.written);
    });
  }
}

for (const boundary of ['text', 'Enter', 'recovery Enter']) {
  test(`ADR writes: unrelated writer at ${boundary} stops bytes with partial accounting`, async t => {
    const f = fixture(t);
    if (boundary === 'text') f.session.composerState.pending = 1;
    if (boundary === 'text') setTimeout(() => { f.setWriter('c'); f.session.composerState.pending = 0; }, 30);
    if (boundary === 'Enter') f.onText = () => f.setWriter('c');
    if (boundary === 'recovery Enter') {
      f.session.pty.write = data => { f.written.push(data); if (data === '\r') f.setWriter('c'); };
    }
    const result = await f.run({});
    const expected = boundary === 'text' ? [] : boundary === 'Enter' ? ['prompt'] : ['prompt', '\r'];
    refused(result, f.written, expected);
    assert.equal(result.written, boundary === 'recovery Enter');
    if (boundary === 'Enter') { assert.equal(result.text_written, true); assert.equal(result.enter_written, false); assert.match(result.reason, /partial|text/i); }
  });
}

test('ADR scenario: plain terminal, local bg attach and remote attach do not probe ownership', async t => {
  for (const type of ['plain', 'bg', 'remote']) {
    const f = fixture(t);
    f.session.isPlainTerminal = type === 'plain'; f.session.isAttach = type === 'bg'; f.session.host = type === 'remote' ? 'vps' : null;
    if (type === 'remote') f.session.handle = { write: data => f.session.pty.write(data), isAlive: () => true };
    f.observation = () => { throw new Error('ownership must not be called'); };
    const result = await f.run({});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.written, ['prompt', '\r']);
  }
});

test('ADR scenario: missing own descriptor and nested headless writer cannot alias', async t => {
  const f = fixture(t);
  f.hide(); f.descriptor('child', 300, 'headless');
  const direct = await f.run({});
  assert.equal(direct.ok, true); assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const alias = await f.run({ sessionId: 'child' });
  assert.equal(alias.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR scenario: nested interactive writer cannot override a valid closest writer', async t => {
  const f = fixture(t);
  f.descriptor('child', 300, 'interactive');
  const direct = await f.run({});
  assert.equal(direct.ok, true); assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const child = await f.run({ sessionId: 'child' });
  assert.equal(child.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR scenario: close/reopen and reused PID cannot receive the pinned delivery', async t => {
  const f = fixture(t);
  f.onText = () => {
    f.session.exited = true;
    f.activeSessions.set('a', { ...f.session, generation: 2, exited: false, pty: { pid: 100, write: d => f.written.push('NEW:' + d) } });
  };
  const result = await f.run({});
  refused(result, f.written, ['prompt']);
  assert.equal(result.text_written, true);
});

test('ADR scenario: id normalization preserves R and rejects distinct live case-colliding tabs', async t => {
  const f = fixture(t);
  const result = await f.run({ sessionId: 'A' });
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'A'); assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  f.activeSessions.set('A', { ...f.session, pty: { pid: 101, write: data => f.written.push(data) } });
  const ambiguous = await f.run({});
  assert.equal(ambiguous.ok, false); assert.match(ambiguous.reason, /ambiguous/i); assert.deepEqual(f.written, []);
});

test('ADR scenario: cold Windows admission warms before text and refuses the unrelated writer', async t => {
  const f = fixture(t, 'win32');
  const finish = f.deferTable();
  const warming = f.warm();
  f.session.composerState.pending = 1;
  f.setWriter('c');
  const resultPromise = f.run({});
  await new Promise(resolve => setTimeout(resolve, 40));
  finish(); await warming; f.session.composerState.pending = 0;
  refused(await resultPromise, f.written);
});

for (const key of ['direct', 'alias']) {
  test(`ADR scenario: Windows ${key} table expiry in the text/Enter gap never awaits refresh`, async t => {
    const f = fixture(t, 'win32', key);
    await f.warm();
    let textAt;
    let enterAt;
    f.onText = () => { textAt = Date.now(); f.expire(); f.deferTable(); };
    f.onEnter = () => { enterAt = Date.now(); };
    const result = await f.run({});
    if (key === 'direct') {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, ['prompt', '\r']);
      assert.ok(enterAt - textAt < 180, 'Enter did not wait for the unresolved table');
    } else {
      refused(result, f.written, ['prompt']);
      assert.equal(result.enter_written, false);
    }
  });
}

for (const reset of ['/clear', '/new', '/reset']) {
  test(`ADR scenario: ${reset} lag/unavailable descriptor does not bind the pre-reset id`, async t => {
    const f = fixture(t, 'linux', 'alias');
    f.onEnter = text => {
      if (text === reset) f.hide();
      if (text === 'reply') { f.setWriter('c'); f.show(); }
      if (text === 'bound') f.setWriter('d');
    };
    const result = await f.run({ command: undefined, chain: [{ command: reset }, { command: 'reply' }, { command: 'bound' }, { command: 'tail' }] }, 4500);
    refused(result, f.written, [reset, '\r', 'reply', '\r', 'bound', '\r']);
    assert.equal(f.activeSessions.get('a'), f.session);
  });
}

test('ADR scenario: no viable fallback fast-fails macOS, namespaces, external processes and bg jobs', async t => {
  for (const platform of ['darwin', 'sandbox', 'linux', 'win32']) {
    const f = fixture(t, platform);
    f.descriptor('outside', 400);
    let started = Date.now();
    const result = await f.run({ sessionId: 'outside' }, 900);
    assert.equal(result.error, 'session not found'); assert.deepEqual(f.written, []);
    assert.ok(Date.now() - started < 300);
    f.descriptor('job', 400, 'bg', { jobId: '1234abcd' });
    started = Date.now();
    const bg = await f.run({ sessionId: 'job' }, 900);
    assert.equal(bg.error, 'background session, not attached here'); assert.equal(bg.jobId, '1234abcd');
    assert.deepEqual(f.written, []); assert.ok(Date.now() - started < 300);
  }
});

test('ADR scenario: an old id continued into an unattached bg job fails immediately', async t => {
  const f = fixture(t);
  f.continueTo('a', 'job'); f.descriptor('job', 400, 'bg', { jobId: '1234abcd' });
  const result = await f.run({});
  assert.equal(result.error, 'background session, not attached here'); assert.equal(result.jobId, '1234abcd');
  assert.deepEqual(f.written, []);
});

test('ADR scenario: a writer changes during turn-end wait and preserves the already written step', async t => {
  const f = fixture(t);
  f.onEnter = text => { if (text === 'first') setTimeout(() => f.setWriter('c'), 10); };
  const result = await f.run({ command: undefined, chain: [{ command: 'first' }, { command: 'tail' }] }, 4500);
  refused(result, f.written, ['first', '\r']);
  assert.equal(result.steps[0].written, true);
});

test('ADR lock: a late descriptor alias joins the pinned tab while different tabs progress', async t => {
  const f = fixture(t);
  f.continueTo('a', 'b'); f.setWriter('b'); f.session.composerState.pending = 1;
  const otherBytes = [];
  f.activeSessions.set('other', { ...f.session, isPlainTerminal: true, composerState: { pending: 0, lastInputAt: 0 }, pty: { pid: 401, write: data => otherBytes.push(data) } });
  const first = f.run({ command: 'first' }, 4500);
  await new Promise(resolve => setTimeout(resolve, 30));
  const alias = f.run({ sessionId: 'b', command: 'second' }, 4500);
  const other = await f.run({ sessionId: 'other' }, 600);
  assert.equal(other.ok, true); assert.deepEqual(otherBytes.slice(0, 2), ['prompt', '\r']);
  f.session.composerState.pending = 0;
  assert.equal((await first).ok, true); assert.equal((await alias).ok, true);
  assert.deepEqual(f.written, ['first', '\r', 'second', '\r']);
});

test('ADR scenario: remote error snapshot wins over a verified local descriptor candidate', async t => {
  const f = fixture(t, 'linux', 'alias');
  f.ctx.remote = { lookup: () => ({ aliases: ['one', 'two'] }), send: () => { throw new Error('must refuse'); } };
  const result = await f.run({});
  assert.equal(result.ok, false); assert.deepEqual(f.written, []); assert.match(result.reason, /host|one|two|ambig/i);
});

test('ADR reset authorization: quoting clear, uppercase clear and resume do not authorize a writer change', async t => {
  for (const command of ['quote /clear', '/CLEAR', '/resume c']) {
    const f = fixture(t);
    f.onEnter = () => f.setWriter('c');
    const result = await f.run({ command: undefined, chain: [{ command }, { command: 'tail' }] }, 4500);
    refused(result, f.written, [command, '\r']);
  }
});

test('ADR reset authorization: it cannot transfer to a separately queued historical alias', async t => {
  const f = fixture(t, 'linux', 'alias');
  f.onEnter = text => { if (text === '/clear') { f.setWriter('c'); f.aliases = new Map([['b', 'a']]); } };
  const chain = f.run({ command: undefined, chain: [{ command: '/clear' }, { command: 'reply' }] }, 4500);
  await new Promise(resolve => setTimeout(resolve, 30));
  const queued = f.run({ command: 'separate' }, 4500);
  assert.equal((await chain).ok, true);
  const result = await queued;
  assert.equal(result.ok, false); assert.equal(result.error, 'not sent');
  assert.deepEqual(f.written, ['/clear', '\r', 'reply', '\r']);
});

test('ADR reset completion: recovery Enter never reaches the verified successor', async t => {
  const f = fixture(t);
  let text;
  f.session.pty.write = data => {
    f.written.push(data);
    if (data !== '\r') text = data;
    else if (text === '/clear') f.setWriter('c');
  };
  const result = await f.run({ command: undefined, chain: [{ command: '/clear' }] });
  assert.deepEqual(f.written, ['/clear', '\r']);
  assert.equal(result.steps[0].written, true);
  assert.notEqual(result.error, 'not sent');
});

test('ADR classifier: an external descriptor without identity cannot hide a verified foreign tab writer', async t => {
  const f = fixture(t);
  f.setWriter('c'); f.descriptor('external', 400, 'interactive', { procStart: null });
  refused(await f.run({}), f.written);
});

test('ADR classifier: unresolved ancestor kind leaves a nested interactive role unknown', async t => {
  const f = fixture(t);
  f.descriptor('a', 200, null); f.descriptor('child', 300, 'interactive');
  const result = await f.run({});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const child = await f.run({ sessionId: 'child' });
  assert.equal(child.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR classifier: an interactive child below a background CLI is not the tab writer', async t => {
  const f = fixture(t);
  f.descriptor('background-parent', 200, 'bg'); f.descriptor('child', 300, 'interactive');
  const direct = await f.run({});
  assert.equal(direct.ok, true, JSON.stringify(direct)); assert.deepEqual(f.written, ['prompt', '\r']);
  f.written.length = 0;
  const child = await f.run({ sessionId: 'child' });
  assert.equal(child.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR normalization: case-only continued-in ids remain the same conversation', async t => {
  const f = fixture(t);
  f.transcript('a', [{ type: 'continued-in', sessionId: 'A', continuedInSessionId: 'B' }]);
  f.transcript('b'); f.setWriter('b');
  const result = await f.run({ sessionId: 'A' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sessionId, 'A'); assert.deepEqual(f.written, ['prompt', '\r']);
});

for (const platform of ['win32', 'linux', 'sandbox', 'darwin']) {
  test(`ADR availability ${platform}: unknown direct delivers, historical alias expires unwritten`, async t => {
    const f = fixture(t, platform);
    f.hide();
    if (platform === 'win32') f.deferTable();
    const direct = await f.run({});
    assert.equal(direct.ok, true, JSON.stringify(direct)); assert.deepEqual(f.written, ['prompt', '\r']);
    f.written.length = 0; f.aliases = new Map([['old', 'a']]);
    refused(await f.run({ sessionId: 'old' }, 100), f.written);
  });
}

test('ADR alias admission: historical unknown recovers proof before text', async t => {
  const f = fixture(t, 'linux', 'alias');
  f.aliases = new Map([['b', 'a']]); f.hide();
  const resultPromise = f.run({});
  await new Promise(resolve => setTimeout(resolve, 35)); f.show();
  assert.equal((await resultPromise).ok, true); assert.deepEqual(f.written, ['prompt', '\r']);
});

test('ADR fallback: a plausible cold Windows hint gets one shared refresh', async t => {
  const f = fixture(t, 'win32', 'alias');
  const finish = f.deferTable();
  const resultPromise = f.run({});
  await new Promise(resolve => setTimeout(resolve, 35)); finish();
  assert.equal((await resultPromise).ok, true); assert.deepEqual(f.written, ['prompt', '\r']);
});

for (const boundary of ['Enter', 'recovery Enter']) {
  for (const key of ['direct', 'alias']) {
    test(`ADR Windows ${key}: expired table at ${boundary} uses only synchronous evidence`, async t => {
      const f = fixture(t, 'win32', key);
      await f.warm();
      if (boundary === 'Enter') {
        const base = f.ctx.isSessionBusy;
        f.ctx.isSessionBusy = (id, binding) => {
          if (f.written.length === 1) { f.expire(); f.deferTable(); }
          return base(id, binding);
        };
      } else {
        f.session.pty.write = data => {
          f.written.push(data);
          if (data === '\r' && f.written.length === 2) { f.expire(); f.deferTable(); }
        };
      }
      const result = await f.run({});
      if (key === 'direct') {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(f.written, boundary === 'Enter' ? ['prompt', '\r'] : ['prompt', '\r', '\r']);
      } else refused(result, f.written, boundary === 'Enter' ? ['prompt'] : ['prompt', '\r']);
    });
  }
}

test('ADR budget: alias proof arriving after the text deadline cannot authorize bytes', async t => {
  const realNow = Date.now;
  const base = realNow();
  let clock = base;
  let hidden = false;
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  const f = fixture(t, 'linux', 'alias', { cliSessionState: { ...cli, refreshProcessTable: async () => { clock = base + 101; hidden = false; } } });
  f.observation = () => hidden ? {} : { writer: { pid: 200, sessionId: 'b', procStart: '200' }, identity: '200:200', supported: true };
  const original = f.ctx.isSessionBusy;
  f.ctx.isSessionBusy = (id, binding) => { if (!f.written.length) hidden = true; return original(id, binding); };
  const result = await f.run({}, 100);
  assert.deepEqual(f.written, []);
  assert.equal(result.error, 'not sent'); assert.match(result.reason, /deadline/i);
});

test('ADR tab mutex: an expired queued alias cannot let a third alias bypass its holder', async t => {
  const previous = process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS;
  process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '100';
  t.after(() => { process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = previous; });
  const f = fixture(t);
  f.continueTo('a', 'b'); f.setWriter('b'); f.session.composerState.pending = 1;
  const first = f.run({ command: 'first' }, 4000);
  first.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 25));
  const timeout = await f.run({ sessionId: 'b', command: 'expires' }, 100);
  assert.equal(timeout.error, 'not sent'); assert.deepEqual(f.written, []);
  f.continueTo('b', 'c'); f.setWriter('c');
  const third = f.run({ sessionId: 'c', command: 'third' }, 4000);
  third.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 15)); f.session.composerState.pending = 0;
  assert.equal((await first).ok, true); assert.equal((await third).ok, true);
  assert.deepEqual(f.written, ['first', '\r', 'third', '\r']);
});

for (const platform of ['win32', 'linux', 'sandbox', 'darwin']) {
  for (const reset of ['/clear', '/new', '/reset']) {
    test(`ADR unknown reset ${platform}: ${reset} and successor retain availability without re-key`, async t => {
      const f = fixture(t, platform);
      if (platform === 'win32') f.deferTable();
      if (platform === 'linux') f.starts.clear();
      f.onEnter = text => { if (text === reset) { f.setWriter('c'); f.hide(); } };
      const result = await f.run({ command: undefined, chain: [{ command: reset }, { command: 'reply' }] }, 4000);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.written, [reset, '\r', 'reply', '\r']);
      assert.equal(f.activeSessions.get('a'), f.session);
      assert.equal(result.steps[0].confirm_source, undefined);
    });
  }
}

for (const platform of ['sandbox', 'darwin']) {
  test(`ADR unsupported ${platform}: an unrekeyed descriptor id cannot alias the local tab`, async t => {
    const f = fixture(t, platform, 'alias');
    const at = performance.now();
    const result = await f.run({}, 1200);
    assert.equal(result.error, 'session not found'); assert.deepEqual(f.written, []);
    assert.ok(performance.now() - at < 300);
  });
}

for (const platform of ['win32', 'linux']) {
  test(`ADR classifier ${platform}: a stale PID file cannot block a separate valid closest writer`, async t => {
    const f = fixture(t, platform);
    f.descriptor('stale', 100, 'interactive', { procStart: platform === 'win32' ? f.created(99) : '999' });
    if (platform === 'win32') await f.warm();
    const result = await f.run({});
    assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(f.written, ['prompt', '\r']);
  });
}

test('ADR classifier: Windows child-before-parent creation order cannot prove an alias', async t => {
  const f = fixture(t, 'win32', 'alias');
  f.parents.set(200, 300); f.parents.set(300, 100); await f.warm();
  const result = await f.run({});
  assert.equal(result.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR ambiguity: one writer generation under two tabs and equal-depth writers never pick first', async t => {
  const f = fixture(t, 'linux', 'alias');
  const duplicate = { ...f.session, pty: { pid: 100, write: data => f.written.push('other:' + data) } };
  f.activeSessions.set('other', duplicate);
  const twoTabs = await f.run({});
  assert.equal(twoTabs.ok, false); assert.deepEqual(f.written, []);
  f.activeSessions.delete('other'); f.parents.set(300, 100); f.descriptor('peer', 300);
  const twoWriters = await f.run({});
  assert.equal(twoWriters.error, 'session not found'); assert.deepEqual(f.written, []);
});

test('ADR reset cursor: old compact evidence cannot confirm a compact after an unobserved reset', async t => {
  const f = fixture(t);
  f.transcript('a', [{ type: 'system', subtype: 'compact_boundary', timestamp: iso(Date.now() + 60000), uuid: 'old-boundary',
    sessionId: 'a', compactMetadata: { trigger: 'manual' } }]);
  f.onEnter = text => { if (text === '/clear') { f.setWriter('c'); f.hide(); } };
  const result = await f.run({ command: undefined, chain: [{ command: '/clear' }, { command: '/compact' }, { command: 'tail' }] }, 2500);
  assert.equal(result.error, 'step not confirmed', JSON.stringify(result)); assert.equal(result.compaction_observed, false);
  assert.deepEqual(f.written, ['/clear', '\r', '/compact', '\r']);
});

test('ADR reset bookkeeping: observed completed clear suppresses recovery without binding a lagging id', async t => {
  const f = fixture(t);
  let text;
  f.session.pty.write = data => {
    f.written.push(data);
    if (data !== '\r') text = data;
    else if (text === '/clear') {
      f.session.realSessionId = 'c';
      f.transcript('c', [{ type: 'user', sessionId: 'c', timestamp: iso(Date.now()),
        message: { content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>' } }]);
    }
  };
  const result = await f.run({ command: undefined, chain: [{ command: '/clear' }] });
  assert.deepEqual(f.written, ['/clear', '\r']);
  assert.equal(result.steps[0].written, true);
});

test('ADR partial write: an Enter I/O failure records known text without claiming safe resend', async t => {
  const f = fixture(t);
  f.session.pty.write = data => { if (data === '\r') throw new Error('broken input'); f.written.push(data); };
  const result = await f.run({});
  assert.deepEqual(f.written, ['prompt']);
  assert.equal(result.error, 'step not confirmed', JSON.stringify(result));
  assert.equal(result.text_written, true); assert.equal(result.enter_written, false); assert.equal(result.written, false);
  assert.match(result.reason, /partial text/i);
});
