'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '2000';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '150';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ID_A, ID_B } = require('./helpers/trigger-world');
const { arrange } = require('./helpers/trigger-flow');

const writes = events => events.filter(event => event[0] === 'write');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a newly spawned session receives no byte until a fresh descriptor holds idle: absent, stale idle, busy, waiting, then stable idle', async t => {
  const timeline = [];
  const a = arrange(t, {
    afterSpawn({ world, key, launchStartedAt }) {
      world.statuses.delete(key);
      const set = (ms, status) => setTimeout(() => world.statuses.set(key, status()), ms);
      set(250, () => ({ status: 'idle', statusUpdatedAt: launchStartedAt - 5000 }));
      set(450, () => ({ status: 'busy', statusUpdatedAt: Date.now() }));
      set(650, () => ({ status: 'waiting', statusUpdatedAt: Date.now() }));
      set(850, () => ({ status: 'idle', statusUpdatedAt: Date.now() }));
    },
    onWrite(world, key, data) { if (data !== '\r') timeline.push({ at: Date.now(), status: world.statuses.get(key) }); },
  });
  const started = Date.now();
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'ready now' });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.resumed, true);
  assert.equal(timeline.length, 1);
  assert.ok(timeline[0].at - started >= 850 + 150 - 50, `text typed too early: ${timeline[0].at - started} ms`);
  assert.equal(timeline[0].status.status, 'idle');
  assert.ok(timeline[0].status.statusUpdatedAt >= started);
  assert.deepEqual(writes(a.events).map(event => event[2]), ['ready now', '\r']);
});

test('without a fresh descriptor the prompt is never typed and the refusal keeps the launch evidence', async t => {
  for (const [name, afterSpawn] of [
    ['absent', ({ world, key }) => world.statuses.delete(key)],
    ['stale idle', ({ world, key, launchStartedAt }) => world.statuses.set(key, { status: 'idle', statusUpdatedAt: launchStartedAt - 9000 })],
  ]) {
    const a = arrange(t, { afterSpawn });
    const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'never', timeout_ms: 1500 });
    assert.equal(result.outcome, 'refused', name);
    assert.equal(result.reason, 'session readiness unavailable', name);
    assert.equal(result.resumed, true, name);
    assert.equal(result.sessionId, ID_A, name);
    assert.equal(result.wrote, false, name);
    assert.deepEqual(writes(a.events), [], name);
    assert.ok(a.world.activeSessions.has(ID_A), `${name}: the session stays open`);
  }
});

test('an idle flicker shorter than the settle window never authorizes the text', async t => {
  const a = arrange(t, {
    afterSpawn({ world, key }) {
      let flip = true;
      const timer = setInterval(() => { world.statuses.set(key, { status: flip ? 'idle' : 'busy', statusUpdatedAt: Date.now() }); flip = !flip; }, 60);
      t.after(() => clearInterval(timer));
    },
  });
  const result = await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'x', timeout_ms: 1200 });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.created, true);
  assert.deepEqual(writes(a.events), []);
});

test('opening without a prompt bypasses the prompt-readiness gate', async t => {
  const a = arrange(t, { afterSpawn: ({ world, key }) => world.statuses.delete(key) });
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, timeout_ms: 1500 });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.resumed, true);
  assert.deepEqual(writes(a.events), []);
});

for (const [name, request, key, extra] of [
  ['open-here', { version: 1, action: 'open', sessionId: ID_A, prompt: 'p' }, ID_A, { resumed: false }],
  ['confirmed resumed', { version: 1, action: 'open', sessionId: ID_A, prompt: 'p' }, null, { resumed: true }],
  ['confirmed new', { version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'p' }, null, { created: true }],
]) {
  test(`${name}: a deadline during submission verification is a timeout, not a success, and nothing is written afterwards`, async t => {
    const a = arrange(t, { autoTurn: false });
    if (key) a.world.addSession(key);
    const result = await a.submit({ ...request, timeout_ms: 1300 });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session action timed out');
    assert.equal(result.uncertain, true);
    assert.equal(result.submitted, 'assumed');
    assert.equal(result.wrote, true);
    assert.equal(result.text_written, true);
    assert.equal(result.enter_written, true);
    assert.equal(result.steps_total, 1);
    assert.equal(result.timedOut, true);
    for (const [flag, value] of Object.entries(extra)) assert.equal(result[flag], value);
    assert.deepEqual(writes(a.events).map(event => event[2]), ['p', '\r']);
    await sleep(2300);
    assert.deepEqual(writes(a.events).map(event => event[2]), ['p', '\r'], 'no late Enter, recovery or cleanup');
  });
}

