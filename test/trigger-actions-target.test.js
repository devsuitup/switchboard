'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeProjectPath } = require('../encode-project-path');
const { resolveLocalTarget } = require('../src/main/triggers/trigger-actions');
const id = 'abcdef01-2345-6789-abcd-0123456789ab';

function rig(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v1-target-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const projectsDir = path.join(dir, 'transcripts');
  fs.mkdirSync(project);
  fs.mkdirSync(projectsDir);
  const folder = encodeProjectPath(project);
  fs.mkdirSync(path.join(projectsDir, folder));
  const transcript = path.join(projectsDir, folder, id + '.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: id, cwd: project }) + '\n');
  const snapshot = { allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} };
  const deps = { fs, projectsDir, getCachedSession: () => null, getCachedFolder: () => null,
    getProjectSnapshot: async () => snapshot, now: () => 0, deadline: 1000 };
  return { dir, project, projectsDir, folder, transcript, snapshot, deps };
}

test('strict resolver admits cold-cache readable local top-level transcript and canonical ID', async t => {
  const r = rig(t);
  const target = await resolveLocalTarget(id.toUpperCase(), r.deps);
  assert.equal(target.ok, true);
  assert.equal(target.sessionId, id);
  assert.equal(target.cwd, r.project);
  assert.equal(target.project, r.project);
  assert.equal(target.transcript, r.transcript);
});

for (const [name, change, reason, outcome = 'refused'] of [
  ['unknown', r => fs.unlinkSync(r.transcript), 'session not found', 'not-found'],
  ['known missing', r => { fs.unlinkSync(r.transcript); r.deps.getCachedSession = () => ({ folder: r.folder }); }, 'no readable transcript'],
  ['empty', r => fs.writeFileSync(r.transcript, ''), 'no readable transcript'],
  ['malformed', r => fs.writeFileSync(r.transcript, '{no json}\n'), 'no readable transcript'],
  ['no recorded cwd', r => fs.writeFileSync(r.transcript, '{"type":"user"}\n'), 'session cwd unavailable'],
  ['unverified cwd', r => fs.writeFileSync(r.transcript, JSON.stringify({ cwd: path.join(r.dir, 'other') }) + '\n'), 'session cwd unavailable'],
  ['non-regular', r => { fs.unlinkSync(r.transcript); fs.mkdirSync(r.transcript); }, 'no readable transcript'],
  ['duplicate folder', r => { const folder = path.join(r.projectsDir, 'another'); fs.mkdirSync(folder); fs.copyFileSync(r.transcript, path.join(folder, id.toUpperCase() + '.jsonl')); }, 'ambiguous session transcript'],
  ['unknown project', r => { r.snapshot.allProjects = []; }, 'unknown project'],
  ['missing cwd directory', r => fs.rmdirSync(r.project), 'project directory does not exist'],
  ['project snapshot failure', r => { r.deps.getProjectSnapshot = async () => { throw new Error('snapshot broke'); }; }, 'project lookup unavailable'],
  ['missing settings provenance', r => { delete r.snapshot.hiddenProjects; }, 'project lookup unavailable'],
  ['cache read error', r => { r.deps.getCachedSession = () => { throw new Error('cache broke'); }; }, 'no readable transcript'],
  ['remote cache', r => { fs.unlinkSync(r.transcript); r.deps.getCachedSession = () => ({ folder: 'server::' + r.folder }); }, 'remote sessions are not supported'],
  ['deadline elapsed', r => { r.deps.now = () => 1000; }, 'session action timed out'],
]) {
  test(`strict resolver: ${name}`, async t => {
    const r = rig(t);
    change(r);
    const result = await resolveLocalTarget(id, r.deps);
    assert.equal(result.reason, reason);
    assert.equal(result.outcome, outcome);
    assert.equal(result.ok, false);
  });
}

test('strict resolver ignores nested subagents and remote mirror folders', async t => {
  const r = rig(t);
  fs.unlinkSync(r.transcript);
  const nested = path.join(r.projectsDir, r.folder, 'subagents');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, id + '.jsonl'), '{}');
  assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'session not found');
});

