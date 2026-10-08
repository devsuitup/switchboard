// Tests for public/resume-guard.js — a session running in another process is
// never resumed automatically, and a resume the user asks for is confirmed
// first. See .ai/contexts/cli-session-state.md ("Live elsewhere").
//
// app.js cannot be eval-ed in jsdom (see test/running-indicators.test.js), so
// its wiring is pinned at source level at the bottom, the same two-layer
// technique as test/open-session-terminal.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GUARD_PATH = path.join(__dirname, '..', 'public', 'resume-guard.js');
const { guardResume } = require(GUARD_PATH);

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LIVE = { pid: 4242, cwd: '/work/proj', startedAt: 1790685077444 };
const SESSION = { sessionId: 'sess-1', projectPath: '/work/proj' };

function makeApi(answer) {
  const asked = [];
  return {
    asked,
    getSessionLiveElsewhere: async (id) => {
      asked.push(id);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function makeConfirm(result) {
  const messages = [];
  const confirm = (msg) => { messages.push(msg); return result; };
  return { confirm, messages };
}

// --- Automatic resume (reload path, working-set restore) -------------------

test('an automatic resume of a session live elsewhere is refused, without asking', async () => {
  const api = makeApi(LIVE);
  const { confirm, messages } = makeConfirm(true);
  assert.equal(await guardResume(SESSION, { automatic: true, api, confirm }), false);
  assert.deepEqual(api.asked, ['sess-1']);
  assert.equal(messages.length, 0, 'nobody asked for this resume, so there is nobody to ask');
});

test('an automatic resume of a session live nowhere else goes ahead', async () => {
  const api = makeApi(null);
  const { confirm, messages } = makeConfirm(false);
  assert.equal(await guardResume(SESSION, { automatic: true, api, confirm }), true);
  assert.equal(messages.length, 0);
});

// --- Resume the user asked for ---------------------------------------------

test('a user resume of a session live elsewhere asks, and a cancel stops it', async () => {
  const api = makeApi(LIVE);
  const { confirm, messages } = makeConfirm(false);
  assert.equal(await guardResume(SESSION, { api, confirm }), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /pid 4242/);
  assert.match(messages[0], /\/work\/proj/);
});

test('a user resume of a session live elsewhere goes ahead once confirmed', async () => {
  const api = makeApi(LIVE);
  const { confirm } = makeConfirm(true);
  assert.equal(await guardResume(SESSION, { api, confirm }), true);
});

test('a user resume of a session live nowhere else does not ask', async () => {
  const api = makeApi(null);
  const { confirm, messages } = makeConfirm(false);
  assert.equal(await guardResume(SESSION, { api, confirm }), true);
  assert.equal(messages.length, 0);
});

// --- Edges -----------------------------------------------------------------

test('a plain terminal is never checked: it has no claude session to duplicate', async () => {
  const api = makeApi(LIVE);
  const { confirm } = makeConfirm(false);
  assert.equal(await guardResume({ sessionId: 't', type: 'terminal' }, { automatic: true, api, confirm }), true);
  assert.equal(api.asked.length, 0);
});

test('a failed check is silence: the resume proceeds as it did before the guard', async () => {
  const api = makeApi(new Error('No handler registered'));
  const { confirm } = makeConfirm(false);
  assert.equal(await guardResume(SESSION, { automatic: true, api, confirm }), true);
});

test('loaded as a classic script, the guard is a global the renderer can call', async () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(GUARD_PATH, 'utf8'), ctx);
  assert.equal(typeof ctx.guardResume, 'function');
  const api = makeApi(LIVE);
  assert.equal(await ctx.guardResume(SESSION, { automatic: true, api, confirm: () => true }), false);
});

// --- Wiring in the shipped files -------------------------------------------

const APP_SRC = read('public/app.js');

function functionBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in app.js`);
  const next = src.indexOf('\nasync function ', start + signature.length);
  const nextSync = src.indexOf('\nfunction ', start + signature.length);
  const ends = [next, nextSync].filter(i => i !== -1);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('openSession runs the guard before it asks main for a PTY', () => {
  const body = functionBody(APP_SRC, 'async function openSession(');
  const guardAt = body.indexOf('guardResume(');
  const spawnAt = body.indexOf('window.api.openTerminal(');
  assert.notEqual(guardAt, -1, 'openSession must call guardResume');
  assert.ok(guardAt < spawnAt, 'the guard must run before open-terminal spawns claude --resume');
  assert.match(body, /guardResume\(session, \{ automatic,/);
});

test('the reload path resumes the remembered session as an automatic resume', () => {
  assert.match(APP_SRC,
    /if \(activeSessionId && !openSessions\.has\(activeSessionId\)\) \{\s*const session = sessionMap\.get\(activeSessionId\);\s*if \(session\) await openSession\(session, undefined, \{ automatic: true \}\);/);
});

test('the working-set restore resumes each session as an automatic resume', () => {
  const body = functionBody(APP_SRC, 'async function runRestore(');
  assert.match(body, /openSession\(s, undefined, \{ automatic: true, live \}\)/);
  assert.doesNotMatch(body, /openSession\(s\)/);
});

test('index.html loads the guard before app.js, preload exposes the check, main answers it', () => {
  const html = read('public/index.html');
  const guardAt = html.indexOf('<script src="resume-guard.js"></script>');
  assert.notEqual(guardAt, -1);
  assert.ok(guardAt < html.indexOf('<script src="app.js"></script>'));

  assert.match(read('preload.js'),
    /getSessionLiveElsewhere: \(id\) => ipcRenderer\.invoke\('session-live-elsewhere', id\)/);
  assert.match(read('main.js'),
    /ipcMain\.handle\('session-live-elsewhere', \(_event, sessionId\) => cliSessionState\.liveElsewhere\(sessionId, sessionHasPty, ptyPids\)\)/);
  assert.match(read('preload.js'),
    /getSessionsLiveElsewhere: \(ids\) => ipcRenderer\.invoke\('sessions-live-elsewhere', ids\)/);
  assert.match(read('main.js'),
    /ipcMain\.handle\('sessions-live-elsewhere', \(_event, sessionIds\) => cliSessionState\.liveElsewhereMany\(sessionIds, sessionHasPty, ptyPids\)\)/);
});

// --- Background sessions (see .ai/contexts/bg-agents.md) --------------------

const LIVE_BG = { pid: 346590, cwd: '/w/em', startedAt: 1, kind: 'bg', jobId: 'bc3fd129' };

test('a user click on a session the daemon runs answers "attach", without asking', async () => {
  const api = makeApi(LIVE_BG);
  const { confirm, messages } = makeConfirm(false);
  assert.deepEqual(await guardResume(SESSION, { api, confirm }), { attach: 'bc3fd129', cwd: '/w/em' });
  assert.equal(messages.length, 0);
});

test('an automatic resume of a session the daemon runs is still refused', async () => {
  const api = makeApi(LIVE_BG);
  const { confirm } = makeConfirm(true);
  assert.equal(await guardResume(SESSION, { automatic: true, api, confirm }), false);
});

test('a live bg descriptor without a usable jobId is refused: no resume offer, no attach', async () => {
  for (const jobId of [null, undefined, '']) {
    const api = makeApi({ ...LIVE_BG, jobId });
    const { confirm, messages } = makeConfirm(true);
    assert.equal(await guardResume(SESSION, { api, confirm }), false);
    assert.equal(messages.length, 0);
  }
});

test('app.js turns the attach verdict into attach options and skips the guard for an explicit attach', () => {
  const app = read('public/app.js');
  assert.match(app, /customOptions\?\.type === 'attach'\s*\?\s*true\s*:\s*await guardResume\(/);
  assert.match(app, /if \(verdict === false\) return false;/);
  assert.match(app, /customOptions = \{ type: 'attach', jobId: verdict\.attach, cwd: verdict\.cwd \|\| projectPath \};/);
  assert.match(app, /entry\.attach = resumeOptions\.type === 'attach';/);
  assert.match(app, /if \(entry\.attach\) continue; \/\/ attach tabs are not restored/);
});
