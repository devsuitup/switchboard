// test/main-local-transcript-wiring.test.js — reads main.js as TEXT and fails
// when the local-transcript wiring (issue #246 step 4) disappears from it.
//
// This proves NOTHING about runtime behaviour beyond the shape of the source:
// the tracker's own coalescing/hasPty properties are exercised in
// test/local-transcript-activity.test.js; this file only pins that main.js
// actually wires the real activeSessions-backed guard into it, on the
// out-of-band path (not the debounced flushChanges()/projects-changed one).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { extractFunction } = require('./app-source');
const { createLocalTranscriptTracker } = require('../local-transcript-activity');
const { createRemoteActivityTracker } = require('../remote-activity');

// Normalised to LF: this file's own balanced-brace slicing assumes '\n',
// and main.js is checked out with CRLF line endings on Windows.
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main.js requires local-transcript-activity and wires the real activeSessions-backed PTY guard', () => {
  assert.match(mainSrc, /require\('\.\/local-transcript-activity'\)/,
    'main.js must require ./local-transcript-activity');
  assert.match(
    mainSrc,
    /createLocalTranscriptTracker\(\s*\{\s*hasPty:\s*sessionHasPty\s*,/,
    'the tracker must be constructed with the real sessionHasPty guard, not a stub',
  );
});

test('sessionHasPty checks activeSessions for a live, non-exited match on realSessionId or the map key', () => {
  const at = mainSrc.indexOf('function sessionHasPty(sessionId)');
  assert.notEqual(at, -1, 'sessionHasPty must be defined');
  const body = mainSrc.slice(at, mainSrc.indexOf('\n}\n', at) + 3);
  assert.match(body, /for \(const \[key, session\] of activeSessions\)/);
  assert.match(body, /session\.exited/, 'must skip an exited session — a dead PTY is not a live PTY');
  assert.match(body, /session\.realSessionId \|\| key/, 'must match a forked/resumed session by its real id, same as cli-session-state.js findSession()');
});

test('the fs.watch callback emits session-transcript-activity out-of-band, not through the debounced flush', () => {
  const watchAt = mainSrc.indexOf("fs.watch(PROJECTS_DIR, { recursive: true }");
  assert.notEqual(watchAt, -1, 'the projects watcher call site must still exist');
  const flushAt = mainSrc.indexOf('function flushChanges()');
  assert.notEqual(flushAt, -1);
  const flushBody = mainSrc.slice(flushAt, mainSrc.indexOf('\n  }\n', flushAt));
  assert.doesNotMatch(flushBody, /localTranscriptTracker/,
    'the heavy debounced flush must not carry the lightweight per-session signal');

  const callbackEnd = mainSrc.indexOf('projectsWatcher.on(\'error\'', watchAt);
  const callbackBody = mainSrc.slice(watchAt, callbackEnd);
  assert.match(callbackBody, /localTranscriptTracker\.record\(parts\)/,
    'the raw watcher callback must feed the tracker directly, before the 500ms debounce');
  const trackerAt = mainSrc.indexOf('const localTranscriptTracker =');
  const trackerBody = mainSrc.slice(trackerAt, mainSrc.indexOf('\n});', trackerAt));
  assert.match(trackerBody, /projectsDir: PROJECTS_DIR/);
  assert.match(trackerBody, /mainWindow\.webContents\.send\('session-transcript-activity', activity\)/);
  assert.match(trackerBody, /mainWindow && !mainWindow\.isDestroyed\(\)/,
    'must guard the send exactly like the other IPC emitters in this file (e.g. onRemoteWatchActivity)');
});

