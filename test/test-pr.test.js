'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const tooling = () => require('../scripts/test-pr');

function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-pr-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function shellEnv(tools) {
  if (process.platform !== 'win32') return { PATH: [tools, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter) };
  const SystemRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    SystemRoot,
    ComSpec: path.join(SystemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [tools, path.join(SystemRoot, 'System32')].filter(Boolean).join(path.delimiter),
  };
}

function fixtureEnv() {
  return { ...shellEnv(), PATH: process.env.PATH || process.env.Path };
}

function resolveFixtureCommand(root, env) {
  const result = process.platform === 'win32'
    ? spawnSync(env.ComSpec, ['/d', '/s', '/c', 'claude --resume fixture'], { cwd: root, env, encoding: 'utf8', timeout: 180000 })
    : spawnSync('/bin/sh', ['-c', 'claude --resume fixture'], { cwd: root, env, encoding: 'utf8', timeout: 180000 });
  assert.ifError(result.error);
  return result;
}

test('the tasks delegate launch and cleanup to the cross-platform script', () => {
  const taskfile = fs.readFileSync(path.join(__dirname, '../Taskfile.yaml'), 'utf8');
  assert.match(taskfile, /node scripts\/test-pr\.js/);
  assert.match(taskfile, /node scripts\/test-pr\.js --clean/);
  assert.match(taskfile, /ISOLATED: /);
  assert.match(taskfile, /ALLOW_CLAUDE: '\{\{\.ALLOW_CLAUDE \| default "0"\}\}'/);
  assert.doesNotMatch(taskfile, /ln -sfn/);
  assert.doesNotMatch(taskfile, /origin\/main\.\.\./);
});

test('default launch preserves inherited environment and existing data locations', (t) => {
  const home = temp(t);
  const env = { HOME: home, USERPROFILE: home, PATH: 'original', CLAUDE_CODE_SSE_PORT: '123', GIT_DIR: 'inherited' };
  const launch = tooling().buildLaunch({ pr: '122', home, env });
  assert.deepEqual(launch.env, { ...env,
    SWITCHBOARD_DATA_DIR: path.join(home, '.switchboard-dev-pr122'),
    SWITCHBOARD_TRIGGERS_DIR: path.join(home, '.switchboard-dev-pr122', 'triggers'),
  });
  assert.deepEqual(launch.args, ['.', '--no-sandbox']);
  assert.deepEqual(env, { HOME: home, USERPROFILE: home, PATH: 'original', CLAUDE_CODE_SSE_PORT: '123', GIT_DIR: 'inherited' });
});

test('isolated launch moves every home and app directory under its temporary root', (t) => {
  const root = temp(t);
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, port: 9334,
    env: { HOME: 'real', USERPROFILE: 'real', APPDATA: 'real', LOCALAPPDATA: 'real', XDG_CONFIG_HOME: 'real' } });
  for (const key of ['HOME', 'USERPROFILE']) assert.equal(launch.env[key], root, key);
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SWITCHBOARD_DATA_DIR', 'SWITCHBOARD_TRIGGERS_DIR']) {
    assert.ok(launch.env[key].startsWith(root + path.sep), key);
  }
  assert.equal(launch.env.SWITCHBOARD_TRIGGERS_DIR, path.join(launch.env.SWITCHBOARD_DATA_DIR, 'triggers'));
  assert.ok(launch.args.includes('--remote-debugging-port=9334'));
});

test('isolated launch drops inherited session and git overrides case-insensitively', (t) => {
  const root = temp(t);
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: {
    CLAUDE_CODE_SSE_PORT: 'real', CLAUDE_CONFIG_DIR: 'real', claudeOther: 'real',
    GIT_DIR: 'real', git_work_tree: 'real', GIT_CONFIG_COUNT: '2', ORIGINAL_PATH: 'real',
    ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'ok', Path: 'tools', home: 'real', userprofile: 'real', appdata: 'real',
  } });
  for (const key of ['CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR', 'claudeOther', 'GIT_DIR', 'git_work_tree',
    'GIT_CONFIG_COUNT', 'ORIGINAL_PATH', 'ELECTRON_RUN_AS_NODE', 'Path', 'home', 'userprofile', 'appdata']) {
    assert.equal(launch.env[key], undefined, key);
  }
  assert.equal(launch.env.KEEP_ME, 'ok');
  assert.equal(launch.env.PATH, path.join(root, 'bin') + path.delimiter + 'tools');
});

