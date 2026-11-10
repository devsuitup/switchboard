'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');

const projectPath = path.posix.resolve('/planning-fixture');
const options = { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false };
const identity = (alias = null, extra = {}) => ({ alias, projectPath, ...extra });
const group = (id = 'group-a', alias = null, extra = {}) => identity(alias, { folderKey: alias ? `${alias}::${id}` : id, runtime: 'claude', verified: true, ...extra });
const member = (id = 'part-a', alias = null, extra = {}) => identity(alias, {
  id, conversationId: 'conversation-a', partId: id, subagentId: null, folderKey: alias ? `${alias}::group-a` : 'group-a',
  runtime: 'claude', cwd: projectPath, verified: true, indexed: true, present: true,
  liveness: { state: 'stopped', source: 'descriptor' }, ...extra,
});

function fixture() {
  const state = {
    snapshot: { revision: 'writer:1', complete: true, initialScanComplete: true, declaredHosts: ['alpha', 'beta'],
      projects: [identity(null, { folderKeys: ['group-a', 'group-b'] }), identity('alpha', { folderKeys: ['alpha::group-a'] }), identity('beta', { folderKeys: ['beta::group-a'] })] },
    ownership: { complete: true, groups: [group()], members: [], candidates: [] },
    schedules: { complete: true, schedules: [], candidates: [] },
    runtime: { complete: true, tabs: [], jobs: [], candidates: [] },
    revision: 'writer:1', events: [], effects: { writes: 0, stops: 0, refreshes: 0 },
  };
  const read = (event, key) => async () => { state.events.push(event); return structuredClone(state[key]); };
  const deps = {
    waitForIndex: async () => { state.events.push('index'); },
    readSnapshot: read('snapshot', 'snapshot'),
    discoverOwnership: read('ownership', 'ownership'),
    discoverSchedules: read('schedules', 'schedules'),
    readRuntimeState: read('runtime', 'runtime'),
    readRevision: read('fence', 'revision'),
    write: () => state.effects.writes++, stop: () => state.effects.stops++, refresh: () => state.effects.refreshes++,
  };
  const planner = createProjectDeletePlanner(deps);
  const request = (changes = {}) => ({ projectPath, options: { ...options }, ...changes });
  return { state, deps, planner, request };
}

async function planFor(f, changes) {
  const result = await f.planner.preview(f.request(changes));
  assert.equal(result.ok, true, `complete snapshot must produce a plan: ${JSON.stringify(result)}`);
  return result.plan;
}

test('nullable row paths remain nullable in a confirmable membership projection', async () => {
  const f = fixture();
  f.state.ownership.groups[0].parentProjectPath = null;
  f.state.runtime.tabs.push(identity(null, { id: 'dormant', runtime: 'terminal', verified: true,
    cwd: null, liveness: { state: 'stopped', source: 'pty' } }));
  const plan = await planFor(f);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.groups[0].parentProjectPath, null);
  assert.equal(plan.tabs[0].cwd, null);
});

for (const [kind, key] of [['tab', 'cwd'], ['group', 'parentProjectPath'], ['member', 'cwd']]) {
  test(`relative ${kind} path causes a row ownership refusal rather than project identity failure`, async () => {
    const f = fixture();
    if (kind === 'tab') f.state.runtime.tabs.push(identity(null, { id: 'dormant', runtime: 'terminal', verified: true,
      cwd: 'rel', liveness: { state: 'stopped', source: 'pty' } }));
    if (kind === 'group') f.state.ownership.groups[0][key] = 'rel';
    if (kind === 'member') f.state.ownership.members.push(member('bad-cwd', null, { cwd: 'rel' }));
    const plan = await planFor(f);
    assert.ok(plan.refusals.some(row => row.code === (kind === 'group' ? 'GROUP_OWNERSHIP' : 'MEMBER_OWNERSHIP')));
  });
}

