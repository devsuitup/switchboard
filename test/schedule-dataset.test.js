'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../src/main/schedules/schedule-runner');
const { readScheduleRunResults } = require('../src/main/schedules/schedule-run-results');
const { encodeProjectPath } = require('../encode-project-path');
const { SCHEDULES, canSymlink, createDataset, gitEnv, parseArgs } = require('../scripts/schedule-dataset');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'schedule-dataset.js');
const NOW = Date.parse('2026-11-25T08:00:00Z');

function dataset(t, options) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-dataset-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const args = parseArgs([home, '--now', new Date(NOW).toISOString()]);
  return { home, args, ...createDataset(args, options) };
}

function transcripts(home, projectPath) {
  const folder = path.join(home, '.claude', 'projects', encodeProjectPath(projectPath));
  return fs.readdirSync(folder).map(file => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8').split('\n')[0]));
}

test('every fixture schedule is listed by the scheduler with its name, state and link', t => {
  const { projects, skipped, home } = dataset(t);
  assert.equal(skipped.length === 0, canSymlink(path.dirname(home)), 'the linked schedule is skipped only where links are refused');
  const listed = runner.listScheduleFiles(projects, { getSetting: () => ({}), defaultSandbox: false, home: os.homedir(), platform: 'linux' });
  const expected = Object.values(SCHEDULES).flat().filter(s => !skipped.includes(s.name));
  assert.deepEqual(listed.map(s => s.name).sort(), expected.map(s => s.name).sort());
  const byName = new Map(listed.map(s => [s.name, s]));
  for (const schedule of expected) {
    const row = byName.get(schedule.name);
    assert.equal(row.cron, schedule.cron, schedule.name);
    assert.equal(row.enabled, schedule.enabled !== false, schedule.name);
    assert.equal(row.linked, !!schedule.linked, schedule.name);
    assert.equal(row.catchUp, !!schedule.catchUp, schedule.name);
    assert.equal(row.runAsBackground, !!schedule.runAsBackground, schedule.name);
    assert.equal(row.readError ?? null, null, schedule.name);
  }
  assert.deepEqual(byName.get('Malformed expression').problems, ['cron can never match']);
  assert.equal(runner.nextCronMatch('*/15 * 31 2 *', NOW), null, 'the never-due fixture never fires');
});

test('every recorded run has a schedule transcript and, unless withheld, a result the listing reads as valid', t => {
  const { home, projects, runsDir, skipped } = dataset(t);
  for (const projectPath of projects) {
    const schedules = SCHEDULES[path.basename(projectPath)].filter(s => !skipped.includes(s.name));
    const rows = transcripts(home, projectPath);
    assert.equal(rows.filter(row => !row.scheduleSlug).length, 1, 'one Add project seed per project');
    const runs = rows.filter(row => row.scheduleSlug);
    assert.equal(runs.length, schedules.reduce((n, s) => n + (s.runs || []).length, 0));
    for (const row of runs) {
      assert.equal(row.cwd, projectPath);
      assert.match(row.message.content, /^Scheduled Task: /);
    }
    const results = readScheduleRunResults(runsDir, runs.map(row => row.sessionId));
    const withheld = schedules.flatMap(s => s.runs || []).filter(run => run.result === false).length;
    assert.equal(results.size, runs.length - withheld);
    for (const record of results.values()) assert.equal(record.unreadable, undefined);
  }
});

test('every enabled fixture schedule that can fire is due only between 03:00 and 03:59', t => {
  const { projects } = dataset(t);
  const listed = runner.listScheduleFiles(projects, { getSetting: () => ({}), defaultSandbox: false, home: os.homedir(), platform: 'linux' });
  for (const schedule of listed.filter(s => s.enabled && runner.nextCronMatch(s.cron, NOW) !== null)) {
    assert.equal(schedule.cron.split(/\s+/)[1], '3', schedule.name);
  }
});

test('the command refuses a directory that is not empty and prints usage without arguments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-dataset-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'keep'), '');
  const refused = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not empty/);
  assert.deepEqual(fs.readdirSync(root), ['keep']);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /^Usage: node scripts\/schedule-dataset\.js <fake-home>/);
});

test('without symbolic links the linked schedule is skipped and named, and the rest is written', t => {
  const { projects, skipped, home } = dataset(t, { symlinks: () => false });
  const linked = Object.values(SCHEDULES).flat().filter(s => s.linked);
  assert.deepEqual(skipped, linked.map(s => s.name));
  const listed = runner.listScheduleFiles(projects, { getSetting: () => ({}), defaultSandbox: false, home: os.homedir(), platform: 'linux' });
  assert.equal(listed.length, Object.values(SCHEDULES).flat().length - linked.length);
  assert.deepEqual(fs.readdirSync(path.join(home, 'shared')), []);
});

test('git runs without repository-routing variables, and dates before 2000 are refused', () => {
  assert.deepEqual(gitEnv({ PATH: '/bin', GIT_DIR: '/elsewhere', git_work_tree: '/w', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
  assert.throws(() => parseArgs(['/h', '--now', '1970-01-01T00:00:00Z']), /from 2000-01-01 on/);
  assert.throws(() => parseArgs(['/h', '--now', 'yesterday']), /--now must be a date/);
});