test('isolated fixtures contain two synthetic projects and a committed git repository', (t) => {
  const root = temp(t);
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: fixtureEnv() });
  const fixture = tooling().prepareFixtures(root, launch.env);
  const projects = path.join(root, '.claude', 'projects');
  const folders = fs.readdirSync(projects);
  assert.equal(folders.length, 2);
  for (const folder of folders) {
    const files = fs.readdirSync(path.join(projects, folder));
    assert.equal(files.length, 1);
    const rows = fs.readFileSync(path.join(projects, folder, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.type), ['user', 'assistant']);
    assert.ok(rows.every(row => row.cwd.startsWith(root + path.sep)));
  }
  const git = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: fixture.repo, env: launch.env, encoding: 'utf8', timeout: 180000 });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(git.stdout.trim(), 'fixture');
});

test('the first PATH entry refuses to launch the real command', (t) => {
  const root = temp(t);
  const fixtures = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: fixtureEnv() });
  tooling().prepareFixtures(root, fixtures.env);
  const fallback = path.join(root, 'fallback');
  fs.mkdirSync(fallback);
  fs.writeFileSync(path.join(fallback, 'claude.cmd'), '@echo fallback\r\n@exit /b 0\r\n');
  fs.writeFileSync(path.join(fallback, 'claude'), '#!/bin/sh\necho fallback\nexit 0\n', { mode: 0o755 });
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: shellEnv(fallback) });
  const result = resolveFixtureCommand(root, launch.env);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /disabled in isolated test-pr mode/);
  assert.equal(result.stdout, '');
});

function lock() {
  return { name: 'switchboard', version: '1', lockfileVersion: 3,
    packages: { '': { name: 'switchboard', version: '1', dependencies: { dep: '^2' } }, 'node_modules/dep': { version: '2', integrity: 'abc' } } };
}

test('a release-only version bump does not invalidate shared dependencies', () => {
  const changed = lock();
  changed.version = '2';
  changed.packages[''].version = '2';
  assert.equal(tooling().lockChanged(JSON.stringify(lock()), JSON.stringify(changed)), false);
});

test('lock comparison ignores property order but detects every non-root change', () => {
  const original = lock();
  assert.equal(tooling().lockChanged(JSON.stringify(original), JSON.stringify({ packages: original.packages, lockfileVersion: 3, version: '1', name: 'switchboard' })), false);
  for (const mutate of [
    value => { value.packages['node_modules/dep'].version = '3'; },
    value => { value.packages['node_modules/dep'].integrity = 'changed'; },
    value => { value.packages[''].dependencies.dep = '^3'; },
    value => { value.name = 'other'; },
    value => { value.lockfileVersion = 2; },
  ]) {
    const changed = lock();
    mutate(changed);
    assert.equal(tooling().lockChanged(JSON.stringify(original), JSON.stringify(changed)), true);
  }
  assert.throws(() => tooling().lockChanged('{}', 'not json'));
});

test('dependency sharing uses a junction on Windows and a directory symlink elsewhere', (t) => {
  const root = temp(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'sentinel'), 'keep');
  for (const platform of ['win32', 'linux', 'darwin']) {
    const worktree = path.join(root, platform);
    fs.mkdirSync(worktree);
    const calls = [];
    tooling().linkNodeModules(worktree, source, { platform, symlink: (...args) => { calls.push(args); } });
    assert.deepEqual(calls, [[source, path.join(worktree, 'node_modules'), platform === 'win32' ? 'junction' : 'dir']]);
  }
});

test('dependency sharing preserves a private install without creating nested links', (t) => {
  const root = temp(t);
  const target = path.join(root, 'node_modules');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'private'), 'keep');
  tooling().linkNodeModules(root, path.join(root, 'missing'));
  assert.deepEqual(fs.readdirSync(target), ['private']);
});