for (const value of [() => {}, Symbol('option')]) {
  test(`uncloneable request ${typeof value} is INVALID_REQUEST`, async () => {
    const f = fixture();
    const request = f.request();
    if (typeof value === 'function') request.extra = value;
    else request.options.sessions = value;
    const result = await f.planner.preview(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.deepEqual(f.state.events, []);
  });
}

test('empty preview waits for indexing and fences a read-only complete plan', async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  const plan = await planFor(f);
  assert.equal(plan.project.alias, null);
  assert.equal(plan.counts.conversations, 0);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.categories.sessions.effect, 'archive');
  assert.equal(plan.categories.projectDirectory.effect, 'kept');
  assert.equal(plan.revision, 'writer:1');
  assert.deepEqual(f.state.events, ['index', 'snapshot', 'ownership', 'schedules', 'runtime', 'fence']);
  assert.deepEqual(f.state.effects, { writes: 0, stops: 0, refreshes: 0 });
  for (const key of ['snapshot', 'ownership', 'schedules', 'runtime', 'revision']) assert.deepEqual(f.state[key], before[key]);
});

test('AC8 isolates same-path local and two-host members across multiple verified cache groups', async () => {
  const f = fixture();
  f.state.ownership.groups.push(group('group-b'), group('group-a', 'alpha'), group('group-a', 'beta'));
  f.state.ownership.members.push(member(), member('continuation', null, { folderKey: 'group-b', archived: true }),
    member('agent', null, { subagentId: 'agent', parentSessionId: 'part-a' }), member('alpha-only', 'alpha'), member('beta-only', 'beta'));
  const local = await planFor(f);
  assert.deepEqual(local.members.map(m => m.id).sort(), ['agent', 'continuation', 'part-a'], 'other-host members must never enter the local plan');
  assert.equal(local.counts.conversations, 1);
  assert.equal(local.counts.parts, 2);
  assert.equal(local.counts.subagents, 1);
  assert.deepEqual(local.groups.map(g => g.folderKey), ['group-a', 'group-b']);
  for (const alias of ['alpha', 'beta']) {
    const remote = await planFor(f, { folderKey: `${alias}::group-a` });
    assert.equal(remote.project.alias, alias);
    assert.deepEqual(remote.members.map(m => m.id), [`${alias}-only`]);
    assert.equal(remote.project.entry, `${alias}::${projectPath.replace(/\\/g, '/')}`);
  }
});

test('AC8 child worktree groups and prefix siblings are kept separately', async () => {
  const f = fixture();
  const child = `${projectPath}/.claude/worktrees/child`;
  f.state.snapshot.projects.push(identity(null, { projectPath: child, folderKeys: ['child'] }));
  f.state.ownership.groups.push(group('child', null, { projectPath: child, parentProjectPath: projectPath }), group('sibling', null, { projectPath: `${projectPath}-other` }));
  f.state.ownership.members.push(member(), member('child-part', null, { projectPath: child, cwd: child, folderKey: 'child' }), member('sibling-part', null, { projectPath: `${projectPath}-other`, cwd: `${projectPath}-other`, folderKey: 'sibling' }));
  const plan = await planFor(f);
  assert.deepEqual(plan.members.map(m => m.id), ['part-a']);
  assert.equal(plan.groups.find(g => g.folderKey === 'child').effect, 'kept');
  assert.equal(plan.groups.some(g => g.folderKey === 'sibling'), false);
});

test('AC8 request path and folder hints must resolve to one declared known host mapping', async () => {
  for (const change of [
    { folderKey: 'unknown::group-a' }, { folderKey: 'alpha::missing' }, { folderKey: 'group-b', projectPath: `${projectPath}-other` },
    { folderKey: 'alpha::group-a', projectPath: `${projectPath}/child` },
  ]) {
    const f = fixture();
    const reply = await f.planner.preview(f.request(change));
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'IDENTITY_UNAVAILABLE');
  }
  const f = fixture();
  f.state.snapshot.projects.push(identity('beta', { folderKeys: ['alpha::group-a'] }));
  assert.equal((await f.planner.preview(f.request({ folderKey: 'alpha::group-a' }))).ok, false);
  f.state.snapshot.projects = f.state.snapshot.projects.filter(p => p.alias);
  assert.equal((await f.planner.preview(f.request())).ok, false, 'a missing local mapping must never select a remote');
});

