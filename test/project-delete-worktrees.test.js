'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { createProjectDeleteService } = require('../src/main/projects/project-delete');
const { createProjectOperationGate } = require('../src/main/shared/project-operation-gate');
let implementation;
try { implementation = require('../src/main/projects/project-delete-worktrees'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const options = { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false };

test('slow unselected status leaves a metadata plan with uninspected rows', async t => {
  const f = gitFixture(t), p = planning([]);
  p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1',
    projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
  const calls = [];
  p.deps.worktrees = implementation.createProjectDeleteWorktrees({
    runGit: async args => {
      calls.push(args);
      if (args.includes('list')) return [f.root, f.target, f.kept].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join('');
      if (args.includes('rev-parse')) return path.join(f.root, 'absent-lock');
      return new Promise(() => {});
    }, readActivity: async () => ({ complete: true, sessions: [], jobs: [], candidates: [] }),
  });
  const started = Date.now();
  const result = await createProjectDeletePlanner({ ...p.deps, timeoutMs: 1000 }).preview({
    projectPath: f.root, options, worktrees: [],
  });
  assert.equal(result.ok, true, 'slow worktree status must not time out metadata planning');
  assert.ok(Date.now() - started < 1000, 'inventory must reserve time for metadata planning');
  for (const row of result.plan.worktrees.filter(row => !row.main)) {
    assert.equal(row.removable, false);
    assert.equal(row.statusKnown, false);
    assert.match(row.reason, /not inspected/i);
  }
  assert.equal(calls.filter(args => args.includes('status')).length, 1, 'expired inventory starts no further status calls');
  assert.equal(result.plan.refusals.length, 0);
});

for (const selected of [false, true]) test(`three-second status gets the ${selected ? 'selected' : 'unselected'} inspection budget`, async t => {
  const f = gitFixture(t), p = planning([]), deletion = require('../worktree-delete');
  let time = 0;
  const deadlines = [];
  t.mock.method(deletion, 'readStatus', async (directory, _root, _git, _unused, _inventory, budget) => {
    deadlines.push({ directory, remaining: budget.deadline - time });
    time += 3000;
    return { dirty: [], fingerprint: directory };
  });
  p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1',
    projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
  p.deps.worktrees = implementation.createProjectDeleteWorktrees({ now: () => time,
    runGit: async () => [f.root, f.kept, f.target].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join(''),
    readActivity: async () => ({ complete: true, sessions: [], jobs: [], candidates: [] }),
  });
  const planner = createProjectDeletePlanner({ ...p.deps, now: () => time, timeoutMs: 6500 });
  const result = await planner.preview({ projectPath: f.root, options, worktrees: selected ? [f.target] : [] });
  assert.equal(result.ok, true, 'slow physical inspection must leave a complete metadata plan');
  assert.deepEqual(result.plan.refusals, [], 'a three-second selected inspection must be allowed');
  const chosen = result.plan.worktrees.find(row => row.path === f.target);
  assert.equal(chosen.removable, selected, 'selected rows must have enough time for a three-second status');
  assert.equal(chosen.statusKnown, selected);
  const unselected = result.plan.worktrees.find(row => row.path === f.kept);
  assert.equal(unselected.removable, false);
  assert.match(unselected.reason, /not inspected/i);
  for (const read of deadlines.filter(row => !selected || row.directory !== f.target)) {
    assert.ok(read.remaining <= 2000, 'unselected reads retain the two-second cap even with a selection');
    assert.ok(read.remaining <= (selected ? 1750 : 3250), 'unselected reads take at most half the remaining planner budget');
  }
  if (selected) {
    assert.equal(deadlines[0].directory, f.target, 'unselected inventory cannot starve a selected row');
    assert.equal((await planner.revalidate(result.plan)).same, true, 'confirm must allow the same slow selected row');
  }
});

test('planner deadline still bounds the metadata fence after a selected inspection expires', async t => {
  const f = gitFixture(t), p = planning([]), deletion = require('../worktree-delete');
  t.mock.method(deletion, 'readStatus', () => new Promise(() => {}));
  p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1',
    projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
  p.deps.worktrees = implementation.createProjectDeleteWorktrees({
    runGit: async () => [f.root, f.target].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join(''),
    readActivity: async () => ({ complete: true, sessions: [], jobs: [], candidates: [] }),
  });
  p.deps.readRevision = () => new Promise(() => {});
  const result = await createProjectDeletePlanner({ ...p.deps, timeoutMs: 1000 }).preview({
    projectPath: f.root, options, worktrees: [f.target],
  });
  assert.equal(result.ok, false, 'the overall deadline remains authoritative for a stalled metadata fence');
  assert.equal(result.code, 'DISCOVERY_TIMEOUT');
  assert.match(result.error, /Delete worktree.*sidebar/i);
});

test('selected inspection reserves 500ms for the metadata fence and returns an uninspected row', async t => {
  const f = gitFixture(t), p = planning([]);
  let time = 0, inspectionDeadline, fenceTime;
  p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1',
    projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
  p.deps.readRevision = async () => { fenceTime = time; time += 100; return '1'; };
  p.deps.worktrees = implementation.createProjectDeleteWorktrees({ now: () => time,
    runGit: async args => {
      if (args.includes('list')) return [f.root, f.target].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join('');
      if (args.includes('rev-parse')) return path.join(f.root, 'absent-lock');
      if (args.includes('status')) time = inspectionDeadline;
      return '';
    },
    readActivity: async (_project, budget) => {
      inspectionDeadline = budget.deadline;
      return { complete: true, sessions: [], jobs: [], candidates: [] };
    },
  });
  const result = await createProjectDeletePlanner({ ...p.deps, now: () => time, timeoutMs: 10000 }).preview({
    projectPath: f.root, options, worktrees: [f.target],
  });
  assert.equal(result.ok, true, 'exhausted selected inspection must leave time for metadata planning');
  assert.equal(inspectionDeadline, 9500, 'selected inspection must end 500ms before the planner deadline');
  assert.equal(fenceTime, 9500);
  assert.equal(result.plan.revision, '1');
  const selected = result.plan.worktrees.find(row => row.path === f.target);
  assert.equal(selected.removable, false);
  assert.equal(selected.statusKnown, false);
  assert.match(selected.reason, /not inspected/i);
  assert.match(selected.reason, /Delete worktree.*sidebar/i);
  assert.equal(result.plan.refusals.length, 1);
  assert.equal(result.plan.refusals[0].target, f.target);
});

test('selected inspection failure directs the user to Delete worktree in the sidebar', async t => {
  const f = gitFixture(t), deletion = require('../worktree-delete');
  t.mock.method(deletion, 'readStatus', async () => { throw new Error('Worktree not inspected: status unavailable.'); });
  const rows = await f.adapter.preview(f.project, { ...f.budget(), selectedWorktrees: [f.target.replaceAll('\\', '/')] });
  const selected = rows.find(row => path.resolve(row.path) === f.target);
  assert.equal(selected.removable, false);
  assert.match(selected.reason, /Delete worktree.*sidebar/i, 'uninspectable selection must offer the dedicated sidebar action');
});

for (const cwd of ['relative', null]) for (const binding of [null, 'folder', 'projectPath']) test(`session cwd ${cwd} is scoped by ${binding || 'dialog-level ownership'}`, async t => {
  const f = gitFixture(t), { createProjectDeleteRuntime } = require('../src/main/projects/project-delete-main');
  const row = { sessionId: 'stray', cwd, ...(binding === 'folder' ? { folder: 'linked-folder' }
    : binding === 'projectPath' ? { projectPath: f.target } : {}) };
  const runtime = createProjectDeleteRuntime({ activeSessions: new Map(), jobsDir: path.join(f.root, 'jobs'), homeDir: f.root,
    runClaude: async () => ({ code: 0, stdout: '[]' }), cliSessionState: {
      getSidebarDescriptors: () => [row], getScheduleRunSnapshot: () => [], readStatusEvidence: async () => ({ known: true, live: null }),
    } });
  const result = await runtime.readWorktreeActivity({ ...f.project, worktreePaths: [f.target, f.kept] }, {
    ...f.budget(), snapshot: { sessions: [], projects: [{ alias: null, projectPath: f.target, folderKeys: ['linked-folder'] }] },
  });
  assert.deepEqual(result.byPath[f.kept].candidates, [], 'an unrelated row must not make every folder uncertain');
  assert.equal(result.byPath[f.target].candidates.length, binding ? 1 : 0);
  assert.equal(result.candidates.length, binding ? 0 : 1, 'unattributed session reason is shown once at dialog level');
});

for (const kind of ['active', 'scheduled run', 'live descriptor', 'unknown descriptor', 'ambiguous descriptor', 'stopped descriptor', 'dormant']) {
  test(`unlocated ${kind} only blocks selected folders when activity is live or uncertain`, async t => {
    const f = gitFixture(t), { createProjectDeleteRuntime } = require('../src/main/projects/project-delete-main');
    const row = { sessionId: 'unlocated', cwd: null };
    const blocking = !['stopped descriptor', 'dormant'].includes(kind);
    const runtime = createProjectDeleteRuntime({
      activeSessions: new Map(kind === 'active' ? [[row.sessionId, row]] : []),
      jobsDir: path.join(f.root, 'jobs'), homeDir: f.root, runClaude: async () => ({ code: 0, stdout: '[]' }),
      cliSessionState: {
        getSidebarDescriptors: () => kind.includes('descriptor') ? [row] : [],
        getScheduleRunSnapshot: () => kind === 'scheduled run' ? [row] : [],
        readStatusEvidence: async () => ({ known: kind !== 'unknown descriptor',
          live: kind === 'live descriptor' ? { pid: 123 } : null, ambiguous: kind === 'ambiguous descriptor' }),
      },
    });
    const p = planning([]);
    p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1', sessions: [row],
      projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
    p.deps.worktrees = implementation.createProjectDeleteWorktrees({ readActivity: runtime.readWorktreeActivity,
      runGit: async args => args.includes('list') ? [f.root, f.target, f.kept].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join('')
        : args.includes('rev-parse') ? path.join(f.root, 'absent-lock') : '' });
    const planner = createProjectDeletePlanner(p.deps);
    for (const selected of [[], [f.target], [f.target, f.kept]]) {
      const preview = await planner.preview({ projectPath: f.root, options, worktrees: selected });
      assert.equal(preview.ok, true, 'unlocated activity must not prevent the metadata plan');
      assert.equal(preview.plan.warnings.filter(row => /Session cwd unavailable/.test(row.error)).length, 1,
        'duplicate session sources must produce one dialog reason');
      assert.equal(preview.plan.refusals.length, blocking ? selected.length : 0,
        'unlocated live or uncertain session must refuse every selected folder');
      for (const row of preview.plan.worktrees.filter(row => !row.main)) {
        const refused = blocking && selected.includes(row.path);
        assert.equal(row.removable, !refused);
        if (refused) assert.match(row.reason, /unattributed activity/i);
      }
    }
  });
}

test('global unknown job is shown once and blocks selected folders only', async t => {
  const f = gitFixture(t), { createProjectDeleteRuntime } = require('../src/main/projects/project-delete-main');
  const runtime = createProjectDeleteRuntime({ activeSessions: new Map(), jobsDir: path.join(f.root, 'jobs'), homeDir: f.root,
    runClaude: async () => ({ code: 0, stdout: JSON.stringify([{ id: '1234abcd', kind: 'background', sessionId: 'unknown' }]) }),
    cliSessionState: { getSidebarDescriptors: () => [], getScheduleRunSnapshot: () => [] } });
  const result = await runtime.readWorktreeActivity({ ...f.project, worktreePaths: [f.target, f.kept] },
    { ...f.budget(), selectedWorktrees: [f.target], snapshot: { sessions: [] } });
  assert.deepEqual(result.byPath[f.kept].candidates, [], 'global job reason must not be copied to each folder');
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].reason, /no durable job record/);
  assert.equal(result.byPath[f.target].ownershipUncertain, true, 'unknown job may own selected folder');
  assert.equal(result.byPath[f.kept].ownershipUncertain, false);
  const p = planning([]);
  p.deps.readSnapshot = async () => ({ complete: true, initialScanComplete: true, revision: '1', sessions: [],
    projects: [{ alias: null, projectPath: f.root, folderKeys: [] }], declaredHosts: [] });
  p.deps.worktrees = implementation.createProjectDeleteWorktrees({ readActivity: runtime.readWorktreeActivity,
    runGit: async args => args.includes('list') ? [f.root, f.target, f.kept].map(dir => `worktree ${dir}\nHEAD abc\n\n`).join('')
      : args.includes('rev-parse') ? path.join(f.root, 'absent-lock') : '' });
  const planner = createProjectDeletePlanner(p.deps);
  for (const selected of [[], [f.target]]) {
    const preview = await planner.preview({ projectPath: f.root, options, worktrees: selected });
    assert.equal(preview.ok, true);
    assert.equal(preview.plan.warnings.filter(row => /no durable job record/.test(row.error)).length, 1);
    assert.equal(preview.plan.worktrees.find(row => row.path === f.target).removable, selected.length === 0);
    assert.equal(preview.plan.worktrees.find(row => row.path === f.kept).removable, true);
    assert.equal(preview.plan.refusals.length, selected.length);
  }
});

