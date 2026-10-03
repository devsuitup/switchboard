'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tooling = () => require('../scripts/test-pr');

function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-pr-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the tasks delegate launch and cleanup to the cross-platform script', () => {
  const taskfile = fs.readFileSync(path.join(__dirname, '../Taskfile.yaml'), 'utf8');
  assert.match(taskfile, /node scripts\/test-pr\.js/);
  assert.match(taskfile, /node scripts\/test-pr\.js --clean/);
  assert.match(taskfile, /ISOLATED: /);
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
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: process.env });
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
  const launch = tooling().buildLaunch({ pr: '122', isolated: true, tempHome: root, env: process.env });
  tooling().prepareFixtures(root, launch.env);
  const fallback = path.join(root, 'fallback');
  fs.mkdirSync(fallback);
  fs.writeFileSync(path.join(fallback, 'claude.cmd'), '@echo fallback\r\n@exit /b 0\r\n');
  fs.writeFileSync(path.join(fallback, 'claude'), '#!/bin/sh\necho fallback\nexit 0\n', { mode: 0o755 });
  const safeEnv = { ...launch.env, PATH: launch.env.PATH.split(path.delimiter)[0] + path.delimiter + fallback };
  const commandShell = path.win32.isAbsolute(process.env.ComSpec || '') ? process.env.ComSpec
    : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const result = process.platform === 'win32'
    ? spawnSync(commandShell, ['/d', '/s', '/c', 'claude --resume fixture'], { cwd: root, env: safeEnv, encoding: 'utf8', timeout: 180000 })
    : spawnSync('/bin/sh', ['-c', 'claude --resume fixture'], { cwd: root, env: safeEnv, encoding: 'utf8', timeout: 180000 });
  assert.ifError(result.error);
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

function workflow(t) {
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
    if (args[0] === 'show') return JSON.stringify(lock());
    if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args[3], { recursive: true });
    return '';
  };
  const env = { ...process.env, PR: '122', HOME: home, USERPROFILE: home, ISOLATED: '0' };
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