test('remote POSIX case remains distinct while local spelling normalizes', async () => {
  const f = fixture();
  f.state.snapshot.projects = [{ alias: 'alpha', projectPath: '/work/Repo', folderKeys: ['alpha::r'] }];
  f.state.ownership.groups = [group('r', 'alpha', { projectPath: '/work/Repo' })];
  assert.equal((await f.planner.preview(f.request({ projectPath: '/work/repo', folderKey: 'alpha::r' }))).ok, false);
  const result = await f.planner.preview(f.request({ projectPath: '/work/Repo/./', folderKey: 'alpha::r' }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.project.projectPath, '/work/Repo');
  const local = fixture();
  assert.equal((await local.planner.preview(local.request({ projectPath: `${projectPath}/./` }))).ok, true);
});

for (const [name, change] of [
  ['initial indexing', s => { s.snapshot.initialScanComplete = false; }],
  ['snapshot completeness', s => { s.snapshot.complete = false; }],
  ['ownership listing', s => { s.ownership.complete = false; }],
  ['schedule listing', s => { s.schedules.complete = false; }],
  ['runtime listing', s => { s.runtime.complete = false; }],
  ['writer revision', s => { s.revision = 'writer:2'; }],
]) test(`incomplete or stale ${name} never returns a confirmable plan`, async () => {
  const f = fixture(); change(f.state);
  const reply = await f.planner.preview(f.request());
  assert.equal(reply.ok, false);
  assert.match(reply.code, /INCOMPLETE|STALE/);
  assert.deepEqual(f.state.effects, { writes: 0, stops: 0, refreshes: 0 });
});

test('missing unindexed unmappable and linked ownership candidates explicitly refuse', async () => {
  for (const extra of [{ present: false }, { indexed: false }, { verified: false }, { runtime: 'mystery' }, { cwd: `${projectPath}/child` }, { linked: true }, { folderKey: 'unmapped' }]) {
    const f = fixture(); f.state.ownership.members.push(member('uncertain', null, extra));
    assert.ok((await planFor(f)).refusals.length > 0, `must refuse ${JSON.stringify(extra)}`);
  }
  const f = fixture(); f.state.ownership.candidates.push({ path: 'unmapped.jsonl', reason: 'unmappable' });
  assert.equal((await planFor(f)).refusals[0].code, 'DISCOVERY_CANDIDATE');
});

test('all disabled invalid and unreadable schedules remain inspectable and bound', async () => {
  const f = fixture();
  f.state.schedules.schedules = ['enabled', 'disabled', 'invalid', 'unreadable'].map(name => identity(null, {
    id: name, path: `${projectPath}/.claude/commands/schedule-${name}.md`, verified: true,
    readable: name !== 'unreadable', enabled: name === 'enabled', problems: name === 'invalid' ? ['no cron'] : [],
  }));
  f.state.schedules.schedules.push(identity('alpha', { id: 'remote-only', path: '/remote/schedule.md', verified: true, readable: true }));
  const plan = await planFor(f);
  assert.equal(plan.schedules.length, 4);
  assert.equal(plan.categories.schedules.effect, 'kept');
  assert.ok(plan.warnings.some(w => w.code === 'SCHEDULE_REACTIVATION'));
  assert.ok(plan.refusals.some(r => r.code === 'SCHEDULE_UNREADABLE'));
  f.state.schedules.schedules.pop();
  f.state.schedules.schedules[0].id = 'replacement';
  assert.notEqual((await planFor(f)).fingerprint, plan.fingerprint);
});

test('shared settings are unavailable and requested erasure is refused without effects', async () => {
  const f = fixture();
  const kept = await planFor(f);
  assert.equal(kept.categories.settings.available, false);
  assert.equal(kept.categories.settings.effect, 'kept');
  assert.equal(kept.refusals.length, 0);
  const selected = await planFor(f, { options: { ...options, settings: true } });
  assert.ok(selected.refusals.some(r => r.code === 'SHARED_SETTINGS'));
  const own = fixture(); own.state.snapshot.projects = [own.state.snapshot.projects[0]];
  const allowed = await planFor(own, { options: { ...options, sessions: true, settings: true } });
  assert.equal(allowed.categories.settings.effect, 'delete');
  assert.equal(allowed.categories.sessions.effect, 'discard');
});

test('dormant pending restore and transcriptless terminal targets are complete and host scoped', async () => {
  const f = fixture();
  f.state.runtime.tabs = ['active', 'saved', 'pending'].map((kind, i) => identity(null, { id: kind, kind, runtime: 'terminal', verified: true,
    liveness: { state: i ? 'stopped' : 'running', source: 'pty', targetId: 'pty-1' } }));
  f.state.runtime.tabs.push(identity('alpha', { id: 'foreign', runtime: 'terminal', verified: true, liveness: { state: 'running', source: 'pty', targetId: 'foreign' } }));
  const plan = await planFor(f);
  assert.equal(plan.tabs.length, 3);
  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0].targetId, 'pty-1');
  assert.equal(plan.counts.processes, 1);
  assert.equal(plan.refusals.length, 0);
});