test('shared status stops after a late Git reply when its inspection deadline expires', async t => {
  const f = gitFixture(t), deletion = require('../worktree-delete');
  let now = 0;
  const commands = [];
  await assert.rejects(deletion.readStatus(f.target, f.root, async args => {
    commands.push(args);
    now = 20;
    return args.includes('rev-parse') ? path.join(f.root, 'absent-lock') : '';
  }, undefined, { records: [f.root, f.target].map(directory => ({ path: directory, fields: [] })) },
  { deadline: 10, signal: new AbortController().signal, now: () => now }), /not inspected/i);
  assert.equal(commands.length, 1, 'late Git reply must not trigger further status or hashing');
});

test('E production activity reader includes descendant sessions, schedules and refused background records', async t => {
  const { createProjectDeleteRuntime } = require('../src/main/projects/project-delete-main');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'e-activity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, 'child'); fs.mkdirSync(child);
  const jobsDir = path.join(root, 'jobs'); fs.mkdirSync(path.join(jobsDir, '1234abcd'), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, '1234abcd', 'state.json'), JSON.stringify({ state: 'done', cwd: child,
    sessionId: '12345678-1234-1234-1234-123456789abc' }));
  const runtime = createProjectDeleteRuntime({ activeSessions: new Map([['live', { cwd: child, sessionId: 'live' }]]), jobsDir,
    homeDir: root, runClaude: async () => ({ code: 0, stdout: '[]' }), cliSessionState: {
      getSidebarDescriptors: options => {
        assert.equal(options?.allWriters, true, 'worktree deletion must include every descriptor writer');
        return [{ sessionId: 'external', cwd: child }];
      },
      readStatusEvidence: async () => ({ known: true, live: { pid: 123 }, ambiguous: false }),
      getScheduleRunSnapshot: () => [{ sessionId: 'schedule', cwd: child }],
    } });
  assert.equal(typeof runtime.readWorktreeActivity, 'function', 'linked worktrees require authoritative descendant activity');
  const result = await runtime.readWorktreeActivity({ alias: null, projectPath: root },
    { signal: new AbortController().signal, deadline: Date.now() + 15000, limit: 20000, snapshot: { sessions: [] } });
  assert.ok(result.sessions.some(row => row.sessionId === 'live'));
  assert.ok(result.sessions.some(row => row.sessionId === 'external'));
  assert.ok(result.jobs.some(row => row.id === '1234abcd'), 'done background record must remain refused');
  assert.ok(result.jobs.some(row => row.sessionId === 'schedule'));
  assert.ok(result.candidates.some(row => row.reason.includes('#1090')));
});

