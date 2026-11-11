'use strict';

// The remote "stop" verb, fully injected: no ssh, no network. Mirrors
// test/remote-attach.test.js's style for the sibling "detach" verb — see
// .ai/contexts/session-state.md ("Lifecycle decisions (2026-09-11)").
//
// Four properties matter:
//   1. A recycled pid is refused before anything is killed — same wording,
//      same guard, as remote-attach's pid-reuse check (not forked).
//   2. A tmux target is killed at the narrowest matching scope — the pane
//      when the target names one, else the window — NEVER the whole session:
//      the VPS harness runs several CLIs as windows/panes of one tmux
//      session, and kill-session would take down every sibling.
//   3. No tmux field falls back to kill -TERM then kill -KILL after a
//      bounded wait.
//   4. No command string ever contains a backtick, and kill-session is
//      never emitted under any input.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRemoteStopAdapter,
  buildStopCommand,
  buildRemoteCommandArgs,
  NOT_CLAUDE_EXIT_CODE,
  NOT_CLAUDE_MARKER,
  TMUX_PANE_KILLED_MARKER,
  TMUX_WINDOW_KILLED_MARKER,
  PID_TERM_MARKER,
  PID_FORCE_MARKER,
} = require('../src/main/remote/remote-stop');

const silentLog = { info() {}, warn() {}, error() {} };

const strictIdentity = { alias: 'vps', sessionId: '11111111-1111-4111-8111-111111111111', pid: 4242,
  procStart: '123456', bootId: '22222222-2222-4222-8222-222222222222' };
const strictOptions = () => ({ strict: true, identity: { ...strictIdentity }, deadline: Date.now() + 6000 });
const strictMarker = kind => `${kind} ${strictIdentity.pid} ${strictIdentity.procStart} ${strictIdentity.sessionId} ${strictIdentity.bootId}\n`;