test('unknown runtime liveness and external live processes stay refused', async () => {
  for (const liveness of [{ state: 'unknown', source: 'descriptor' }, { state: 'running', source: 'external', targetId: 'external-pid' }, undefined]) {
    const f = fixture(); f.state.ownership.members.push(member('codex', null, { runtime: 'codex', liveness }));
    const plan = await planFor(f);
    assert.ok(plan.refusals.some(r => /LIVENESS|EXTERNAL/.test(r.code)));
    assert.equal(plan.stops.length, 0);
  }
});

test('background and schedule jobs need fresh consent and exact named stop identities', async () => {
  const f = fixture();
  f.state.runtime.jobs.push(identity(null, { id: 'job-1', name: 'Nightly', scheduleId: 'schedule-1', runtime: 'claude', verified: true,
    liveness: { state: 'running', source: 'job', targetId: 'job-1', generation: 42 } }));
  const excluded = await planFor(f);
  assert.ok(excluded.refusals.some(r => r.code === 'BACKGROUND_CONSENT' && r.target === 'job-1'));
  assert.equal(excluded.stops[0].excluded, true);
  const accepted = await planFor(f, { options: { ...options, stopBackgroundJobs: true } });
  assert.equal(accepted.refusals.length, 0);
  assert.equal(accepted.stops[0].excluded, false);
  assert.equal(accepted.stops[0].name, 'Nightly');
  assert.notEqual(excluded.fingerprint, accepted.fingerprint);
  f.state.runtime.jobs[0].liveness.generation++;
  assert.notEqual((await planFor(f, { options: { ...options, stopBackgroundJobs: true } })).fingerprint, accepted.fingerprint);
});

test('fingerprints are order independent and separate membership from the writer revision', async () => {
  const f = fixture();
  f.state.ownership.groups.push(group('group-b'));
  f.state.ownership.members = Array.from({ length: 12 }, (_, i) => member(`part-${i}`));
  const plan = await planFor(f);
  assert.equal(plan.members.length, 12, 'full detail must survive the ten-item display limit');
  f.state.ownership.groups.reverse(); f.state.ownership.members.reverse();
  f.state.snapshot.revision = f.state.revision = 'writer:2';
  const reordered = await planFor(f);
  assert.equal(reordered.fingerprint, plan.fingerprint);
  assert.equal(reordered.membershipDigest, plan.membershipDigest);
  assert.equal(reordered.revision, 'writer:2');
  assert.equal((await f.planner.revalidate(plan)).same, true);
  f.state.ownership.members.push(member('new-part'));
  const changed = await f.planner.revalidate(plan);
  assert.equal(changed.same, false);
  assert.notEqual(changed.plan.membershipDigest, plan.membershipDigest);
  f.state.ownership.complete = false;
  const incomplete = await f.planner.revalidate(plan);
  assert.equal(incomplete.same, false);
  assert.equal(incomplete.plan, null);
});

test('unknown fields coercion and physical or worktree options are rejected', async () => {
  for (const request of [
    { ...fixture().request(), extra: true },
    ...[{ sessions: 'true' }, { schedules: true }, { transcripts: true }, { worktrees: true }, { stopBackgroundJobs: 1 }, { extra: false }]
      .map(extra => ({ ...fixture().request(), options: { ...options, ...extra } })),
  ]) {
    const reply = await fixture().planner.preview(request);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'INVALID_REQUEST');
  }
});

