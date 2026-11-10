'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { isolatedHome } = require('./fixtures/isolated-home.cjs');
const { encodeProjectPath } = require('../encode-project-path');

const realHome = process.env.SWITCHBOARD_TEST_REAL_HOME || os.homedir();

function guardedHome(t, { externalProject = false } = {}) {
  const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-real-'));
  const hooks = [];
  const projects = [];
  const home = isolatedHome({ after: hook => hooks.push(hook) }, { realHome: fakeRealHome, projects: () => projects });
  t.after(() => {
    fs.rmSync(path.join(fakeRealHome, '.claude'), { recursive: true, force: true });
    try { hooks.forEach(hook => hook()); }
    finally { fs.rmSync(fakeRealHome, { recursive: true, force: true }); }
  });
  home.install();
  const project = path.join(externalProject ? fakeRealHome : home.home, 'project');
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(commands, 'schedule-guard.md'), '---\ncron: * * * * *\n---\nPrompt');
  const runner = require('../src/main/schedules/schedule-runner');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 10, 8, 9, 14, 30).getTime() });
  const stop = runner.startScheduler({ info() {}, warn() {}, error() {} }, (argv, cwd, name, done) => {
    projects.push(cwd);
    done();
  }, { projects: () => [project] });
  t.after(stop);
  t.mock.timers.tick(30000);
  assert.deepEqual(projects, [project], 'the shipped scheduler must fire the guarded project');
  return { home, project, fakeRealHome, hooks };
}

test('an unrelated project created concurrently does not fail the home guard', async t => {
  const { home, project, fakeRealHome, hooks } = guardedHome(t);
  const projectsDir = path.join(fakeRealHome, '.claude', 'projects');
  const worker = new Worker(path.join(__dirname, 'fixtures/project-folder-writer.cjs'), {
    workerData: path.join(projectsDir, 'unrelated-live-cli-project'),
  });
  const exited = once(worker, 'exit');
  worker.postMessage('create');
  assert.equal((await exited)[0], 0, 'the concurrent writer must finish');
  assert.doesNotThrow(() => home.assertProjects([project]), 'unrelated CLI activity must not fail isolation');
  assert.doesNotThrow(() => hooks.shift()(), 'the final hook must also allow unrelated CLI activity');
});

test('an unrelated project removed during a run does not fail the home guard', t => {
  const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-real-'));
  const unrelated = path.join(fakeRealHome, '.claude', 'projects', 'unrelated-live-cli-project');
  fs.mkdirSync(unrelated, { recursive: true });
  const hooks = [];
  const home = isolatedHome({ after: hook => hooks.push(hook) }, { realHome: fakeRealHome });
  t.after(() => {
    try { hooks.forEach(hook => hook()); }
    finally { fs.rmSync(fakeRealHome, { recursive: true, force: true }); }
  });
  fs.rmSync(unrelated, { recursive: true });
  assert.doesNotThrow(() => home.assertProjects([]), 'unrelated CLI deletion must not fail isolation');
});

test('a fired project leaked into a fake real home fails the final guard', t => {
  const { project, fakeRealHome, hooks } = guardedHome(t, { externalProject: true });
  fs.mkdirSync(path.join(fakeRealHome, '.claude', 'projects', encodeProjectPath(project)), { recursive: true });
  assert.throws(() => hooks.shift()(), /real home/, 'the final hook must report a leaked fired project');
});

test('a temporary-root project absent from the fired list fails the final guard', t => {
  const { fakeRealHome, hooks } = guardedHome(t);
  const unlisted = path.join(os.tmpdir(), 'sb-preloaded-home-regression', 'unlisted-project');
  fs.mkdirSync(path.join(fakeRealHome, '.claude', 'projects', encodeProjectPath(unlisted)), { recursive: true });
  assert.throws(() => hooks.shift()(), /real home/, 'the final hook must reject temporary-root leaks outside the fired list');
});

test('the real-home override guards a fake home without an explicit option', t => {
  const { home, project, fakeRealHome } = guardedHome(t);
  const previous = process.env.SWITCHBOARD_TEST_REAL_HOME;
  process.env.SWITCHBOARD_TEST_REAL_HOME = fakeRealHome;
  const hooks = [];
  const overridden = isolatedHome({ after: hook => hooks.push(hook) });
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TEST_REAL_HOME;
    else process.env.SWITCHBOARD_TEST_REAL_HOME = previous;
    hooks.forEach(hook => hook());
  });
  const leaked = path.join(fakeRealHome, '.claude', 'projects', encodeProjectPath(project));
  fs.mkdirSync(leaked, { recursive: true });
  try {
    assert.throws(() => overridden.assertProjects([]), /real home must not contain test project/,
      'SWITCHBOARD_TEST_REAL_HOME must point the guard at the fake real home');
  } finally {
    fs.rmSync(leaked, { recursive: true });
  }
  home.assertProjects([project]);
});

test('a runner loaded before home isolation fires only into the new disposable home', t => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const original = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preloaded-home-')));
  process.env.HOME = original;
  process.env.USERPROFILE = original;
  require('../src/main/schedules/schedule-runner');
  const isolated = isolatedHome(t, { realHome });
  isolated.install();
  t.after(() => {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(original, { recursive: true, force: true });
  });
  const runner = require('../src/main/schedules/schedule-runner');
  const project = path.join(isolated.home, 'project');
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(commands, 'schedule-test.md'), '---\ncron: * * * * *\n---\nPrompt');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 10, 8, 9, 14, 30).getTime() });
  const runs = [];
  const stop = runner.startScheduler({ info() {}, warn() {}, error() {} }, (...args) => {
    runs.push(args);
    args[3]();
  }, { projects: () => [project] });
  t.mock.timers.tick(30000);
  stop();
  assert.equal(runs.length, 1, 'the real scheduler must fire once');
  const originalProjects = path.join(original, '.claude', 'projects');
  t.diagnostic(`preloaded home folders: ${JSON.stringify(fs.existsSync(originalProjects) ? fs.readdirSync(originalProjects) : [])}`);
  isolated.assertProjects([project]);
  assert.deepEqual(fs.existsSync(originalProjects) ? fs.readdirSync(originalProjects) : [], [],
    'the home captured by the preloaded runner must stay empty');
});
