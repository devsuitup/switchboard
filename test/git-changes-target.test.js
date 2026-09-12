'use strict';

// Cwd resolution for the Changes panel IPCs — extracted so the resolution
// order (remote descriptor / live local PTY / disk scan) can be exercised
// with fully injected dependencies, no Electron. See issue #251 and
// .ai/contexts/ipc-bridge.md ("Changes panel").

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGitChangesTarget } = require('../git-changes-target');

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
