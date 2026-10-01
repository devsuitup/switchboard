'use strict';

// Cwd resolution for the Changes panel IPCs — extracted so the resolution
// order (remote descriptor / live local PTY / disk scan) can be exercised
// with fully injected dependencies, no Electron. See issue #251 and
// .ai/contexts/ipc-bridge.md ("Changes panel").

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGitChangesTarget, isValidChangesSessionId } = require('../git-changes-target');

function baseDeps(overrides = {}) {
  return {
    getCachedFolder: () => null,
    isRemoteFolder: () => false,
    parseFolderKey: (folder) => ({ alias: null, folder }),
    getRemoteSessions: () => ({ sessions: [] }),
    activeSessions: new Map(),
    resolveSessionRealCwd: () => null,
    existsSync: () => false,
    projectsDir: '/projects',
    ...overrides,
  };
}

test('rejects an empty/missing session id without touching any dependency', () => {
  let touched = false;
  const deps = baseDeps({ getCachedFolder: () => { touched = true; return null; } });
  const result = resolveGitChangesTarget('', deps);
  assert.equal(result.ok, false);
  assert.equal(touched, false);
});

// --- sessionId shape validation (adversarial review, MAJOR finding 4) ------

test('isValidChangesSessionId: accepts a plain CLI-issued id and a remote pid: placeholder', () => {
  assert.equal(isValidChangesSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), true);
  assert.equal(isValidChangesSessionId('pid:4242'), true);
});

test('isValidChangesSessionId: rejects path traversal, separators, and the composite subagent shape (mutation target: dropping the shape check)', () => {
  assert.equal(isValidChangesSessionId('../../x'), false);
  assert.equal(isValidChangesSessionId('..'), false);
  assert.equal(isValidChangesSessionId('.'), false);
  assert.equal(isValidChangesSessionId('a/b'), false);
  assert.equal(isValidChangesSessionId('a\\b'), false);
  assert.equal(isValidChangesSessionId('sub:parent-id:agent-1'), false, 'main.js never routes a subagent id to this IPC');
  assert.equal(isValidChangesSessionId('pid:'), false, 'a placeholder id must carry a positive integer pid');
  assert.equal(isValidChangesSessionId('pid:0'), false);
  assert.equal(isValidChangesSessionId('pid:-1'), false);
  assert.equal(isValidChangesSessionId(''), false);
  assert.equal(isValidChangesSessionId(null), false);
});

test('resolveGitChangesTarget: "../../x" is refused up front, without ever calling resolveSessionRealCwd (mutation target: validating after dispatch instead of before)', () => {
  let realCwdCalled = false;
  const deps = baseDeps({ resolveSessionRealCwd: () => { realCwdCalled = true; return '/should-not-be-reached'; } });
  const result = resolveGitChangesTarget('../../x', deps);
  assert.equal(result.ok, false);
  assert.equal(realCwdCalled, false, 'an invalid id must never reach the disk-scanning fallback');
});

test('resolveGitChangesTarget: a well-formed remote pid: placeholder id is accepted and dispatched to the remote path', () => {
  const deps = baseDeps({
    getCachedFolder: () => 'vps::-home-dev-proj',
    isRemoteFolder: () => true,
    parseFolderKey: () => ({ alias: 'vps' }),
    getRemoteSessions: (alias) => ({
      sessions: alias === 'vps' ? [{ sessionId: 'pid:4242', cwd: '/srv/app' }] : [],
    }),
  });
  const result = resolveGitChangesTarget('pid:4242', deps);
  assert.deepEqual(result, { ok: true, kind: 'remote', alias: 'vps', cwd: '/srv/app' });
});

