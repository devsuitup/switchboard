'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const espree = require('espree');

const root = path.join(__dirname, '..');
function load(file, globals = {}) {
  const filename = path.join(root, file);
  const context = vm.createContext({ require: createRequire(filename), module: { exports: {} }, ...globals });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

function cleaner(platform) {
  return load('src/main/shared/clean-env.js', { process: { platform } }).module.exports.cleanEnv;
}

function mainStatement(predicate) {
  const filename = path.join(root, 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const value of Object.values(node)) {
      const found = Array.isArray(value) ? value.map(find).find(Boolean) : find(value);
      if (found) return found;
    }
    return null;
  }
  const node = find(ast);
  assert.ok(node, 'production launch statement exists');
  return { source: source.slice(...node.range), filename };
}

for (const [platform, expected] of [['darwin', 'UTF-8'], ['linux', 'C.UTF-8'], ['win32', undefined]]) {
  test(`${platform}: sessions without a locale inherit the platform UTF-8 default`, () => {
    const clean = cleaner(platform);
    for (const inherited of [{}, { LANG: '' }, { LC_ALL: '', LC_CTYPE: '', LANG: '' }]) {
      const source = { ...inherited, PATH: '/bin', CLAUDECODE: '1' };
      const before = { ...source };
      const env = clean(source);
      assert.equal(env.LC_CTYPE, expected === undefined ? inherited.LC_CTYPE : expected);
      assert.equal(env.PATH, '/bin');
      assert.equal(env.CLAUDECODE, undefined);
      assert.deepEqual(source, before);
    }
  });

  test(`${platform}: any nonempty inherited locale wins, including an explicit C locale`, () => {
    const clean = cleaner(platform);
    for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG']) {
      for (const value of ['C', 'fr_FR.ISO8859-1', 'ja_JP.UTF-8']) {
        const source = { LC_ALL: '', LC_CTYPE: '', LANG: '', [key]: value };
        assert.equal(JSON.stringify(clean(source)), JSON.stringify(source));
      }
    }
  });

  test(`${platform}: non-session callers can opt out without losing inherited locales`, () => {
    const clean = cleaner(platform);
    for (const source of [{ PATH: '/bin' }, { LC_CTYPE: 'inherited' }]) {
      assert.equal(JSON.stringify(clean(source, { locale: false })), JSON.stringify(source));
    }
  });
}

test('main startup supplies local sessions but never synthesizes a locale for the SSH PTY', () => {
  const filename = path.join(root, 'main.js');
  const main = fs.readFileSync(filename, 'utf8');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const source = { PATH: '/bin' };
    let spawnOptions;
    const context = vm.createContext({
      require: name => name === './src/main/shared/clean-env' ? { cleanEnv: cleaner(platform), scrubSessionEnv() {} } : {},
      process: { env: source }, module: {},
      createTmuxAttachAdapter: opts => opts,
      loadAttachProfileId() {}, app: { getPath() {} }, log: {}, os: { homedir: () => '/home/test' },
      spawnPty: (_file, _args, opts) => { spawnOptions = opts; },
    });
    const start = main.indexOf('const { cleanEnv');
    const end = main.indexOf('\n', main.indexOf('const cleanPtyEnv =', start));
    vm.runInContext(main.slice(start, end), context, { filename });
    const env = vm.runInContext('cleanPtyEnv', context);
    assert.equal(env.LC_CTYPE, platform === 'win32' ? undefined : platform === 'darwin' ? 'UTF-8' : 'C.UTF-8');
    const remoteStart = main.indexOf('const remoteAttachAdapter =');
    const remoteEnd = main.indexOf('\n});', remoteStart) + '\n});'.length;
    vm.runInContext(main.slice(remoteStart, remoteEnd), context, { filename });
    vm.runInContext("remoteAttachAdapter.spawnPty('ssh', ['host'], {})", context);
    assert.equal(spawnOptions.env.LC_CTYPE, undefined, `${platform} SSH must not forward a synthesized LC_CTYPE`);
    assert.deepEqual(source, { PATH: '/bin' });
  }
});

test('git changes keeps LC_ALL=C even with a session UTF-8 environment', () => {
  const context = load('git-changes-runner.js', { process });
  const env = vm.runInContext('localGitEnv', context)(cleaner('darwin')({}));
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.LANG, 'C');
});

test('local Claude and plain-terminal launch environments retain the UTF-8 default', () => {
  const plain = mainStatement(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === 'launch' && d.init?.callee?.name === 'plainTerminalLaunch'));
  const claude = mainStatement(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === 'ptyEnv'));
  for (const platform of ['darwin', 'linux', 'win32']) {
    const context = vm.createContext({ cleanPtyEnv: cleaner(platform)({}), shell: '/bin/sh', shellExtraArgs: [],
      shellArgs: () => [], plainTerminalLaunch: require('../plain-terminal-shell').plainTerminalLaunch,
      ensurePlainTerminalInitFiles: () => false, PLAIN_TERMINAL_INIT_DIR: '/unused', log: {} });
    vm.runInContext(plain.source, context, { filename: plain.filename });
    vm.runInContext(claude.source, context, { filename: claude.filename });
    const expected = platform === 'win32' ? undefined : platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
    assert.equal(vm.runInContext('launch.env.LC_CTYPE', context), expected);
    assert.equal(vm.runInContext('ptyEnv.LC_CTYPE', context), expected);
  }
});

test('schedule launch passes the UTF-8 default to the intercepted child spawn', async () => {
  const statement = mainStatement(n => n.type === 'FunctionDeclaration' && n.id.name === 'runScheduleCommand');
  for (const platform of ['darwin', 'linux', 'win32']) {
    let spawned;
    const context = vm.createContext({ cleanPtyEnv: cleaner(platform)({}),
      getSetting: () => ({}), isProjectSettingsArchived: () => false,
      SETTING_DEFAULTS: {}, resolveShell: () => ({ path: '/test-shell' }),
      quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
      resolveScheduleSandbox: () => false, process: { platform }, Date,
      log: { info() {}, error() {} }, cliSessionState: { trackScheduleRun() {} },
      activityReporter: { sessionStarted() {}, sessionEnded() {} },
      cpSpawn: (_file, _args, opts) => {
        spawned = opts;
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('spawn'));
        return child;
      } });
    vm.runInContext(statement.source, context, { filename: statement.filename });
    assert.equal((await context.runScheduleCommand(['--resume', 'test-session'], '/project', 'test')).ok, true);
    assert.equal(spawned.env.LC_CTYPE, platform === 'win32' ? undefined : platform === 'darwin' ? 'UTF-8' : 'C.UTF-8');
  }
});

test('relaunch does not persist a synthesized locale into the next app and its implicit SSH children', async () => {
  let cleaned = false;
  const context = load('src/main/app/relaunch.js', {
    process,
    require: name => name === '../shared/clean-env' ? { cleanEnv: (...args) => { cleaned = true; return cleaner('linux')(...args); } } : createRequire(path.join(root, 'src/main/app/relaunch.js'))(name),
  });
  let launched;
  await context.module.exports({ env: { PATH: '/bin' }, execPath: '/app', argv: [], cwd: '/tmp',
    spawnSync: (_file, _args, opts) => { launched = opts.env; return { status: 0 }; }, quit() {}, notify() {} });
  assert.equal(launched.LC_CTYPE, undefined);
  assert.equal(cleaned, true, 'the relaunch fixture must use the Linux environment cleaner');
});
