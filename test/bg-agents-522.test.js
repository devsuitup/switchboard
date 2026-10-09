'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const { mergeRoster, parseJobState } = require('../bg-agents-roster');
const bgAgents = require('../bg-agents');
const cliSessionState = require('../cli-session-state');
const bgIpc = require('../bg-agents-ipc');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const BRIDGE = 'bbbbbbbb-1234-4321-abcd-123456789abc';
const JOB = 'aaaaaaaa';
const PID = 987654;

function fixture(t, { state = 'stopped', live = true, own = false, ownDescriptor = false, bridge = false, unknown = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-522-'));
  const jobs = path.join(dir, 'jobs');
  const sessions = path.join(dir, 'sessions');
  const transcript = path.join(dir, SID + '.jsonl');
  fs.mkdirSync(path.join(jobs, JOB), { recursive: true });
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(jobs, JOB, 'state.json'), JSON.stringify({
    state, linkScanPath: transcript, tokens: 42, bridgeSessionId: bridge ? BRIDGE : undefined,
  }));
  const descriptor = path.join(sessions, PID + '.json');
  const writeDescriptor = () => fs.writeFileSync(descriptor, unknown ? '{' : JSON.stringify({
    pid: PID, sessionId: (bridge ? BRIDGE : SID).toUpperCase(), kind: 'interactive', status: 'busy', cwd: dir,
  }));
  writeDescriptor();
  const activeSessions = own ? new Map([['pending', { realSessionId: SID.toUpperCase(), pid: PID }]]) : new Map();
  cliSessionState.init({ dir: sessions, activeSessions, onIdle() {}, isProcessAlive: () => live, readProcStartMany: async () => new Map(), platform: 'win32' });
  const calls = [];
  bgAgents.init({
    jobsDir: jobs, homeDir: dir, cliSessionState, resolveProjectRoots: async () => null,
    runClaude: async (args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === 'agents' ? JSON.stringify([{ id: JOB, sessionId: SID, kind: 'background', state, cwd: dir }]) : '', stderr: '' };
    },
  });
  const handlers = new Map();
  bgIpc.init({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, bgAgents, cliSessionState,
    activeSessions, sessionHasPty: () => own, ptyPids: () => own || ownDescriptor ? [PID] : [],
    getMainWindow: () => null, log: { warn() {} },
  });
  t.after(() => {
    bgAgents.stop();
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { calls, handlers, dir, transcript, descriptor, jobs, activeSessions,
    setLive(value) { live = value; },
    setUnknown(value) { unknown = value; writeDescriptor(); },
  };
}

for (const state of ['stopped', 'done', 'failed']) {
  for (const listed of [true, false]) {
    test(`[522] ${state} job and live interactive descriptor merge (${listed ? 'CLI' : 'files'})`, { timeout: 9000 }, (t) => {
      const f = fixture(t, { state });
      const job = parseJobState(fs.readFileSync(path.join(f.jobs, JOB, 'state.json'), 'utf8'));
      const roster = mergeRoster({ cli: listed ? [{ id: JOB, sessionId: SID, kind: 'background', state }] : null,
        jobs: new Map([[JOB, job]]), descriptors: cliSessionState.readAllDescriptors() });
      assert.equal(roster.length, 1, 'one conversation must have one row');
      assert.equal(roster[0].kind, 'interactive');
      assert.equal(roster[0].state, null, 'finished job state must not override the live session');
      assert.equal(roster[0].pid, PID);
      assert.equal(roster[0].status, 'busy');
      assert.equal(roster[0].tokens, 42, 'job metadata survives');
    });
  }
}

for (const verb of ['rm', 'respawn', 'stop']) {
  for (const scenario of ['external', 'own', 'own-descriptor', 'bridge', 'unknown']) {
    test(`[522] IPC ${verb} refuses ${scenario}, then allows a checked stopped conversation`, { timeout: 9000 }, async (t) => {
      const f = fixture(t, { own: scenario === 'own', ownDescriptor: scenario === 'own-descriptor', bridge: scenario === 'bridge', unknown: scenario === 'unknown' });
      const invoke = () => f.handlers.get('bg-agent-verb')({}, verb, JOB);
      const refusal = await invoke();
      assert.equal(refusal.ok, false, 'the shipped IPC must refuse before invoking the CLI');
      assert.match(refusal.error, scenario === 'unknown' ? /cannot tell|cannot read/i : /running|live/i);
      if (scenario === 'external' || scenario === 'bridge') assert.match(refusal.error, new RegExp(String(PID)));
      assert.equal(f.calls.length, 0, 'a refusal must not run even a reconciliation');
      f.setLive(false);
      f.setUnknown(false);
      f.activeSessions.clear();
      assert.deepEqual(await invoke(), { ok: true });
      assert.deepEqual(f.calls[0], [verb, JOB]);
    });
  }
}

for (const verb of ['rm', 'respawn']) {
  test(`[522] IPC ${verb} rechecks job state after a stopped snapshot`, { timeout: 9000 }, async (t) => {
    const f = fixture(t, { live: false });
    await f.handlers.get('get-bg-agents')({});
    fs.writeFileSync(path.join(f.jobs, JOB, 'state.json'), JSON.stringify({ state: 'working', linkScanPath: f.transcript }));
    f.calls.length = 0;
    assert.equal((await f.handlers.get('bg-agent-verb')({}, verb, JOB)).ok, false);
    assert.equal(f.calls.length, 0);
  });
}

test('[522] roster and IPC transcript handle a missing file, then an existing file', { timeout: 9000 }, async (t) => {
  const f = fixture(t, { live: false });
  const snapshot = await f.handlers.get('get-bg-agents')({});
  assert.equal(snapshot.roster[0].transcriptAvailable, false);
  f.calls.length = 0;
  const missing = await f.handlers.get('bg-agent-verb')({}, 'transcript', JOB);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /transcript.*(missing|exist|available)/i);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.transcript, '');
  const present = await f.handlers.get('bg-agent-verb')({}, 'transcript', JOB);
  assert.equal(present.ok, true);
  assert.equal(present.sessionId, SID);
  assert.equal(f.calls.length, 0);
});

