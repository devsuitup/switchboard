// Tests for app.js's openSession — reopening a plain terminal must reach
// open-terminal as a plain terminal. See .ai/contexts/session-state.md
// ("Reopening a plain terminal").
//
// app.js cannot be eval-ed in jsdom (module-scope `new ViewerPanel(...)` etc.
// — see test/running-indicators.test.js's file header for the full reason).
// `makeOpenSession` below is therefore a HAND-MAINTAINED MIRROR of the real
// function, not the shipped code — it pins the *decision* logic in isolation.
// The source-level pins at the bottom catch the regressions that matter in the
// shipped file without needing a full eval — the same two-layer technique as
// test/confirm-and-stop-session.test.js.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Mirrors public/app.js's openSession(session, customOptions), with every
// external dependency injected instead of read off globals.
function makeOpenSession(deps) {
  return async function openSession(session, customOptions) {
    const { sessionId, projectPath } = session;

    if (deps.openSessions.has(sessionId)) {
      const entry = deps.openSessions.get(sessionId);
      if (entry.closed) {
        deps.destroySession(sessionId);
      } else {
        deps.showSession(sessionId);
        return;
      }
    }

    const entry = deps.createTerminalEntry(session);
    const resumeOptions = customOptions
      || (session.type === 'terminal' ? { type: 'terminal' } : await deps.resolveDefaultSessionOptions({ projectPath }));
    const result = await deps.api.openTerminal(sessionId, projectPath, false, resumeOptions, entry.initialSize);
    if (!result.ok) {
      deps.markFailed(sessionId, result.error);
      return;
    }
    deps.showSession(sessionId);
  };
}

function makeDeps(overrides = {}) {
  const calls = { openTerminal: [], destroyed: [], shown: [], created: [], resolveDefaults: 0, launchTerminal: [] };
  const deps = {
    calls,
    openSessions: new Map(),
    destroySession: (id) => calls.destroyed.push(id),
    showSession: (id) => calls.shown.push(id),
    createTerminalEntry: (session) => { calls.created.push(session.sessionId); return { initialSize: { cols: 80, rows: 24 } }; },
    resolveDefaultSessionOptions: async () => { calls.resolveDefaults++; return { permissionMode: 'plan' }; },
    // The mint-a-new-session path openSession must no longer take.
    launchTerminalSession: (project) => calls.launchTerminal.push(project),
    markFailed: () => {},
    api: {
      openTerminal: async (sessionId, projectPath, isNew, sessionOptions, initialSize) => {
        calls.openTerminal.push({ sessionId, projectPath, isNew, sessionOptions, initialSize });
        return { ok: true };
      },
    },
    ...overrides,
  };
  return deps;
}

const TERMINAL_SESSION = { sessionId: 'term-uuid', projectPath: '/proj', type: 'terminal' };
const CLAUDE_SESSION = { sessionId: 'claude-uuid', projectPath: '/proj' };

// --- The intent that was being dropped -------------------------------------

test('a terminal session that is not open reaches open-terminal as a plain terminal (mutation target: the dropped type)', async () => {
  const deps = makeDeps();
  await makeOpenSession(deps)(TERMINAL_SESSION);

  assert.equal(deps.calls.openTerminal.length, 1);
  assert.deepEqual(deps.calls.openTerminal[0].sessionOptions, { type: 'terminal' },
    'main.js reads sessionOptions.type === "terminal"; without it a shell id is handed to claude --resume');
  assert.equal(deps.calls.resolveDefaults, 0,
    'a shell has no permission mode, worktree or MCP emulation to resolve');
});

test('a Claude session still resumes with the project\'s current defaults, and carries no terminal type', async () => {
  const deps = makeDeps();
  await makeOpenSession(deps)(CLAUDE_SESSION);

  assert.equal(deps.calls.resolveDefaults, 1);
  assert.deepEqual(deps.calls.openTerminal[0].sessionOptions, { permissionMode: 'plan' });
  assert.equal(deps.calls.openTerminal[0].sessionOptions.type, undefined);
});

test('an explicit customOptions still wins — the resume-with-config dialog is not overridden', async () => {
  const deps = makeDeps();
  const chosen = { permissionMode: 'acceptEdits', chrome: true };
  await makeOpenSession(deps)(CLAUDE_SESSION, chosen);

  assert.equal(deps.calls.openTerminal[0].sessionOptions, chosen);
  assert.equal(deps.calls.resolveDefaults, 0);
});

