'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localGitEnv } = require('../src/main/changes/git-changes-runner');
const shared = require('../worktree-delete');
let implementation;
try { implementation = require('../src/main/projects/project-delete-worktrees'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function gitFixture(t) {
  assert.equal(typeof implementation?.createProjectDeleteWorktrees, 'function', 'production linked-worktree adapter must exist');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-e-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...localGitEnv(), GIT_CONFIG_GLOBAL: path.join(root, 'no-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const commands = [], git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  git(['init', '-q', '--template=']); fs.writeFileSync(path.join(root, 'tracked'), 'base');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const target = path.join(root, 'linked é'), kept = path.join(root, 'kept');
  git(['worktree', 'add', '-qb', 'topic', target]); git(['worktree', 'add', '-qb', 'keep', kept]);
  const state = { sessions: [], candidates: [], jobs: [] };
  const runGit = async (args, consume) => { commands.push(args); return consume ? shared.streamGit(args, consume, { env }) : git(args); };
  const adapter = implementation.createProjectDeleteWorktrees({ runGit, readActivity: async () => ({ complete: true, ...state }) });
  const project = { alias: null, projectPath: root };
  const budget = () => ({ signal: new AbortController().signal, deadline: Date.now() + 15000, limit: 20000 });
  return { root, target, kept, state, commands, adapter, project, budget };
}

test('E real Git discovery lists main, branch, dirty/untracked bytes; removes exactly the reviewed linked directory', async t => {
  const f = gitFixture(t);
  fs.writeFileSync(path.join(f.target, 'untracked'), 'discard');
  let rows;
  await assert.doesNotReject(async () => { rows = await f.adapter.preview(f.project, f.budget()); }, 'installed Git must support worktree inventory');
  assert.equal(rows.find(row => row.main).removable, false);
  const selected = rows.find(row => path.resolve(row.path) === f.target);
  assert.equal(selected.branch, 'topic'); assert.equal(selected.removable, true);
  assert.ok(selected.dirty.some(line => line.includes('untracked')));
  const results = [];
  assert.equal(await f.adapter.remove(f.project, [selected], row => results.push(row)), true);
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(f.kept), true);
  assert.equal(fs.readFileSync(path.join(f.root, 'tracked'), 'utf8'), 'base');
  assert.deepEqual(results.map(row => row.state), ['removed']);
  assert.equal(f.commands.filter(args => args.includes('remove')).length, 1);
});

test('E real Git changed contents and new live sessions refuse before any disk removal', async t => {
  const f = gitFixture(t);
  fs.writeFileSync(path.join(f.target, 'untracked'), 'old');
  const rows = await f.adapter.preview(f.project, f.budget()), selected = rows.find(row => path.resolve(row.path) === f.target);
  fs.writeFileSync(path.join(f.target, 'untracked'), 'new');
  assert.equal(await f.adapter.remove(f.project, [selected], () => {}), false);
  assert.equal(fs.existsSync(f.target), true);
  const fresh = (await f.adapter.preview(f.project, f.budget())).find(row => path.resolve(row.path) === f.target);
  f.state.sessions.push({ sessionId: 'live', cwd: f.target });
  assert.equal(await f.adapter.remove(f.project, [fresh], () => {}), false);
  assert.equal(f.commands.some(args => args.includes('remove')), false, 'late activity must prevent Git removal');
  const blocked = (await f.adapter.preview(f.project, f.budget())).find(row => path.resolve(row.path) === f.target);
  assert.equal(blocked.removable, false); assert.equal(blocked.sessions[0].sessionId, 'live');
});
