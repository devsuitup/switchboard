'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bgAgents = require('../bg-agents');
const cliSessionState = require('../cli-session-state');
const bgIpc = require('../bg-agents-ipc');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const JOB = 'abcdef01';
const PID = 987654;

function fixture(t, state, descriptors) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-764-'));
  const jobs = path.join(dir, 'jobs');
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(jobs, JOB), { recursive: true });
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(jobs, JOB, 'state.json'), JSON.stringify({ state, sessionId: SID }));
  for (const [index, descriptor] of descriptors.entries()) {
    const pid = PID + index;
    fs.writeFileSync(path.join(sessions, pid + '.json'), JSON.stringify({
      pid, sessionId: SID.toUpperCase(), status: 'idle', statusUpdatedAt: 1, cwd: dir, ...descriptor,
    }));
  }
  cliSessionState.init({ dir: sessions, activeSessions: new Map(), onIdle() {},
    isProcessAlive: pid => descriptors[pid - PID]?.alive !== false,
    readProcStartMany: async () => new Map(), platform: 'win32' });
  const calls = [];
  bgAgents.init({ jobsDir: jobs, homeDir: dir, cliSessionState,
    makeIsOwnPid: () => () => true, resolveProjectRoots: async () => null,
    runClaude: async args => {
      calls.push(args);
      return { code: 0, stderr: '', stdout: args[0] === 'agents'
        ? JSON.stringify([{ id: JOB, sessionId: SID, kind: 'background', state, cwd: dir }]) : '' };
    } });
  const handlers = new Map();
  bgIpc.init({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, bgAgents, cliSessionState,
    activeSessions: new Map(), sessionHasPty: () => false, ptyPids: () => [PID],
    getMainWindow: () => null, log: { warn() {} } });
  t.after(() => {
    bgAgents.stop();
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  bgAgents.start();
  return { calls, handlers };
}

function sidebar(t, snapshot) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('agents-view.js');
  const project = makeSampleProject();
  project.sessions[0].sessionId = SID;
  ctx.read('applyAgentsSnapshot')(snapshot);
  ctx.sidebar.renderProjects([project], false);
  return { ctx, row: ctx.document.querySelector(`[data-session-id="${SID}"]`) };
}

for (const state of ['working', 'blocked']) {
  test(`[764] stale ${state} job with a live interactive descriptor is not hosted`, async t => {
    fixture(t, state, [{ kind: 'interactive' }]);
    const snapshot = await bgAgents.reconcile();
    assert.equal(snapshot.roster.find(e => e.id === JOB).hosted, false,
      'a live interactive conversation must override stale job state');
    assert.equal((await bgAgents.conversationCheck(JOB)).hosted, false);
    assert.deepEqual(bgAgents.liveJobCheck(SID), { known: true, job: null });
    const { ctx, row } = sidebar(t, snapshot);
    assert.ok(row);
    assert.equal(row.querySelector('.bg-badge'), null, 'interactive sidebar row has no bg badge');
    assert.equal(ctx.read('bgAgentSessionIds').has(SID), false);
    const entry = snapshot.roster.find(e => e.id === JOB);
    assert.equal(ctx.read('agentJobIsLive')(entry), false, 'Agents must not count the job as running');
    const verbs = ctx.read('agentVerbAvailability')(entry, true);
    assert.equal(verbs.attach, false);
    assert.equal(verbs.stop, false);
    assert.equal(verbs.rm, false, 'the live conversation still protects Delete');
  });

  test(`[764] stale ${state} snapshot removes an existing sidebar bg badge`, async t => {
    fixture(t, state, [{ kind: 'interactive' }]);
    const { ctx, row } = sidebar(t, { daemonReachable: true, roster: [
      { id: JOB, sessionId: SID, kind: 'background', state, hosted: true },
    ] });
    assert.ok(row.querySelector('.bg-badge'));
    ctx.read('applyAgentsSnapshot')(await bgAgents.reconcile());
    ctx.sidebar.renderProjects([makeProject()], false);
    assert.equal(ctx.document.querySelector(`[data-session-id="${SID}"] .bg-badge`), null,
      'a refreshed interactive session must lose its stale bg badge');
  });

  for (const jobId of [JOB.toUpperCase(), undefined]) {
    test(`[764] ${state} job retains hosting with matching bg descriptor ${jobId || 'by session'}`, async t => {
      fixture(t, state, [{ kind: 'interactive' }, { kind: 'bg', jobId }]);
      const snapshot = await bgAgents.reconcile();
      assert.equal(snapshot.roster.find(e => e.id === JOB).hosted, true);
      const { row } = sidebar(t, snapshot);
      assert.ok(row.querySelector('.bg-badge'), 'real bg evidence keeps the badge');
      assert.equal((await bgAgents.conversationCheck(JOB)).hosted, true);
    });
  }

  for (const descriptors of [[], [{ kind: 'interactive', alive: false }],
    [{ kind: 'interactive', sessionId: 'bbbbbbbb-1234-4321-abcd-123456789abc' }]]) {
    test(`[764] ${state} job remains hosted without a live matching interactive descriptor ${JSON.stringify(descriptors)}`, async t => {
      fixture(t, state, descriptors);
      const snapshot = await bgAgents.reconcile();
      assert.equal(snapshot.roster.find(e => e.id === JOB).hosted, true,
        'working/blocked file-only evidence must remain hosted');
      assert.ok(sidebar(t, snapshot).row.querySelector('.bg-badge'));
    });
  }

  test(`[764] ${state} job cannot borrow another job's bg descriptor`, async t => {
    fixture(t, state, [{ kind: 'interactive' }, { kind: 'bg', jobId: 'bbbbbbbb' }]);
    const snapshot = await bgAgents.reconcile();
    assert.equal(snapshot.roster.find(e => e.id === JOB).hosted, false);
    assert.equal((await bgAgents.conversationCheck(JOB)).hosted, false);
  });

  test(`[764] stale ${state} Delete and Stop refuse the live interactive pid, not stale hosting`, async t => {
    const f = fixture(t, state, [{ kind: 'interactive' }]);
    for (const verb of ['rm', 'respawn', 'stop']) {
      for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
        const result = await f.handlers.get(channel)({}, verb, JOB);
        assert.equal(result.ok, false);
        assert.match(result.error, new RegExp(String(PID)), 'refusal must identify the live interactive process');
        assert.doesNotMatch(result.error, /stop it first/);
      }
    }
    assert.deepEqual(f.calls, [], 'no daemon command may touch the interactive conversation');
    assert.deepEqual(await bgAgents.runVerb('rm', JOB), { ok: true },
      'the low-level daemon wrapper must not refuse solely on the stale state; IPC owns process safety');
    assert.deepEqual(f.calls[0], ['rm', JOB]);
  });
}

function makeProject() {
  const project = makeSampleProject();
  project.sessions[0].sessionId = SID;
  return project;
}