test('a deadline between the text and its Enter withholds the Enter and keeps the partial evidence', async t => {
  const startedAt = Date.now();
  const a = arrange(t, {
    autoTurn: false,
    onWrite(world, key, data) { if (data !== '\r') { while (Date.now() < startedAt + 1500) { /* hold the text write open past the deadline */ } } },
  });
  a.world.addSession(ID_A);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'cut', timeout_ms: 1200 });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.text_written, true);
  assert.equal(result.enter_written, false);
  assert.equal(result.wrote, true);
  assert.match(result.reason, /Enter was withheld/);
  assert.deepEqual(writes(a.events).map(event => event[2]), ['cut']);
});

test('a dialog, a busy turn and a dirty composer refuse the prompt with the existing delivery reasons and write nothing', async t => {
  const cases = [
    ['dialog', world => world.statuses.set(ID_A, { status: 'waiting', statusUpdatedAt: Date.now() }), 'the CLI reports a dialog open (waiting); nothing was written into it'],
    ['busy', world => { world.statuses.set(ID_A, { status: 'busy', statusUpdatedAt: Date.now() }); world.activeSessions.get(ID_A)._cliBusy = true; }, 'the CLI still reported a turn running (busy) at the deadline; nothing was written'],
  ];
  for (const [name, arrange_, reason] of cases) {
    const a = arrange(t);
    a.world.addSession(ID_A);
    arrange_(a.world);
    const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'x', timeout_ms: 700 });
    assert.equal(result.outcome, 'refused', name);
    assert.equal(result.reason, reason, name);
    assert.equal(result.wrote, false, name);
    assert.deepEqual(writes(a.events), [], name);
  }
  const dirty = arrange(t);
  const session = dirty.world.addSession(ID_A);
  session.composerState.pending = 4;
  const result = await dirty.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'x', timeout_ms: 600 });
  assert.match(result.reason, /unsubmitted in the composer/);
  assert.deepEqual(writes(dirty.events), []);
});

test('a late descriptor after the deadline cannot change a terminal result', async t => {
  const a = arrange(t, { afterSpawn: ({ world, key }) => world.statuses.delete(key) });
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'x', timeout_ms: 900 });
  assert.equal(result.reason, 'session readiness unavailable');
  a.world.statuses.set(ID_A, { status: 'idle', statusUpdatedAt: Date.now() });
  await sleep(500);
  assert.deepEqual(writes(a.events), []);
});

test('a new session obtains its descriptor like a resumed one', async t => {
  const a = arrange(t);
  const result = await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'hi' });
  assert.equal(result.sessionId, ID_B);
  assert.equal(result.outcome, 'opened');
});

// ── Sandboxed targets: readiness comes from the PTY-scoped raw descriptor proof ──
const fs = require('node:fs');
const path = require('node:path');
const { tempRoot } = require('./helpers/trigger-world');
const { makeProc } = require('./helpers/fake-proc');
const realCli = require('../cli-session-state');

const NS_BOX = 'pid:[4026532001]';