function planning(rows) {
  const projectPath = path.resolve(os.tmpdir(), 'e-planning');
  const state = { rows, removed: [], events: [], revision: '1' };
  const empty = { complete: true, groups: [], members: [], tabs: [], jobs: [], schedules: [], candidates: [] };
  const worktrees = {
    preview: async () => structuredClone(state.rows),
    async remove(project, selected, record) {
      for (const row of selected) {
        state.events.push('remove:' + row.path);
        const result = { path: row.path, state: state.fail === row.path ? 'failed' : 'removed', error: state.fail === row.path ? 'Git refused; inspect disk' : undefined };
        record(result);
        if (result.state === 'failed') return false;
        state.removed.push(row.path);
      }
      return true;
    },
  };
  const deps = {
    waitForIndex: async () => {}, readSnapshot: async () => ({ complete: true, initialScanComplete: true, revision: state.revision,
      projects: [{ alias: null, projectPath, folderKeys: [] }], declaredHosts: [] }),
    discoverOwnership: async () => empty, discoverSchedules: async () => empty,
    readRuntimeState: async () => empty, readRevision: async () => state.revision, worktrees,
  };
  const planner = createProjectDeletePlanner(deps);
  const request = selected => ({ projectPath, options, worktrees: selected });
  return { state, deps, planner, request, projectPath, worktrees };
}

