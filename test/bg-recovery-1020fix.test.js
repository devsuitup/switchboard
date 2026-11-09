'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadAppFunctions } = require('./app-source');
const bg = require('../src/main/bg-agents/bg-agents');
const handoff = require('../src/main/bg-agents/bg-handoff');
const SID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const line = value => JSON.stringify(value) + '\n';

function setup(t, { forkAt = 0, exitAt = Infinity, descriptor = true, unknown = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-main-1020fix-'));
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir); fs.mkdirSync(path.join(root, 'folder')); fs.mkdirSync(path.join(root, 'daemon'));
  fs.writeFileSync(path.join(root, 'daemon', 'roster.json'), line({ proto: 1, updatedAt: '2000-01-01T00:00:00Z', workers: {} }));
  const writeJob = (id, sessionId, state) => {
    fs.mkdirSync(path.join(jobsDir, id));
    fs.writeFileSync(path.join(jobsDir, id, 'state.json'), line({ state, sessionId, resumeSessionId: sessionId }));
  };
  writeJob('aaaaaaaa', SID, 'stopped');
  const file = path.join(root, 'folder', SID + '.jsonl');
  fs.writeFileSync(file, line({ type: 'user', sessionId: SID }));
  let now = 0, forked = false;
  const descriptors = [], writes = [], respawns = [], kills = [], scheduled = [];
  const session = { kind: 'local-pty', realSessionId: SID, projectFolder: 'folder', cwd: root,
    composerState: require('../src/main/terminals/composer-state').createComposerState(), pty: { pid: 4242, onData: () => ({ dispose() {} }) } };
  const advance = async ms => {
    now += ms;
    if (!forked && now >= forkAt) {
      forked = true;
      fs.appendFileSync(file, line({ type: 'continued-in', sessionId: SID, continuedInSessionId: NEXT }));
      fs.writeFileSync(path.join(root, 'folder', NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
      writeJob('bbbbbbbb', NEXT, 'working');
      if (descriptor) descriptors.push({ kind: 'bg', jobId: 'bbbbbbbb', sessionId: NEXT, cwd: root });
    }
    if (now >= exitAt) session.exited = true;
  };
  const cli = { getStatus: () => ({ status: 'idle' }), readAllDescriptors: () => descriptors,
    onDescriptorsChanged: () => () => {}, liveElsewhereChecked: async () => ({ known: true, live: null }),
    refreshProcessTable: async () => {}, readWorkerProcessEvidence: () => ({ processTableFresh: !unknown, tableEntry: () => undefined }) };
  bg.init({ jobsDir, homeDir: root, cliSessionState: cli, resolveTranscriptPath: id => path.join(root, 'folder', id + '.jsonl') });
  t.after(() => { bg.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const ctx = vm.createContext({ fs, path, require: createRequire(path.join(__dirname, '../main.js')), PROJECTS_DIR: root,
    Date: { now: () => now }, Promise, setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; }, clearTimeout,
    activeSessions: new Map([['tab', session]]), cliSessionState: cli, bgAgents: bg,
    sessionHasPty: () => false, ptyPids: () => [], mainWindow: null, log: { warn() {} },
    writePty: (_, text) => { writes.push(text); return true; }, killPty: () => kills.push(true),
    detectSessionTransitions() {}, sessionCache: { resolveSessionContinuations: async () => ({}) },
    writer: { refreshFolder: async () => {} }, notifyRendererProjectsChanged() {},
    unsubscribeBgAgents: { respawnForHandoff: async () => { respawns.push(true); return { ok: true, attached: true }; } },
    ...handoff,
    sendToBackground: (id, deps) => handoff.sendToBackground(id, { ...deps, delay: advance, waitForChange: advance }),
  });
  const { handleSendToBackground } = loadAppFunctions(ctx, { declarations: ['backgroundHandoffs'],
    functions: ['handleSendToBackground', 'persistBackgroundHandoff', 'readBackgroundHandoffStamp'], sourcePath: path.join(__dirname, '../main.js') });
  return { send: async () => { await advance(0); return handleSendToBackground({}, 'tab'); }, writes, respawns, kills, scheduled, session, activeSessions: ctx.activeSessions, time: () => now };
}

test('1020fix2 shipped handler refuses an earlier live fork and leaves the tab untouched', async t => {
  const h = setup(t);
  const before = { ...h.session, composerState: { ...h.session.composerState }, backgrounding: false };
  const result = await h.send();
  assert.equal(result.ok, false, 'an earlier live continuation must refuse the handoff');
  assert.equal(result.code, 'refused');
  assert.equal(result.error, 'This conversation already runs in the background; open it from the sidebar.');
  assert.deepEqual(h.writes, [], 'refusal must write neither /exit nor /bg');
  assert.deepEqual(h.respawns, []);
  assert.deepEqual(h.kills, []);
  assert.equal(h.activeSessions.get('tab'), h.session, 'the foreground tab must remain registered');
  assert.deepEqual(h.session, before, 'the foreground CLI and composer must remain unchanged');
});

test('1020fix shipped handler refuses unknown continuation liveness before typing exit', async t => {
  const h = setup(t, { descriptor: false, unknown: true });
  const result = await h.send();
  assert.deepEqual(h.writes, [], 'unknown continuation ownership must not close the tab');
  assert.equal(result.ok, false);
  assert.match(result.error, /check|retry|try again/i);
  assert.deepEqual(h.respawns, []);
});

test('1020fix shipped handler adopts a fork at the exit timeout without respawning', async t => {
  const h = setup(t, { forkAt: 15400 });
  const result = await h.send();
  assert.equal(result.ok, true, 'exit timeout must still observe the continuation');
  assert.equal(result.sessionId, NEXT);
  assert.equal(result.jobId, 'bbbbbbbb');
  assert.deepEqual(h.writes, ['/exit', '\r']);
  assert.deepEqual(h.respawns, []);
  assert.equal(h.scheduled.length, 1, 'adoption must schedule cleanup of the old CLI');
  assert.equal(h.scheduled[0].ms, 15000);
  h.scheduled[0].fn();
  assert.deepEqual(h.kills, [true], 'the old-id CLI must be killed after adoption');
  assert.ok(h.time() >= 15400 && h.time() <= 25300, 'keep the 15 second exit budget and 10 second observation bound');
});

test('1020fix exit timeout without a fork never respawns the live source', async t => {
  const h = setup(t, { forkAt: Infinity });
  const result = await h.send();
  assert.equal(result.code, 'exit-timeout');
  assert.deepEqual(h.respawns, []);
  assert.deepEqual(h.kills, []);
});

test('1020fix an exit after the budget cannot authorize respawn before a delayed fork', async t => {
  const h = setup(t, { exitAt: 20000, forkAt: 25500 });
  const result = await h.send();
  assert.deepEqual(h.respawns, [], 'an exit after the budget must not authorize an early respawn');
  assert.equal(result.code, 'exit-timeout');
  assert.deepEqual(h.kills, []);
});
