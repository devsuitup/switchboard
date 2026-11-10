'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolatedHome } = require('./fixtures/isolated-home.cjs');

const realHome = process.env.SWITCHBOARD_1064_REAL_HOME || os.homedir();

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