for (const remainingMs of [4999, 5000, 5001]) {
  test(`A4c2afix2 strict remote connection allowance boundary ${remainingMs}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const payloads = [];
    const result = await makeAdapter(async (_alias, command) => {
      payloads.push(JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64').toString()));
      return { code: 0, stdout: strictMarker(payloads.length === 1 ? 'STOP_SIGNALLED' : 'STOP_ENDED') };
    }).stop('vps', strictIdentity, { ...strictOptions(), deadline: 1000 + remainingMs });
    assert.equal(payloads.length, remainingMs > 5000 ? 2 : 0, 'no SSH command when the connection allowance exhausts the budget');
    assert.equal(result.ended, remainingMs > 5000);
    if (remainingMs > 5000) assert.deepEqual(payloads.map(payload => payload.remainingMs), [1, 1]);
    else assert.match(result.error, /deadline/);
  });
}

test('A4c2afix strict remote sends a duration and guards using remote monotonic time', async () => {
  const calls = [];
  const result = await makeAdapter(async (_alias, command, options) => {
    calls.push({ command, options, payload: JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64').toString()) });
    return { code: 0, stdout: strictMarker(calls.length === 1 ? 'STOP_SIGNALLED' : 'STOP_ENDED') };
  }).stop('vps', strictIdentity, strictOptions());
  assert.equal(result.ended, true);
  for (const { command, options, payload } of calls) {
    const connectSeconds = Number(buildRemoteCommandArgs('vps', '').find(arg => arg.startsWith('ConnectTimeout=')).split('=')[1]);
    assert.equal(payload.remainingMs, options.timeoutMs - connectSeconds * 1000, 'remote duration must reserve the SSH connection allowance');
    assert.equal(Object.hasOwn(payload, 'deadline'), false);
    assert.match(command, /deadline=time\.monotonic\(\)\+x\[/);
    assert.match(command, /if time\.monotonic\(\)>=deadline/);
    assert.doesNotMatch(command, /time\.time\(/);
  }
});

for (const stdout of [PID_TERM_MARKER, PID_FORCE_MARKER, '', strictMarker('STOP_SIGNALLED')]) {
  test(`A4c2a strict remote ACK alone never proves death: ${stdout.trim() || 'empty'}`, async () => {
    const result = await makeAdapter(async () => ({ code: 0, stdout })).stop('vps', strictIdentity, strictOptions());
    assert.equal(result.ok, false, 'a signal acknowledgement cannot prove remote death');
    assert.equal(result.ended, false);
  });
}

test('A4c2a strict remote stop requires a separate host-bound death read', async () => {
  const calls = [];
  const adapter = makeAdapter(async (alias, command, options) => {
    calls.push({ alias, command, options });
    return { code: 0, stdout: strictMarker(calls.length === 1 ? 'STOP_SIGNALLED' : 'STOP_ENDED') };
  });
  const result = await adapter.stop('vps', strictIdentity, strictOptions());
  assert.equal(result.ended, true, 'independent death marker is required');
  assert.equal(calls.length, 2);
  assert.match(calls[0].command, /\/stat/);
  assert.match(calls[0].command, /boot_id/);
  assert.match(calls[0].command, /--session-id/);
  assert.match(calls[0].command, /pidfd_open/);
  assert.match(calls[0].command, /pidfd_send_signal/);
  assert.ok(calls[0].command.indexOf("start()") < calls[0].command.indexOf('pidfd_send_signal'));
  assert.doesNotMatch(calls[1].command, /kill -/);
  assert.ok(calls.every(c => c.options.timeoutMs <= 6000));
});

for (const outcome of ['STOP_REUSED', 'STOP_UNKNOWN', 'STOP_LIVE', 'unreachable']) {
  test(`A4c2a strict remote ${outcome} is not proven`, async () => {
    let calls = 0;
    const result = await makeAdapter(async () => {
      if (++calls === 1) return { code: 0, stdout: strictMarker('STOP_SIGNALLED') };
      if (outcome === 'unreachable') throw new Error('unreachable');
      return { code: 0, stdout: strictMarker(outcome) };
    }).stop('vps', strictIdentity, strictOptions());
    assert.equal(result.ended, false);
    assert.equal(result.ok, false);
  });
}

test('A4c2a strict remote mismatched declared identity and expired deadline never signal', async () => {
  let calls = 0;
  const adapter = makeAdapter(async () => { calls++; return { code: 0, stdout: PID_TERM_MARKER }; });
  for (const identity of [{ ...strictIdentity, alias: 'other' }, { ...strictIdentity, pid: 99 },
    { ...strictIdentity, sessionId: 'foreign' }, { ...strictIdentity, procStart: '999' }, { ...strictIdentity, bootId: '' }]) {
    assert.equal((await adapter.stop('vps', strictIdentity, { ...strictOptions(), identity })).ok, false);
  }
  assert.equal((await adapter.stop('vps', strictIdentity, { ...strictOptions(), deadline: 0 })).ok, false);
  assert.equal(calls, 0);
});

function makeAdapter(runRemoteCommand) {
  return createRemoteStopAdapter({ runRemoteCommand, log: silentLog });
}

// --- buildStopCommand ------------------------------------------------------

test('buildStopCommand: no tmux target kills by pid only, no tmux mention', () => {
  const cmd = buildStopCommand(4242, null);
  assert.match(cmd, /kill -TERM 4242/);
  assert.match(cmd, /kill -KILL 4242/);
  assert.ok(!cmd.includes('tmux'), 'no tmux invocation when the descriptor names no target');
});

test('buildStopCommand: a target naming a pane kills only that pane, never the session', () => {
  const cmd = buildStopCommand(4242, 'main:@0.%0');
  assert.match(cmd, /tmux -S "\$sock" kill-pane -t main:@0\.%0/);
  assert.match(cmd, /\/proc\/4242\/environ/, 'socket must be discovered from the pid\'s own environ, like remote-attach\'s probe');
  assert.match(cmd, /kill -TERM 4242/, 'the pid fallback must still be present if tmux kill-pane fails');
  assert.ok(!cmd.includes('kill-session'), 'never kill-session — siblings share the session on the VPS harness');
});

test('buildStopCommand: a target naming a window only kills the window, never the session', () => {
  const cmd = buildStopCommand(4242, 'main:@0');
  assert.match(cmd, /tmux -S "\$sock" kill-window -t main:@0\b/);
  assert.ok(!cmd.includes('kill-pane'), 'a window-only target must not be treated as a pane target');
  assert.ok(!cmd.includes('kill-session'), 'never kill-session — siblings share the session on the VPS harness');
});

test('buildStopCommand: the pid-reuse guard runs before either kill path', () => {
  const cmd = buildStopCommand(4242, 'main:@0.%0');
  const guardIdx = cmd.indexOf(NOT_CLAUDE_MARKER);
  const tmuxIdx = cmd.indexOf('kill-pane');
  const killIdx = cmd.indexOf('kill -TERM');
  assert.ok(guardIdx >= 0 && guardIdx < tmuxIdx && guardIdx < killIdx, 'the refusal guard must precede both kill paths');
  assert.match(cmd, /\/proc\/4242\/cmdline/, 'must reuse remote-attach\'s cmdline check, not a forked copy');
});

test('kill-session never appears in any built command, for any input', () => {
  const inputs = [null, 'main:@0.%0', 'main:@0', 'main:0.0', 'main:0'];
  for (const tmuxTarget of inputs) {
    assert.ok(!buildStopCommand(4242, tmuxTarget).includes('kill-session'),
      `kill-session must never appear (input: ${tmuxTarget})`);
  }
});

test('buildStopCommand waits roughly 3s before escalating to kill -KILL', () => {
  const cmd = buildStopCommand(4242, null);
  assert.match(cmd, /sleep 0\.5/);
  assert.match(cmd, /-lt 6/, '6 ticks of 0.5s bounds the wait at ~3s');
});

test('buildStopCommand: a successful tmux kill-pane still polls /proc before declaring success (mutation target: dropping the post-tmux poll)', () => {
  const cmd = buildStopCommand(4242, 'main:@0.%0');
  const killPaneIdx = cmd.indexOf('kill-pane -t main:@0.%0');
  const thenIdx = cmd.indexOf('then', killPaneIdx);
  const markerIdx = cmd.indexOf(TMUX_PANE_KILLED_MARKER, thenIdx);
  const pollIdx = cmd.indexOf('while [ -d /proc/4242 ]', thenIdx);
  assert.ok(thenIdx > killPaneIdx && markerIdx > thenIdx, 'sanity: tmux kill precedes its own success marker');
  assert.ok(pollIdx > thenIdx && pollIdx < markerIdx,
    'a /proc poll must run between the tmux kill and its success marker');
  assert.match(cmd.slice(thenIdx, markerIdx), /if \[ ! -d \/proc\/4242 \]/,
    'the tmux success marker must be gated on the pid actually being gone, not just on tmux\'s exit code');
});

test('buildStopCommand: a tmux-killed pid that survives the poll falls through to the pid-kill path (mutation target: dropping the fallthrough)', () => {
  const cmd = buildStopCommand(4242, 'main:@0.%0');
  const tail = cmd.slice(cmd.indexOf('kill-pane'));
  assert.match(tail, /kill -TERM 4242 2>\/dev\/null;[\s\S]*kill -KILL 4242/,
    'the pid TERM->KILL fallback must still be reachable after a tmux kill whose target never actually dies');
});

test('no builder ever emits a backtick', () => {
  assert.ok(!buildStopCommand(4242, null).includes('`'));
  assert.ok(!buildStopCommand(4242, 'main:@0.%0').includes('`'));
  assert.ok(!buildStopCommand(4242, 'main:@0').includes('`'));
});

