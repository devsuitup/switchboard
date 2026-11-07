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
function launchBlock(marker) {
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (marker === 'schedule' && node.type === 'FunctionDeclaration' && node.id.name === 'runScheduleCommand') return node;
    if (node.type === 'IfStatement' && source.slice(...node.test.range) === marker
      && source.slice(...node.consequent.range).includes('const extraBinds')) return node;
    for (const value of Object.values(node)) {
      const found = Array.isArray(value) ? value.map(find).find(Boolean) : find(value);
      if (found) return found;
    }
    return null;
  }
  const block = find(ast);
  assert.ok(block, 'shipped sandbox launch block exists');
  return source.slice(...(marker === 'schedule' ? block : block.consequent).range);
}

test('GIVEN a relative trigger override WHEN watcher and every sandbox launch resolve it THEN the absolute main cwd wins', async t => {
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-control-launch-'));
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const expected = path.join(base, 'control with spaces');
  process.env.SWITCHBOARD_TRIGGERS_DIR = path.relative(process.cwd(), expected);
  assert.equal(typeof watcher.getTriggersDir, 'function', 'watcher exports the shared resolver');
  assert.equal(watcher.getTriggersDir(), expected);
  const requireMain = createRequire(filename);
  for (const mode of ['new', 'resume', 'fork', 'schedule']) {
    const env = {};
    const ctx = vm.createContext({
      require: requireMain, fs, path, os, getTriggersDir: watcher.getTriggersDir,
      ptyEnv: env, env, projectPath: base, spawnCwd: path.join(base, 'other-cwd'), cwd: base,
      sessionOptions: { sandbox: true, addDirs: '', forkFrom: mode === 'fork' ? 'source' : null },
      parseAddDirs: () => [], sandboxBindEnv: () => '', encodeProjectPath: () => 'folder',
      quoteArgvForShell: (_shell, argv) => argv.join(' '), shell: '/bin/bash',
      sandboxScriptPath: () => '/sandbox.sh', claudeArgv: [],
      scheduleBindRefusals: () => [], scheduleProjects: () => ({ list: async () => [] }),
      process: { platform: 'linux' }, getSetting: () => ({}), SETTING_DEFAULTS: {},
      isProjectSettingsArchived: () => false, resolveShell: () => ({ path: '/bin/bash' }),
      cleanPtyEnv: {}, resolveScheduleSandbox: () => true, shellArgs: (_shell, command) => [command],
      log: { info() {}, error() {} }, cliSessionState: { trackScheduleRun() {} },
      activityReporter: { sessionStarted() {} },
      cpSpawn: (_shell, _args, options) => {
        Object.assign(env, options.env);
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    const block = launchBlock(mode === 'schedule' ? 'schedule' : '!isAttach && sessionOptions?.sandbox');
    if (mode === 'schedule') {
      vm.runInContext(block, ctx, { filename });
      const result = await ctx.runScheduleCommand([], base, 'test', null);
      assert.equal(result.ok, true);
    } else vm.runInContext(block, ctx, { filename });
    assert.equal(env.SWITCHBOARD_SANDBOX_TRIGGERS_DIR, expected, `${mode} receives the watcher path`);
    assert.ok(fs.statSync(path.join(expected, 'processed')).isDirectory(), `${mode} prepares the control directory`);
    fs.rmSync(expected, { recursive: true });
  }
  process.env.SWITCHBOARD_TRIGGERS_DIR = '';
  assert.equal(watcher.getTriggersDir(), path.resolve(os.homedir(), '.switchboard', 'triggers'));
});
