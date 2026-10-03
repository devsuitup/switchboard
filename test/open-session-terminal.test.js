// Tests for app.js's openSession — reopening a plain terminal must reach
// open-terminal as a plain terminal. See .ai/contexts/session-state.md
// ("Reopening a plain terminal").
//
// openSession is extracted from the real public/app.js (test/app-source.js)
// and runs in the jsdom window of dom-setup.js; the terminal, the IPC bridge
// and the other renderer files it calls into are stubbed.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

async function withHarness(setup, fn) {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    const calls = { openTerminal: [], destroyed: [], shown: [], created: [], resolveDefaults: 0, launchTerminal: [], written: [] };
    Object.assign(window, {
      restoringWorkingSet: false,
      sessionOpenedOutsideRestore: false,
      openSessions: new Map(),
      skippedWorkingSetEntries: new Set(),
      dormantWorkingSet: new Map(),
      destroySession: (id) => calls.destroyed.push(id),
      showSession: (id) => calls.shown.push(id),
      guardResume: async () => true,
      createTerminalEntry: (session) => {
        calls.created.push(session.sessionId);
        return { initialSize: { cols: 80, rows: 24 }, terminal: { write: (text) => calls.written.push(text) } };
      },
      resolveDefaultSessionOptions: async () => { calls.resolveDefaults++; return { permissionMode: 'plan' }; },
      launchTerminalSession: (project) => calls.launchTerminal.push(project),
      forgetSessionExit: () => {},
      syncPtySizeAfterOpen: () => {},
      setSessionMcpActive: () => {},
      setSessionSandboxed: () => {},
      schedulePersistWorkingSet: () => {},
      pollActiveSessions: () => {},
      api: {
        openTerminal: async (sessionId, projectPath, isNew, sessionOptions, initialSize) => {
          calls.openTerminal.push({ sessionId, projectPath, isNew, sessionOptions, initialSize });
          return { ok: true };
        },
      },
    });
    setup(window, calls);
    const { openSession } = loadAppFunctions(ctx.context, {
      declarations: ['ptyGenerations', 'pendingOpens'],
      functions: ['beginPtyOpen', 'settlePtyOpen', 'openSession'],
    });
    await fn({ openSession, window, calls });
  } finally {
    ctx.destroy();
  }
}

const noSetup = () => {};
const plain = (value) => JSON.parse(JSON.stringify(value));
const TERMINAL_SESSION = { sessionId: 'term-uuid', projectPath: '/proj', type: 'terminal' };
const CLAUDE_SESSION = { sessionId: 'claude-uuid', projectPath: '/proj' };

// --- The intent that was being dropped -------------------------------------

test('a terminal session that is not open reaches open-terminal as a plain terminal (mutation target: the dropped type)', async () => {
  await withHarness(noSetup, async ({ openSession, calls }) => {
    await openSession(TERMINAL_SESSION);

    assert.equal(calls.openTerminal.length, 1);
    assert.deepEqual(plain(calls.openTerminal[0].sessionOptions), { type: 'terminal' },
      'main.js reads sessionOptions.type === "terminal"; without it a shell id is handed to claude --resume');
    assert.equal(calls.resolveDefaults, 0,
      'a shell has no permission mode, worktree or MCP emulation to resolve');
  });
});

test('a Claude session still resumes with the project\'s current defaults, and carries no terminal type', async () => {
  await withHarness(noSetup, async ({ openSession, calls }) => {
    await openSession(CLAUDE_SESSION);

    assert.equal(calls.resolveDefaults, 1);
    assert.deepEqual(plain(calls.openTerminal[0].sessionOptions), { permissionMode: 'plan' });
    assert.equal(calls.openTerminal[0].sessionOptions.type, undefined);
  });
});

test('an explicit customOptions still wins — the resume-with-config dialog is not overridden', async () => {
  await withHarness(noSetup, async ({ openSession, calls }) => {
    const chosen = { permissionMode: 'acceptEdits', chrome: true };
    await openSession(CLAUDE_SESSION, chosen);

    assert.equal(calls.openTerminal[0].sessionOptions, chosen);
    assert.equal(calls.resolveDefaults, 0);
  });
});

test('customOptions wins over the terminal default too, so the precedence has one rule, not two', async () => {
  await withHarness(noSetup, async ({ openSession, calls }) => {
    const chosen = { type: 'terminal', panelFor: 'owner' };
    await openSession(TERMINAL_SESSION, chosen);

    assert.equal(calls.openTerminal[0].sessionOptions, chosen);
  });
});

// --- The orphaned row ------------------------------------------------------

test('a terminal whose shell exited reopens under its own id instead of minting a second row', async () => {
  const setup = (window) => window.openSessions.set('term-uuid', { closed: true });
  await withHarness(setup, async ({ openSession, calls }) => {
    await openSession(TERMINAL_SESSION);

    assert.deepEqual(calls.destroyed, ['term-uuid'], 'the dead entry is torn down first');
    assert.deepEqual(calls.launchTerminal, [],
      'minting a new id leaves the clicked row pointing at an id nothing can open');
    assert.equal(calls.openTerminal.length, 1);
    assert.equal(calls.openTerminal[0].sessionId, 'term-uuid', 'the row you clicked is the row that comes back');
    assert.deepEqual(plain(calls.openTerminal[0].sessionOptions), { type: 'terminal' });
  });
});

test('an exited Claude session still reopens in place, the way it always did', async () => {
  const setup = (window) => window.openSessions.set('claude-uuid', { closed: true });
  await withHarness(setup, async ({ openSession, calls }) => {
    await openSession(CLAUDE_SESSION);

    assert.deepEqual(calls.destroyed, ['claude-uuid']);
    assert.equal(calls.openTerminal[0].sessionId, 'claude-uuid');
  });
});

test('a live entry is only shown — no second PTY for a terminal that is already running', async () => {
  const setup = (window) => window.openSessions.set('term-uuid', { closed: false });
  await withHarness(setup, async ({ openSession, calls }) => {
    await openSession(TERMINAL_SESSION);

    assert.deepEqual(calls.shown, ['term-uuid']);
    assert.equal(calls.openTerminal.length, 0);
    assert.equal(calls.created.length, 0);
  });
});

test('a failed open-terminal marks the entry closed and writes the error into its terminal', async () => {
  const setup = (window) => {
    window.api.openTerminal = async () => ({ ok: false, error: 'spawn failed' });
  };
  await withHarness(setup, async ({ openSession, calls }) => {
    await openSession(CLAUDE_SESSION);

    assert.match(calls.written.join(''), /Error: spawn failed/);
    assert.deepEqual(calls.shown, ['claude-uuid'], 'the failed entry is still shown so the error is visible');
  });
});

test('public/dialogs.js: resolveDefaultSessionOptions still returns Claude launch options only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'dialogs.js'), 'utf8');
  const start = src.indexOf('async function resolveDefaultSessionOptions(project)');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.doesNotMatch(body, /type:\s*'terminal'/,
    'the terminal intent belongs to the caller that knows the session type, not to the Claude defaults');
});
