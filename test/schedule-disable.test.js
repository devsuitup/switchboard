// setScheduleEnabled: archiving a folder writes `enabled: false` into its
// schedule files, the mechanism scanSchedules already reads.
// See .ai/contexts/schedule-runner.md ("Disabling a schedule file").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setScheduleEnabled, scanSchedules } = require('../schedule-runner');

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-disable-')));
  const project = path.join(root, 'p');
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  return { root, project, commands, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeSchedule(r, frontMatter, name = 'schedule-a.md') {
  const filePath = path.join(r.commands, name);
  fs.writeFileSync(filePath, '---\n' + frontMatter + '\n---\nRun the report.\n');
  return filePath;
}

function symlink(target, linkPath, type, t) {
  try { fs.symlinkSync(target, linkPath, type); return true; }
  catch { t.skip('cannot create a symlink on this machine'); return false; }
}

test('setScheduleEnabled: rewrites enabled: true to enabled: false and leaves every other byte', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'name: a\ncron: * * * * *\nenabled: true\nslug: a');
    assert.equal(scanSchedules(null, [r.project]).length, 1, 'precondition: the schedule is enabled');
    assert.deepEqual(setScheduleEnabled(filePath, false, { projectRoot: r.project }), { ok: true });
    assert.equal(fs.readFileSync(filePath, 'utf8'), '---\nname: a\ncron: * * * * *\nenabled: false\nslug: a\n---\nRun the report.\n');
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: inserts enabled: false as the first front-matter line when there is none', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '---\nenabled: false\ncron: * * * * *\n---\nRun the report.\n');
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: an enabled key inside a block is not the top-level key', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\ncli:\n  enabled: x\n  model: opus');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '---\nenabled: false\ncron: * * * * *\ncli:\n  enabled: x\n  model: opus\n---\nRun the report.\n');
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: refuses a symlinked schedule file and leaves its target as is', (t) => {
  const r = rig();
  try {
    const target = path.join(r.root, 'shared-schedule.md');
    const original = '---\ncron: * * * * *\nenabled: true\n---\nRun the report.\n';
    fs.writeFileSync(target, original);
    const filePath = path.join(r.commands, 'schedule-a.md');
    if (!symlink(target, filePath, 'file', t)) return;
    const res = setScheduleEnabled(filePath, false, { projectRoot: r.project });
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.ok(fs.lstatSync(filePath).isSymbolicLink(), 'the link must still be a link');
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: keeps the file mode', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX file modes'); return; }
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    fs.chmodSync(filePath, 0o640);
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.deepEqual(scanSchedules(null, [r.project]), []);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: an indented enabled line with no open block is the top-level key', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\n  enabled: true');
    assert.equal(scanSchedules(null, [r.project]).length, 1, 'precondition: the parser reads it as enabled');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: every duplicate enabled line is rewritten', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'enabled: false\ncron: * * * * *\nenabled: true');
    assert.equal(scanSchedules(null, [r.project]).length, 1, 'precondition: the last line wins');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: an enabled line the parser ignores gets a top-level line inserted', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true\r');
    assert.equal(scanSchedules(null, [r.project]).length, 1, 'precondition: the CR line is not read');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.deepEqual(scanSchedules(null, [r.project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: replaces the file rather than writing into it', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    const before = fs.statSync(filePath).ino;
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.notEqual(fs.statSync(filePath).ino, before);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: refuses a schedule reached through a symlinked commands directory', (t) => {
  const r = rig();
  try {
    const shared = path.join(r.root, 'dotfiles');
    fs.mkdirSync(shared);
    const original = '---\ncron: * * * * *\nenabled: true\n---\nRun the report.\n';
    fs.writeFileSync(path.join(shared, 'schedule-a.md'), original);
    fs.rmSync(r.commands, { recursive: true });
    if (!symlink(shared, r.commands, 'dir', t)) return;
    const res = setScheduleEnabled(path.join(r.commands, 'schedule-a.md'), false, { projectRoot: r.project });
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(path.join(shared, 'schedule-a.md'), 'utf8'), original);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: refuses a rewrite the parser does not read as disabled, and leaves the file', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    const original = fs.readFileSync(filePath, 'utf8');
    const res = setScheduleEnabled(filePath, false, { projectRoot: r.project, rewrite: (content) => content });
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: a project reached through a linked ancestor is disabled', (t) => {
  const r = rig();
  try {
    const link = path.join(r.root, 'link');
    if (!symlink(r.root, link, 'dir', t)) return;
    const project = path.join(link, 'p');
    const filePath = path.join(project, '.claude', 'commands', 'schedule-a.md');
    fs.writeFileSync(filePath, '---\ncron: * * * * *\nenabled: true\n---\nRun the report.\n');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: project }).ok, true);
    assert.deepEqual(scanSchedules(null, [project]), []);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: turns a disabled schedule back on and leaves every other byte', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'name: a\ncron: * * * * *\nenabled: false');
    assert.deepEqual(scanSchedules(null, [r.project]), [], 'precondition: the schedule is disabled');
    assert.deepEqual(setScheduleEnabled(filePath, true, { projectRoot: r.project }), { ok: true });
    assert.equal(fs.readFileSync(filePath, 'utf8'), '---\nname: a\ncron: * * * * *\nenabled: true\n---\nRun the report.\n');
    assert.equal(scanSchedules(null, [r.project]).length, 1);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: refuses a rewrite that changes the cron line or the prompt, and leaves the file', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    const original = fs.readFileSync(filePath, 'utf8');
    const cronChanged = (content) => content.replace('enabled: true', 'enabled: false').replace('cron: * * * * *', 'cron: 0 * * * *');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project, rewrite: cronChanged }).ok, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    const bodyChanged = (content) => content.replace('enabled: true', 'enabled: false').replace('Run the report.', 'Something else.');
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project, rewrite: bodyChanged }).ok, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: keeps a mode the umask would drop', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX file modes'); return; }
  const r = rig();
  try {
    const probe = path.join(r.root, 'umask-probe');
    fs.writeFileSync(probe, '', { mode: 0o666 });
    if ((fs.statSync(probe).mode & 0o777) === 0o666) { t.skip('the umask drops no bit'); return; }
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    fs.chmodSync(filePath, 0o666);
    assert.equal(setScheduleEnabled(filePath, false, { projectRoot: r.project }).ok, true);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o666);
  } finally { r.cleanup(); }
});

test('setScheduleEnabled: a failed replace leaves no temp file and the original in place', () => {
  const r = rig();
  try {
    const filePath = writeSchedule(r, 'cron: * * * * *\nenabled: true');
    const original = fs.readFileSync(filePath, 'utf8');
    const rename = () => { throw new Error('EPERM'); };
    const res = setScheduleEnabled(filePath, false, { projectRoot: r.project, rename });
    assert.deepEqual(res, { ok: false, error: 'EPERM' });
    assert.deepEqual(fs.readdirSync(r.commands), ['schedule-a.md']);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  } finally { r.cleanup(); }
});
