'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const { mergeRoster, parseJobState } = require('../bg-agents-roster');
const bgAgents = require('../bg-agents');
const cliSessionState = require('../cli-session-state');
const bgIpc = require('../bg-agents-ipc');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const BRIDGE = 'cse_0189wicjnQ3j6mppaWVWuntM';
const DESCRIPTOR_BRIDGE = 'session_0189wicjnQ3j6mppaWVWuntM';
const OTHER_SID = 'bbbbbbbb-1234-4321-abcd-123456789abc';
const JOB = 'aaaaaaaa';
const PID = 987654;

function fixture(t, { state = 'stopped', live = true, own = false, ownDescriptor = false, bridge = false, unknown = false, resolveTranscriptPath } = {}) {
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
    pid: PID, sessionId: (bridge ? OTHER_SID : SID).toUpperCase(), bridgeSessionId: bridge ? DESCRIPTOR_BRIDGE : undefined,
    kind: 'interactive', status: 'busy', cwd: dir,
  }));
  writeDescriptor();
  const activeSessions = own ? new Map([['pending', { realSessionId: SID.toUpperCase(), pid: PID }]]) : new Map();
  cliSessionState.init({ dir: sessions, activeSessions, onIdle() {}, isProcessAlive: () => live, readProcStartMany: async () => new Map(), platform: 'win32' });
  const calls = [];
  bgAgents.init({
    jobsDir: jobs, homeDir: dir, cliSessionState, resolveProjectRoots: async () => null, resolveTranscriptPath,
    makeIsOwnPid: () => pid => ownDescriptor && pid === PID,
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

test('[530] roster exposes transcript availability and the IPC rechecks a newly indexed file', { timeout: 9000 }, async (t) => {
  let indexed = false;
  let checks = 0;
  const f = fixture(t, { live: false, resolveTranscriptPath: () => { checks++; return indexed ? f.transcript : null; } });
  fs.writeFileSync(f.transcript, 'indexed transcript');
  const missing = await f.handlers.get('get-bg-agents')({});
  assert.equal(missing.roster[0].transcriptAvailable, false);
  const beforeClick = checks;
  const invoke = () => f.handlers.get('bg-agent-verb')({}, 'transcript', JOB);
  assert.equal((await invoke()).ok, false);
  indexed = true;
  assert.equal((await invoke()).ok, true, 'index completion needs no roster rebuild');
  assert.equal(checks, beforeClick + 2);
  assert.equal((await bgAgents.reconcile()).roster[0].transcriptAvailable, true);
});

test('[522] IPC transcript handles a missing file, then an existing file', { timeout: 9000 }, async (t) => {
  const f = fixture(t, { live: false });
  await f.handlers.get('get-bg-agents')({});
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
  window.openSessions = new Map();
  loadAppFunctions(dom.getInternalVMContext(), {
    sourcePath: path.join(__dirname, '..', 'public', 'stop-session-ui.js'), functions: ['runAttachedJobVerb'],
  });
  window.showJsonlViewer = () => { throw new Error('missing transcript must not open the viewer'); };
  return { window, context: dom.getInternalVMContext(), ...loadAppFunctions(dom.getInternalVMContext(), {
    sourcePath: path.join(__dirname, '..', 'public', 'agents-view.js'),
    declarations: ['agentsPendingVerbs', 'agentsInFlightVerbs', 'agentsVerbErrors', 'agentsViewActive', 'agentsDaemonReachable', 'agentsSnapshotRevision'],
    functions: ['agentJobIsLive', 'agentVerbAvailability', 'agentsEntryKey', 'agentDisplayName', 'renderAgentDetail',
      'formatTokens', 'formatAgentAge', 'agentsEscapeAttr', 'runAgentVerb', 'refreshAgentsRoster'],
  }) };
}

for (const bridge of [false, true]) {
  test(`[530] two finished jobs sharing one live ${bridge ? 'bridge' : 'UUID'} have independent row keys`, async (t) => {
    const f = fixture(t, { bridge });
    const second = 'bbbbbbbb';
    fs.mkdirSync(path.join(f.jobs, second));
    fs.copyFileSync(path.join(f.jobs, JOB, 'state.json'), path.join(f.jobs, second, 'state.json'));
    const { roster } = await f.handlers.get('get-bg-agents')({});
    const r = renderer(t);
    assert.equal(roster.length, 2, 'both jobs retain their metadata');
    const keys = roster.map(r.agentsEntryKey);
    assert.equal(new Set(keys).size, roster.length, 'every roster row has a unique key');
    vm.runInContext(`agentsPendingVerbs.add('${keys[0]}'); agentsVerbErrors.set('${keys[0]}', 'first job error')`, r.context);
    const detail = r.window.document.createElement('div');
    detail.innerHTML = r.renderAgentDetail(roster[1]);
    assert.equal(detail.querySelector('[data-verb="resume"]').disabled, false, 'pending state stays on the first job');
    assert.equal(detail.querySelector('.agents-detail-error'), null, 'errors stay on the first job');
  });
}

test('[530] real missing transcript disables the button, appearance enables it, disappearance disables it', async (t) => {
  const f = fixture(t, { live: false });
  const r = renderer(t);
  for (const present of [false, true, false]) {
    if (present) fs.writeFileSync(f.transcript, '');
    else if (fs.existsSync(f.transcript)) fs.unlinkSync(f.transcript);
    const { roster } = await f.handlers.get('get-bg-agents')({});
    assert.equal(roster[0].transcriptAvailable, present, 'availability follows the file without reading its contents');
    const detail = r.window.document.createElement('div');
    detail.innerHTML = r.renderAgentDetail(roster[0]);
    const button = detail.querySelector('[data-verb="transcript"]');
    assert.equal(button.disabled, !present);
    assert.equal(button.title, present ? '' : 'Transcript does not exist or is not available yet');
  }
});

test('[530] bridge merged row explains and opens the live transcript rather than the old job file', async (t) => {
  let livePath;
  const f = fixture(t, { bridge: true, resolveTranscriptPath: id => path.join(livePath, id.toLowerCase() + '.jsonl') });
  livePath = f.dir;
  fs.writeFileSync(f.transcript, 'old pre-compaction transcript');
  let snapshot = await f.handlers.get('get-bg-agents')({});
  assert.equal(snapshot.roster[0].transcriptAvailable, false, 'the old job file cannot enable the live transcript');
  fs.writeFileSync(path.join(f.dir, OTHER_SID + '.jsonl'), 'live transcript');
  snapshot = await bgAgents.reconcile();
  const entry = snapshot.roster[0];
  assert.equal(entry.transcriptAvailable, true);
  const r = renderer(t);
  const detail = r.window.document.createElement('div');
  detail.innerHTML = r.renderAgentDetail(entry);
  assert.match(detail.textContent, /Transcript opens the live session, not the job's pre-compaction file\./);
  const opened = [];
  r.window.api = { bgAgentVerb: (verb, id) => f.handlers.get('bg-agent-verb')({}, verb, id) };
  r.window.showJsonlViewer = session => opened.push(session.sessionId.toLowerCase());
  await r.runAgentVerb('transcript', entry);
  assert.deepEqual(opened, [OTHER_SID]);
  detail.innerHTML = r.renderAgentDetail({ id: JOB, sessionId: SID, kind: 'background', state: 'stopped' });
  assert.doesNotMatch(detail.textContent, /Transcript opens the live session/);
});

test('[530] bridge merged row cannot stat the old job transcript as its live transcript', async (t) => {
  const f = fixture(t, { bridge: true });
  fs.writeFileSync(f.transcript, 'old transcript');
  const { roster } = await f.handlers.get('get-bg-agents')({});
  assert.equal(roster[0].transcriptAvailable, false);
  assert.equal((await f.handlers.get('bg-agent-verb')({}, 'transcript', JOB)).ok, false);
});

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

for (const listed of [true, false]) {
  test(`[522r2] real bridge lineage merges different UUIDs (${listed ? 'CLI' : 'files'})`, { timeout: 9000 }, (t) => {
    const f = fixture(t, { bridge: true });
    const job = parseJobState(fs.readFileSync(path.join(f.jobs, JOB, 'state.json'), 'utf8'));
    const roster = mergeRoster({ cli: listed ? [{ id: JOB, sessionId: SID, kind: 'background', state: 'stopped' }] : null,
      jobs: new Map([[JOB, job]]), descriptors: cliSessionState.readAllDescriptors() });
    assert.equal(roster.length, 1, 'bridge lineage must deduplicate the conversation');
    assert.equal(roster[0].sessionId.toLowerCase(), OTHER_SID, 'transcript uses the live conversation UUID');
    assert.equal(roster[0].kind, 'interactive');
    assert.equal(roster[0].conversationPid, PID);
    assert.equal(roster[0].jobState, 'stopped');
  });
}

for (const bridge of [false, true]) {
test(`[522r2] own live descriptor keeps the job row and explains Switchboard ownership (${bridge ? 'bridge' : 'UUID'})`, { timeout: 9000 }, async (t) => {
  const f = fixture(t, { bridge, ownDescriptor: true });
  const { roster } = await f.handlers.get('get-bg-agents')({});
  assert.equal(roster.length, 1);
  assert.equal(roster[0].kind, 'background');
  assert.equal(roster[0].state, 'stopped');
  assert.equal(roster[0].conversationPid, PID);
  const r = renderer(t);
  const detail = r.window.document.createElement('div');
  detail.innerHTML = r.renderAgentDetail(roster[0]);
  assert.equal(detail.querySelector('[data-verb="rm"]').disabled, true);
  assert.match(detail.querySelector('[data-verb="rm"]').title, /open in this window.*Stop it from its sidebar row first/i);
});
}

test('[522r2] includeOwnProcesses explicitly overrides ordinary own filtering for bridge lineage', { timeout: 9000 }, async (t) => {
  const f = fixture(t, { bridge: true, ownDescriptor: true });
  cliSessionState.init({ dir: path.join(f.dir, 'sessions'), activeSessions: new Map(), onIdle() {}, isProcessAlive: () => true, readProcStartMany: async () => new Map(), platform: 'linux', readParentPid: () => null });
  const pids = () => [PID];
  assert.equal((await cliSessionState.liveElsewhereChecked(BRIDGE, () => false, pids)).live, null);
  const checked = await cliSessionState.liveElsewhereChecked(BRIDGE, () => false, pids, { includeOwnProcesses: true });
  assert.ok(checked.live, 'the destructive-verb check includes the own live bridge holder');
  assert.equal(checked.live.pid, PID);
});

test('[522r2] a different opaque bridge suffix does not match', { timeout: 9000 }, async (t) => {
  const f = fixture(t, { bridge: true });
  fs.writeFileSync(f.descriptor, JSON.stringify({ pid: PID, sessionId: OTHER_SID, bridgeSessionId: DESCRIPTOR_BRIDGE + 'x', kind: 'interactive' }));
  assert.equal((await cliSessionState.liveElsewhereChecked(BRIDGE, () => false)).live, null);
});

test('[522r2] bridge suffix case remains significant in roster and checked IPC', { timeout: 9000 }, async (t) => {
  const f = fixture(t, { bridge: true });
  fs.writeFileSync(f.descriptor, JSON.stringify({ pid: PID, sessionId: OTHER_SID, bridgeSessionId: DESCRIPTOR_BRIDGE.toLowerCase(), kind: 'interactive' }));
  const { roster } = await f.handlers.get('get-bg-agents')({});
  assert.equal(roster.length, 2);
  assert.equal((await cliSessionState.liveElsewhereChecked(BRIDGE, () => false)).live, null);
});

test('[522r2] promoted external row uses the interactive holders ownership and pid', { timeout: 9000 }, (t) => {
  const f = fixture(t, { ownDescriptor: true });
  fs.writeFileSync(f.descriptor, JSON.stringify({ pid: PID, sessionId: SID, kind: 'bg', jobId: JOB }));
  fs.writeFileSync(path.join(f.dir, 'sessions', (PID + 1) + '.json'), JSON.stringify({ pid: PID + 1, sessionId: SID, kind: 'interactive' }));
  const job = parseJobState(fs.readFileSync(path.join(f.jobs, JOB, 'state.json'), 'utf8'));
  const [entry] = mergeRoster({ cli: null, jobs: new Map([[JOB, job]]), descriptors: cliSessionState.readAllDescriptors(), isOwnPid: pid => pid === PID });
  assert.equal(entry.kind, 'interactive');
  assert.equal(entry.conversationPid, PID + 1);
  const r = renderer(t);
  const detail = r.window.document.createElement('div');
  detail.innerHTML = r.renderAgentDetail(entry);
  assert.doesNotMatch(detail.querySelector('[data-verb="rm"]').title, /open in Switchboard/i);
  assert.match(detail.querySelector('[data-verb="rm"]').title, new RegExp(String(PID + 1)));
});

for (const fresh of ['missing', 'queued', 'no-conversation']) {
  test(`[522r2] IPC Stop reaches the daemon despite fresh ${fresh} state`, { timeout: 9000 }, async (t) => {
    const f = fixture(t, { state: 'working' });
    await f.handlers.get('get-bg-agents')({});
    const file = path.join(f.jobs, JOB, 'state.json');
    if (fresh === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify({ state: fresh === 'queued' ? 'queued' : 'stopped' }));
    if (fresh === 'no-conversation') bgAgents.stop();
    f.calls.length = 0;
    assert.deepEqual(await f.handlers.get('bg-agent-verb')({}, 'stop', JOB), { ok: true });
    assert.deepEqual(f.calls[0], ['stop', JOB]);
  });
}

for (const ok of [false, true]) {
  test(`[522r2] attached Stop closes the tab only after ${ok ? 'success' : 'refusal'}`, { timeout: 9000 }, async (t) => {
    const r = renderer(t);
    const calls = [];
    r.window.api = {
      checkBgAgentVerb: async () => ({ ok: true }),
      bgAgentVerb: async () => { calls.push('main'); return { ok, error: 'refused' }; },
      stopSession: async () => { calls.push('close'); },
      getBgAgents: async () => ({ roster: [], daemonReachable: true }),
    };
    r.window.appConfirm = async () => true;
    r.window.applyAgentsSnapshot = () => {};
    await r.runAgentVerb('stop', { id: JOB, sessionId: SID, kind: 'background', attachedHere: true });
    assert.deepEqual(calls, ok ? ['main', 'close'] : ['main']);
  });
}

test('[522r2] merged interactive row displays job id and finished state', { timeout: 9000 }, (t) => {
  const r = renderer(t);
  const html = r.renderAgentDetail({ id: JOB, sessionId: SID, kind: 'interactive', jobState: 'stopped' });
  assert.match(html, new RegExp('job ' + JOB));
  assert.match(html, /stopped/);
});

test('[522r2] merged interactive row still contributes to Finished count', { timeout: 9000 }, (t) => {
  const r = renderer(t);
  const { window } = r;
  window.document.body.innerHTML = '<div id="agents-list"></div><div id="agents-detail"></div><span id="agents-viewer-count"></span>';
  window.agentIsLive = e => e.kind === 'interactive';
  window.sortAgentEntries = e => e;
  window.renderAgentList = () => '';
  window.agentsSelectedEntry = () => null;
  window.morphdom = (a, b) => a.replaceWith(b);
  const { renderAgentsView } = loadAppFunctions(r.context, {
    sourcePath: path.join(__dirname, '..', 'public', 'agents-view.js'),
    declarations: ['agentsRoster', 'agentsShowFinished', 'agentsGroupBy', 'agentsSelectedKey'], functions: ['renderAgentsView'],
  });
  vm.runInContext(`agentsRoster = [{ id: '${JOB}', sessionId: '${SID}', kind: 'interactive', jobState: 'stopped' }]`, r.context);
  renderAgentsView();
  assert.equal(window.document.getElementById('agents-viewer-count').textContent, '0 running · 1 finished');
});

for (const ok of [false, true]) {
  test(`[522r2] renderer Transcript awaits main and ${ok ? 'opens its returned UUID' : 'shows its refusal'}`, { timeout: 9000 }, async (t) => {
    const r = renderer(t);
    const calls = [];
    r.window.api = {
      bgAgentVerb: async (verb, id) => { calls.push([verb, id]); return { ok, sessionId: OTHER_SID, error: 'Transcript is not indexed yet' }; },
    };
    r.window.showJsonlViewer = e => calls.push(e.sessionId);
    await r.runAgentVerb('transcript', { id: JOB, sessionId: SID, kind: 'background' });
    assert.deepEqual(calls, ok ? [['transcript', JOB], OTHER_SID] : [['transcript', JOB]]);
    if (!ok) assert.equal(vm.runInContext(`agentsVerbErrors.get('bg:${JOB}')`, r.context), 'Transcript is not indexed yet');
  });
}
