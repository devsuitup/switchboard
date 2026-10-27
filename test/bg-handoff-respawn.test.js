'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');
const bg = require('../bg-agents');

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SOURCE_PID = 4242;

function setup(t, { jobs = {}, outside = [], others = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s2-respawn-'));
  t.after(() => { bg.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir);
  fs.mkdirSync(path.join(root, 'daemon'));
  fs.writeFileSync(path.join(root, 'daemon', 'roster.json'), JSON.stringify({ proto: 1, updatedAt: '2000-01-01T00:00:00Z', workers: {} }));
  for (const [id, fields] of Object.entries(jobs)) {
    fs.mkdirSync(path.join(jobsDir, id));
    fs.writeFileSync(path.join(jobsDir, id, 'state.json'), JSON.stringify(fields));
  }
  bg.init({ jobsDir, homeDir: root, cliSessionState: { readAllDescriptors: () => [],
    refreshProcessTable: async () => {}, readWorkerProcessEvidence: () => ({ processTableFresh: true, tableEntry: () => undefined }) } });
  const folder = 'folder';
  fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, folder, SID + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
  const writes = [], respawned = [], exitedAtRespawn = [], listeners = new Set();
  const session = { kind: 'local-pty', realSessionId: SID, projectFolder: folder, exitDrain: Promise.resolve(),
    composerState: require('../composer-state').createComposerState(),
    pty: { pid: SOURCE_PID, onData: () => ({ dispose() {} }) } };
  const activeSessions = new Map([['tab', session], ...others.map((o, i) => ['other' + i, o])]);
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, Promise, path, fs, require: require('node:module').createRequire(path.join(__dirname, '../main.js')), PROJECTS_DIR: root,
    detectSessionTransitions() {}, notifyRendererProjectsChanged() {}, log: { warn() {} },
    sessionCache: { resolveSessionContinuations: async () => ({ candidates: [], unresolved: false }) },
    writer: { refreshFolder: async () => false },
    sessionHasPty: id => id.toLowerCase() === SID, ptyPids: require('../cli-session-state').makePtyPids(activeSessions),
    activeSessions,
    mainWindow: { isDestroyed: () => false, webContents: { send() {} } },
    writePty: (entry, text) => {
      writes.push(text);
      if (text === '\r') setTimeout(() => { session.exited = true; for (const fn of [...listeners]) fn(); }, 10);
      return true;
    },
    killPty() {},
    bgAgents: bg,
    unsubscribeBgAgents: { respawnForHandoff: async job => { respawned.push(job.id); exitedAtRespawn.push(session.exited === true); return { ok: true, attached: true }; } },
    cliSessionState: {
      getStatus: () => (session.exited ? null : { status: 'idle', waitingFor: null }),
      readAllDescriptors: () => [],
      onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      liveElsewhereChecked: async (id, hasPty, ptyPids, opts = {}) => {
        if (!opts.includeOwnProcesses && hasPty(id)) return { known: true, live: null };
        const excluded = new Set(ptyPids(id));
        const live = outside.find(p => p.sessionId.toLowerCase() === id.toLowerCase() && !excluded.has(p.pid));
        return { known: true, live: live || null };
      },
    },
    ...require('../bg-handoff'),
    sendToBackground: (id, deps) => require('../bg-handoff').sendToBackground(id, { ...deps, timeoutMs: 1000, exitTimeoutMs: 300 }),
  });
  const { handleSendToBackground } = loadAppFunctions(ctx, { declarations: ['backgroundHandoffs'],
    functions: ['handleSendToBackground', 'persistBackgroundHandoff', 'readBackgroundHandoffStamp'], sourcePath: path.join(__dirname, '../main.js') });
  return { send: () => handleSendToBackground({}, 'tab'), writes, respawned, exitedAtRespawn, session };
}

test('S2-T1 a stopped job of this conversation is relaunched by respawn after /exit, never /bg', { timeout: 20000 }, async t => {
  const h = setup(t, { jobs: { aaaaaaaa: { state: 'stopped', sessionId: SID, resumeSessionId: SID, name: 's2-a', nameSource: 'user' } },
    outside: [{ sessionId: SID, pid: SOURCE_PID }] });
  const result = await h.send();
  assert.deepEqual(h.writes, ['/exit', '\r']);
  assert.deepEqual(h.respawned, ['aaaaaaaa']);
  assert.deepEqual(h.exitedAtRespawn, [true]);
  assert.equal(result.ok, true);
  assert.equal(result.respawned, true);
  assert.equal(result.sessionId, SID);
  assert.equal(result.jobId, 'aaaaaaaa');
});

test('S2-T11 a unique stopped match plus an unrelated future-state record is refused before any write', { timeout: 20000 }, async t => {
  const h = setup(t, { jobs: {
    aaaaaaaa: { state: 'stopped', sessionId: SID, resumeSessionId: SID },
    bbbbbbbb: { state: 'future-state', sessionId: OTHER },
  } });
  const result = await h.send();
  assert.equal(result.code, 'refused');
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.respawned, []);
});

test('S2-T12 an outside process holding the conversation while the source tab is alive is refused before any write', { timeout: 20000 }, async t => {
  const h = setup(t, { jobs: { aaaaaaaa: { state: 'stopped', sessionId: SID, resumeSessionId: SID } },
    outside: [{ sessionId: SID, pid: SOURCE_PID }, { sessionId: SID, pid: 777 }] });
  const result = await h.send();
  assert.equal(result.code, 'refused');
  assert.match(result.error, /pid 777/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.respawned, []);
});

test('S2-T13 a job that resumes this conversation, while another job still runs its session id, is refused before any write', { timeout: 20000 }, async t => {
  const h = setup(t, { jobs: {
    aaaaaaaa: { state: 'stopped', sessionId: OTHER, resumeSessionId: SID },
    bbbbbbbb: { state: 'working', sessionId: OTHER },
  } });
  const result = await h.send();
  assert.equal(result.code, 'refused');
  assert.match(result.error, /bbbbbbbb/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.respawned, []);
});

test('S2-T12b an outside pid that belongs to another live tab of this window is still refused', { timeout: 20000 }, async t => {
  const h = setup(t, { jobs: { aaaaaaaa: { state: 'stopped', sessionId: SID, resumeSessionId: SID } },
    others: [{ kind: 'local-pty', realSessionId: SID, pty: { pid: 777 } }],
    outside: [{ sessionId: SID, pid: SOURCE_PID }, { sessionId: SID, pid: 777 }] });
  const result = await h.send();
  assert.equal(result.code, 'refused');
  assert.match(result.error, /pid 777/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.respawned, []);
});
