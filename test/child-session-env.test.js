'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { extractFunction } = require('./app-source');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const parentMarkers = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_JOB_DIR', 'CLAUDE_PID',
  'AI_AGENT', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_ENV_FILE', 'CLAUDE_PROJECT_DIR',
  'TRACEPARENT', 'TRACESTATE',
];

test('GIVEN main-process startup WHEN children can start THEN session scrubbing precedes the reloader and cleanPtyEnv', () => {
  const scrub = MAIN.indexOf('scrubSessionEnv(process.env)');
  const reloader = MAIN.indexOf("require('electron-reloader')");
  const cleanPtyEnv = MAIN.indexOf('const cleanPtyEnv =');
  assert.ok(scrub >= 0, 'startup must scrub process.env');
  assert.ok(reloader > scrub, 'startup must scrub before electron-reloader');
  assert.ok(cleanPtyEnv > reloader, 'electron-reloader must precede cleanPtyEnv');
  assert.doesNotMatch(MAIN.slice(0, scrub), /\b(?:spawn\w*|fork|exec\w*)\s*\(|\bnew\s+Worker\s*\(|\butilityProcess\b/);
});

function contaminate(t) {
  for (const key of [...parentMarkers, 'CLAUDE_CONFIG_DIR', 'ELECTRON_RUN_AS_NODE']) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = key === 'CLAUDE_CONFIG_DIR' ? 'user-config' : 'launching-session';
  }
}

function assertClean(env, intentional = {}) {
  for (const key of parentMarkers) {
    if (Object.hasOwn(intentional, key)) assert.equal(env[key], intentional[key]);
    else assert.equal(Object.hasOwn(env, key), false, `${key} leaked from the launching session`);
  }
  assert.equal(env.CLAUDE_CONFIG_DIR, 'user-config');
}

function bootstrap(context) {
  const start = MAIN.indexOf('const { cleanEnv');
  const end = MAIN.indexOf('\n', MAIN.indexOf('const cleanPtyEnv =', start));
  assert.ok(start > 0 && end > start);
  vm.runInContext(MAIN.slice(start, end), context, { filename: 'main.js' });
}

function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4242;
  return c;
}

function mainContext() {
  const calls = [];
  const handlers = new Map();
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const c = child();
    queueMicrotask(() => { c.emit('spawn'); c.emit('close', 0); });
    return c;
  };
  const context = vm.createContext({
    require: createRequire(path.join(ROOT, 'main.js')),
    process, path, os, fs,
    spawnChild: spawn, cpSpawn: spawn,
    spawnPty: spawn,
    setTimeout, clearTimeout,
    log: { info() {}, warn() {}, error() {} },
    isWindows: false, isWslShell: () => false,
    getSetting: () => ({}), SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false },
    resolveShell: () => ({ path: '/bin/bash' }),
    shellArgs: (_shell, command) => command ? ['-c', command] : ['-i'],
    quoteArgvForShell: (_shell, args) => args.join(' '),
    resolveScheduleSandbox: () => false, isProjectSettingsArchived: () => false,
    activityReporter: { sessionStarted() {} },
    cliSessionState: { trackScheduleRun() {}, ensureWatching: () => true },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    mainWindow: {}, activeSessions: new Map(),
    remoteIndexer: { findSessionAlias: () => null }, getCachedFolder: () => null,
    isRemoteFolder: () => false, resolveSessionRealCwd: () => null,
    PROJECTS_DIR: path.join(ROOT, '.work-files', 'no-transcripts-670'),
    normalizePtySize: require('../pty-size').normalizePtySize,
    encodeProjectPath: require('../encode-project-path').encodeProjectPath,
    resolvePanelTerminalCwd: () => ({ ok: true, cwd: ROOT }), resolveGitChangesTarget() {},
    sessionTransitions: { snapshotContinuationsBeforeSpawn: async () => null },
    plainTerminalLaunch: require('../plain-terminal-shell').plainTerminalLaunch,
    ensurePlainTerminalInitFiles: () => false, PLAIN_TERMINAL_INIT_DIR: null,
    startMcpServer: async () => ({ port: 6700 }),
    scheduleProjects: () => ({ add: async () => {} }),
    createComposerState: require('../composer-state').createComposerState,
    parseAddDirs: () => [], sessionTranscriptExists: () => true,
    revealIfSdkSession() {}, wireSessionPty() {}, notifyRendererProjectsChanged() {},
    getMcpState: () => null, JOB_ID_RE: /^[0-9a-f]{8}$/,
  });
  bootstrap(context);
  return { context, calls, handlers };
}