test('cleanup removes the dependency link before git removes the worktree, preserving its source', (t) => {
  const root = temp(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'sentinel'), 'keep');
  const worktree = path.join(root, '.worktrees', 'pr-122-test');
  fs.mkdirSync(worktree, { recursive: true });
  tooling().linkNodeModules(worktree, source);
  assert.ok(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink());
  const calls = [];
  tooling().cleanWorktree({ checkout: root, pr: '122', home: root, run: (file, args) => {
    calls.push([file, args]);
    assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(source, 'sentinel'), 'utf8'), 'keep');
  } });
  assert.deepEqual(calls, [['git', ['worktree', 'remove', '--force', worktree]]]);
  assert.equal(fs.readFileSync(path.join(source, 'sentinel'), 'utf8'), 'keep');
});

test('invalid PR numbers and debug ports are rejected before side effects', () => {
  for (const pr of ['', '../122', '1;echo', '-1', '$(cmd)']) {
    assert.throws(() => tooling().buildLaunch({ pr }), /numeric/);
  }
  for (const port of ['oops', 0, 65536, 1.5]) {
    assert.throws(() => tooling().buildLaunch({ pr: '122', isolated: true, tempHome: 'fixture', port }), /port/);
  }
});

const bundleScript = require('../package.json').scripts['bundle:codemirror'];
const bundleOptions = { entryPoints: ['public/codemirror-setup.js'], bundle: true,
  outfile: 'public/codemirror-bundle.js', format: 'iife', platform: 'browser', minify: true };

function evaluateBuild(file, args, worktree, onBuild) {
  assert.equal(file, process.execPath);
  assert.equal(args[0], '-e');
  assert.doesNotMatch(args.join(' '), /bin[\\/]esbuild|\.bin|\bnpm\b/);
  vm.runInNewContext(args[1], { process: { argv: [file, ...args.slice(2)] },
    require: name => {
      assert.equal(name, path.join(worktree, 'node_modules', 'esbuild'));
      return { buildSync: options => onBuild(JSON.parse(JSON.stringify(options))) };
    } }, { timeout: 1000 });
}

function workflow(t, script = bundleScript) {
  const checkout = temp(t);
  const home = temp(t);
  const modules = path.join(checkout, 'node_modules');
  fs.mkdirSync(path.join(modules, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'electron', 'index.js'), 'module.exports = "fixture-executable";');
  const calls = [];
  const messages = [];
  const run = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    if (args[0] === 'rev-parse') return 'fixture-sha\n';
    if (args[0] === 'ls-tree') return 'package-lock.json\n';
    if (args[0] === 'show') return JSON.stringify(lock());
    if (args[0] === 'worktree' && args[1] === 'add') {
      fs.mkdirSync(args[3], { recursive: true });
      fs.writeFileSync(path.join(args[3], 'package.json'), JSON.stringify({ scripts: { 'bundle:codemirror': script } }));
    }
    return '';
  };
  const env = { ...fixtureEnv(), PR: '122', HOME: home, USERPROFILE: home, ISOLATED: '0' };
  return { checkout, home, env, run, calls, messages,
    log: message => messages.push(message), warn: message => messages.push(message) };
}

test('the complete isolated workflow prints the debug endpoint and removes its home after exit', async (t) => {
  const setup = workflow(t);
  let launchedHome;
  const status = await tooling().main({ ...setup, env: { ...setup.env, ISOLATED: '1', DEBUG_PORT: '9334', GIT_DIR: 'real' },
    launch: async (file, args, options) => {
      launchedHome = options.env.HOME;
      assert.equal(file, 'fixture-executable');
      assert.ok(args.includes('--remote-debugging-port=9334'));
      assert.equal(options.env.GIT_DIR, undefined);
      assert.equal(fs.readdirSync(path.join(launchedHome, '.claude', 'projects')).length, 2);
      return 7;
    } });
  assert.equal(status, 7);
  assert.ok(launchedHome);
  assert.equal(fs.existsSync(launchedHome), false);
  assert.ok(setup.messages.some(message => message.includes('http://127.0.0.1:9334/json')));
  assert.deepEqual(setup.calls.filter(call => call.args[0] === 'show').map(call => call.args[1]),
    ['origin/main:package-lock.json', 'fixture-sha:package-lock.json']);
});

