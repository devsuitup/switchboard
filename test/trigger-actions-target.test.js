'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkProject } = require('../src/main/triggers/trigger-actions');

const project = '/work/project';
const snapshot = (hiddenProjects = [], allProjects = [{ projectPath: project }]) => ({
  allProjects, global: { hiddenProjects, hiddenProjectKinds: {} },
});

test('settings-hidden projects take precedence over membership and directory existence', async () => {
  for (const kind of ['archive', 'delete', undefined]) {
    const state = snapshot([project], []);
    if (kind) state.global.hiddenProjectKinds[project] = kind;
    assert.equal(await checkProject(project, async () => state, () => false), 'project is archived');
  }
});

test('group archive, kind-only and remote entries do not hide a known local project', async () => {
  const state = snapshot(['remote:/work/project']);
  state.archivedProjects = { [project]: {} };
  state.global.hiddenProjectKinds[project] = 'archive';
  assert.equal(await checkProject(project, async () => state, () => true), null);
  assert.equal(await checkProject('/work/unknown', async () => state, () => false), 'unknown project');
  assert.equal(await checkProject(project, async () => state, () => false), 'project directory does not exist');
});

test('unavailable project snapshot or provenance refuses admission', async () => {
  assert.equal(await checkProject(project, async () => { throw new Error('unavailable'); }, () => true), 'project lookup unavailable');
  assert.equal(await checkProject(project, async () => ({ allProjects: [] }), () => true), 'project lookup unavailable');
});

// ── Strict closed-session resolver and refusals before any lifecycle call ──
const fsx = require('node:fs');
const pathx = require('node:path');
const { resolveClosedTarget } = require('../src/main/triggers/trigger-actions');
const { extractVerifiedCwdFromJsonl, resolveWorktreePath } = require('../derive-project-path');
const { tempRoot, ID_A: SID_A } = require('./helpers/trigger-world');
const { arrange } = require('./helpers/trigger-flow');
const { makeProc } = require('./helpers/fake-proc');
const realCli = require('../cli-session-state');

function transcriptRoot(t) {
  const root = tempRoot(t);
  const projects = pathx.join(root, 'projects');
  const cwd = pathx.join(root, 'work');
  fsx.mkdirSync(cwd, { recursive: true });
  const folderOf = dir => dir.replace(/[^a-zA-Z0-9]/g, '-');
  const write = (id, { folder = folderOf(cwd), cwdLine = cwd, name = `${id}.jsonl`, content } = {}) => {
    fsx.mkdirSync(pathx.join(projects, folder), { recursive: true });
    fsx.writeFileSync(pathx.join(projects, folder, name), content ?? JSON.stringify({ type: 'user', sessionId: id, cwd: cwdLine, message: { role: 'user', content: 'hi' } }) + '\n');
  };
  const deps = (extra = {}) => ({ projectsDir: projects, getCachedSession: () => null, getCachedFolder: () => null, isRemoteFolder: () => false,
    extractVerifiedCwd: extractVerifiedCwdFromJsonl, resolveWorktreePath, ...extra });
  return { root, projects, cwd, write, deps };
}

test('resolver: a readable transcript missing from the cache resolves to its recorded cwd and project root', t => {
  const r = transcriptRoot(t);
  r.write(SID_A);
  const found = resolveClosedTarget(SID_A.toUpperCase(), r.deps());
  assert.equal(found.status, 'found');
  assert.equal(found.sessionId, SID_A);
  assert.equal(found.cwd, r.cwd);
  assert.equal(found.projectPath, r.cwd);
});

test('resolver: a worktree cwd keeps its recorded cwd and maps to the repository root', t => {
  const r = transcriptRoot(t);
  const worktree = pathx.join(r.cwd, '.claude', 'worktrees', 'wt');
  fsx.mkdirSync(worktree, { recursive: true });
  r.write(SID_A, { folder: worktree.replace(/[^a-zA-Z0-9]/g, '-'), cwdLine: worktree });
  const found = resolveClosedTarget(SID_A, r.deps());
  assert.equal(found.cwd, worktree);
  assert.equal(found.projectPath, r.cwd);
});

test('resolver: unknown id, known id without transcript, empty, directory and unverified-cwd transcripts', t => {
  const r = transcriptRoot(t);
  assert.deepEqual(resolveClosedTarget(SID_A, r.deps()), { status: 'unknown' });
  assert.deepEqual(resolveClosedTarget(SID_A, r.deps({ getCachedSession: () => ({ sessionId: SID_A }) })), { status: 'refused', reason: 'no readable transcript' });
  r.write(SID_A, { content: '' });
  assert.equal(resolveClosedTarget(SID_A, r.deps()).reason, 'no readable transcript');
  const dirId = '11111111-2222-3333-4444-555555555555';
  fsx.mkdirSync(pathx.join(r.projects, 'x', `${dirId}.jsonl`), { recursive: true });
  assert.equal(resolveClosedTarget(dirId, r.deps()).reason, 'no readable transcript');
  const lie = '22222222-2222-3333-4444-555555555555';
  r.write(lie, { cwdLine: '/somewhere/else' });
  assert.equal(resolveClosedTarget(lie, r.deps()).reason, 'session cwd unavailable');
  const bad = '33333333-2222-3333-4444-555555555555';
  r.write(bad, { content: 'not json\n' });
  assert.equal(resolveClosedTarget(bad, r.deps()).reason, 'no readable transcript');
});