test('discovery errors timeouts and excessive inventories fail closed without late effects', async () => {
  const f = fixture();
  const broken = createProjectDeletePlanner({ ...f.deps, discoverOwnership: async () => { throw new Error('denied'); } });
  assert.equal((await broken.preview(f.request())).code, 'DISCOVERY_UNAVAILABLE');
  const hung = createProjectDeletePlanner({ ...f.deps, timeoutMs: 20, discoverOwnership: () => new Promise(() => {}) });
  assert.equal((await hung.preview(f.request())).code, 'DISCOVERY_TIMEOUT');
  f.state.ownership.members = Array.from({ length: 3 }, (_, i) => member(`p-${i}`));
  const bounded = createProjectDeletePlanner({ ...f.deps, maxItems: 2 });
  assert.equal((await bounded.preview(f.request())).code, 'DISCOVERY_LIMIT');
  assert.deepEqual(f.state.effects, { writes: 0, stops: 0, refreshes: 0 });
});

test('an empty remote project revalidates by bound identity without local fallback', async () => {
  const f = fixture();
  f.state.ownership.groups = [];
  const plan = await planFor(f, { folderKey: 'alpha::group-a' });
  const result = await f.planner.revalidate(plan);
  assert.equal(result.same, true, 'a remote project with no cache rows must retain its bound host');
  assert.equal(result.plan.project.alias, 'alpha');
});

test('cache group runtime and complete known folder inventory must agree with members', async () => {
  const f = fixture();
  f.state.ownership.members.push(member('wrong-runtime', null, { runtime: 'codex' }));
  assert.ok((await planFor(f)).refusals.some(r => r.code === 'MEMBER_OWNERSHIP'), 'member runtime must match its verified backing group');
  const missing = fixture();
  missing.state.snapshot.projects[0].cacheFolderKeys = ['missing-cache-group'];
  assert.ok((await planFor(missing)).refusals.some(r => r.code === 'GROUP_MISSING'), 'a known backing group cannot silently disappear');
});

test('duplicate schedule identities refuse rather than collapsing distinct files', async () => {
  const f = fixture();
  f.state.schedules.schedules = ['first', 'second'].map(name => identity(null, {
    id: 'duplicate', path: `${projectPath}/schedule-${name}.md`, readable: true, verified: true,
  }));
  assert.ok((await planFor(f)).refusals.some(r => r.code === 'SCHEDULE_OWNERSHIP'), 'schedule identities must be unique');
});

test('inherited options cannot conceal unknown own fields', async () => {
  const f = fixture();
  const inherited = Object.assign(Object.create(options), { one: false, two: false, three: false, four: false, five: false });
  const reply = await f.planner.preview(f.request({ options: inherited }));
  assert.equal(reply.code, 'INVALID_REQUEST', 'options must contain exactly the five own boolean fields');
});

const running = { state: 'running', source: 'descriptor', targetId: 'controlled' };
const hasRefusal = (plan, code) => plan.refusals.some(row => row.code === code);

test('large synchronous discovery yields and refuses within its deadline', async t => {
  const f = fixture();
  f.state.snapshot.projects = [f.state.snapshot.projects[0]];
  f.state.ownership.groups = Array.from({ length: 4000 }, (_, i) => group(`g-${i}`, null, { projectPath: `${projectPath}/child-${i}` }));
  const original = fs.realpathSync.native;
  t.after(() => { fs.realpathSync.native = original; });
  fs.realpathSync.native = value => {
    const start = performance.now();
    while (performance.now() - start < 1) { /* bounded fake filesystem latency */ }
    return value;
  };
  const start = performance.now();
  const reply = await createProjectDeletePlanner({ ...f.deps, timeoutMs: 100 }).preview(f.request());
  const elapsed = performance.now() - start;
  assert.equal(reply.code, 'DISCOVERY_TIMEOUT', 'slow synchronous inventory must time out');
  assert.ok(elapsed < 350, `deadline must yield within a small margin, took ${elapsed}ms`);
});

test('local canonicalization calls realpath once per distinct path per preview', async t => {
  const f = fixture();
  f.state.ownership.members = Array.from({ length: 100 }, (_, i) => member(`p-${i}`));
  const calls = new Map();
  const original = fs.realpathSync.native;
  t.after(() => { fs.realpathSync.native = original; });
  fs.realpathSync.native = value => { calls.set(value, (calls.get(value) || 0) + 1); return value; };
  await planFor(f);
  assert.deepEqual([...calls.values()], [1], 'each distinct local path is canonicalized once');
  calls.clear();
  await planFor(f);
  assert.deepEqual([...calls.values()], [1], 'memo belongs to this planning call');
});