test('the complete default workflow retains the original HOME and adds no debug port', async (t) => {
  const setup = workflow(t);
  const status = await tooling().main({ ...setup, launch: async (file, args, options) => {
    assert.equal(options.env.HOME, setup.home);
    assert.deepEqual(args, ['.', '--no-sandbox']);
    return 0;
  }, fixtures: () => assert.fail('default mode must not create fixtures') });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(setup.home), true);
  assert.equal(setup.messages.some(message => message.includes('remote-debugging-port')), false);
});

for (const isolated of ['0', '1']) {
  test(`mode ISOLATED=${isolated} rebuilds CodeMirror before every launch, including a stale bundle`, async (t) => {
    const setup = workflow(t);
    const worktree = path.join(setup.checkout, '.worktrees', 'pr-122-test');
    const bundle = path.join(worktree, 'public', 'codemirror-bundle.js');
    const steps = [];
    const run = (file, args, options) => {
      if (file !== process.execPath) return setup.run(file, args, options);
      evaluateBuild(file, args, worktree, options => assert.deepEqual(options, bundleOptions));
      assert.equal(options.cwd, worktree);
      assert.equal(options.stdio, 'inherit');
      assert.equal(fs.realpathSync(path.join(worktree, 'node_modules')), fs.realpathSync(path.join(setup.checkout, 'node_modules')));
      steps.push('bundle');
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      fs.writeFileSync(bundle, 'rebuilt');
      return '';
    };
    const options = { ...setup, env: { ...setup.env, ISOLATED: isolated }, run, fixtures: () => {},
      launch: async () => {
        assert.equal(fs.readFileSync(bundle, 'utf8'), 'rebuilt');
        steps.push('launch');
        return 0;
      } };

    assert.equal(await tooling().main(options), 0);
    fs.writeFileSync(bundle, 'stale');
    assert.equal(await tooling().main(options), 0);
    assert.deepEqual(steps, ['bundle', 'launch', 'bundle', 'launch']);
  });

  test(`mode ISOLATED=${isolated} aborts launch with a clear error when the CodeMirror build fails`, async (t) => {
    const setup = workflow(t);
    const worktree = path.join(setup.checkout, '.worktrees', 'pr-122-test');
    const run = (file, args, options) => {
      if (file !== process.execPath) return setup.run(file, args, options);
      throw new Error('esbuild failed');
    };

    await assert.rejects(tooling().main({ ...setup, env: { ...setup.env, ISOLATED: isolated }, run,
      fixtures: () => assert.fail('build failure must prevent fixture setup'),
      launch: async () => assert.fail('build failure must prevent launch') }), error => {
      assert.match(error.message, /Failed to build CodeMirror bundle/);
      assert.ok(error.message.includes(worktree));
      assert.match(error.message, /esbuild failed/);
      return true;
    });
    assert.equal(setup.messages.some(message => message.startsWith('Launching')), false);
  });
}

test('a failing fixture setup or launch still removes the temporary home', async (t) => {
  for (const failure of ['fixtures', 'launch']) {
    const setup = workflow(t);
    let createdHome;
    const options = { ...setup, env: { ...setup.env, ISOLATED: '1' },
      fixtures: (home, env) => {
        createdHome = home;
        if (failure === 'fixtures') throw new Error('fixture failure');
        return tooling().prepareFixtures(home, env);
      },
      launch: async () => { throw new Error('launch failure'); },
    };
    await assert.rejects(tooling().main(options), new RegExp(`${failure === 'fixtures' ? 'fixture' : 'launch'} failure`));
    assert.ok(createdHome);
    assert.equal(fs.existsSync(createdHome), false);
  }
});