function sandboxRig(t, sessionId) {
  const root = tempRoot(t);
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const proc = makeProc(path.join(root, 'proc'));
  const field = (pid, index) => {
    const stat = fs.readFileSync(path.join(proc.root, String(pid), 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[index];
  };
  realCli.init({ dir, activeSessions: new Map(), log: { info() {}, warn() {}, error() {}, debug() {} }, platform: 'linux',
    isProcessAlive: () => true, readProcStart: pid => field(pid, 19), readParentPid: pid => Number(field(pid, 1)), readCliProcess: () => false });
  t.after(() => realCli.stop());
  proc.add(8000, { start: '500' }).add(8100, { start: '600', ppid: 8000 }).add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: NS_BOX });
  const descriptor = (status, statusUpdatedAt, extra = {}) => {
    try {
      fs.writeFileSync(path.join(dir, '42.json'), JSON.stringify({
        pid: 42, sessionId, kind: 'interactive', status, statusUpdatedAt, procStart: '777', cwd: '/work/project', ...extra }));
    } catch { /* the rig was already removed by a finished test */ }
  };
  return { proc, dir, descriptor, cli: realCli, edges: { procRoot: proc.root } };
}

const MODES = [
  ['resumed', ID_A, { version: 1, action: 'open', sessionId: ID_A, prompt: 'sandboxed' }, { resumed: true }],
  ['new', ID_B, { version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'sandboxed' }, { created: true }],
];

for (const [mode, id, request, flags] of MODES) {
  for (const occupied of [false, true]) {
    test(`sandboxed ${mode} (host N ${occupied ? 'occupied by another process' : 'absent'}): bytes only after a proven fresh settled idle, exactly one pair`, async t => {
      const rig = sandboxRig(t, id);
      if (occupied) rig.proc.add(42, { start: '999' });
      const timeline = [];
      const a = arrange(t, {
        world: { real: rig }, spawnSession: { sandbox: true, pid: 8000 },
        afterSpawn({ launchStartedAt }) {
          const at = (ms, fn) => setTimeout(fn, ms);
          at(250, () => rig.descriptor('idle', launchStartedAt - 5000));
          at(450, () => rig.descriptor('busy', Date.now()));
          at(650, () => rig.descriptor('waiting', Date.now()));
          at(850, () => rig.descriptor('idle', Date.now()));
        },
        onWrite(world, key, data) {
          if (data !== '\r') { timeline.push(rig.cli.observeSandboxWriterV1(8000, { sessionId: id, ptyStart: '500', ...rig.edges }).writer?.status); return; }
          rig.descriptor('busy', Date.now());
          setTimeout(() => rig.descriptor('idle', Date.now()), 80);
        },
      });
      const started = Date.now();
      const result = await a.submit(request);
      assert.equal(result.outcome, 'opened');
      for (const [flag, value] of Object.entries(flags)) assert.equal(result[flag], value);
      assert.deepEqual(timeline, ['idle']);
      assert.ok(Date.now() - started >= 850);
      assert.deepEqual(writes(a.events).map(event => event[2]), ['sandboxed', '\r']);
    });
  }
}

test('sandboxed targets without a proven mapping never receive bytes and refuse readiness', async t => {
  const cases = [
    ['inner pid mismatch', rig => rig.proc.add(9000, { nspid: [9000, 43], start: '777', ppid: 8100, ns: NS_BOX })],
    ['namespace missing', rig => rig.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: null })],
    ['start mismatch', rig => rig.proc.add(9000, { nspid: [9000, 42], start: '778', ppid: 8100, ns: NS_BOX })],
    ['outside the pty tree', rig => rig.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 1, ns: NS_BOX })],
    ['descriptor start differs', rig => rig.descriptor('idle', Date.now() + 100000, { procStart: '778' })],
    ['procfs unreadable', rig => { rig.proc.add(7000, { start: '1' }); rig.proc.unreadable(7000); }],
    ['second eligible writer', rig => { rig.proc.add(9100, { nspid: [9100, 43], start: '888', ppid: 8100, ns: NS_BOX }); fs.writeFileSync(path.join(rig.dir, '43.json'), JSON.stringify({ pid: 43, sessionId: ID_A, kind: 'interactive', status: 'idle', statusUpdatedAt: Date.now() + 100000, procStart: '888' })); }],
  ];
  for (const [name, break_] of cases) {
    const rig = sandboxRig(t, ID_A);
    const a = arrange(t, {
      world: { real: rig }, spawnSession: { sandbox: true, pid: 8000 },
      afterSpawn() { rig.descriptor('idle', Date.now() + 100000); break_(rig); },
    });
    const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'never', timeout_ms: 1200 });
    assert.equal(result.outcome, 'refused', name);
    assert.equal(result.resumed, true, name);
    assert.deepEqual(writes(a.events), [], name);
    assert.ok(/readiness|ownership|binding/.test(result.reason), `${name}: ${result.reason}`);
  }
});