test('E planner binds exact individual selection and content to the fingerprint', async () => {
  const row = { path: path.resolve(os.tmpdir(), 'linked-e'), branch: 'topic', removable: true, fingerprint: 'one', sessions: [], dirty: [] };
  const f = planning([row]);
  const kept = await f.planner.preview(f.request([]));
  assert.equal(kept.ok, true, 'empty worktree selection must be accepted');
  const chosen = await f.planner.preview(f.request([row.path]));
  assert.equal(chosen.ok, true, 'individual worktree selection must be accepted');
  assert.equal(chosen.plan.worktrees[0].selected, true);
  assert.notEqual(chosen.plan.fingerprint, kept.plan.fingerprint, 'selection must change the token fingerprint');
  assert.equal((await f.planner.revalidate(chosen.plan)).same, true);
  f.state.rows[0].fingerprint = 'changed-content';
  assert.equal((await f.planner.revalidate(chosen.plan)).same, false, 'changed worktree content must invalidate consent');
  for (const selected of [[row.path, row.path], [path.resolve(os.tmpdir(), 'foreign')], [f.projectPath]]) {
    const reply = await f.planner.preview(f.request(selected));
    assert.ok(!reply.ok || reply.plan.refusals.length, 'foreign, main and duplicate selections must refuse');
  }
  f.state.rows[0].removable = false; f.state.rows[0].reason = 'Stop live session first';
  assert.ok((await f.planner.preview(f.request([row.path]))).plan.refusals.length);
});