test('an existing dependency link is replaced safely and its source survives', (t) => {
  const root = temp(t);
  const source = path.join(root, 'source');
  const replacement = path.join(root, 'replacement');
  fs.mkdirSync(source);
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(source, 'keep'), 'keep');
  tooling().linkNodeModules(root, source);
  tooling().linkNodeModules(root, replacement);
  assert.equal(fs.realpathSync(path.join(root, 'node_modules')), fs.realpathSync(replacement));
  assert.equal(fs.readFileSync(path.join(source, 'keep'), 'utf8'), 'keep');
});

test('invalid options prevent even the first git command', async () => {
  for (const env of [{ PR: '../122' }, { PR: '122', ISOLATED: '1', DEBUG_PORT: 'invalid' }]) {
    await assert.rejects(tooling().main({ env, run: () => assert.fail('git must not run') }));
  }
});

test('invalid ISOLATED values fail with a usage error before any git call', async (t) => {
  for (const value of ['true', 'yes', 'on', '2', ' 1', null]) {
    for (const clean of [false, true]) {
      const setup = workflow(t);
      await assert.rejects(tooling().main({ ...setup, clean, env: { ...setup.env, ISOLATED: value },
        launch: async () => assert.fail('invalid ISOLATED must not launch') }), /ISOLATED must be 1 or 0/);
      assert.equal(setup.calls.length, 0);
    }
  }
});

test('ISOLATED accepts 1, 0, empty and unset with the intended HOME', async (t) => {
  for (const value of ['1', '0', '', undefined]) {
    const setup = workflow(t);
    const env = { ...setup.env };
    if (value === undefined) delete env.ISOLATED;
    else env.ISOLATED = value;
    let launchedHome;
    const status = await tooling().main({ ...setup, env, fixtures: () => {},
      launch: async (file, args, options) => {
        launchedHome = options.env.HOME;
        assert.equal(args.some(arg => arg.startsWith('--remote-debugging-port=')), value === '1');
        assert.equal(launchedHome === setup.home, value !== '1');
        return 0;
      } });
    assert.equal(status, 0);
    assert.equal(fs.existsSync(launchedHome), value !== '1');
  }
});

test('invalid ALLOW_CLAUDE values fail before any git call, including cleanup', async (t) => {
  for (const value of ['true', 'yes', 'on', '2', ' 1', '1 ', null, 1, false]) {
    for (const clean of [false, true]) {
      const setup = workflow(t);
      await assert.rejects(tooling().main({ ...setup, clean,
        env: { ...setup.env, ISOLATED: '1', ALLOW_CLAUDE: value },
        launch: async () => assert.fail('invalid ALLOW_CLAUDE must not launch') }), /ALLOW_CLAUDE must be 1 or 0/);
      assert.equal(setup.calls.length, 0);
    }
  }
});

test('ALLOW_CLAUDE=1 requires ISOLATED=1 before any git call', async (t) => {
  for (const isolated of ['0', '', undefined]) {
    for (const clean of [false, true]) {
      const setup = workflow(t);
      await assert.rejects(tooling().main({ ...setup, clean,
        env: { ...setup.env, ISOLATED: isolated, ALLOW_CLAUDE: '1' },
        launch: async () => assert.fail('ALLOW_CLAUDE outside isolated mode must not launch') }),
      /ALLOW_CLAUDE=1 requires ISOLATED=1.*default mode already uses the real claude/);
      assert.equal(setup.calls.length, 0);
    }
  }
});

test('default mode accepts disabled, empty and unset ALLOW_CLAUDE without changing PATH', async (t) => {
  for (const value of ['0', '', undefined]) {
    const setup = workflow(t);
    assert.equal(await tooling().main({ ...setup, env: { ...setup.env, ALLOW_CLAUDE: value },
      fixtures: () => assert.fail('default mode must not create fixtures'),
      launch: async (file, args, options) => {
        assert.equal(options.env.PATH, setup.env.PATH);
        assert.equal(options.env.HOME, setup.home);
        return 0;
      } }), 0);
  }
});