for (const kind of ['member', 'tab', 'job']) test(`selected folder with conflicting ${kind} ownership refuses instead of disappearing`, async () => {
  const f = fixture();
  const row = member('conflict', null, { projectPath: `${projectPath}/sub` });
  if (kind === 'member') f.state.ownership.members.push(row);
  else f.state.runtime[`${kind}s`].push(row);
  assert.ok(hasRefusal(await planFor(f), 'MEMBER_OWNERSHIP'), 'selected-folder conflict must refuse');
});

test('membership survives stop and volatile transcript evidence while fingerprint tracks liveness', async () => {
  const f = fixture();
  f.state.ownership.members = [member('live', null, { liveness: running, sessionFile: `${projectPath}/live.jsonl`, size: 10, mtimeMs: 1 })];
  const before = await planFor(f);
  f.state.ownership.members[0].liveness = { state: 'stopped', source: 'descriptor' };
  const stopped = await planFor(f);
  assert.equal(stopped.membershipDigest, before.membershipDigest, 'stopping must not change membership');
  assert.notEqual(stopped.fingerprint, before.fingerprint, 'stopping must change fingerprint');
  Object.assign(f.state.ownership.members[0], { size: 20, mtimeMs: 2, fileEvidence: { size: 20, mtimeMs: 2 } });
  assert.equal((await planFor(f)).membershipDigest, before.membershipDigest, 'volatile file evidence is not membership');
  f.state.ownership.members[0].partId = 'replacement';
  assert.notEqual((await planFor(f)).membershipDigest, before.membershipDigest, 'part identity is membership');
});

test('transcript size and mtime never change membership', async () => {
  const f = fixture();
  f.state.ownership.members = [member('file', null, { sessionFile: `${projectPath}/file.jsonl`, size: 10, mtimeMs: 1 })];
  const before = await planFor(f);
  Object.assign(f.state.ownership.members[0], { size: 20, mtimeMs: 2, fileEvidence: { size: 20, mtimeMs: 2 } });
  assert.equal((await planFor(f)).membershipDigest, before.membershipDigest, 'transcript size and mtime are not membership');
});

test('inventory processing lets event loop timers fire', async () => {
  const f = fixture();
  f.state.ownership.members = Array.from({ length: 2000 }, (_, i) => member(`p-${i}`));
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 0);
  try {
    await planFor(f);
    assert.equal(fired, true, 'inventory batches must yield to deadline timers');
  } finally { clearTimeout(timer); }
});

for (const kind of ['tab', 'job']) test(`duplicate ${kind} ids refuse`, async () => {
  const f = fixture();
  f.state.runtime[`${kind}s`] = [member('duplicate'), member('duplicate')];
  assert.ok(hasRefusal(await planFor(f), 'MEMBER_OWNERSHIP'), 'runtime ids must be unique');
});

for (const flag of [{ scheduleId: 'schedule' }, { background: true }, { jobId: 'job' }]) test(`running member ${Object.keys(flag)[0]} requires consent`, async () => {
  const f = fixture();
  f.state.ownership.members = [member('background', null, { ...flag, liveness: running })];
  const plan = await planFor(f);
  assert.ok(hasRefusal(plan, 'BACKGROUND_CONSENT'), 'member background markers require consent');
  assert.equal(plan.stops[0].excluded, true);
  assert.equal(hasRefusal(await planFor(f, { options: { ...options, stopBackgroundJobs: true } }), 'BACKGROUND_CONSENT'), false);
});

test('sort order uses code units', async () => {
  const f = fixture();
  f.state.ownership.members = [member('a'), member('Z')];
  assert.deepEqual((await planFor(f)).members.map(row => row.id), ['Z', 'a'], 'canonical sorting uses code units');
});

test('duplicate known canonical identities select deterministically and check every settings spelling', async t => {
  const f = fixture();
  const other = `${projectPath}-link`;
  const original = fs.realpathSync.native;
  t.after(() => { fs.realpathSync.native = original; });
  fs.realpathSync.native = value => value === path.resolve(other) ? path.resolve(projectPath) : value;
  f.state.snapshot.projects = [identity(null), identity(null, { projectPath: other }), identity('alpha', { projectPath: other.replace(/\\/g, '/') })];
  const before = await planFor(f);
  assert.equal(before.categories.settings.available, false, 'all selected spellings protect shared settings');
  f.state.snapshot.projects.reverse();
  const after = await planFor(f);
  assert.equal(after.project.entry, before.project.entry, 'known-row order must not select identity spelling');
  assert.equal(after.fingerprint, before.fingerprint);
});