for (const [name, options, intentional] of [
  ['new Claude PTY with its own MCP link', {}, { CLAUDE_CODE_SSE_PORT: '6700' }],
  ['resumed Claude PTY', { mcpEmulation: false }, {}],
  ['forked Claude PTY', { forkFrom: 'source', mcpEmulation: false }, {}],
  ['plain terminal with the claude shim', { type: 'terminal' }, { CLAUDECODE: '1' }],
  ['panel shell', { type: 'terminal', panelFor: 'owner' }, { CLAUDECODE: '1' }],
  ['background attach PTY', { type: 'attach', jobId: '1234abcd' }, {}],
]) {
  test(`GIVEN a contaminated process.env WHEN opening ${name} THEN only its own identity reaches spawn`, async t => {
    contaminate(t);
    const h = mainContext();
    const start = MAIN.indexOf("ipcMain.handle('open-terminal'");
    const end = MAIN.indexOf('\n});', start) + 4;
    vm.runInContext(MAIN.slice(start, end), h.context);
    const result = await h.handlers.get('open-terminal')(null, 'new-id', ROOT, name.startsWith('new'), options);
    assert.equal(result.ok, true, result.error);
    assert.equal(h.calls.length, 1);
    assertClean(h.calls[0].options.env, intentional);
  });
}

for (const argv of [['--bg', '--', 'task'], ['respawn', '1234abcd'], ['agents', '--json', '--all']]) {
  test(`GIVEN a contaminated process.env WHEN running claude ${argv[0]} THEN its child env is independent`, async t => {
    contaminate(t);
    const h = mainContext();
    vm.runInContext(extractFunction(MAIN, 'runClaudeCommand'), h.context);
    const result = await h.context.runClaudeCommand(argv, { cwd: ROOT, timeout: 5000 });
    assert.equal(result.code, 0);
    assertClean(h.calls[0].options.env);
  });
}

test('GIVEN a contaminated process.env WHEN a schedule starts THEN its child env is independent', async t => {
  contaminate(t);
  const h = mainContext();
  const source = MAIN.replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
  vm.runInContext(extractFunction(source, 'runScheduleCommand'), h.context);
  await h.context.runScheduleCommand(['--resume', 'schedule-id', '-p', 'task'], ROOT, 'schedule', () => {});
  assert.equal(h.calls.length, 1);
  assertClean(h.calls[0].options.env);
});

test('GIVEN a contaminated process.env WHEN startup finishes THEN implicit SSH and updater children inherit no session', t => {
  contaminate(t);
  mainContext();
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout);
  assertClean(env);
  assert.equal(env.ELECTRON_RUN_AS_NODE, 'launching-session');
});

test('GIVEN a contaminated process.env WHEN the PR launcher builds its real-user env THEN identity is removed', t => {
  contaminate(t);
  const { buildLaunch } = require('../scripts/test-pr');
  const launch = buildLaunch({ pr: 670, env: process.env, home: os.tmpdir() });
  assertClean(launch.env);
});

test('GIVEN a contaminated process.env WHEN postinstall spawns build tools THEN they inherit no session', t => {
  contaminate(t);
  const envs = [];
  const source = fs.readFileSync(path.join(ROOT, 'scripts/postinstall.js'), 'utf8');
  const localRequire = createRequire(path.join(ROOT, 'scripts/postinstall.js'));
  vm.runInNewContext(source, {
    require: name => name === 'child_process'
      ? { execSync: (_command, options) => envs.push({ ...(options.env || process.env) }) }
      : localRequire(name),
    process: { env: process.env, platform: 'win32' }, console,
  });
  assert.equal(envs.length, 1);
  assertClean(envs[0]);
});