for (const value of ['0', '', undefined, '1']) {
  test(`isolated ALLOW_CLAUDE=${value} preserves isolation and reports the command policy`, async (t) => {
    const setup = workflow(t);
    const enabled = value === '1';
    const originalPath = setup.env.PATH || setup.env.Path;
    const env = { ...setup.env, ISOLATED: '1', ALLOW_CLAUDE: value,
      Path: originalPath, ORIGINAL_PATH: 'must-not-be-used', original_path: 'must-not-be-used',
      CLAUDE_CONFIG_DIR: setup.home, claudeOther: 'inherited', GIT_DIR: setup.home, git_work_tree: setup.home };
    delete env.PATH;
    fs.mkdirSync(path.join(setup.home, '.claude'));
    fs.writeFileSync(path.join(setup.home, '.claude', '.credentials.json'), 'private sentinel');
    fs.writeFileSync(path.join(setup.home, '.claude.json'), 'private sentinel');
    let launchedHome;
    assert.equal(await tooling().main({ ...setup, env,
      launch: async (file, args, options) => {
        launchedHome = options.env.HOME;
        assert.notEqual(launchedHome, setup.home);
        assert.equal(options.env.USERPROFILE, launchedHome);
        assert.equal(options.env.PATH, enabled ? originalPath : path.join(launchedHome, 'bin') + path.delimiter + originalPath);
        for (const key of ['Path', 'ORIGINAL_PATH', 'original_path', 'CLAUDE_CONFIG_DIR', 'claudeOther', 'GIT_DIR', 'git_work_tree']) {
          assert.equal(options.env[key], undefined, key);
        }
        assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
        assert.equal(options.env.GIT_CONFIG_GLOBAL, path.join(launchedHome, '.gitconfig'));
        for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
          'SWITCHBOARD_DATA_DIR', 'SWITCHBOARD_TRIGGERS_DIR']) {
          assert.ok(options.env[key].startsWith(launchedHome + path.sep), key);
        }
        for (const stub of ['claude', 'claude.cmd', 'claude.ps1']) {
          assert.equal(fs.existsSync(path.join(launchedHome, 'bin', stub)), !enabled, stub);
        }
        assert.equal(fs.readdirSync(path.join(launchedHome, '.claude', 'projects')).length, 2);
        assert.equal(fs.existsSync(path.join(launchedHome, '.claude', '.credentials.json')), false);
        assert.equal(fs.existsSync(path.join(launchedHome, '.claude.json')), false);
        fs.writeFileSync(path.join(launchedHome, '.claude', '.credentials.json'), 'temporary login');
        return 0;
      } }), 0);
    assert.equal(fs.existsSync(launchedHome), false);
    assert.equal(fs.readFileSync(path.join(setup.home, '.claude', '.credentials.json'), 'utf8'), 'private sentinel');
    const banner = setup.messages.join('\n');
    assert.match(banner, enabled ? /Real claude enabled/ : /Real claude disabled/);
    if (enabled) assert.match(banner, /starts logged out.*login.*temporary HOME.*deleted on exit/i);
  });
}

test('enabled isolated mode resolves the original PATH command without a stub', (t) => {
  const root = temp(t);
  const fallback = path.join(root, 'original-tools');
  fs.mkdirSync(fallback);
  fs.writeFileSync(path.join(fallback, 'claude.cmd'), '@echo original command\r\n@exit /b 0\r\n');
  fs.writeFileSync(path.join(fallback, 'claude'), '#!/bin/sh\necho original command\nexit 0\n', { mode: 0o755 });
  const env = shellEnv(fallback);
  const originalPath = env.PATH;
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, allowClaude: true, tempHome: root,
    env: { ...env, ORIGINAL_PATH: 'must-not-be-used' } });
  assert.equal(launch.env.PATH, originalPath);
  const result = resolveFixtureCommand(root, launch.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'original command');
  assert.equal(result.stderr, '');
});