test('known-row permutation cannot choose a different local entry spelling', async t => {
  const f = fixture();
  const original = fs.realpathSync.native;
  t.after(() => { fs.realpathSync.native = original; });
  fs.realpathSync.native = () => path.resolve(projectPath);
  f.state.snapshot.projects = [identity(null), identity(null, { projectPath: `${projectPath}-link` })];
  const before = await planFor(f);
  f.state.snapshot.projects.reverse();
  assert.deepEqual((await planFor(f)).project, before.project, 'known-row permutations must select the same project entry');
});

test('request is cloned before validating accessor-backed options', async () => {
  const f = fixture();
  let reads = 0;
  const inputOptions = { ...options, get sessions() { return ++reads > 1 ? 'unsafe' : false; } };
  const reply = await f.planner.preview(f.request({ options: inputOptions }));
  assert.equal(reply.ok, true);
  assert.equal(reply.plan.categories.sessions.selected, false, 'only validated cloned values enter the plan');
  assert.equal(reads, 1, 'clone request once before validation');
});

test('Windows case-variant local paths share identity', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture();
  const original = fs.realpathSync.native;
  t.after(() => { fs.realpathSync.native = original; });
  fs.realpathSync.native = value => value;
  const result = await f.planner.preview(f.request({ projectPath: projectPath.toUpperCase() }));
  assert.equal(result.ok, true, 'Windows local identity must fold case');
});

test('undeclared remote host refuses even with valid mapping', async () => {
  const f = fixture(); f.state.snapshot.declaredHosts = [];
  assert.equal((await f.planner.preview(f.request({ folderKey: 'alpha::group-a' }))).code, 'IDENTITY_UNAVAILABLE', 'undeclared host must refuse');
});

test('AC8 foreign running jobs never become stop targets', async () => {
  const f = fixture();
  f.state.runtime.jobs = [member('foreign-job', 'alpha', { liveness: running })];
  const plan = await planFor(f, { options: { ...options, stopBackgroundJobs: true } });
  assert.deepEqual(plan.stops, [], 'other-host job must never be stopped');
});

test('missing ownership explicitly refuses', async () => {
  const f = fixture(); const row = member(); delete row.alias; f.state.ownership.members = [row];
  assert.ok(hasRefusal(await planFor(f), 'OWNERSHIP_UNKNOWN'), 'unknown host ownership must refuse');
});

for (const extra of [{ verified: false }, { runtime: 'mystery' }]) test(`selected group ${Object.keys(extra)[0]} is verified`, async () => {
  const f = fixture(); Object.assign(f.state.ownership.groups[0], extra);
  assert.ok(hasRefusal(await planFor(f), 'GROUP_OWNERSHIP'), 'selected group ownership and runtime must be verified');
});

test('unverified child group never becomes a kept verified group', async () => {
  const f = fixture();
  f.state.ownership.groups.push(group('child', null, { projectPath: `${projectPath}/child`, parentProjectPath: projectPath, verified: false }));
  assert.equal((await planFor(f)).groups.some(row => row.folderKey === 'child'), false, 'kept child groups require verification');
});

test('duplicate member ids explicitly refuse', async () => {
  const f = fixture(); f.state.ownership.members = [member(), member()];
  assert.ok(hasRefusal(await planFor(f), 'MEMBER_OWNERSHIP'), 'duplicate member ids must refuse');
});

for (const extra of [{ verified: false }, { linked: true }]) test(`schedule ${Object.keys(extra)[0]} ownership refuses`, async () => {
  const f = fixture();
  f.state.schedules.schedules = [identity(null, { id: 'schedule', path: '/schedule.md', verified: true, readable: true, ...extra })];
  assert.ok(hasRefusal(await planFor(f), 'SCHEDULE_OWNERSHIP'), 'schedule verification and links must refuse');
});

test('revalidation of identical refused plans always returns same false', async () => {
  const f = fixture(); f.state.ownership.members = [member('uncertain', null, { present: false })];
  const plan = await planFor(f);
  assert.equal((await f.planner.revalidate(plan)).same, false, 'a matching refused fingerprint cannot authorize execution');
});
