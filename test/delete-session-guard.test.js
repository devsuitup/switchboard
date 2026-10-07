// test/delete-session-guard.test.js — delete-session refuses a live session, and refuses when it cannot tell.
// Runs the real bg-agents and cli-session-state against temp dirs. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deleteSessionRefusal } = require('../delete-session-guard');
const bgAgents = require('../bg-agents');
const cliSessionState = require('../cli-session-state');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const UPPER = SID.toUpperCase();

function setup({ jobsDir, descriptorsDir }) {
  bgAgents.init({
    jobsDir, log: silentLog, runClaude: async () => ({ code: 1, stdout: '', stderr: '' }),
    cliSessionState, homeDir: os.tmpdir(), resolveProjectRoots: async () => null,
  });
  cliSessionState.init({
    dir: descriptorsDir, activeSessions: new Map(), log: silentLog, onIdle: () => {},
    isProcessAlive: () => true, readProcStart: () => '111', readParentPid: () => 1, ownPid: 99999, platform: 'linux',
  });
}

function refusal(id, activeSessions = new Map()) {
  return deleteSessionRefusal(id, {
    activeSessions,
    liveJobCheck: (sid) => bgAgents.liveJobCheck(sid),
    liveElsewhereChecked: (sid) => cliSessionState.liveElsewhereChecked(sid, () => false, () => []),
  });
}

function writeJob(jobsDir, id, state) {
  fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, id, 'state.json'), JSON.stringify({
    state, linkScanPath: `/home/u/.claude/projects/-w/${SID}.jsonl`,
  }));
}

function writeDescriptor(descriptorsDir, pid, sessionId) {
  fs.mkdirSync(descriptorsDir, { recursive: true });
  fs.writeFileSync(path.join(descriptorsDir, `${pid}.json`), JSON.stringify({ pid, sessionId, procStart: '111', status: 'idle' }));
}

let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-del-guard-')); });
test.afterEach(() => {
  bgAgents.stop();
  cliSessionState.stop();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

test('nothing live and neither directory present: the delete may go ahead', async () => {
  setup({ jobsDir: path.join(root, 'jobs'), descriptorsDir: path.join(root, 'sessions') });
  assert.equal(await refusal(SID), null);
});

test('a job that is done does not hold the session', async () => {
  const jobsDir = path.join(root, 'jobs');
  writeJob(jobsDir, 'aaaaaaaa', 'done');
  setup({ jobsDir, descriptorsDir: path.join(root, 'sessions') });
  assert.equal(await refusal(SID), null);
});

test('no roster loaded and an unreadable jobs directory: refused, with the reason', async () => {
  const jobsDir = path.join(root, 'jobs');
  fs.writeFileSync(jobsDir, 'not a directory');
  setup({ jobsDir, descriptorsDir: path.join(root, 'sessions') });
  assert.match(await refusal(SID), /cannot tell whether a background job[\s\S]*not deleted/);
});

test('an unreadable descriptor directory: refused, with the reason', async () => {
  const descriptorsDir = path.join(root, 'sessions');
  fs.writeFileSync(descriptorsDir, 'not a directory');
  setup({ jobsDir: path.join(root, 'jobs'), descriptorsDir });
  assert.match(await refusal(SID), /cannot tell whether this session is still running elsewhere/);
});

test('a live job, with no roster loaded, refuses the delete whatever the case of the id', async () => {
  for (const state of ['working', 'blocked']) {
    const jobsDir = path.join(root, `jobs-${state}`);
    writeJob(jobsDir, 'aaaaaaaa', state);
    setup({ jobsDir, descriptorsDir: path.join(root, 'sessions') });
    assert.match(await refusal(SID), /background job aaaaaaaa is still running/);
    assert.match(await refusal(UPPER), /background job aaaaaaaa is still running/);
  }
});

test('a live job whose state names no session cannot be ruled out: refused', async () => {
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(path.join(jobsDir, 'aaaaaaaa'), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'aaaaaaaa', 'state.json'), JSON.stringify({ state: 'working' }));
  setup({ jobsDir, descriptorsDir: path.join(root, 'sessions') });
  assert.match(await refusal(SID), /does not name its session/);
});

test('a session live in another process refuses the delete whatever the case of the id', async () => {
  const descriptorsDir = path.join(root, 'sessions');
  writeDescriptor(descriptorsDir, 4242, SID);
  setup({ jobsDir: path.join(root, 'jobs'), descriptorsDir });
  assert.match(await refusal(UPPER), /still running outside this window/);
  fs.rmSync(path.join(descriptorsDir, '4242.json'));
  writeDescriptor(descriptorsDir, 4242, UPPER);
  assert.match(await refusal(SID), /still running outside this window/);
});

test('an open terminal holds the session under any case, by its id or its real id', async () => {
  setup({ jobsDir: path.join(root, 'jobs'), descriptorsDir: path.join(root, 'sessions') });
  assert.match(await refusal(UPPER, new Map([[SID, { exited: false }]])), /close it first/);
  assert.match(await refusal(UPPER, new Map([['tmp-1', { exited: false, realSessionId: SID }]])), /close it first/);
  assert.equal(await refusal(UPPER, new Map([[SID, { exited: true }]])), null);
});
