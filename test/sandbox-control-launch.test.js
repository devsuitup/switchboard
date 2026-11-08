'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const espree = require('espree');
const { EventEmitter } = require('node:events');
const watcher = require('../src/main/triggers/trigger-watcher');

const filename = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(filename, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });

function shippedLaunch(mode) {
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (mode === 'schedule'
      ? node.type === 'FunctionDeclaration' && node.id.name === 'runScheduleCommand'
      : node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
        && node.expression.callee.object?.name === 'ipcMain'
        && node.expression.arguments[0]?.value === 'open-terminal') return node;
    for (const value of Object.values(node)) {
      const found = Array.isArray(value) ? value.map(find).find(Boolean) : find(value);
      if (found) return found;
    }
    return null;
  }
  const node = find(ast);
  assert.ok(node, 'shipped launch entry point exists');
  return source.slice(...node.range);
}

for (const mode of ['new', 'resume', 'fork', 'schedule']) {
  test(`GIVEN a relative trigger override WHEN ${mode} launches THEN the watcher path reaches its spawn`, async t => {
    const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-control-launch-'));
    t.after(() => {
      if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
      else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
      fs.rmSync(base, { recursive: true, force: true });
    });
    const expected = path.join(base, 'control with spaces');
    process.env.SWITCHBOARD_TRIGGERS_DIR = path.relative(process.cwd(), expected);
    assert.equal(watcher.getTriggersDir(), expected);
    const cwd = path.join(base, 'other-cwd');
    fs.mkdirSync(cwd);
    const calls = [];
    const handlers = new Map();
    const spawn = (shell, args, options) => {
      calls.push({ shell, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const ctx = vm.createContext({
      require: createRequire(filename), fs, path, os, process: { platform: 'linux' },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      mainWindow: {}, unsavedGuard: { launchAllowed: () => true }, activeSessions: new Map(),
      getCachedFolder: () => null, isRemoteFolder: () => false,
      remoteIndexer: { findSessionAlias: () => null }, resolveSessionRealCwd: () => cwd,
      PROJECTS_DIR: path.join(base, 'transcripts'),
      normalizePtySize: require('../src/main/terminals/pty-size').normalizePtySize,
      isWslShell: () => false, encodeProjectPath: () => 'fixture',
      getSetting: () => ({}), SETTING_DEFAULTS: {}, resolveShell: () => ({ path: '/bin/bash' }),
      sessionTransitions: { snapshotContinuationsBeforeSpawn: async () => null },
      sessionTranscriptExists: () => true, parseAddDirs: () => [], sandboxBindEnv: () => '',
      quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, command) => ['-c', command],
      sandboxScriptPath: () => '/sandbox.sh', cleanPtyEnv: {},
      scheduleProjects: () => ({ add: async () => {}, list: async () => [] }),
      resolveScheduleSandbox: () => true,
      scheduleLaunchRefusal: require('../src/main/schedules/schedule-runner').scheduleLaunchRefusal,
      getHarness: require('../harnesses').getHarness,
      isProjectSettingsArchived: () => false,
      log: { info() {}, warn() {}, error() {} },
      cliSessionState: { trackScheduleRun() {}, ensureWatching: () => true },
      activityReporter: { sessionStarted() {} }, trackWindowsPty() {},
      createComposerState: require('../src/main/terminals/composer-state').createComposerState,
      revealIfSdkSession() {}, wireSessionPty() {}, getMcpState: () => null,
      spawnPty: spawn, cpSpawn: spawn,
    });
    vm.runInContext(shippedLaunch(mode), ctx, { filename });
    const result = mode === 'schedule'
      ? await ctx.runScheduleCommand([], cwd, 'test', null)
      : await handlers.get('open-terminal')(null, 'session-id', base, mode !== 'resume', {
        sandbox: true, mcpEmulation: false, ...(mode === 'fork' ? { forkFrom: 'source-id' } : {}),
      });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.length, 1, `${mode} must reach exactly one spawn`);
    const call = calls[0];
    assert.equal(call.options.env.SWITCHBOARD_SANDBOX_TRIGGERS_DIR, expected, `${mode} spawn receives the watcher path`);
    assert.equal(call.options.cwd, mode === 'new' ? base : cwd);
    assert.ok(call.args.join(' ').includes('/sandbox.sh'), 'spawn executes the sandbox wrapper');
    if (mode === 'new') assert.match(call.args.join(' '), /--session-id session-id/);
    if (mode === 'resume') assert.match(call.args.join(' '), /--resume session-id/);
    if (mode === 'fork') assert.match(call.args.join(' '), /--resume source-id --fork-session/);
    assert.ok(fs.statSync(path.join(expected, 'processed')).isDirectory());
  });
}

test('GIVEN an empty override WHEN the watcher resolves its directory THEN it uses the absolute default', t => {
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
  });
  process.env.SWITCHBOARD_TRIGGERS_DIR = '';
  assert.equal(watcher.getTriggersDir(), path.resolve(os.homedir(), '.switchboard', 'triggers'));
});
