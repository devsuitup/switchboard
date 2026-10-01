'use strict';

// Cwd resolution for the Changes panel IPCs — extracted so the resolution
// order (remote descriptor / live local PTY / disk scan) can be exercised
// with fully injected dependencies, no Electron. See issue #251 and
// .ai/contexts/ipc-bridge.md ("Changes panel").

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGitChangesTarget, isValidChangesSessionId, listSubagentWorktrees, collectSubagentChanges, checkSubagentRepo } = require('../git-changes-target');

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

test('resolveGitChangesTarget: a sidecar that is missing or unparsable is a distinct refusal, not the parent rows (mutation target: sharing the parent target)', () => {
  for (const meta of [null, undefined, 'text', 7]) {
    const result = resolveGitChangesTarget(SUB_ID, subDeps(meta), SUB_OPTS);
    assert.equal(result.ok, false, JSON.stringify(meta));
    assert.equal(result.reason, 'no-worktree-recorded');
  }
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

test('resolveGitChangesTarget: a UNC worktreePath is refused without a stat (mutation target: dropping the UNC check)', () => {
  for (const worktreePath of ['\\\\host\\share\\wt', '\\\\?\\UNC\\host\\share\\wt', '//host/share/wt']) {
    let stat = false;
    const deps = subDeps({ worktreePath }, { existsSync: () => { stat = true; return true; } });
    const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
    assert.equal(result.ok, false, worktreePath);
    assert.equal(stat, false, worktreePath);
  }
});

// --- listing a parent's subagent worktrees ---------------------------------

const BS = String.fromCharCode(92);
const WT2 = path.resolve('/repo/.claude/worktrees/agent-bbbb');

function listDeps(rows, metas, overrides = {}) {
  const reads = [];
  const base = subDeps(null, {
    getCachedFolder: (id) => (id === 'parent-1' || id.startsWith('sub:parent-1:') ? '-repo' : null),
    listSubagents: () => rows,
  });
  const deps = {
    ...base,
    cache: new Map(),
    exists: async (p) => [WORKTREE, WT2, path.resolve('/repo')].includes(p),
    readSubagentMetaAsync: async (jsonlPath) => {
      reads.push(jsonlPath);
      return metas[path.basename(jsonlPath, '.jsonl').slice('agent-'.length)] ?? null;
    },
    gitCommonDir: async () => path.resolve('/repo/.git'),
    ...overrides,
  };
  deps.reads = reads;
  return deps;
}

test('listSubagentWorktrees: lists only subagents whose worktree differs from the parent, labelled description then type then id, newest first', async () => {
  const rows = [
    { sessionId: 'sub:parent-1:aaaa', agentId: 'aaaa', description: 'fix the thing', subagentType: 'general-purpose', modified: '2026-10-01T10:00:00Z' },
    { sessionId: 'sub:parent-1:bbbb', agentId: 'bbbb', description: null, subagentType: 'Explore', modified: '2026-10-01T12:00:00Z' },
    { sessionId: 'sub:parent-1:cccc', agentId: 'cccc', description: null, subagentType: null, modified: '2026-10-01T09:00:00Z' },
    { sessionId: 'sub:parent-1:dddd', agentId: 'dddd', description: 'shares', subagentType: 'x' },
    { sessionId: 'sub:parent-1:eeee', agentId: 'eeee', description: 'same as parent', subagentType: 'x' },
    { sessionId: 'sub:parent-1:ffff', agentId: 'ffff', description: 'sidecar gone', subagentType: 'x' },
    { sessionId: 'sub:parent-1:gggg', agentId: 'gggg', description: 'removed', subagentType: 'x' },
  ];
  const metas = {
    aaaa: { worktreePath: WORKTREE },
    bbbb: { worktreePath: WT2 },
    cccc: { worktreePath: WORKTREE },
    dddd: { agentType: 'x' },
    eeee: { worktreePath: path.resolve('/repo') },
    gggg: { worktreePath: path.resolve('/repo/.claude/worktrees/gone') },
  };
  const out = await listSubagentWorktrees('parent-1', listDeps(rows, metas));
  assert.deepEqual(out.map((o) => [o.agentId, o.label, o.cwd]), [
    ['bbbb', 'Explore', WT2],
    ['aaaa', 'fix the thing', WORKTREE],
    ['cccc', 'cccc', WORKTREE],
  ]);
  assert.equal(out[1].sessionId, 'sub:parent-1:aaaa');
});

test('listSubagentWorktrees: a parent that is not a local session, or an invalid id, lists nothing and reads nothing', async () => {
  const rows = [{ sessionId: 'sub:parent-1:aaaa', agentId: 'aaaa' }];
  const metas = { aaaa: { worktreePath: WORKTREE } };
  for (const [id, over] of [['../x', {}], ['sub:parent-1:aaaa', {}], ['parent-1', { isRemoteFolder: () => true }]]) {
    const deps = listDeps(rows, metas, over);
    assert.deepEqual(await listSubagentWorktrees(id, deps), []);
    assert.deepEqual(deps.reads, []);
  }
});

test('listSubagentWorktrees: only the newest worktrees are examined (mutation target: dropping the scan bound)', async () => {
  const rows = []; const metas = {};
  for (let i = 0; i < 60; i++) {
    const id = 'a' + String(i).padStart(2, '0');
    rows.push({ sessionId: 'sub:parent-1:' + id, agentId: id, modified: '2026-10-01T10:' + String(i).padStart(2, '0') + ':00Z' });
    metas[id] = { worktreePath: WORKTREE };
  }
  const out = await listSubagentWorktrees('parent-1', listDeps(rows, metas));
  assert.equal(out.length, 24);
  assert.equal(out[0].agentId, 'a59');
});

test('listSubagentWorktrees: a sidecar is read once, a removed worktree is checked once, an unreadable sidecar is retried (mutation target: no cache)', async () => {
  const rows = [
    { sessionId: 'sub:parent-1:aaaa', agentId: 'aaaa' },
    { sessionId: 'sub:parent-1:gone', agentId: 'gone' },
    { sessionId: 'sub:parent-1:none', agentId: 'none' },
  ];
  const metas = { aaaa: { worktreePath: WORKTREE }, gone: { worktreePath: path.resolve('/repo/.claude/worktrees/gone') } };
  const existsCalls = [];
  const deps = listDeps(rows, metas, { exists: async (p) => { existsCalls.push(p); return p === WORKTREE; } });
  await listSubagentWorktrees('parent-1', deps);
  const firstReads = deps.reads.length;
  assert.equal(firstReads, 3);
  const out = await listSubagentWorktrees('parent-1', deps);
  assert.deepEqual(out.map((o) => o.agentId), ['aaaa']);
  assert.equal(deps.reads.length, firstReads + 1, 'only the unreadable sidecar is read again');
  assert.equal(existsCalls.filter((p) => p.endsWith('gone')).length, 1, 'a removed worktree is not stat-ed again');
});

test('listSubagentWorktrees: sidecar reads run a few at a time, not all at once (mutation target: unbounded fan-out)', async () => {
  const rows = []; const metas = {};
  for (let i = 0; i < 50; i++) { rows.push({ sessionId: 'sub:parent-1:a' + i, agentId: 'a' + i }); metas['a' + i] = { agentType: 'x' }; }
  let inFlight = 0; let peak = 0;
  const deps = listDeps(rows, metas, {
    readSubagentMetaAsync: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { agentType: 'x' };
    },
  });
  await listSubagentWorktrees('parent-1', deps);
  assert.ok(peak > 1 && peak <= 8, 'peak ' + peak);
});

test('listSubagentWorktrees: a worktree of another repository is left out, and each directory is asked its repository once (mutation target: skipping the repository check)', async () => {
  const rows = [
    { sessionId: 'sub:parent-1:aaaa', agentId: 'aaaa' },
    { sessionId: 'sub:parent-1:bbbb', agentId: 'bbbb' },
  ];
  const metas = { aaaa: { worktreePath: WORKTREE }, bbbb: { worktreePath: WT2 } };
  const asked = [];
  const deps = listDeps(rows, metas, {
    gitCommonDir: async (cwd) => { asked.push(cwd); return cwd === WT2 ? path.resolve('/elsewhere/.git') : path.resolve('/repo/.git'); },
  });
  const out = await listSubagentWorktrees('parent-1', deps);
  assert.deepEqual(out.map((o) => o.agentId), ['aaaa']);
  await listSubagentWorktrees('parent-1', deps);
  assert.equal(asked.length, 3, 'parent, aaaa and bbbb, once each');
  const none = await listSubagentWorktrees('parent-1', listDeps(rows, metas, { gitCommonDir: async () => null }));
  assert.deepEqual(none, [], 'an unanswerable repository is a refusal');
});

test('listSubagentWorktrees: the parent comparison ignores case where the platform does (mutation target: string equality)', async () => {
  const rows = [{ sessionId: 'sub:parent-1:aaaa', agentId: 'aaaa' }];
  const parentCwd = 'C:' + BS + 'Repo';
  const wt = 'c:' + BS + 'repo';
  const deps = listDeps(rows, { aaaa: { worktreePath: wt } }, {
    pathOps: path.win32,
    resolveSessionRealCwd: () => parentCwd,
    existsSync: () => true,
    exists: async () => true,
  });
  assert.deepEqual(await listSubagentWorktrees('parent-1', deps), []);
});

test('resolveGitChangesTarget: an extended-length drive path is normalised, any UNC or host path is refused (mutation target: the UNC pattern)', () => {
  const accepted = [
    [BS + BS + '?' + BS + 'C:' + BS + 'wt', 'C:' + BS + 'wt'],
    [BS + BS + '.' + BS + 'C:' + BS + 'wt', 'C:' + BS + 'wt'],
  ];
  for (const [recorded, normalised] of accepted) {
    const seen = [];
    const deps = subDeps({ worktreePath: recorded }, { existsSync: (p) => { seen.push(p); return true; } });
    const result = resolveGitChangesTarget(SUB_ID, deps, SUB_OPTS);
    assert.equal(result.ok, true, recorded);
    assert.equal(result.cwd, normalised);
    assert.deepEqual(seen, [normalised]);
  }
  const refused = [
    BS + BS + '?' + BS + 'UNC' + BS + 'h' + BS + 's' + BS + 'wt',
    BS + BS + 'h' + BS + 's' + BS + 'wt',
    '//h/s/wt',
    BS + BS + '?' + BS + 'Volume{1}' + BS + 'wt',
    BS + BS + '?' + BS + 'C:',
  ];
  for (const recorded of refused) {
    const result = resolveGitChangesTarget(SUB_ID, subDeps({ worktreePath: recorded }, { existsSync: () => true }), SUB_OPTS);
    assert.equal(result.ok, false, recorded);
  }
});

// --- the groups the parent's panel shows -----------------------------------

function group(i) {
  return { sessionId: 'sub:p:a' + i, agentId: 'a' + i, label: 'A' + i, cwd: '/w' + i };
}
const DIRTY = { ok: true, branch: { head: 'b' }, files: [{ path: 'x.js', state: 'M' }], totals: { files: 1, added: 1, deleted: 0, uncounted: 0 } };
const CLEAN = { ok: true, branch: { head: 'b' }, files: [], totals: { files: 0 } };

test('collectSubagentChanges: keeps the groups git reports files for, drops clean, failed and throwing ones', async () => {
  const groups = [group(1), group(2), group(3), group(4)];
  const status = { '/w1': DIRTY, '/w2': CLEAN, '/w3': { ok: false, error: 'boom' } };
  const { subagents, omitted } = await collectSubagentChanges(groups, (cwd) => ({
    status: async () => { if (cwd === '/w4') throw new Error('x'); return status[cwd]; },
  }));
  assert.deepEqual(subagents, [{
    sessionId: 'sub:p:a1', agentId: 'a1', label: 'A1', branch: { head: 'b' }, files: DIRTY.files, totals: DIRTY.totals,
  }]);
  assert.equal(omitted, 0);
});

test('collectSubagentChanges: the cap counts groups with changes, so clean worktrees take no slot, and the rest are counted (mutation target: capping before git status)', async () => {
  const groups = []; for (let i = 0; i < 20; i++) groups.push(group(i));
  const { subagents, omitted } = await collectSubagentChanges(groups, (cwd) => ({
    status: async () => (Number(cwd.slice(2)) < 6 ? CLEAN : DIRTY),
  }));
  assert.equal(subagents.length, 8);
  assert.deepEqual(subagents.map((g) => g.agentId), ['a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13']);
  assert.equal(omitted, 6);
});

test('collectSubagentChanges: at most a few git status run at once (mutation target: unbounded parallelism)', async () => {
  const groups = []; for (let i = 0; i < 12; i++) groups.push(group(i));
  let inFlight = 0; let peak = 0;
  await collectSubagentChanges(groups, () => ({
    status: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return DIRTY;
    },
  }));
  assert.ok(peak > 1 && peak <= 3, 'peak ' + peak);
});