test('remote: resolves cwd from the host descriptor list, no PTY required', () => {
  const deps = baseDeps({
    getCachedFolder: () => 'vps::-home-dev-proj',
    isRemoteFolder: () => true,
    parseFolderKey: () => ({ alias: 'vps' }),
    getRemoteSessions: (alias) => ({
      sessions: alias === 'vps' ? [{ sessionId: 's1', cwd: '/srv/app' }] : [],
    }),
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.deepEqual(result, { ok: true, kind: 'remote', alias: 'vps', cwd: '/srv/app' });
});

test('remote: refuses when the descriptor is gone or carries no cwd (mutation target: falling back to a stale value)', () => {
  const deps = baseDeps({
    getCachedFolder: () => 'vps::-home-dev-proj',
    isRemoteFolder: () => true,
    parseFolderKey: () => ({ alias: 'vps' }),
    getRemoteSessions: () => ({ sessions: [] }),
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /no known working directory/);
});

test('local: a live session in this app wins with its own recorded cwd, even without touching the disk scan', () => {
  let scanCalled = false;
  const deps = baseDeps({
    activeSessions: new Map([['s1', { exited: false, cwd: '/repo/.claude-worktrees/feature-x' }]]),
    resolveSessionRealCwd: () => { scanCalled = true; return '/should-not-be-used'; },
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: '/repo/.claude-worktrees/feature-x' });
  assert.equal(scanCalled, false, 'a live session\'s own cwd must short-circuit the disk scan');
});

test('local: an exited session in activeSessions is treated as not-live, falling through to the disk scan', () => {
  const deps = baseDeps({
    activeSessions: new Map([['s1', { exited: true, cwd: '/stale/cwd' }]]),
    resolveSessionRealCwd: () => '/repo/real-cwd',
    existsSync: (p) => p === '/repo/real-cwd',
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: '/repo/real-cwd' });
});

test('local: not live in this app — falls back to resolveSessionRealCwd, same source as the resume path', () => {
  const deps = baseDeps({
    getCachedFolder: () => '-home-dev-proj',
    resolveSessionRealCwd: (projectsDir, sessionId, preferredFolder) => {
      assert.equal(projectsDir, '/projects');
      assert.equal(sessionId, 's1');
      assert.equal(preferredFolder, '-home-dev-proj');
      return '/home/dev/proj';
    },
    existsSync: (p) => p === '/home/dev/proj',
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: '/home/dev/proj' });
});

test('local: a resolved cwd that no longer exists on disk is refused, not returned stale', () => {
  const deps = baseDeps({
    resolveSessionRealCwd: () => '/deleted/worktree',
    existsSync: () => false,
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.equal(result.ok, false);
});

test('local: nothing found anywhere resolves to a clear error, not a throw', () => {
  const deps = baseDeps();
  const result = resolveGitChangesTarget('s1', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not resolve/);
});

test('a getCachedFolder throw is swallowed, resolution still proceeds as local', () => {
  const deps = baseDeps({
    getCachedFolder: () => { throw new Error('db closed'); },
    resolveSessionRealCwd: () => '/home/dev/proj',
    existsSync: () => true,
  });
  const result = resolveGitChangesTarget('s1', deps);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: '/home/dev/proj' });
});

// --- a subagent's worktree (issue #303) ------------------------------------

const path = require('node:path');

const SUB_ID = 'sub:parent-1:a219d84ea899';
const WORKTREE = path.resolve('/repo/.claude/worktrees/agent-a219d84ea899');
const SUB_OPTS = { allowSubagent: true };

function subDeps(meta, overrides = {}) {
  const metaReads = [];
  const deps = baseDeps({
    getCachedFolder: (id) => (id === SUB_ID || id === 'parent-1' ? '-repo' : null),
    existsSync: (p) => p === WORKTREE || p === path.resolve('/repo'),
    resolveSessionRealCwd: (_dir, id) => (id === 'parent-1' ? path.resolve('/repo') : null),
    readSubagentMeta: (jsonlPath) => { metaReads.push(jsonlPath); return meta; },
    ...overrides,
  });
  deps.metaReads = metaReads;
  return deps;
}

test('isValidChangesSessionId: a sub: id stays refused unless the caller opts in, and then only with well-formed parts', () => {
  assert.equal(isValidChangesSessionId(SUB_ID), false);
  assert.equal(isValidChangesSessionId(SUB_ID, SUB_OPTS), true);
  for (const bad of [
    'sub:', 'sub:a', 'sub:a:', 'sub::b', 'sub:a:b:c', 'sub:../x:b', 'sub:a:../x', 'sub:a:..', 'sub:..:b',
    'sub:a/b:c', 'sub:a:b/c', 'sub:a:b\\c', 'sub:a b:c', 'sub:a:b\0',
  ]) {
    assert.equal(isValidChangesSessionId(bad, SUB_OPTS), false, JSON.stringify(bad));
  }
});

test('resolveGitChangesTarget: a sub: id is refused without opt-in, before any dependency runs', () => {
  const deps = subDeps({ worktreePath: WORKTREE }, { getCachedFolder: () => { throw new Error('touched'); } });
  const result = resolveGitChangesTarget(SUB_ID, deps);
  assert.equal(result.ok, false);
  assert.deepEqual(deps.metaReads, []);
});

test('resolveGitChangesTarget: a malformed sub: id is refused before any disk access (mutation target: validating after the meta read)', () => {
  let touched = false;
  const deps = subDeps({ worktreePath: WORKTREE }, {
    getCachedFolder: () => { touched = true; return '-repo'; },
    existsSync: () => { touched = true; return true; },
    resolveSessionRealCwd: () => { touched = true; return null; },
    readSubagentMeta: () => { touched = true; return null; },
  });
  for (const bad of ['sub:../../x:b', 'sub:a:../../x', 'sub:a:b:c', 'sub:a/b:c']) {
    const result = resolveGitChangesTarget(bad, deps, SUB_OPTS);
    assert.equal(result.ok, false, bad);
  }
  assert.equal(touched, false);
});

test('resolveGitChangesTarget: a subagent in a worktree resolves to the worktree path recorded in its sidecar', () => {
  const deps = subDeps({ worktreePath: WORKTREE, worktreeBranch: 'worktree-agent-a219d84ea899' });
  const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: WORKTREE, subagent: true });
  assert.deepEqual(deps.metaReads, [
    path.join('/projects', '-repo', 'parent-1', 'subagents', 'agent-a219d84ea899.jsonl'),
  ]);
});

test('resolveGitChangesTarget: a subagent with no worktreePath shares the parent target, with no second row source', () => {
  const deps = subDeps({ agentType: 'general-purpose' });
  const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
  assert.deepEqual(result, { ok: true, kind: 'local', cwd: path.resolve('/repo'), subagent: true });
});

test('resolveGitChangesTarget: a subagent whose sidecar is missing shares the parent target', () => {
  const result = resolveGitChangesTarget(SUB_ID, subDeps(null), SUB_OPTS);
  assert.equal(result.ok, true);
  assert.equal(result.cwd, path.resolve('/repo'));
});

test('resolveGitChangesTarget: a removed worktree is reported as such, not thrown and not the parent directory (mutation target: falling back to the parent)', () => {
  const deps = subDeps({ worktreePath: WORKTREE }, { existsSync: (p) => p === path.resolve('/repo') });
  const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'worktree-removed');
  assert.match(result.error, /no longer exists/);
});

test('resolveGitChangesTarget: a sidecar worktreePath that is relative, traversing or carries a control character is refused without a stat', () => {
  for (const worktreePath of ['rel/worktree', path.resolve('/repo') + '/../etc', WORKTREE + '\nx', 42, '']) {
    let stat = false;
    const deps = subDeps({ worktreePath }, { existsSync: () => { stat = true; return true; } });
    const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
    assert.equal(result.ok, false, JSON.stringify(worktreePath));
    assert.equal(stat, false, JSON.stringify(worktreePath));
  }
});

test('resolveGitChangesTarget: a subagent of a remote folder is refused', () => {
  const deps = subDeps({ worktreePath: WORKTREE }, { isRemoteFolder: () => true });
  const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
  assert.equal(result.ok, false);
  assert.deepEqual(deps.metaReads, []);
});

test('resolveGitChangesTarget: a subagent absent from the cache is refused', () => {
  const deps = subDeps({ worktreePath: WORKTREE }, { getCachedFolder: () => null });
  const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
  assert.equal(result.ok, false);
  assert.deepEqual(deps.metaReads, []);
});