test('E subtree holds drain admitted children and reject new descendant launches', async () => {
  const gate = createProjectOperationGate(), root = path.resolve(os.tmpdir(), 'e-gate');
  assert.equal(typeof gate.holdTree, 'function', 'worktree deletion needs subtree exclusion');
  const lease = gate.tryAdmit(path.join(root, 'nested'));
  const hold = gate.holdTree(root); let ready = false;
  hold.ready.then(() => { ready = true; }); await Promise.resolve();
  assert.equal(ready, false, 'existing descendant launch must drain');
  assert.equal(gate.tryAdmit(path.join(root, 'new')), null);
  assert.throws(() => gate.hold(path.join(root, 'child')));
  const sibling = gate.tryAdmit(root + '-sibling'); assert.ok(sibling); sibling.release();
  const remote = gate.tryAdmit(root, 'remote'); assert.ok(remote); remote.release();
  lease.release(); await hold.ready; hold.release();
  const reopened = gate.tryAdmit(path.join(root, 'new')); assert.ok(reopened); reopened.release();
});

async function serviceFixture(t, fail) {
  const a = path.resolve(os.tmpdir(), 'e-selected-a'), b = path.resolve(os.tmpdir(), 'e-selected-b');
  const f = planning([a, b].map(p => ({ path: p, removable: true, fingerprint: p, sessions: [], dirty: [] })));
  f.state.fail = fail ? b : undefined;
  const gate = createProjectOperationGate(), sender = { valid: () => true };
  const writer = {
    listProjectDeletionOperations: async () => ({ rows: [], revision: 1, nextCursor: null }),
    readProjectDeletionScope: async () => ({ writerRevision: 1, projectEpoch: 0, writerMembershipDigest: 'durable' }),
    reserveProjectDeletion: () => ({ ready: Promise.resolve(), release() {} }),
    async completeProjectDeletion() {
      f.state.events.push('metadata');
      return { state: 'committed', terminal: true, receiptAvailable: true, invalidation: {}, committedRevision: 2 };
    },
  };
  const stop = { preflight: async () => ({ ok: true }), stop: async () => {
    f.state.events.push('stop'); return { ok: true, stopped: [], failed: [], skipped: [] };
  }, verify: async () => ({ ok: true }) };
  const service = createProjectDeleteService({ writer, planner: f.planner, inventory: { inspectRetainedFiles: async () => [] },
    stop, gate, worktrees: f.worktrees });
  t.after(() => service.dispose()); await service.initialize();
  return { ...f, a, b, gate, service, sender, writer };
}

