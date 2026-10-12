// see .ai/contexts/trigger-watcher.md, "Re-keyed sessions"
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';
process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '300';
process.env.SWITCHBOARD_PENDING_OWN_ENTRY_MS = '1000';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { start } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');
const sessionTransitions = require('../session-transitions');
const cliSessionState = require('../cli-session-state');

function mkTmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const iso = (ms) => new Date(ms).toISOString();
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const prompt = (id, at, content) => ({ sessionId: id, type: 'user', timestamp: iso(at), message: { role: 'user', content } });
const endTurn = (id, at) => ({ sessionId: id, type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } });
const system = (id, at, subtype) => ({ sessionId: id, type: 'system', subtype, timestamp: iso(at) });
const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };

const CLEAR_TEXT = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';

// A CLI under one PTY: /clear moves it to a new transcript and a new id, as the real one does.
function clearingSession(onText = noop) {
  const projectsDir = mkTmp('sw-clear-chain-projects-');
  const folderPath = path.join(projectsDir, 'proj');
  fs.mkdirSync(folderPath);
  const old = Date.now() - 60_000;
  const oldFile = path.join(folderPath, 'old-id.jsonl');
  fs.writeFileSync(oldFile, jsonl([prompt('old-id', old - 1000, 'earlier'), endTurn('old-id', old), system('old-id', old + 100, 'turn_duration')]));
  fs.utimesSync(oldFile, new Date(old + 200), new Date(old + 200));

  let current = 'old-id';
  const status = { 'old-id': { status: 'idle', statusUpdatedAt: old + 300 } };
  const written = [];
  let lastText = null;
  const pty = {
    pid: 4242,
    write(data) {
      written.push(data);
      if (data !== '\r') { lastText = data; onText(data); return; }
      if (!fs.existsSync(folderPath)) return;
      const at = Date.now();
      if (lastText === '/clear') {
        setTimeout(() => {
          if (!fs.existsSync(folderPath)) return;
          current = 'new-id';
          fs.writeFileSync(path.join(folderPath, 'new-id.jsonl'), jsonl([
            { sessionId: 'new-id', type: 'mode', mode: 'normal' },
            { type: 'file-history-snapshot', messageId: 'm1', snapshot: {} },
            { sessionId: 'new-id', type: 'user', isMeta: true, timestamp: iso(at), message: { role: 'user', content: '<local-command-caveat>Caveat: synthetic.</local-command-caveat>' } },
            prompt('new-id', at, CLEAR_TEXT),
          ]));
          status['new-id'] = { status: 'idle', statusUpdatedAt: Date.now() };
          sessionTransitions.detectSessionTransitions('proj');
        }, 30);
      } else {
        const id = current;
        status[id] = { status: 'busy', statusUpdatedAt: Date.now() };
        fs.appendFileSync(path.join(folderPath, id + '.jsonl'), jsonl([prompt(id, at, lastText)]));
        setTimeout(() => {
          if (!fs.existsSync(folderPath)) return;
          fs.appendFileSync(path.join(folderPath, id + '.jsonl'), jsonl([endTurn(id, Date.now()), system(id, Date.now(), 'turn_duration')]));
          status[id] = { status: 'idle', statusUpdatedAt: Date.now() };
        }, 100);
      }
    },
  };
  const session = {
    pty, cwd: '/w', projectFolder: 'proj', exited: false, isPlainTerminal: false,
    knownJsonlFiles: new Set(['old-id.jsonl']), forkFrom: null, realSessionId: null,
    _cliBusy: false, composerState: { pending: 0, lastInputAt: 0 },
  };
  const activeSessions = new Map([['old-id', session]]);
  sessionTransitions.init({
    PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log,
    rekeyMcpServer: noop, clearOwner: (id, pid) => (pid === 4242 ? 'mine' : 'other'),
  });
  const ctx = createTriggerContext({
    activeSessions, log, projectsDir,
    isPtyAlive: () => true,
    getCliStatus: (id) => status[id] && { ...status[id] },
    resolveSessionId: (id) => sessionTransitions.currentSessionId(id),
  });
  return { ctx, written, activeSessions, cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

async function runTriggers(ctx, triggers, timeoutMs, tmp = mkTmp('sw-clear-chain-triggers-'), expectedIds = triggers.map(([id]) => id)) {
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(ctx);
  try {
    for (const [uuid, trigger] of triggers) {
      fs.writeFileSync(path.join(tmp, uuid + '.json'), JSON.stringify({ wait: 'none', timeout_ms: timeoutMs, ...trigger }), 'utf8');
    }
    const results = {};
    const deadline = Date.now() + timeoutMs + 5000;
    for (const uuid of expectedIds) {
      const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline) throw new Error('no result file for ' + uuid);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 20));
      results[uuid] = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
    return results;
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function continuingSession(t, { detect = true, duplicate = false, owner = true, statusForOld = false } = {}) {
  const projectsDir = mkTmp('sw-continuation-projects-');
  const folderPath = path.join(projectsDir, 'proj');
  const descriptors = path.join(projectsDir, 'descriptors');
  fs.mkdirSync(folderPath);
  fs.mkdirSync(descriptors);
  const oldFile = path.join(folderPath, 'old-id.jsonl');
  fs.writeFileSync(oldFile, jsonl([prompt('old-id', Date.now() - 60000, 'earlier')]));
  const written = [];
  const idleStatus = { status: 'idle', statusUpdatedAt: Date.now() - 10000 };
  const session = {
    pty: { pid: 4242, write: data => {
      written.push(data);
      if (data === '\r') idleStatus.statusUpdatedAt = Date.now();
    } }, cwd: projectsDir,
    projectFolder: 'proj', knownJsonlFiles: new Set(['old-id.jsonl']),
    composerState: { pending: 0, lastInputAt: 0 }, _cliBusy: false,
  };
  const activeSessions = new Map([['old-id', session]]);
  if (duplicate) activeSessions.set('other-id', { ...session });
  cliSessionState.init({
    dir: descriptors, activeSessions, log, platform: 'linux', onIdle: noop,
    isProcessAlive: () => true, readProcStart: () => '111',
    readParentPid: pid => pid === 4243 ? (owner ? 4242 : 9999) : 1,
  });
  const clearOwner = (...args) => cliSessionState.clearOwner(...args);
  const events = [];
  sessionTransitions.init({
    PROJECTS_DIR: projectsDir, activeSessions, log, rekeyMcpServer: noop,
    clearOwner,
    getDescriptorRevision: () => cliSessionState.getDescriptorRevision(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
  });
  const ctx = createTriggerContext({
    activeSessions, log, projectsDir, isPtyAlive: () => true, clearOwner,
    getLiveDescriptor: id => cliSessionState.findLiveProcess(id),
    getCliStatus: id => id === 'new-id' || (statusForOld && id === 'old-id') ? idleStatus : undefined,
    resolveSessionId: id => sessionTransitions.currentSessionId(id),
  });
  fs.appendFileSync(oldFile, jsonl([{ type: 'continued-in', sessionId: 'old-id', continuedInSessionId: 'new-id' }]));
  fs.writeFileSync(path.join(folderPath, 'new-id.jsonl'), jsonl([prompt('new-id', Date.now(), 'continued')]));
  fs.writeFileSync(path.join(descriptors, '4243.json'), JSON.stringify({ pid: 4243, sessionId: 'new-id', kind: 'interactive', procStart: '111' }));
  if (detect) sessionTransitions.detectSessionTransitions('proj');
  t.after(() => {
    cliSessionState.stop();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });
  return { ctx, written, activeSessions, session, events, folderPath, oldFile, descriptorPath: path.join(descriptors, '4243.json') };
}

test('continued-in alias survives a torn descriptor read and its restoration', async t => {
  const s = continuingSession(t, { detect: false });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal((await s.ctx.findPtyForSession('new-id')).ptyProcess, s.session.pty);
  const descriptor = fs.readFileSync(s.descriptorPath, 'utf8');
  fs.writeFileSync(s.descriptorPath, '');
  now += 4000;
  assert.equal(s.ctx.getPtyForSession('new-id')?.ptyProcess, s.session.pty);
  fs.writeFileSync(s.descriptorPath, descriptor);
  now += 4000;
  assert.equal(s.ctx.getPtyForSession('new-id')?.ptyProcess, s.session.pty);
});

test('continued-in alias ownership checks are throttled during polling', async t => {
  const s = continuingSession(t, { detect: false });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const probe = t.mock.method(cliSessionState, 'clearOwner');
  await s.ctx.findPtyForSession('new-id');
  const initial = probe.mock.callCount();
  for (let tick = 0; tick < 20; tick++) {
    now += 100;
    assert.equal(s.ctx.getPtyForSession('new-id').ptyProcess, s.session.pty);
    s.ctx.isSessionBusy('new-id');
    s.ctx.getComposerState('new-id');
  }
  assert.equal(probe.mock.callCount(), initial);
  now += 4000;
  assert.equal(s.ctx.getPtyForSession('new-id').ptyProcess, s.session.pty);
  assert.equal(probe.mock.callCount(), initial + 1);
});

test('continued-in foreign ownership cache is invalidated by the real descriptor watcher', async t => {
  const s = continuingSession(t, { detect: false, owner: false });
  assert.equal(cliSessionState.ensureWatching(), true);
  const probe = t.mock.method(cliSessionState, 'clearOwner');
  for (let pass = 0; pass < 10; pass++) sessionTransitions.detectSessionTransitions('proj');
  assert.equal(probe.mock.callCount(), 1);
  assert.equal(s.activeSessions.get('old-id'), s.session);
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('descriptor change not observed')); }, 3000);
    const unsubscribe = cliSessionState.onDescriptorsChanged(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
  const descriptor = JSON.parse(fs.readFileSync(s.descriptorPath, 'utf8'));
  fs.writeFileSync(s.descriptorPath, JSON.stringify({ ...descriptor, pid: 4242 }));
  await changed;
  sessionTransitions.detectSessionTransitions('proj');
  assert.equal(probe.mock.callCount(), 2);
  assert.equal(s.activeSessions.get('new-id'), s.session);
});

test('continued-in alias is dropped when its live descriptor moves to a third conversation', async t => {
  const s = continuingSession(t, { detect: false });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal((await s.ctx.findPtyForSession('new-id')).ptyProcess, s.session.pty);
  const descriptor = JSON.parse(fs.readFileSync(s.descriptorPath, 'utf8'));
  fs.writeFileSync(s.descriptorPath, JSON.stringify({ ...descriptor, sessionId: 'third-id' }));
  now += 60000;
  assert.equal(s.ctx.getPtyForSession('new-id'), null);
});

test('continued-in a new alias evicts the previous alias on the same PTY immediately', async t => {
  const s = continuingSession(t, { detect: false });
  assert.equal((await s.ctx.findPtyForSession('new-id')).ptyProcess, s.session.pty);
  const descriptor = JSON.parse(fs.readFileSync(s.descriptorPath, 'utf8'));
  fs.writeFileSync(s.descriptorPath, JSON.stringify({ ...descriptor, sessionId: 'third-id' }));
  assert.equal((await s.ctx.findPtyForSession('third-id')).ptyProcess, s.session.pty);
  assert.equal(s.ctx.getPtyForSession('new-id'), null);
});

test('continued-in a gated alias scan waits for the direct tab lock acquired during the scan', async t => {
  const s = continuingSession(t, { detect: false, statusForOld: true });
  const tmp = mkTmp('sw-continuation-two-phase-');
  const find = s.ctx.findPtyForSession;
  let scanStarted, releaseScan, idleStarted, resolvedScan;
  const started = new Promise(resolve => { scanStarted = resolve; });
  const gate = new Promise(resolve => { releaseScan = resolve; });
  const idle = new Promise(resolve => { idleStarted = resolve; });
  const resolved = new Promise(resolve => { resolvedScan = resolve; });
  s.ctx.findPtyForSession = async (...args) => {
    scanStarted();
    await gate;
    const result = await find(...args);
    resolvedScan();
    return result;
  };
  s.session._cliBusy = true;
  const busy = s.ctx.isSessionBusy;
  s.ctx.isSessionBusy = id => {
    if (id === 'old-id') idleStarted();
    return busy(id);
  };
  const keepAlive = setTimeout(() => { releaseScan(); s.session._cliBusy = false; }, 5000);
  t.after(() => clearTimeout(keepAlive));
  const run = runTriggers(s.ctx, [['first', { sessionId: 'new-id', command: 'first' }]], 6000, tmp, ['first', 'direct']);
  await started;
  fs.writeFileSync(path.join(tmp, 'direct.json'), JSON.stringify({ sessionId: 'old-id', command: 'direct', wait: 'idle', timeout_ms: 6000 }));
  await idle;
  releaseScan();
  await resolved;
  await new Promise(resolve => setTimeout(resolve, 100));
  const mid = [...s.written];
  s.session._cliBusy = false;
  const results = await run;
  assert.deepEqual(mid, [], 'nothing may write while the direct trigger holds the tab lock');
  assert.equal(results.first.ok, true, JSON.stringify(results.first));
  assert.equal(results.direct.ok, true, JSON.stringify(results.direct));
  assert.deepEqual(s.written.filter(data => data !== '\r'), ['direct', 'first']);
});

test('continued-in a failed alias resolution releases both queues for the next trigger', async t => {
  const s = continuingSession(t, { detect: false });
  const find = s.ctx.findPtyForSession;
  let calls = 0;
  s.ctx.findPtyForSession = (...args) => {
    if (++calls === 1) throw new Error('descriptor scan failed');
    return find(...args);
  };
  const results = await runTriggers(s.ctx, [
    ['failed', { sessionId: 'new-id', command: 'failed' }],
    ['next', { sessionId: 'new-id', command: 'next' }],
  ], 2000);
  assert.equal(results.failed.ok, false);
  assert.equal(results.next.ok, true, JSON.stringify(results.next));
  assert.deepEqual(s.written, ['next', '\r']);
});

test('continued-in with two records and pre-existing B: its trigger reaches the owning tab', async t => {
  const s = continuingSession(t, { detect: false });
  fs.appendFileSync(s.oldFile, jsonl([{ type: 'continued-in', sessionId: 'old-id', continuedInSessionId: 'foreign-id' }]));
  fs.writeFileSync(path.join(s.folderPath, 'foreign-id.jsonl'), jsonl([prompt('foreign-id', Date.now(), 'elsewhere')]));
  s.session.knownJsonlFiles = new Set(['old-id.jsonl', 'new-id.jsonl', 'foreign-id.jsonl']);
  sessionTransitions.detectSessionTransitions('proj');
  assert.equal(s.activeSessions.get('new-id'), s.session);
  const { continuation } = await runTriggers(s.ctx, [['continuation', { sessionId: 'new-id', command: 'reply' }]], 2000);
  assert.equal(continuation.ok, true, JSON.stringify(continuation));
  assert.deepEqual(s.written, ['reply', '\r']);
});

test('continued-in alias scans cannot reorder two triggers dispatched for B', async t => {
  const s = continuingSession(t, { detect: false });
  const tmp = mkTmp('sw-continuation-fifo-');
  const find = s.ctx.findPtyForSession;
  let calls = 0;
  let firstScanStarted;
  let releaseFirstScan;
  const started = new Promise(resolve => { firstScanStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirstScan = resolve; });
  s.ctx.findPtyForSession = async (...args) => {
    if (++calls === 1) { firstScanStarted(); await gate; }
    return find(...args);
  };
  const keepAlive = setTimeout(() => releaseFirstScan(), 2000);
  t.after(() => clearTimeout(keepAlive));
  const run = runTriggers(s.ctx, [['first', { sessionId: 'new-id', command: 'first' }]], 4000, tmp, ['first', 'second']);
  await started;
  fs.writeFileSync(path.join(tmp, 'second.json'), JSON.stringify({ sessionId: 'new-id', command: 'second', wait: 'none', timeout_ms: 4000 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  releaseFirstScan();
  const results = await run;
  assert.equal(results.first.ok, true, JSON.stringify(results.first));
  assert.equal(results.second.ok, true, JSON.stringify(results.second));
  assert.deepEqual(s.written.filter(data => data !== '\r'), ['first', 'second']);
});

test('continued-in A to B: a trigger for B reaches the PTY opened under A', async t => {
  const s = continuingSession(t);
  const { continuation } = await runTriggers(s.ctx, [['continuation', { sessionId: 'new-id', command: 'reply' }]], 2000);
  assert.equal(continuation.ok, true, JSON.stringify(continuation));
  assert.deepEqual(s.written, ['reply', '\r']);
  assert.equal(s.activeSessions.get('new-id'), s.session);
  assert.equal(s.activeSessions.has('old-id'), false);
  assert.equal(sessionTransitions.currentSessionId('old-id'), 'new-id');
  assert.deepEqual(s.events, [['session-forked', 'old-id', 'new-id', 'continuation']]);
});

test('continued-in before detection: a live descriptor routes B to its unique owning PTY', async t => {
  const s = continuingSession(t, { detect: false });
  const { continuation } = await runTriggers(s.ctx, [['continuation', { sessionId: 'new-id', chain: [{ command: 'reply' }] }]], 2000);
  assert.equal(continuation.ok, true, JSON.stringify(continuation));
  assert.deepEqual(s.written, ['reply', '\r']);
  assert.equal(s.ctx.resolveSessionId('new-id'), 'old-id');
  assert.deepEqual(s.ctx.getCliStatus('new-id').status, 'idle');
  assert.equal(path.basename(s.ctx.getTranscriptTurn('new-id').compactionCursor.filePath), 'new-id.jsonl');
});

test('continued-in before detection: old and new ids share the same trigger queue', async t => {
  const s = continuingSession(t, { detect: false, statusForOld: true });
  const tmp = mkTmp('sw-continuation-queue-');
  const write = s.session.pty.write;
  s.session.pty.write = data => {
    write(data);
    if (data === 'first') fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({
      sessionId: 'new-id', command: 'other', wait: 'none', timeout_ms: 4000,
    }));
  };
  const results = await runTriggers(s.ctx, [
    ['chain', { sessionId: 'old-id', chain: [{ command: 'first' }, { command: 'second' }] }],
  ], 4000, tmp, ['chain', 'single']);
  assert.equal(results.chain.ok, true, JSON.stringify(results.chain));
  assert.equal(results.single.ok, true, JSON.stringify(results.single));
  assert.deepEqual(s.written.filter(data => data !== '\r'), ['first', 'second', 'other']);
});

test('continued-in old and new ids still share a tab lock when its PTY object changes', async t => {
  const s = continuingSession(t, { detect: false, statusForOld: true });
  const tmp = mkTmp('sw-continuation-replaced-pty-');
  const write = s.session.pty.write;
  s.session.pty.write = data => {
    write(data);
    if (data !== 'first') return;
    s.session.pty = { pid: 4242, write };
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({
      sessionId: 'new-id', command: 'other', wait: 'none', timeout_ms: 4000,
    }));
  };
  const results = await runTriggers(s.ctx, [
    ['chain', { sessionId: 'old-id', chain: [{ command: 'first' }, { command: 'second' }] }],
  ], 4000, tmp, ['chain', 'single']);
  assert.equal(results.chain.ok, true, JSON.stringify(results.chain));
  assert.equal(results.single.ok, true, JSON.stringify(results.single));
  assert.deepEqual(s.written.filter(data => data !== '\r'), ['first', 'second', 'other']);
});

for (const [name, options] of [['ambiguous PTYs', { duplicate: true }], ['another process', { owner: false }]]) {
  test(`continued-in fallback refuses ${name}`, async t => {
    const s = continuingSession(t, { detect: false, ...options });
    const { continuation } = await runTriggers(s.ctx, [['continuation', { sessionId: 'new-id', command: 'reply' }]], 2000);
    assert.equal(continuation.error, 'session not found');
    assert.deepEqual(s.written, []);
  });
}

test('a [/clear, reply] chain follows the session to its new id and writes the reply', async () => {
  const s = clearingSession();
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: '/clear' }, { command: 'reply' }] }]], 6000);
    assert.ok(s.activeSessions.has('new-id'), 'the session was re-keyed by the /clear');
    assert.equal(chain.ok, true, JSON.stringify(chain));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['/clear', 'reply']);
  } finally {
    s.cleanup();
  }
});