// --- createRemoteStopAdapter().stop() --------------------------------------

test('stop() refuses a recycled pid without reporting success (mutation target: removing the guard)', async () => {
  const calls = [];
  const adapter = makeAdapter(async (alias, command) => {
    calls.push(command);
    return { code: NOT_CLAUDE_EXIT_CODE, stdout: NOT_CLAUDE_MARKER + '\n', stderr: '' };
  });
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242 });
  assert.equal(result.ok, false);
  assert.match(result.error, /pid 4242 now belongs to a process that is not a claude CLI/);
  assert.equal(calls.length, 1);
});

test('stop() succeeds via tmux kill-pane when the descriptor names a pane target', async () => {
  const commands = [];
  const adapter = makeAdapter(async (alias, command) => {
    commands.push(command);
    return { code: 0, stdout: TMUX_PANE_KILLED_MARKER + '\n', stderr: '' };
  });
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });
  assert.deepEqual(result, { ok: true, method: 'tmux-pane' });
  assert.match(commands[0], /kill-pane/);
  assert.ok(!commands[0].includes('kill-session'));
});

test('stop() succeeds via tmux kill-window when the descriptor names a window-only target', async () => {
  const commands = [];
  const adapter = makeAdapter(async (alias, command) => {
    commands.push(command);
    return { code: 0, stdout: TMUX_WINDOW_KILLED_MARKER + '\n', stderr: '' };
  });
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0' });
  assert.deepEqual(result, { ok: true, method: 'tmux-window' });
  assert.match(commands[0], /kill-window/);
  assert.ok(!commands[0].includes('kill-session'));
});

test('stop() succeeds via a plain kill -TERM when no tmux target is named', async () => {
  const adapter = makeAdapter(async () => ({ code: 0, stdout: PID_TERM_MARKER + '\n', stderr: '' }));
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242 });
  assert.deepEqual(result, { ok: true, method: 'pid-term' });
});

test('stop() reports the forced kill -KILL escalation as its own method', async () => {
  const adapter = makeAdapter(async () => ({ code: 0, stdout: PID_FORCE_MARKER + '\n', stderr: '' }));
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242 });
  assert.deepEqual(result, { ok: true, method: 'pid-kill' });
});

test('stop() surfaces an ssh failure without claiming success', async () => {
  const adapter = makeAdapter(async () => ({ code: 255, stdout: '', stderr: 'ssh: connection refused' }));
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242 });
  assert.equal(result.ok, false);
  assert.match(result.error, /connection refused/);
});

test('stop() surfaces a thrown ssh runner without throwing itself', async () => {
  const adapter = makeAdapter(async () => { throw new Error('ECONNRESET'); });
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242 });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
});

test('stop() refuses a descriptor with no readable pid, before any ssh call', async () => {
  let calls = 0;
  const adapter = makeAdapter(async () => { calls++; return { code: 0, stdout: '' }; });
  const result = await adapter.stop('vps', { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /pid/i);
  assert.equal(calls, 0);
});

test('stop() ignores a descriptor tmux field that fails validation and falls back to pid-kill semantics', async () => {
  const commands = [];
  const adapter = makeAdapter(async (alias, command) => {
    commands.push(command);
    return { code: 0, stdout: PID_TERM_MARKER + '\n', stderr: '' };
  });
  const result = await adapter.stop('vps', { sessionId: 's1', pid: 4242, tmux: 'not valid; rm -rf /' });
  assert.equal(result.ok, true);
  assert.ok(!commands[0].includes('tmux'), 'an unparseable tmux field must never reach the command string');
});