test('injected projects-watch notifications verify real files while indexing stays independent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-wiring-621-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const parts = ['folder', `${id}.jsonl`];
  const filename = path.join(...parts);
  const file = path.join(root, filename);
  const childParts = ['folder', id, 'subagents', 'agent-7.jsonl'];
  const childName = path.join(...childParts);
  const childFile = path.join(root, childName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'old\n');
  fs.utimesSync(file, 100, 100);
  fs.mkdirSync(path.dirname(childFile), { recursive: true });
  fs.writeFileSync(childFile, 'old child\n');
  fs.utimesSync(childFile, 100, 100);
  const sent = [];
  const refreshed = [];
  const timers = [];
  const activityTimers = new Set();
  let at = Date.now();
  let racing = 0;
  let callback;
  const context = vm.createContext({
    PROJECTS_DIR: root, path, console, projectsWatcher: null,
    taskRecords: { read() { return Promise.resolve(); }, child() {} },
    cliSessionState: { getStatus() { return {}; } },
    bgAgents: { getSnapshot() { return { roster: [] }; } },
    fs: { ...fs, watch: (_root, _opts, cb) => { callback = cb; return { on() {} }; } },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
    setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout() {},
    detectSessionTransitions() {}, notifyRendererProjectsChanged() {},
    writer: { refreshFolder: async (...args) => refreshed.push(args), async dropFolderRows() {} },
  });
  const declaration = mainSrc.slice(mainSrc.indexOf('const localTranscriptTracker ='), mainSrc.indexOf('\n\n// see .ai/contexts/cli-session-state.md', mainSrc.indexOf('const localTranscriptTracker =')));
  let tracker;
  context.sessionHasPty = () => false;
  context.createLocalTranscriptTracker = opts => {
    tracker = createLocalTranscriptTracker({ ...opts, projectsDir: root, now: () => at,
      setTimeout: (fn, ms) => { const timer = { fn, at: at + ms }; activityTimers.add(timer); return timer; },
      clearTimeout: timer => activityTimers.delete(timer),
      fs: { ...fs.promises, stat: async transcript => {
        if (racing > 0 && transcript === childFile) {
          racing--;
          fs.appendFileSync(transcript, 'racing child append\n');
          callback('change', childName);
        }
        return fs.promises.stat(transcript);
      } },
    });
    return tracker;
  };
  vm.runInContext(declaration + '\n' + extractFunction(mainSrc, 'startProjectsWatcher') + '\nstartProjectsWatcher();', context);
  t.after(() => {
    tracker.dispose?.();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  callback('change', filename);
  await tracker.record(parts);
  callback('change', childName);
  await tracker.record(childParts);
  assert.deepEqual(sent, [], 'a startup notification must not reach the activity channel');
  fs.readFileSync(file);
  callback('change', filename);
  await tracker.record(parts);
  fs.readFileSync(childFile);
  callback('change', childName);
  await tracker.record(childParts);
  assert.deepEqual(sent, [], 'unchanged metadata produces no activity/unread/spawn');
  await timers.at(-1)();
  assert.equal(refreshed.length, 1, 'suppressed activity still invalidates indexing');
  fs.appendFileSync(file, 'new\n');
  callback('change', filename);
  await tracker.record(parts);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'session-transcript-activity');
  assert.equal(sent[0][1].sessionId, id);
  fs.appendFileSync(childFile, 'new child\n');
  callback('change', childName);
  await tracker.record(childParts);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].kind, 'subagent');
  assert.equal(sent[1][1].parentSessionId, id);
  assert.equal(sent[1][1].agentId, '7');
  const freshId = '22222222-2222-4222-8222-222222222222';
  const freshParts = ['folder', `${freshId}.jsonl`];
  const freshChildParts = ['folder', freshId, 'subagents', 'agent-8.jsonl'];
  for (const fresh of [freshParts, freshChildParts]) {
    const freshName = path.join(...fresh);
    fs.mkdirSync(path.dirname(path.join(root, freshName)), { recursive: true });
    fs.writeFileSync(path.join(root, freshName), 'first write\n');
    callback('change', freshName);
    await tracker.record(fresh);
  }
  assert.equal(sent.length, 4, 'new parent and child first writes must reach the activity channel');
  assert.equal(sent[2][1].sessionId, freshId);
  assert.equal(sent[3][1].parentSessionId, freshId);
  assert.equal(sent[3][1].agentId, '8');
  at += 1000;
  fs.appendFileSync(childFile, 'first burst append\n');
  racing = 2;
  callback('change', childName);
  await tracker.record(childParts);
  assert.equal(sent.length, 4, 'unstable child evidence must not reach IPC');
  at += 50;
  for (const timer of [...activityTimers]) {
    if (timer.at > at) continue;
    activityTimers.delete(timer);
    await timer.fn();
  }
  assert.equal(sent.length, 5, 'the settled burst must reach IPC without a later watch notification');
  assert.equal(sent[4][0], 'session-transcript-activity');
  assert.equal(sent[4][1].agentId, '7');
  assert.equal(activityTimers.size, 0);
});

test('remote watcher wiring sends leading and trailing activity once and guards a destroyed window', t => {
  const sent = [];
  const timers = new Set();
  let at = 0;
  let destroyed = false;
  let tracker;
  const context = vm.createContext({
    mainWindow: { isDestroyed: () => destroyed, webContents: { send: (...args) => sent.push(args) } },
    createRemoteActivityTracker: opts => {
      tracker = createRemoteActivityTracker({ ...opts, now: () => at, ipcMinMs: 50,
        setTimeout: (fn, ms) => { const timer = { fn, at: at + ms }; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer),
      });
      return tracker;
    },
  });
  t.after(() => tracker.dispose?.());
  const start = mainSrc.indexOf('const remoteActivityTracker =');
  const declaration = mainSrc.slice(start, mainSrc.indexOf('\nfunction onRemoteWatchActivity', start));
  vm.runInContext(declaration + '\n' + extractFunction(mainSrc, 'onRemoteWatchActivity'), context);
  const rel = 'folder/11111111-1111-4111-8111-111111111111/subagents/agent-A.jsonl';
  context.onRemoteWatchActivity('vps', rel);
  at = 10;
  context.onRemoteWatchActivity('vps', rel);
  assert.equal(sent.length, 1, 'leading activity is not duplicated by callback plus return value');
  at = 50;
  for (const timer of [...timers]) {
    timers.delete(timer);
    timer.fn();
  }
  assert.equal(sent.length, 2, 'the sole final remote append reaches IPC after the throttle boundary');
  assert.equal(sent[1][0], 'remote-activity');
  assert.equal(sent[1][1].agentId, 'A');
  destroyed = true;
  at = 100;
  context.onRemoteWatchActivity('vps', rel);
  assert.equal(sent.length, 2, 'a destroyed window receives nothing');
});