test('customOptions wins over the terminal default too, so the precedence has one rule, not two', async () => {
  const deps = makeDeps();
  const chosen = { type: 'terminal', panelFor: 'owner' };
  await makeOpenSession(deps)(TERMINAL_SESSION, chosen);

  assert.equal(deps.calls.openTerminal[0].sessionOptions, chosen);
});

// --- The orphaned row ------------------------------------------------------

test('a terminal whose shell exited reopens under its own id instead of minting a second row', async () => {
  const deps = makeDeps();
  deps.openSessions.set('term-uuid', { closed: true });
  await makeOpenSession(deps)(TERMINAL_SESSION);

  assert.deepEqual(deps.calls.destroyed, ['term-uuid'], 'the dead entry is torn down first');
  assert.deepEqual(deps.calls.launchTerminal, [],
    'minting a new id leaves the clicked row pointing at an id nothing can open');
  assert.equal(deps.calls.openTerminal.length, 1);
  assert.equal(deps.calls.openTerminal[0].sessionId, 'term-uuid', 'the row you clicked is the row that comes back');
  assert.deepEqual(deps.calls.openTerminal[0].sessionOptions, { type: 'terminal' });
});

test('an exited Claude session still reopens in place, the way it always did', async () => {
  const deps = makeDeps();
  deps.openSessions.set('claude-uuid', { closed: true });
  await makeOpenSession(deps)(CLAUDE_SESSION);

  assert.deepEqual(deps.calls.destroyed, ['claude-uuid']);
  assert.equal(deps.calls.openTerminal[0].sessionId, 'claude-uuid');
});

test('a live entry is only shown — no second PTY for a terminal that is already running', async () => {
  const deps = makeDeps();
  deps.openSessions.set('term-uuid', { closed: false });
  await makeOpenSession(deps)(TERMINAL_SESSION);

  assert.deepEqual(deps.calls.shown, ['term-uuid']);
  assert.equal(deps.calls.openTerminal.length, 0);
  assert.equal(deps.calls.created.length, 0);
});

// ---------------------------------------------------------------------------
// Source-level pins for the REAL public/app.js.
// ---------------------------------------------------------------------------

function openSessionBody() {
  const start = APP_SRC.indexOf('async function openSession(session, customOptions)');
  assert.notEqual(start, -1, 'openSession must still exist with the (session, customOptions) signature');
  const end = APP_SRC.indexOf('\n}', APP_SRC.indexOf('pollActiveSessions();', start));
  assert.ok(end > start);
  return APP_SRC.slice(start, end);
}

test('public/app.js: openSession passes { type: \'terminal\' } for a terminal session (mutation target: reverting to the bare defaults call)', () => {
  const body = openSessionBody();
  assert.match(body, /session\.type === 'terminal'\s*\?\s*\{\s*type:\s*'terminal'\s*\}/,
    'a terminal session must supply its own type rather than the Claude launch defaults');
});

test('public/app.js: customOptions is still the first term of the resumeOptions chain', () => {
  const body = openSessionBody();
  const chain = body.slice(body.indexOf('const resumeOptions'));
  const custom = chain.indexOf('customOptions');
  const terminal = chain.indexOf("session.type === 'terminal'");
  assert.notEqual(custom, -1);
  assert.ok(custom < terminal, 'an explicit choice from the resume dialog must keep winning');
});

test('public/app.js: openSession no longer mints a new session for an exited terminal', () => {
  const body = openSessionBody();
  assert.doesNotMatch(body, /launchTerminalSession\(/,
    'minting a second id leaves the original sidebar row pointing at an id nothing can open');
  assert.match(body, /window\.api\.openTerminal\(sessionId,/,
    'the reopen must target the session id that was clicked');
});

test('public/dialogs.js: resolveDefaultSessionOptions still returns Claude launch options only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'dialogs.js'), 'utf8');
  const start = src.indexOf('async function resolveDefaultSessionOptions(project)');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.doesNotMatch(body, /type:\s*'terminal'/,
    'the terminal intent belongs to the caller that knows the session type, not to the Claude defaults');
});