test('a nested interactive descriptor below the writer does not make the sandbox proof ambiguous', async t => {
  const rig = sandboxRig(t, ID_A);
  rig.descriptor('idle', Date.now());
  rig.proc.add(9100, { nspid: [9100, 43], start: '888', ppid: 9000, ns: NS_BOX });
  fs.writeFileSync(path.join(rig.dir, '43.json'), JSON.stringify({ pid: 43, sessionId: 'other', kind: 'interactive', status: 'busy', statusUpdatedAt: 1, procStart: '888' }));
  const seen = rig.cli.observeSandboxWriterV1(8000, { sessionId: ID_A, ptyStart: '500', ...rig.edges });
  assert.equal(seen.writer.hostPid, 9000);
});

test('losing the sandbox proof between the text and its Enter withholds the Enter', async t => {
  const rig = sandboxRig(t, ID_A);
  const a = arrange(t, {
    world: { real: rig }, spawnSession: { sandbox: true, pid: 8000 }, autoTurn: false,
    afterSpawn({ launchStartedAt }) { rig.descriptor('idle', launchStartedAt + 5); },
    onWrite(world, key, data) { if (data !== '\r') rig.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: null }); },
  });
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'half', timeout_ms: 3000 });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.text_written, true);
  assert.equal(result.enter_written, false);
  assert.deepEqual(writes(a.events).map(event => event[2]), ['half']);
});

test('open-here keeps the legacy fallback when no usable descriptor exists at the first read', async t => {
  const a = arrange(t);
  a.world.addSession(ID_A);
  a.world.statuses.delete(ID_A);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'hello', timeout_ms: 3000 });
  assert.equal(result.outcome, 'opened');
  assert.equal(result.resumed, false);
  assert.deepEqual(writes(a.events).map(event => event[2]), ['hello', '\r']);
});

test('open-here on a sandboxed tab without a proven writer never falls back to typing', async t => {
  const rig = sandboxRig(t, ID_A);
  const a = arrange(t, { world: { real: rig } });
  a.world.addSession(ID_A, { sandbox: true, pid: 8000 });
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'never', timeout_ms: 1500 });
  assert.equal(result.outcome, 'refused');
  assert.deepEqual(writes(a.events), []);
});

// ── Real bubblewrap: the shipped wrapper around a fake descriptor writer in its own PID namespace ──
const { spawnSync } = require('node:child_process');
const nodePty = require('node-pty');
const { makeWorld, startWatcher } = require('./helpers/trigger-world');

const LINUX_HOST = process.platform === 'linux';
const REAL_BWRAP = LINUX_HOST && spawnSync('bwrap', [
  '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--share-net', '--dir', '/var',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
  '/bin/true',
], { encoding: 'utf8' }).status === 0;

test('real bwrap readiness fixture: CI that asks for it gets it, not a skip',
  { skip: !process.env.SWITCHBOARD_REQUIRE_REAL_BWRAP && 'only when SWITCHBOARD_REQUIRE_REAL_BWRAP is set' }, () => {
    assert.ok(REAL_BWRAP, 'bwrap with unprivileged user namespaces must work on this runner');
  });

const FAKE_CLAUDE = [
  '#!/usr/bin/env bash',
  'sid="$FIXTURE_SESSION_ID"',
  'dir="$HOME/.claude/sessions"',
  'mkdir -p "$dir"',
  'stat=$(</proc/self/stat); rest=${stat##*) }; set -- $rest',
  'start="${20}"',
  '[ -n "${FIXTURE_BAD_START:-}" ] && start="$FIXTURE_BAD_START"',
  'write() {',
  `  printf '{"pid":%s,"sessionId":"%s","kind":"interactive","status":"%s","statusUpdatedAt":%s,"procStart":"%s","cwd":"%s"}' "$$" "$sid" "$1" "$(date +%s%3N)" "$start" "$PWD" > "$dir/$$.json.tmp"`,
  '  mv "$dir/$$.json.tmp" "$dir/$$.json"',
  '}',
  'write busy; sleep 0.4; write idle',
  'while IFS= read -r line; do',
  `  printf '%s\\n' "$line" >> "$PWD/received.log"`,
  '  write busy; sleep 0.3; write idle',
  'done',
].join('\n') + '\n';

