// test/trigger-context.test.js — the ctx object main.js hands to trigger-watcher.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { createTriggerContext, createLocalSessionHandle } = require('../trigger-context');
const { createComposerState, noteUserInput } = require('../composer-state');
const { spawnSync } = require('node:child_process');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeSession(overrides = {}) {
  return {
    pty: { pid: process.pid, write() {} },
    exited: false,
    _cliBusy: false,
    composerState: createComposerState(),
    ...overrides,
  };
}

function ctxWith(sessions) {
  return createTriggerContext({ activeSessions: new Map(sessions), log: silentLog });
}

test('getComposerState returns { pending, lastInputAt } for a live session', () => {
  const session = makeSession();
  noteUserInput(session.composerState, 'half a sentence', 4242);
  const ctx = ctxWith([['s1', session]]);

  assert.deepEqual(ctx.getComposerState('s1'), { pending: 15, lastInputAt: 4242 });
});

test('getComposerState returns null for an unknown session', () => {
  const ctx = ctxWith([['s1', makeSession()]]);
  assert.equal(ctx.getComposerState('nope'), null);
});

test('getComposerState returns null for an exited session', () => {
  const ctx = ctxWith([['s1', makeSession({ exited: true })]]);
  assert.equal(ctx.getComposerState('s1'), null);
});

test('getComposerState returns null for a session carrying no composerState', () => {
  const ctx = ctxWith([['s1', makeSession({ composerState: undefined })]]);
  assert.equal(ctx.getComposerState('s1'), null);
});

test('getPtyForSession exposes the pty of a live session and null otherwise', () => {
  const live   = makeSession();
  const exited = makeSession({ exited: true });
  const ctx    = ctxWith([['live', live], ['exited', exited]]);

  assert.equal(ctx.getPtyForSession('live').ptyProcess, live.pty);
  assert.equal(ctx.getPtyForSession('exited'), null);
  assert.equal(ctx.getPtyForSession('nope'), null);
});

test('getPtyForSession exposes the session\'s cwd for the target guard, undefined when the session predates the field', () => {
  const withCwd    = makeSession({ cwd: 'C:\\Projects\\foo' });
  const withoutCwd = makeSession();
  const ctx        = ctxWith([['with', withCwd], ['without', withoutCwd]]);

  assert.equal(ctx.getPtyForSession('with').cwd, 'C:\\Projects\\foo');
  assert.equal(ctx.getPtyForSession('without').cwd, undefined,
    'a session predating this field must read as indeterminate, not as some default path');
});

test('isSessionBusy reads _cliBusy and is false for an unknown session', () => {
  const ctx = ctxWith([
    ['busy', makeSession({ _cliBusy: true })],
    ['idle', makeSession()],
  ]);

  assert.equal(ctx.isSessionBusy('busy'), true);
  assert.equal(ctx.isSessionBusy('idle'), false);
  assert.equal(ctx.isSessionBusy('nope'), false);
});

test('getPtyForSession attaches a handle: local (host null) writes to session.pty', () => {
  const written = [];
  const session = makeSession({ pty: { pid: process.pid, write: (d) => written.push(d) } });
  const ctx     = ctxWith([['s1', session]]);

  const entry = ctx.getPtyForSession('s1');
  entry.handle.write('hello');
  assert.deepEqual(written, ['hello'], 'the local handle must write into session.pty');
  assert.equal(entry.handle.isAlive(), true, "the local handle probes session.pty's real pid");
});

test('getPtyForSession: a non-null host takes session.handle as given, not session.pty', () => {
  const written = [];
  const session = makeSession({
    host: 'some-remote-host',
    pty: undefined, // deliberately no node-pty on this entry
    handle: { write: (d) => written.push(d), isAlive: () => true },
  });
  const ctx = ctxWith([['s1', session]]);

  const entry = ctx.getPtyForSession('s1');
  assert.equal(entry.handle, session.handle, 'a non-local entry must use the supplied handle unchanged');
  entry.handle.write('x');
  assert.deepEqual(written, ['x']);
});

test('createLocalSessionHandle.write forwards verbatim to the underlying pty', () => {
  const written = [];
  const handle = createLocalSessionHandle({ pid: process.pid, write: (d) => written.push(d) });
  handle.write('abc');
  handle.write('\r');
  assert.deepEqual(written, ['abc', '\r']);
});

test('createLocalSessionHandle.isAlive reflects the real process, not just an override', () => {
  const aliveHandle = createLocalSessionHandle({ pid: process.pid, write() {} });
  assert.equal(aliveHandle.isAlive(), true, 'the current test process must read as alive');

  // The only test in this suite (or trigger-watcher's) exercising the FALSE
  // branch of the real signal-0 probe with a genuinely dead pid -- every
  // trigger-watcher test overrides ctx.isPtyAlive instead, so this is the
  // one place mutating this probe to always return true is observable.
  const child = spawnSync(process.platform === 'win32' ? 'cmd' : 'true',
    process.platform === 'win32' ? ['/c', 'exit', '0'] : []);
  const deadHandle = createLocalSessionHandle({ pid: child.pid, write() {} });
  assert.equal(deadHandle.isAlive(), false, 'a pid whose process has already exited must read as not alive');
});

test('log is forwarded, and isPtyAlive is only present when supplied', () => {
  const plain = createTriggerContext({ activeSessions: new Map(), log: silentLog });
  assert.equal(plain.log, silentLog);
  assert.equal('isPtyAlive' in plain, false);

  const probe = () => true;
  const withProbe = createTriggerContext({
    activeSessions: new Map(), log: silentLog, isPtyAlive: probe,
  });
  assert.equal(withProbe.isPtyAlive, probe);
});