test('E disk effects remain partial when the metadata writer proves no commit', async t => {
  const f = await serviceFixture(t);
  f.writer.completeProjectDeletion = async () => ({ state: 'notStarted', terminal: true, receiptAvailable: true, noLateCommit: true });
  const preview = await f.service.preview(f.sender, f.request([f.a]));
  const result = await f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  assert.equal(result.state, 'partial', 'removed folders cannot be reported as an operation that never started');
  assert.equal(result.partial, true);
  assert.equal(result.worktrees[0].state, 'removed');
});

test('E service holds selected descendant launches until the removal promise settles', async t => {
  const f = await serviceFixture(t); let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.worktrees.remove = async () => { entered(); await new Promise(resolve => { finish = resolve; }); return false; };
  const preview = await f.service.preview(f.sender, f.request([f.a]));
  const executing = f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  await started;
  const lease = f.gate.tryAdmit(path.join(f.a, 'new-session'));
  finish(); await executing;
  assert.equal(lease, null, 'no descendant may launch while disk removal is in flight');
});

test('E service removes only selected worktrees after stop and before metadata', async t => {
  const f = await serviceFixture(t);
  const preview = await f.service.preview(f.sender, f.request([f.a]));
  assert.ok(preview.token, 'selected worktrees must produce an owned token');
  const result = await f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  assert.equal(result.ok, true);
  assert.deepEqual(f.state.events, ['stop', 'remove:' + f.a, 'metadata']);
  assert.deepEqual(result.worktrees.map(row => [row.path, row.state]), [[f.a, 'removed']]);
  assert.deepEqual(f.state.removed, [f.a]);
});

test('E failed second removal seals a partial result, never submits metadata or replays on state read', async t => {
  const f = await serviceFixture(t, true);
  const preview = await f.service.preview(f.sender, f.request([f.a, f.b]));
  assert.ok(preview.token, 'selected worktrees must produce an owned token');
  const result = await f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  assert.equal(result.state, 'partial'); assert.equal(result.ok, false);
  assert.deepEqual(result.worktrees.map(row => row.state), ['removed', 'failed']);
  assert.equal(f.state.events.includes('metadata'), false, 'disk failure must keep parent metadata untouched');
  await f.service.readState(f.sender, { operationId: result.operationId });
  assert.deepEqual(f.state.events, ['stop', 'remove:' + f.a, 'remove:' + f.b]);
  const lease = f.gate.tryAdmit(path.join(f.a, 'child')); assert.ok(lease); lease.release();
});