for (const [mode, , request, flag] of [
  ['resumed', ID_A, { version: 1, action: 'open', sessionId: ID_A, prompt: 'real sandbox prompt' }, 'resumed'],
  ['new', ID_B, { version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'real sandbox prompt' }, 'created'],
]) {
  for (const bad of [false, true]) {
    test(`real bwrap (${mode}${bad ? ', mismatched start identity' : ''}): ${bad ? 'no byte reaches the PTY and readiness expires' : 'one prompt reaches only that PTY after settled fresh idle'}`,
      { skip: !REAL_BWRAP && 'requires a usable unprivileged user namespace' }, async t => {
        const root = tempRoot(t);
        const home = path.join(root, 'home');
        const proj = path.join(root, 'proj');
        const bin = path.join(root, 'bin');
        for (const dir of [path.join(home, '.claude'), proj, bin]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
        const sessions = path.join(home, '.claude', 'sessions');
        const world = makeWorld({ real: { cli: realCli, edges: {} } });
        realCli.init({ dir: sessions, activeSessions: new Map(), log: { info() {}, warn() {}, error() {}, debug() {} }, platform: 'linux', isProcessAlive: () => false });
        const spawned = [];
        t.after(() => { realCli.stop(); for (const p of spawned) { try { p.kill(); } catch { /* already gone */ } } });
        const bridge = {
          waitReady: async () => ({ ok: true }),
          async ensureOpen(op) {
            if (op.mode === 'reattach') return { ok: true, generation: op.generation, spawned: false };
            const launchStartedAt = Date.now();
            const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FIXTURE_SESSION_ID: op.tabKey,
              ...(bad ? { FIXTURE_BAD_START: '1' } : {}) };
            for (const key of Object.keys(env)) if (/^(GIT_|HUSKY|SWITCHBOARD_)/.test(key)) delete env[key];
            const ptyProcess = nodePty.spawn('bash', [path.join(__dirname, '..', 'scripts', 'claude-sandbox.sh'), '--resume', op.tabKey], { cwd: proj, env, cols: 80, rows: 24 });
            spawned.push(ptyProcess);
            const session = world.addSession(op.tabKey, { sandbox: true, cwd: proj });
            const handle = { pid: ptyProcess.pid, dead: false, write: data => ptyProcess.write(data) };
            ptyProcess.onExit(() => { handle.dead = true; session.exited = true; });
            session.pty = handle;
            return { ok: true, generation: session.generation, spawned: true, launchStartedAt };
          },
        };
        const watcher = startWatcher(t, world, { bridge, resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project' }) }, root);
        const result = await watcher.submit({ ...request, timeout_ms: bad ? 5000 : 30000 });
        const received = fs.existsSync(path.join(proj, 'received.log')) ? fs.readFileSync(path.join(proj, 'received.log'), 'utf8').trim().split('\n') : [];
        if (bad) {
          assert.equal(result.outcome, 'refused');
          assert.equal(result.reason, 'session readiness unavailable');
          assert.equal(result[flag], true);
          assert.deepEqual(received, []);
          return;
        }
        assert.equal(result.outcome, 'opened', JSON.stringify(result));
        assert.equal(result[flag], true);
        assert.deepEqual(received, ['real sandbox prompt']);
        const [descriptorName] = fs.readdirSync(sessions).filter(name => /^\d+\.json$/.test(name));
        const innerPid = Number(path.basename(descriptorName, '.json'));
        const seen = realCli.observeSandboxWriterV1(spawned[0].pid, { sessionId: result.sessionId, ptyStart: null });
        assert.equal(seen.writer.pid, innerPid);
        assert.notEqual(seen.writer.hostPid, innerPid, 'the writer has a distinct host PID');
      });
  }
}
