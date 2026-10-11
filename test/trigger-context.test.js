// test/trigger-context.test.js — the ctx object main.js hands to trigger-watcher.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { createTriggerContext, createLocalSessionHandle } = require('../trigger-context');
const { createComposerState, noteUserInput } = require('../composer-state');
const { spawnSync } = require('node:child_process');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('U3/U19/U23: dynamic remote context filters hosts on every lookup and forwards only source data', () => {
  let on = false; let enabled = true; let ambiguous = false; const descriptor = { sessionId: 'remote' }; const sent = [];
  const remote = {
    indexer: { findSessionAliases: (id, predicate) => id === 'remote' && predicate('vps') ? (ambiguous ? ['vps', 'other'] : ['vps']) : [], getRemoteSessions: () => ({ sessions: [descriptor], at: 42, error: 'backoff' }) },
    adapter: { send: (...args) => sent.push(args) }, isEnabled: () => enabled, maxAgeMs: 123,
  };
  const ctx = createTriggerContext({ activeSessions: new Map(), log: silentLog, get remote() { return on ? remote : undefined; } });
  assert.equal(ctx.remote, undefined); on = true;
  assert.deepEqual(ctx.remote.lookup('remote'), { alias: 'vps', descriptor, at: 42, error: 'backoff', maxAgeMs: 123 });
  ctx.remote.send('vps', descriptor, 'text'); assert.deepEqual(sent, [['vps', descriptor, 'text']]);
  ambiguous = true; assert.deepEqual(ctx.remote.lookup('remote'), { aliases: ['vps', 'other'] }); ambiguous = false;
  enabled = false; assert.equal(ctx.remote.lookup('remote'), null);
  on = false; assert.equal(ctx.remote, undefined);
  assert.equal(createTriggerContext({ activeSessions: new Map(), log: silentLog }).remote, undefined);
  assert.equal(Object.hasOwn(createTriggerContext({ activeSessions: new Map(), log: silentLog }), 'remote'), false);
});

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

test('getCliStatus is only present when supplied, and answers for local live sessions only', () => {
  assert.equal('getCliStatus' in createTriggerContext({ activeSessions: new Map(), log: silentLog }), false);

  const sessions = new Map([
    ['local', { pty: {}, host: null }],
    ['remote', { pty: {}, host: 'box', handle: {} }],
  ]);
  const seen = [];
  const ctx = createTriggerContext({
    activeSessions: sessions, log: silentLog,
    getCliStatus: (id) => { seen.push(id); return { status: 'idle', statusUpdatedAt: 5 }; },
  });
  assert.deepEqual(ctx.getCliStatus('local'), { status: 'idle', statusUpdatedAt: 5 });
  assert.equal(ctx.getCliStatus('remote'), undefined, 'a remote session has no local descriptor');
  assert.equal(ctx.getCliStatus('unknown'), undefined);
  assert.deepEqual(seen, ['local']);
});

test('a re-keyed id is resolved before every lookup, the live descriptor included', () => {
  const pty = { pid: 1, write() {} };
  const asked = [];
  const ctx = createTriggerContext({
    activeSessions: new Map([['new-id', { pty, host: null, _cliBusy: true }]]),
    log: silentLog,
    getLiveDescriptor: (id) => { asked.push(id); return { id }; },
    resolveSessionId: (id) => (id === 'old-id' ? 'new-id' : id),
  });
  assert.equal(ctx.getPtyForSession('old-id').ptyProcess, pty);
  assert.equal(ctx.isSessionBusy('old-id'), true);
  assert.deepEqual(ctx.getLiveDescriptor('old-id'), { id: 'new-id' });
  assert.deepEqual(asked, ['new-id']);
});

test('a re-key mid-chain forgets the transcript read under the previous id', () => {
  const turnModule = require('../transcript-turn');
  const original = turnModule.createTranscriptTurnReader;
  const forgotten = [];
  turnModule.createTranscriptTurnReader = (...args) => {
    const reader = original(...args);
    return { ...reader, forget: (p) => { forgotten.push(p); reader.forget(p); } };
  };
  const contextPath = require.resolve('../trigger-context');
  const cached = require.cache[contextPath];
  delete require.cache[contextPath];
  try {
    const { createTriggerContext: create } = require('../trigger-context');
    const session = { pty: { pid: 1 }, host: null, projectFolder: 'proj', exited: false };
    const activeSessions = new Map([['old-id', session]]);
    let alias = null;
    const ctx = create({ activeSessions, log: silentLog, projectsDir: '/projects', resolveSessionId: (id) => alias && id === 'old-id' ? alias : id });
    ctx.getTranscriptTurn('old-id');
    activeSessions.delete('old-id');
    activeSessions.set('new-id', session);
    session.realSessionId = 'new-id';
    alias = 'new-id';
    ctx.getTranscriptTurn('old-id');
    assert.deepEqual(forgotten, [require('node:path').join('/projects', 'proj', 'old-id.jsonl')]);
    ctx.forgetTranscriptTurn('old-id');
    assert.deepEqual(forgotten.at(-1), require('node:path').join('/projects', 'proj', 'new-id.jsonl'));
  } finally {
    turnModule.createTranscriptTurnReader = original;
    require.cache[contextPath] = cached;
  }
});