function gitFixture(t) {
  assert.equal(typeof implementation?.createProjectDeleteWorktrees, 'function', 'production linked-worktree adapter must exist');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-e-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'linked'), kept = path.join(root, 'kept');
  fs.mkdirSync(target); fs.mkdirSync(kept); fs.writeFileSync(path.join(root, 'tracked'), 'base');
  const commands = [], state = { sessions: [], candidates: [], jobs: [] };
  const runGit = async args => {
    commands.push(args);
    if (args.includes('list')) {
      const separator = args.includes('-z') ? '\0' : '\n';
      return [root, target, kept].filter(p => fs.existsSync(p)).map(p =>
        ['worktree ' + p.replaceAll('\\', '/'), 'HEAD abc', 'branch refs/heads/topic', ''].join(separator) + separator).join('');
    }
    if (args.includes('rev-parse')) return path.join(root, 'absent-lock') + '\n';
    if (args.includes('ls-files')) return '';
    if (args.includes('status')) return fs.existsSync(path.join(args[1], 'untracked')) ? '?? untracked\0' : '';
    if (args.includes('remove')) { fs.rmSync(args.at(-1), { recursive: true }); return ''; }
    throw new Error('Unexpected Git command: ' + args.join(' '));
  };
  const adapter = implementation.createProjectDeleteWorktrees({ runGit, readActivity: async () => ({ complete: true, ...state }) });
  const project = { alias: null, projectPath: root.replaceAll('\\', '/').toLowerCase() };
  if (process.platform !== 'win32') project.projectPath = root;
  const budget = () => ({ signal: new AbortController().signal, deadline: Date.now() + 15000, limit: 20000 });
  return { root, target, kept, state, commands, adapter, project, budget };
}