function renderer(t) {
  const dom = new JSDOM('<div></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  window.sessionMap = new Map();
  window.showJsonlViewer = () => { throw new Error('missing transcript must not open the viewer'); };
  return { window, ...loadAppFunctions(dom.getInternalVMContext(), {
    sourcePath: path.join(__dirname, '..', 'public', 'agents-view.js'),
    declarations: ['agentsPendingVerbs', 'agentsVerbErrors', 'agentsViewActive', 'agentsDaemonReachable'],
    functions: ['agentJobIsLive', 'agentVerbAvailability', 'agentsEntryKey', 'renderAgentDetail',
      'formatTokens', 'formatAgentAge', 'agentsEscapeAttr', 'runAgentVerb'],
  }) };
}

test('[522] renderer disables destructive buttons and names the live pid', { timeout: 9000 }, (t) => {
  const r = renderer(t);
  const entry = { id: JOB, sessionId: SID, kind: 'background', state: 'stopped', conversationPid: PID, transcriptAvailable: true };
  const available = r.agentVerbAvailability(entry, true);
  assert.equal(available.rm, false);
  assert.equal(available.respawn, false);
  const detail = r.window.document.createElement('div');
  r.window.agentsDaemonReachable = true;
  detail.innerHTML = r.renderAgentDetail(entry);
  for (const verb of ['rm', 'respawn']) {
    const button = detail.querySelector(`[data-verb="${verb}"]`);
    assert.equal(button.disabled, true);
    assert.match(button.title, new RegExp(String(PID)));
  }
});

test('[522] a live background descriptor also disables destructive buttons on a finished job', { timeout: 9000 }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.descriptor, JSON.stringify({ pid: PID, sessionId: SID, kind: 'bg', jobId: JOB, status: 'busy' }));
  const job = parseJobState(fs.readFileSync(path.join(f.jobs, JOB, 'state.json'), 'utf8'));
  const roster = mergeRoster({ cli: null, jobs: new Map([[JOB, job]]), descriptors: cliSessionState.readAllDescriptors() });
  assert.equal(roster[0].conversationPid, PID);
  const r = renderer(t);
  assert.equal(r.agentVerbAvailability(roster[0], true).rm, false);
  assert.equal(r.agentVerbAvailability(roster[0], true).respawn, false);
  const detail = r.window.document.createElement('div');
  detail.innerHTML = r.renderAgentDetail(roster[0]);
  assert.match(detail.querySelector('[data-verb="rm"]').title, new RegExp(String(PID)));
});

test('[522] renderer disables missing Transcript with a reason and tolerates direct invocation', { timeout: 9000 }, async (t) => {
  const r = renderer(t);
  const entry = { id: JOB, sessionId: SID, kind: 'background', state: 'done', transcriptAvailable: false };
  assert.equal(r.agentVerbAvailability(entry, true).transcript, false);
  const detail = r.window.document.createElement('div');
  r.window.agentsDaemonReachable = true;
  detail.innerHTML = r.renderAgentDetail(entry);
  const button = detail.querySelector('[data-verb="transcript"]');
  assert.equal(button.disabled, true);
  assert.match(button.title, /transcript.*(missing|exist|available)/i);
  await r.runAgentVerb('transcript', entry);
});
