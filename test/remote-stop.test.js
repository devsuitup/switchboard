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
  NOT_CLAUDE_EXIT_CODE,
  NOT_CLAUDE_MARKER,
  TMUX_PANE_KILLED_MARKER,
  TMUX_WINDOW_KILLED_MARKER,
  PID_TERM_MARKER,
  PID_FORCE_MARKER,
} = require('../remote-stop');

const silentLog = { info() {}, warn() {}, error() {} };

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
