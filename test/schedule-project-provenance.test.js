// test/schedule-project-provenance.test.js — a schedule runs only for a project
// whose path is the one its ~/.claude/projects folder is named after, and a
// sandboxed run binds no directory under $HOME that is not such a project.
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

const { scanSchedules, knownProjectPaths, refusedScheduleBinds } = require('../schedule-runner');
const { encodeProjectPath } = require('../encode-project-path');

const PROJECTS = path.join(ROOT, '.claude', 'projects');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function project(dir, { folder = encodeProjectPath(dir), cwd = dir } = {}) {
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'schedule-x.md'),
    '---\nname: X\ncron: * * * * *\n---\n\nDo it.\n');
  fs.mkdirSync(path.join(PROJECTS, folder), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, folder, 'seed.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');
}

function reset() {
  fs.rmSync(path.join(ROOT, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'work'), { recursive: true, force: true });
}

test('schedules: a project whose path matches its transcript folder is scanned', () => {
  reset();
  const p = path.join(ROOT, 'work', 'app');
  project(p);
  const found = scanSchedules();
  assert.deepEqual(found.map(s => s.projectPath), [p]);
  assert.deepEqual([...knownProjectPaths()], [p]);
});

test('schedules: a transcript whose cwd is not the path its folder is named after is not a project', () => {
  reset();
  const p = path.join(ROOT, 'work', 'app');
  const planted = path.join(p, 'sub');
  fs.mkdirSync(p, { recursive: true });
  project(planted, { folder: encodeProjectPath(p), cwd: planted });
  const lines = [];
  const found = scanSchedules({ warn: (...a) => lines.push(a.join(' ')), error: () => {}, info: () => {} });
  assert.deepEqual(found, [], 'a schedule planted below the project must not run');
  assert.deepEqual([...knownProjectPaths()], []);
  assert.ok(lines.some(l => l.includes(planted)), 'the refusal must be logged');
});

test('schedules: sandboxed add-dirs under $HOME must be a known project or inside one', () => {
  const home = '/home/u';
  const known = new Set(['/home/u/work/app', '/home/u/work/lib']);
  assert.deepEqual(refusedScheduleBinds(['/home/u/work/lib', '/home/u/work/app/docs', '/opt/data'], known, home), []);
  assert.deepEqual(
    refusedScheduleBinds(['/home/u/.local/bin', '/home/u/work', '/home/u/work/application'], known, home),
    ['/home/u/.local/bin', '/home/u/work', '/home/u/work/application']);
  assert.deepEqual(refusedScheduleBinds(['/home/u/work/app/../../.ssh'], known, home), ['/home/u/work/app/../../.ssh'],
    'the path is judged normalised');
});