test('resolver: duplicate transcripts across folders or by case are ambiguous, never the first one', t => {
  const r = transcriptRoot(t);
  r.write(SID_A);
  r.write(SID_A, { folder: 'other-folder' });
  assert.equal(resolveClosedTarget(SID_A, r.deps()).reason, 'ambiguous session transcript');
  const q = transcriptRoot(t);
  q.write(SID_A);
  q.write(SID_A, { name: `${SID_A.toUpperCase()}.jsonl` });
  assert.equal(resolveClosedTarget(SID_A, q.deps()).reason, 'ambiguous session transcript');
});

test('resolver: remote cache rows are remote, a cache exception and an expired deadline are refusals, never absence', t => {
  const r = transcriptRoot(t);
  r.write(SID_A);
  assert.equal(resolveClosedTarget(SID_A, r.deps({ getCachedFolder: () => 'host::x', isRemoteFolder: () => true })).status, 'remote');
  assert.equal(resolveClosedTarget(SID_A, r.deps({ getCachedSession: () => { throw new Error('db'); } })).reason, 'project lookup unavailable');
  assert.equal(resolveClosedTarget(SID_A, r.deps({ deadline: 5, now: () => 10 })).reason, 'session action timed out');
});

test('resolver: a transcript denied to the reader is a refusal', t => {
  const r = transcriptRoot(t);
  r.write(SID_A);
  const file = pathx.join(r.projects, fsx.readdirSync(r.projects)[0], `${SID_A}.jsonl`);
  fsx.chmodSync(file, 0);
  assert.equal(resolveClosedTarget(SID_A, r.deps()).reason, 'no readable transcript');
  fsx.chmodSync(file, 0o644);
});

function refusalFlow(t, options) {
  const calls = [];
  const a = arrange(t, { ...options, deps: { bridge: { waitReady: async () => ({ ok: true }), ensureOpen: async op => { calls.push(op); return { ok: false, reason: 'unexpected' }; } }, ...options.deps } });
  return { ...a, calls };
}

test('hidden or removed settings entries refuse new and resume before membership, directory and lifecycle', async t => {
  for (const kind of ['archive', 'delete', undefined]) {
    const hidden = { allProjects: [], global: { hiddenProjects: ['/work/project'], hiddenProjectKinds: kind ? { '/work/project': kind } : {} }, archivedProjects: { '/work/project': {} } };
    const a = refusalFlow(t, { deps: { getSnapshot: async () => hidden, directoryExists: () => false } });
    const resume = await a.submit({ version: 1, action: 'open', sessionId: SID_A });
    const created = await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'x' });
    for (const result of [resume, created]) { assert.equal(result.outcome, 'refused'); assert.equal(result.reason, 'project is archived'); }
    assert.deepEqual(a.calls, []);
  }
});

test('an archived group still in allProjects, a worktree of a hidden repository and unknown paths', async t => {
  const snapshot = { allProjects: [{ projectPath: '/work/project' }, { projectPath: '/work/project/.claude/worktrees/wt' }], global: { hiddenProjects: ['/work'], hiddenProjectKinds: {} }, archivedProjects: { '/work/project': {} } };
  const a = arrange(t, { deps: { getSnapshot: async () => snapshot } });
  assert.equal((await a.submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'x' })).outcome, 'opened');
  const unknown = await a.submit({ version: 1, action: 'open', new: { project: '/nowhere', name: 'n' }, prompt: 'x' });
  assert.equal(unknown.reason, 'unknown project');
  const broken = await arrange(t, { deps: { getSnapshot: async () => ({ allProjects: [] }) } }).submit({ version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'x' });
  assert.equal(broken.reason, 'project lookup unavailable');
});