// --- a subagent target must belong to the parent's repository --------------

test('checkSubagentRepo: a worktree of the parent repository passes, another repository or an unanswerable one is refused (mutation target: skipping the check)', async () => {
  const common = path.resolve('/repo/.git');
  const deps = (over) => listDeps([], {}, over);
  const target = { ok: true, kind: 'local', cwd: WORKTREE, subagent: true };
  assert.deepEqual(await checkSubagentRepo(SUB_ID, target, deps({ gitCommonDir: async () => common })), { ok: true });
  const other = await checkSubagentRepo(SUB_ID, target, deps({ gitCommonDir: async (cwd) => (cwd === WORKTREE ? path.resolve('/x/.git') : common) }));
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'other-repo');
  assert.equal((await checkSubagentRepo(SUB_ID, target, deps({ gitCommonDir: async () => null }))).ok, false);
});

test('checkSubagentRepo: a target that is not a distinct subagent worktree needs no git call', async () => {
  let asked = false;
  const deps = listDeps([], {}, { gitCommonDir: async () => { asked = true; return null; } });
  const own = { ok: true, kind: 'local', cwd: '/anything' };
  assert.deepEqual(await checkSubagentRepo('s1', own, deps), { ok: true });
  const shared = { ok: true, kind: 'local', cwd: path.resolve('/repo'), subagent: true };
  assert.deepEqual(await checkSubagentRepo(SUB_ID, shared, deps), { ok: true });
  assert.equal(asked, false);
  const refused = { ok: false, error: 'x' };
  assert.equal(await checkSubagentRepo(SUB_ID, refused, deps), refused);
});