for (const isolated of [false, true]) {
  for (const allowClaude of isolated ? [false, true] : [false]) {
    test(`ISOLATED=${isolated} ALLOW_CLAUDE=${allowClaude} prefers exact PATH and removes case variants`, (t) => {
      const root = temp(t);
      const env = { Path: 'inherited-tools', path: 'lowercase-tools', PATH: 'preferred-tools', KEEP_ME: 'ok' };
      const launch = tooling().buildLaunch({ pr: '122', isolated, allowClaude, tempHome: root, env });
      assert.deepEqual(Object.keys(launch.env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
      assert.equal(launch.env.PATH, isolated && !allowClaude
        ? path.join(root, 'bin') + path.delimiter + env.PATH : env.PATH);
      assert.equal(launch.env.KEEP_ME, 'ok');
      assert.deepEqual(env, { Path: 'inherited-tools', path: 'lowercase-tools', PATH: 'preferred-tools', KEEP_ME: 'ok' });
    });
  }
}

test('mixed-case inherited PATH resolves only the fake command from exact PATH', (t) => {
  const root = temp(t);
  const tools = path.join(root, 'fake-tools');
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'claude.cmd'), '@echo fake command\r\n@exit /b 0\r\n');
  fs.writeFileSync(path.join(tools, 'claude'), '#!/bin/sh\necho fake command\nexit 0\n', { mode: 0o755 });
  const decoy = path.join(root, 'decoy-tools');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'claude.cmd'), '@echo decoy command\r\n@exit /b 3\r\n');
  fs.writeFileSync(path.join(decoy, 'claude'), '#!/bin/sh\necho decoy command\nexit 3\n', { mode: 0o755 });
  const safeEnv = shellEnv(tools);
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, allowClaude: true, tempHome: root,
    env: { Path: shellEnv(decoy).PATH, ...safeEnv } });
  assert.deepEqual(Object.keys(launch.env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(launch.env.PATH, safeEnv.PATH);
  const result = resolveFixtureCommand(root, launch.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fake command');
  assert.equal(result.stderr, '');
});

test('missing lock contents on either side count as changed, and both missing are unchanged', () => {
  assert.equal(tooling().lockChanged('', '{}'), true);
  assert.equal(tooling().lockChanged('{}', ''), true);
  assert.equal(tooling().lockChanged('', ''), false);
});

test('missing lock files warn only when one side is missing and never prevent launch', async (t) => {
  for (const missing of [['origin/main'], ['fixture-sha'], ['origin/main', 'fixture-sha']]) {
    const setup = workflow(t);
    let launches = 0;
    const status = await tooling().main({ ...setup,
      run: (file, args, options) => {
        if (args[0] === 'ls-tree' && missing.includes(args[2])) return '';
        if (args[0] === 'show' && missing.includes(args[1].split(':')[0])) {
          throw new Error('fatal: package-lock.json does not exist in this revision');
        }
        return setup.run(file, args, options);
      },
      launch: async () => { launches++; return 0; } });
    assert.equal(status, 0);
    assert.equal(launches, 1);
    assert.equal(setup.messages.some(message => message.startsWith('WARNING: package-lock.json')), missing.length === 1);
  }
});

function signalWorkflow(t, platform) {
  const setup = workflow(t);
  const child = new EventEmitter();
  child.pid = 123;
  const stops = [];
  child.kill = signal => { stops.push(signal); };
  const fakeProcess = Object.assign(new EventEmitter(), { platform, env: setup.env, execPath: process.execPath });
  const script = path.join(__dirname, '../scripts/test-pr.js');
  const scriptRequire = createRequire(script);
  const module = { exports: {} };
  let createdHome;
  let cleanups = 0;
  const fakeFs = { ...fs, rmSync: (target, options) => {
    if (target === createdHome) cleanups++;
    fs.rmSync(target, options);
  } };
  const fakeChildProcess = {
    spawn: () => child,
    execFileSync: (file, args) => { stops.push([file, ...args]); },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { module, __dirname: path.dirname(script),
    process: fakeProcess, console, require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return fakeChildProcess;
      return scriptRequire(name);
    } }, { filename: script, timeout: 1000 });
  const result = module.exports.main({ ...setup, env: { ...setup.env, ISOLATED: '1' },
    fixtures: home => { createdHome = home; } });
  t.after(async () => { child.emit('close', 0); await result; });
  return { child, fakeProcess, stops, result, home: () => createdHome, cleanups: () => cleanups };
}

