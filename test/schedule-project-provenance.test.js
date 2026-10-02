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
  scanSchedules, initialScheduleProjects, refusedScheduleBinds, scheduleBindRefusals, resolveScheduleSandbox, scheduleRegistry,
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

test('schedules: the seed holds only the projects that carry a per-project setting', () => {
  reset();
  const configured = path.join(ROOT, 'work', 'configured');
  const folderOnly = path.join(ROOT, 'work', 'folder-only');
  const planted = path.join(ROOT, 'work', 'planted');
  for (const dir of [configured, folderOnly, planted]) withSchedule(dir);
  transcript(encodeProjectPath(configured), configured);
  transcript(encodeProjectPath(folderOnly), folderOnly);
  transcript(encodeProjectPath(planted), planted);
  const keys = ['global', 'project:' + configured, 'project:relative/dir', 'db_version'];
  assert.deepEqual(initialScheduleProjects(() => keys), [configured],
    'a transcript folder registers nothing, whatever its path or schedule; only an absolute project: key does');
});

test('schedules: a transcript folder alone does not enter the registry at its first read', () => {
  reset();
  const planted = path.join(ROOT, 'work', 'planted');
  withSchedule(planted);
  transcript(encodeProjectPath(planted), planted);
  const store = {};
  const registry = scheduleRegistry(k => store[k], (k, v) => { store[k] = v; },
    () => initialScheduleProjects(() => []));
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(scanSchedules(undefined, registry.list()), []);
});

test('schedules: a project launched from the app is registered after a seed that left it out', () => {
  const store = {};
  const registry = scheduleRegistry(k => store[k], (k, v) => { store[k] = v; }, () => []);
  const launched = path.resolve('/p/launched');
  assert.deepEqual(registry.list(), []);
  registry.add(launched);
  assert.deepEqual(registry.list(), [launched]);
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

test('schedules: an add-dir at or under a .claude or .git is refused, even inside a registered project', () => {
  reset();
  const home = ROOT;
  const app = path.join(ROOT, 'work', 'app');
  fs.mkdirSync(path.join(app, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(app, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
  const known = [app];
  const refused = [
    path.join(app, '.claude'),
    path.join(app, '.claude') + path.sep,
    path.join(app, '.claude', 'commands'),
    path.join(app, '.claude', 'missing'),
    path.join(app, '.git'),
    path.join(app, '.git', 'hooks'),
    path.join(app, 'sub', '..', '.claude'),
    path.join(app, 'sub', '.claude'),
  ];
  assert.deepEqual(refusedScheduleBinds(refused, known, home), refused);
  const allowed = [app, path.join(app, 'sub'), path.join(app, '.claude', '..'), path.join(app, '.claude-notes'), path.join(app, 'x.git')];
  assert.deepEqual(refusedScheduleBinds(allowed, known, home), []);
  assert.deepEqual(refusedScheduleBinds([path.join(path.dirname(ROOT), 'elsewhere', '.claude')], known, home),
    [path.join(path.dirname(ROOT), 'elsewhere', '.claude')], 'outside $HOME too');
});

test('schedules: an add-dir that is a symbolic link to a .claude, or out of a project into $HOME, is judged by its target', (t) => {
  reset();
  const home = ROOT;
  const app = path.join(ROOT, 'work', 'app');
  fs.mkdirSync(path.join(app, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.ssh'), { recursive: true });
  const toClaude = path.join(app, 'link-claude');
  const toSsh = path.join(app, 'link-ssh');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const viaOutside = path.join(outside, 'to-ssh');
  try {
    fs.symlinkSync(path.join(app, '.claude'), toClaude, 'junction');
    fs.symlinkSync(path.join(ROOT, '.ssh'), toSsh, 'junction');
    fs.symlinkSync(path.join(ROOT, '.ssh'), viaOutside, 'junction');
  } catch (err) {
    t.skip(`cannot create links here: ${err.code}`);
    return;
  }
  const known = [app];
  assert.deepEqual(refusedScheduleBinds([toClaude, toSsh], known, home), [toClaude, toSsh]);
  assert.deepEqual(refusedScheduleBinds([viaOutside], known, home), [viaOutside], 'a link from outside $HOME into it');
  const movedClaude = path.join(ROOT, 'work', 'app2');
  fs.mkdirSync(movedClaude, { recursive: true });
  fs.symlinkSync(outside, path.join(movedClaude, '.claude'), 'junction');
  const asSpelled = path.join(movedClaude, '.claude');
  assert.deepEqual(refusedScheduleBinds([asSpelled], known, home), [asSpelled], 'a .claude that links elsewhere is refused as spelled');
});

test('schedules: a relative cwd is judged from its resolved path', () => {
  const proj = path.resolve('rel-proj-385');
  const get = (key) => (key === 'project:' + proj ? { sandbox: true } : undefined);
  assert.equal(resolveScheduleSandbox('rel-proj-385', get, false), true);
  assert.equal(resolveScheduleSandbox(path.join('rel-proj-385', 'sub', '..', 'sub'), get, false), true);
});

test('schedules: a relative add-dir is taken from the schedule\'s directory, and the refusal says why', () => {
  const home = path.resolve('/home/u');
  const app = path.resolve('/home/u/work/app');
  const known = [app];
  assert.deepEqual(refusedScheduleBinds(['sub', './docs'], known, home, app), []);
  assert.deepEqual(refusedScheduleBinds(['../../.ssh', '../lib'], known, home, app), ['../../.ssh', '../lib']);
  assert.deepEqual(refusedScheduleBinds(['../app/sub'], known, home, path.resolve('/home/u/work/other')), []);
  assert.deepEqual(
    scheduleBindRefusals(['.claude', '../../.ssh', 'sub'], known, home, app),
    [
      { dir: '.claude', reason: 'at or inside a .claude or .git directory' },
      { dir: '../../.ssh', reason: 'under the home directory and not a Switchboard project' },
    ]);
});