test('a trigger for the new id waits for a chain still running under the old id', async () => {
  const tmp = mkTmp('sw-clear-chain-triggers-');
  const s = clearingSession((text) => {
    if (text !== 'first') return;
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({ sessionId: 'new-id', command: 'other', wait: 'none', timeout_ms: 6000 }), 'utf8');
  });
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: '/clear' }, { command: 'first' }, { command: 'second' }] }]], 6000, tmp);
    assert.equal(chain.ok, true, JSON.stringify(chain));
    const resultPath = path.join(tmp, 'processed', 'single.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['/clear', 'first', 'second', 'other'], 'one terminal, one queue, whichever id names it');
  } finally {
    s.cleanup();
  }
});

test('a trigger waits for a chain whose session got a new PTY under the same id', async () => {
  const tmp = mkTmp('sw-clear-chain-triggers-');
  let s = null;
  s = clearingSession((text) => {
    if (text !== 'first') return;
    const session = s.activeSessions.get('old-id');
    const previous = session.pty;
    session.pty = { pid: previous.pid, write: (data) => previous.write(data) };
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({ sessionId: 'old-id', command: 'other', wait: 'none', timeout_ms: 6000 }), 'utf8');
  });
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: 'first' }, { command: 'second' }] }]], 6000, tmp);
    assert.equal(chain.ok, true, JSON.stringify(chain));
    const resultPath = path.join(tmp, 'processed', 'single.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['first', 'second', 'other']);
  } finally {
    s.cleanup();
  }
});