for (const platform of ['linux', 'win32']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`repeated ${signal} on ${platform} keeps forwarding until child exit and cleans HOME once`, async (t) => {
      const setup = signalWorkflow(t, platform);
      assert.equal(fs.existsSync(setup.home()), true);
      for (let i = 0; i < 2; i++) {
        assert.equal(setup.fakeProcess.emit(signal), true);
        assert.equal(setup.stops.length, i + 1);
        assert.equal(fs.existsSync(setup.home()), true);
        assert.equal(setup.cleanups(), 0);
      }
      if (platform === 'linux') assert.deepEqual(setup.stops, ['SIGTERM', 'SIGTERM']);
      else assert.deepEqual(setup.stops, [
        ['taskkill', '/pid', '123', '/T', '/F'], ['taskkill', '/pid', '123', '/T', '/F'],
      ]);
      setup.child.emit('close', 7);
      assert.equal(await setup.result, 7);
      setup.child.emit('close', 7);
      assert.equal(fs.existsSync(setup.home()), false);
      assert.equal(setup.cleanups(), 1);
      assert.equal(setup.fakeProcess.listenerCount('SIGINT'), 0);
      assert.equal(setup.fakeProcess.listenerCount('SIGTERM'), 0);
    });
  }
}


test('the package bundle script parses into the expected esbuild API options', () => {
  assert.deepEqual(tooling().parseBundleScript(bundleScript), bundleOptions);
});

test('the bundle parser supports multiple entries and refuses unsupported syntax', () => {
  assert.deepEqual(tooling().parseBundleScript('esbuild first.js second.js --bundle --outfile=out.js'),
    { entryPoints: ['first.js', 'second.js'], bundle: true, outfile: 'out.js' });
  for (const script of [
    'esbuild entry.js --unknown', 'esbuild entry.js --unknown=value',
    'esbuild entry.js --outfile=', 'esbuild entry.js --outfile out.js',
    'esbuild entry.js --bundle=false', 'esbuild entry.js --bundle --bundle',
    'esbuild entry.js --format=iife --format=cjs', 'esbuild "entry with spaces.js"',
    'esbuild entry.js && echo done', 'esbuild --bundle', '', 'npm run bundle:codemirror',
  ]) assert.throws(() => tooling().parseBundleScript(script), /Unsupported|entry point/);
});

for (const isolated of ['0', '1']) {
  test(`mode ISOLATED=${isolated} reads bundle options from the worktree package script`, async (t) => {
    const setup = workflow(t, 'esbuild public/other.js --bundle --outfile=public/other-bundle.js --format=cjs --platform=node');
    const worktree = path.join(setup.checkout, '.worktrees', 'pr-122-test');
    let builds = 0;
    await tooling().main({ ...setup, env: { ...setup.env, ISOLATED: isolated }, fixtures: () => {},
      run: (file, args, options) => {
        if (file !== process.execPath) return setup.run(file, args, options);
        evaluateBuild(file, args, worktree, options => {
          assert.deepEqual(options, { entryPoints: ['public/other.js'], bundle: true,
            outfile: 'public/other-bundle.js', format: 'cjs', platform: 'node' });
          builds++;
        });
      }, launch: async () => { assert.equal(builds, 1); return 0; } });
  });

  test(`mode ISOLATED=${isolated} rejects an unknown bundle flag before build or launch`, async (t) => {
    const setup = workflow(t, bundleScript + ' --unknown');
    await assert.rejects(tooling().main({ ...setup, env: { ...setup.env, ISOLATED: isolated },
      run: (file, args, options) => {
        assert.notEqual(file, process.execPath, 'unsupported options must prevent building');
        return setup.run(file, args, options);
      }, fixtures: () => assert.fail('unsupported options must prevent fixtures'),
      launch: async () => assert.fail('unsupported options must prevent launch') }),
    /Failed to build CodeMirror bundle.*Unsupported.*--unknown/);
  });
}