test('a missing recorded cwd is refused without falling back to the parent', async t => {
  const a = refusalFlow(t, { deps: { directoryExists: dir => dir !== '/work/project/.claude/worktrees/wt',
    resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project/.claude/worktrees/wt', projectPath: '/work/project' }) } });
  const result = await a.submit({ version: 1, action: 'open', sessionId: SID_A });
  assert.equal(result.reason, 'project directory does not exist');
  assert.deepEqual(a.calls, []);
});

test('transcript, remote and plain-terminal refusals reach the caller with zero lifecycle calls', async t => {
  const cases = [
    [{ resolveClosed: async () => ({ status: 'refused', reason: 'no readable transcript' }) }, 'refused', 'no readable transcript'],
    [{ resolveClosed: async () => ({ status: 'unknown' }) }, 'not-found', 'session not found'],
    [{ resolveClosed: async () => ({ status: 'refused', reason: 'ambiguous session transcript' }) }, 'refused', 'ambiguous session transcript'],
    [{ isRemoteTarget: async () => true }, 'refused', 'remote sessions are not supported'],
    [{ isRemoteTarget: async () => { throw new Error('x'); } }, 'refused', 'session liveness unavailable'],
    [{ liveV1: async () => ({ known: false, reason: 'x' }) }, 'refused', 'session liveness unavailable'],
    [{ liveV1: async () => ({ known: true, live: { kind: 'schedule' } }) }, 'refused', 'scheduled session is not supported'],
    [{ liveV1: async () => ({ known: true, live: { kind: 'bg' } }) }, 'refused', 'background session is not supported'],
    [{ liveV1: async () => ({ known: true, live: { kind: 'interactive' } }) }, 'refused', 'session live elsewhere'],
  ];
  for (const [deps, outcome, reason] of cases) {
    const a = refusalFlow(t, { deps });
    const result = await a.submit({ version: 1, action: 'open', sessionId: SID_A, prompt: 'x' });
    assert.equal(result.outcome, outcome, reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(a.calls, [], reason);
    assert.deepEqual(a.events.filter(event => event[0] === 'write'), [], reason);
  }
  for (const [flag, reason] of [['isPlainTerminal', 'plain terminal sessions are not supported'], ['host', 'remote sessions are not supported'], ['isAttach', 'background session is not supported'], ['backgrounded', 'background session is not supported']]) {
    const a = refusalFlow(t, {});
    a.world.addSession(SID_A, { [flag]: flag === 'host' ? 'vps' : true });
    const result = await a.submit({ version: 1, action: 'open', sessionId: SID_A, prompt: 'x' });
    assert.equal(result.reason, reason, flag);
    assert.deepEqual(a.calls, [], flag);
  }
});

// Real descriptor module and procfs: no stubbed liveness verdict.
const NS_BOX = 'pid:[4026532001]';
function liveRig(t, inner = 42) {
  const root = tempRoot(t);
  const dir = pathx.join(root, 'sessions');
  fsx.mkdirSync(dir);
  const proc = makeProc(pathx.join(root, 'proc'));
  realCli.init({ dir, activeSessions: new Map(), log: { info() {}, warn() {}, error() {}, debug() {} }, platform: 'linux', isProcessAlive: () => false });
  t.after(() => realCli.stop());
  const descriptor = () => fsx.writeFileSync(pathx.join(dir, `${inner}.json`), JSON.stringify({ pid: inner, sessionId: SID_A, kind: 'interactive', status: 'idle', statusUpdatedAt: 1, procStart: '777' }));
  const liveV1 = id => realCli.liveElsewhereV1Checked(id, { procRoot: proc.root, ptyPids: () => [] });
  return { proc, dir, descriptor, liveV1 };
}

test('a raw descriptor with a live namespace writer refuses with and without a prompt, with zero bridge calls and bytes', async t => {
  for (const variant of ['host N absent', 'host N occupied']) {
    for (const prompt of [true, false]) {
      const rig = liveRig(t);
      rig.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 1, ns: NS_BOX });
      if (variant === 'host N occupied') rig.proc.add(42, { start: '999' });
      rig.descriptor();
      const a = refusalFlow(t, { deps: { liveV1: rig.liveV1 } });
      const result = await a.submit({ version: 1, action: 'open', sessionId: SID_A, ...(prompt ? { prompt: 'x' } : {}) });
      assert.equal(result.reason, 'session live elsewhere', `${variant} ${prompt}`);
      assert.deepEqual(a.calls, []);
      assert.deepEqual(a.world.writes, []);
    }
  }
});

test('an unresolvable raw identity refuses as liveness unavailable; a complete empty scan admits resolution', async t => {
  const rig = liveRig(t);
  rig.proc.add(9000, { nspid: [9000, 42], start: '778', ppid: 1, ns: NS_BOX });
  rig.descriptor();
  const blocked = refusalFlow(t, { deps: { liveV1: rig.liveV1 } });
  assert.equal((await blocked.submit({ version: 1, action: 'open', sessionId: SID_A })).reason, 'session liveness unavailable');
  assert.deepEqual(blocked.calls, []);
  const clear = liveRig(t);
  const a = arrange(t, { deps: { liveV1: clear.liveV1 } });
  assert.equal((await a.submit({ version: 1, action: 'open', sessionId: SID_A })).outcome, 'opened');
});

test('a candidate appearing after resolution and before dispatch makes zero bridge calls', async t => {
  const rig = liveRig(t);
  let checks = 0;
  const liveV1 = async id => { checks += 1; if (checks === 2) { rig.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 1, ns: NS_BOX }); rig.descriptor(); } return rig.liveV1(id); };
  const a = refusalFlow(t, { deps: { liveV1 } });
  const result = await a.submit({ version: 1, action: 'open', sessionId: SID_A });
  assert.equal(result.reason, 'session live elsewhere');
  assert.equal(checks, 2);
  assert.deepEqual(a.calls, []);
});