test('E shared removal with a controlled Git port discovery lists main, branch, dirty/untracked bytes; removes exactly the reviewed linked directory', async t => {
  const f = gitFixture(t);
  fs.writeFileSync(path.join(f.target, 'untracked'), 'discard');
  const rows = await f.adapter.preview(f.project, f.budget());
  assert.equal(rows.find(row => row.main).removable, false);
  assert.equal(rows.find(row => row.main).statusKnown, false, 'kept checkout must not be scanned');
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

test('E adapter rejects remote, main checkout and uncertain activity without invoking Git removal', async t => {
  const f = gitFixture(t);
  await assert.rejects(f.adapter.preview({ ...f.project, alias: 'remote' }, f.budget()), { code: 'WORKTREE_UNAVAILABLE' });
  let rows = await f.adapter.preview(f.project, f.budget());
  assert.equal(await f.adapter.remove(f.project, [rows.find(row => row.main)], () => {}), false);
  f.state.candidates.push({ reason: 'External ownership unknown' });
  rows = await f.adapter.preview(f.project, f.budget());
  assert.equal(rows.find(row => path.resolve(row.path) === f.target).removable, false);
  assert.equal(f.commands.some(args => args.includes('remove')), false);
});

test('E shared removal with a controlled Git port changed contents and new live sessions refuse before any disk removal', async t => {
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

test('E inventory supports Git 2.24 newline porcelain and scans only removable rows', async t => {
  const f = gitFixture(t);
  await f.adapter.preview(f.project, f.budget());
  assert.equal(f.commands.some(args => args.includes('list') && args.includes('-z')), false, 'Git 2.24 rejects list -z');
  assert.equal(f.commands.filter(args => args.includes('list')).length, 1, 'registration is read once per inventory');
  assert.equal(f.commands.some(args => args.includes('status') && path.resolve(args[1]) === f.root), false, 'main checkout must not be scanned');
});

test('E no selection ignores dirty changes while selected bytes invalidate consent', async t => {
  const f = await serviceFixture(t);
  const preview = await f.service.preview(f.sender, f.request([]));
  f.state.rows[0].dirty.push('?? new.txt'); f.state.rows[0].fingerprint = 'new';
  const result = await f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  assert.equal(result.state, 'committed', 'unselected dirty bytes must not invalidate project consent');
  const g = await serviceFixture(t);
  const selected = await g.service.preview(g.sender, g.request([g.a]));
  g.state.rows[0].fingerprint = 'new';
  const changed = await g.service.execute(g.sender, { token: selected.token, fingerprint: selected.plan.fingerprint });
  assert.equal(changed.code, 'PREVIEW_CHANGED');
  assert.equal(g.state.removed.length, 0);
});

test('E precheck refusal has no partial disk effect or invented failed path', async t => {
  const f = gitFixture(t), results = [];
  const rows = await f.adapter.preview(f.project, f.budget());
  const selected = rows.find(row => path.resolve(row.path) === f.target);
  fs.writeFileSync(path.join(f.target, 'untracked'), 'late');
  await f.adapter.remove(f.project, [selected], row => results.push(row));
  assert.equal(results[0].state, 'refused', 'no Git remove was attempted');
});

test('E whole-inventory failure refuses without blaming the first selected path', async t => {
  const f = gitFixture(t);
  const selected = (await f.adapter.preview(f.project, f.budget())).find(row => path.resolve(row.path) === f.target);
  const adapter = implementation.createProjectDeleteWorktrees({ runGit: async () => { throw new Error('inventory offline'); }, readActivity: async () => ({ complete: true }) });
  const failures = [];
  await adapter.remove(f.project, [selected], row => failures.push(row));
  assert.equal(failures[0].state, 'refused');
  assert.equal(failures[0].path, undefined, 'whole inventory failure has no individual path');
});

test('E service reports precheck refusal without partially completed deletion', async t => {
  const f = await serviceFixture(t);
  f.worktrees.remove = async (_project, _selected, record) => { record({ state: 'refused', error: 'inventory offline' }); return false; };
  const preview = await f.service.preview(f.sender, f.request([f.a]));
  const result = await f.service.execute(f.sender, { token: preview.token, fingerprint: preview.plan.fingerprint });
  assert.equal(result.partial, false, 'refusal is not a disk effect');
  assert.equal(result.state, 'notStarted');
  assert.equal(f.state.events.includes('metadata'), false);
});

test('E confirm only inspects selected worktrees and retains the last removal guard', async t => {
  const f = gitFixture(t);
  const selected = (await f.adapter.preview(f.project, f.budget())).find(row => path.resolve(row.path) === f.target);
  f.commands.length = 0;
  assert.equal(await f.adapter.remove(f.project, [selected], () => {}), true);
  assert.equal(f.commands.some(args => args.includes('status') && path.resolve(args[1]) !== f.target), false, 'confirm must not inspect unselected folders');
  assert.equal(f.commands.filter(args => args.includes('status') && !args.includes('--ignored')).length, 2, 'preflight and immediately before removal');
});

test('E preview shares one Claude roster and path resolution across sibling worktree rows', async t => {
  const f = gitFixture(t), { createProjectDeleteRuntime } = require('../src/main/projects/project-delete-main');
  let spawns = 0, descriptors = 0;
  const resolutions = new Map();
  const runtime = createProjectDeleteRuntime({ fs: { ...fs.promises, realpath: async value => {
    resolutions.set(value, (resolutions.get(value) || 0) + 1); return fs.promises.realpath(value);
  } }, activeSessions: new Map(), jobsDir: path.join(f.root, 'jobs'), homeDir: f.root,
  runClaude: async () => { spawns++; return { code: 0, stdout: '[]' }; }, cliSessionState: {
    getSidebarDescriptors: () => { descriptors++; return [{ sessionId: 'one', cwd: f.target }, { sessionId: 'two', cwd: f.target }]; },
    readStatusEvidence: async () => ({ known: true, live: null }), getScheduleRunSnapshot: () => [],
  } });
  const adapter = implementation.createProjectDeleteWorktrees({ runGit: async args => {
    f.commands.push(args);
    if (args.includes('list')) return [f.root, f.target, f.kept].map(p => `worktree ${p.replaceAll('\\', '/')}\nHEAD abc\n\n`).join('').replaceAll('\n', args.includes('-z') ? '\0' : '\n');
    if (args.includes('rev-parse')) return path.join(f.root, 'absent-lock');
    return '';
  }, readActivity: runtime.readWorktreeActivity });
  const budget = { ...f.budget(), snapshot: { sessions: [] } };
  await runtime.readJobs(f.project, budget);
  const rows = await adapter.preview(f.project, budget);
  assert.equal(rows.length, 3);
  assert.equal(spawns, 1, 'one claude agents spawn per preview, including parent inventory');
  assert.equal(descriptors, 1, 'session inventory is read once');
  assert.equal(Math.max(...resolutions.values()), 1, 'paths resolve once per inventory');
});
