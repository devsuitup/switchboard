// test/schedule-project-provenance.test.js — schedules run only in projects
// Switchboard itself recorded, never in a path taken from a transcript, and a
// sandboxed schedule is sandboxed by the nearest project that contains it.
// see docs/sandbox.md ("Schedules")
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-provenance-')));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
delete process.env.SWITCHBOARD_DATA_DIR;

const {
  scanSchedules, initialScheduleProjects, refusedScheduleBinds, resolveScheduleSandbox, scheduleRegistry,
} = require('../schedule-runner');
const { encodeProjectPath } = require('../encode-project-path');

const PROJECTS = path.join(ROOT, '.claude', 'projects');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function withSchedule(dir) {
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'schedule-x.md'),
    '---\nname: X\ncron: * * * * *\n---\n\nDo it.\n');
}

function transcript(folder, cwd) {
  fs.mkdirSync(path.join(PROJECTS, folder), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, folder, 'seed.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');
}

function reset() {
  fs.rmSync(path.join(ROOT, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'work'), { recursive: true, force: true });
}

test('schedules: only projects in the registry are scanned', () => {
  reset();
  const app = path.join(ROOT, 'work', 'app');
  const other = path.join(ROOT, 'work', 'other');
  withSchedule(app);
  withSchedule(other);
  transcript(encodeProjectPath(other), other);
  assert.deepEqual(scanSchedules(undefined, [app]).map(s => s.projectPath), [app]);
  assert.deepEqual(scanSchedules(undefined, []), [], 'a transcript does not make a project');
  assert.deepEqual(scanSchedules(), [], 'no registry, no schedule');
});

test('schedules: a path whose encoding collides with a registered project\'s folder is not scanned', () => {
  reset();
  const apiClient = path.join(ROOT, 'api-client');
  const colliding = path.join(ROOT, 'api', 'client');
  withSchedule(colliding);
  fs.mkdirSync(apiClient, { recursive: true });
  assert.equal(encodeProjectPath(colliding), encodeProjectPath(apiClient), 'the rig must reproduce the collision');
  transcript(encodeProjectPath(apiClient), colliding);
  assert.deepEqual(scanSchedules(undefined, [apiClient]), []);
});

test('schedules: the registry is seeded once from the projects that already carry a schedule', () => {
  reset();
  const app = path.join(ROOT, 'work', 'app');
  const plain = path.join(ROOT, 'work', 'plain');
  const planted = path.join(ROOT, 'work', 'planted');
  withSchedule(app);
  withSchedule(planted);
  fs.mkdirSync(path.join(plain, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.claude', 'commands', 'review.md'), 'Review.\n');
  transcript(encodeProjectPath(app), app);
  transcript(encodeProjectPath(plain), plain);
  transcript('-some-other-folder', planted);
  assert.deepEqual(initialScheduleProjects(), [app],
    'neither a project without a schedule nor a transcript naming a path its folder is not named after');
});

test('schedules: a schedule is sandboxed by the nearest project setting that contains it', () => {
  const proj = path.resolve('/home/u/proj');
  const settings = {
    global: { sandbox: false },
    ['project:' + proj]: { sandbox: true },
    ['project:' + path.join(proj, 'sub', 'open')]: { sandbox: false },
  };
  const get = (key) => settings[key];
  assert.equal(resolveScheduleSandbox(proj, get, false), true);
  assert.equal(resolveScheduleSandbox(path.join(proj, 'sub'), get, false), true, 'a subdirectory inherits its project');
  assert.equal(resolveScheduleSandbox(path.join(proj, 'sub', 'open'), get, false), false, 'an explicit setting below wins');
  assert.equal(resolveScheduleSandbox(path.resolve('/home/u/projection'), get, false), false, 'a sibling with a common prefix does not');
  assert.equal(resolveScheduleSandbox(path.resolve('/elsewhere'), get, false), false, 'the global setting applies otherwise');
  assert.equal(resolveScheduleSandbox(path.resolve('/elsewhere'), () => undefined, true), true, 'then the default');
});

test('schedules: the registry is seeded only while it was never written, then changes only by add and remove', () => {
  const store = {};
  const get = (k) => store[k];
  const set = (k, v) => { store[k] = v; };
  const seeded = path.resolve('/p/seeded');
  const opened = path.resolve('/p/opened');
  let seeds = 0;
  const registry = scheduleRegistry(get, set, () => { seeds++; return [seeded]; });
  assert.deepEqual(registry.list(), [seeded]);
  registry.add(opened);
  registry.add(opened);
  registry.add(opened + path.sep + 'x' + path.sep + '..');
  registry.add('relative/path');
  assert.deepEqual(registry.list(), [seeded, opened], 'no duplicate (even unnormalised), no relative path');
  registry.remove(seeded);
  assert.deepEqual(registry.list(), [opened]);
  registry.remove(opened);
  assert.deepEqual(registry.list(), [], 'an emptied registry is not seeded again');
  assert.equal(seeds, 1);
});

test('schedules: sandboxed add-dirs under $HOME must be a registered project or inside one', () => {
  const home = '/home/u';
  const known = ['/home/u/work/app', '/home/u/work/lib'];
  assert.deepEqual(refusedScheduleBinds(['/home/u/work/lib', '/home/u/work/app/docs', '/opt/data'], known, home), []);
  assert.deepEqual(
    refusedScheduleBinds(['/home/u/.local/bin', '/home/u/work', '/home/u/work/application'], known, home),
    ['/home/u/.local/bin', '/home/u/work', '/home/u/work/application']);
  assert.deepEqual(refusedScheduleBinds(['/home/u/work/app/../../.ssh'], known, home), ['/home/u/work/app/../../.ssh'],
    'the path is judged normalised');
});