test('strict resolver refuses unreadable local transcript and directory listing errors', async t => {
  const r = rig(t);
  const deny = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  r.deps.fs = { ...fs, openSync: deny };
  assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'no readable transcript');
  r.deps.fs = { ...fs, readdirSync: deny };
  assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'no readable transcript');
});

for (const kind of ['archive', 'delete', undefined]) {
  test(`settings hidden ${kind} precedes membership and missing directory`, async t => {
    const r = rig(t);
    r.snapshot.hiddenProjects = [r.project];
    if (kind) r.snapshot.hiddenProjectKinds[r.project] = kind;
    r.snapshot.allProjects = [];
    fs.rmdirSync(r.project);
    assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'project is archived');
  });
}

test('group archive and kind-only metadata allow a known project', async t => {
  const r = rig(t);
  r.snapshot.archivedProjects = [r.project];
  r.snapshot.hiddenProjectKinds[r.project] = 'archive';
  assert.equal((await resolveLocalTarget(id, r.deps)).ok, true);
  r.snapshot.hiddenProjects = ['server:' + r.project];
  assert.equal((await resolveLocalTarget(id, r.deps)).ok, true);
});

test('recorded worktree cwd remains separate from the known project root', async t => {
  const r = rig(t);
  const cwd = path.join(r.project, '.worktrees', 'next');
  fs.mkdirSync(cwd, { recursive: true });
  fs.unlinkSync(r.transcript);
  const folder = encodeProjectPath(cwd);
  fs.mkdirSync(path.join(r.projectsDir, folder));
  fs.writeFileSync(path.join(r.projectsDir, folder, id + '.jsonl'), JSON.stringify({ cwd }) + '\n');
  const target = await resolveLocalTarget(id, r.deps);
  assert.equal(target.ok, true);
  assert.equal(target.cwd, cwd);
  assert.equal(target.project, r.project);
  fs.rmdirSync(cwd);
  assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'project directory does not exist');
});

test('a known worktree project remains eligible when only its repository ancestor is hidden', async t => {
  const r = rig(t);
  const cwd = path.join(r.project, '.worktrees', 'independent');
  fs.mkdirSync(cwd, { recursive: true });
  fs.unlinkSync(r.transcript);
  const folder = encodeProjectPath(cwd);
  fs.mkdirSync(path.join(r.projectsDir, folder));
  fs.writeFileSync(path.join(r.projectsDir, folder, id + '.jsonl'), JSON.stringify({ cwd }) + '\n');
  r.snapshot.hiddenProjects = [r.project];
  r.snapshot.hiddenProjectKinds[r.project] = 'delete';
  r.snapshot.allProjects = [{ projectPath: cwd }];
  const target = await resolveLocalTarget(id, r.deps);
  assert.equal(target.ok, true, 'hidden repository membership must not deny a distinct known worktree project');
  assert.equal(target.project, cwd);
  assert.equal(target.cwd, cwd);
});

test('a disappearing directory listing is a read refusal rather than unknown absence', async t => {
  const r = rig(t);
  r.deps.fs = { ...fs, readdirSync() { throw Object.assign(new Error('directory disappeared'), { code: 'ENOENT' }); } };
  assert.equal((await resolveLocalTarget(id, r.deps)).reason, 'no readable transcript');
});

for (const port of ['getCachedSession', 'getCachedFolder', 'getProjectSnapshot']) {
  test(`strict resolver bounds an unresolved ${port} with the injected deadline`, async t => {
    const r = rig(t);
    let now = 0;
    const timers = new Set();
    r.deps.now = () => now;
    r.deps.setTimeout = (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; };
    r.deps.clearTimeout = timer => timers.delete(timer);
    r.deps[port] = () => new Promise(() => {});
    let result;
    const pending = resolveLocalTarget(id, r.deps).then(value => { result = value; });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    now = 1000;
    for (const timer of [...timers]) if (timer.at <= now) timer.fn();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(result?.reason, 'session action timed out');
    assert.equal(result.ok, false);
    await pending;
    assert.equal(timers.size, 0, 'deadline timers are released');
  });
}
