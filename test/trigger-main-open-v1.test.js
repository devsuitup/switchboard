'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ID,  } = require('./fixtures/trigger-main-open.cjs');
test('invalid private launch permit cannot spawn', async () => {
  const f = fixture(); const r = await f.open();
  assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});
test('resume permit cannot take the ordinary missing-transcript fresh-start fallback', async () => {
  const f = fixture(); f.authorize();
  f.context.validateTriggerOpen = async () => ({ ok: false, reason: 'no readable transcript' });
  const r = await f.open(); assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});
test('permit is rechecked after asynchronous launch preparation', async () => {
  const f = fixture(); f.authorize();
  f.context.scheduleProjects = () => ({ add: async () => { f.context.triggerRendererBridge.checkPermit = () => null; } });
  const r = await f.open(); assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});
test('valid resume uses exact --resume, records spawn time and marks actual entry', async () => {
  const f = fixture(); f.authorize();
  const r = await f.open(); assert.equal(r.ok, true);
  assert.match(f.spawns[0].args[0], new RegExp(`--resume ${ID}`));
  assert.equal(f.marks[0]?.[1], f.map.get(ID));
  assert.ok(Number.isInteger(f.map.get(ID).launchStartedAt));
});
test('concurrent ordinary open requests share preparation and spawn only once', async () => {
  const f = fixture();
  const releases = []; f.context.sessionTransitions.snapshotContinuationsBeforeSpawn = () => new Promise(resolve => { releases.push(resolve); });
  const first = f.open(null);
  await new Promise(resolve => setImmediate(resolve));
  const second = f.open(null);
  await new Promise(resolve => setImmediate(resolve)); releases.forEach(release => release(null));
  const result = await Promise.all([first, second]);
  assert.equal(f.spawns.length, 1); assert.equal(result.every(r => r.ok), true);
});
test('reattach-only permit with a vanished target never spawns', async () => {
  const f = fixture(); f.permit.mode = 'reattach'; f.authorize();
  const r = await f.open('permit', false, { reattachOnly: true });
  assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});

test('ordinary launch records the actual resume/fresh mode and source for joined trigger validation', async () => {
  const f = fixture(); f.context.sessionTranscriptExists = () => true;
  assert.equal((await f.open(null)).ok, true);
  assert.equal(f.map.get(ID).launchMode, 'resume');
  assert.equal(f.map.get(ID).launchSourceId, ID);
  assert.ok(Number.isInteger(f.map.get(ID).launchStartedAt));
  const fresh = fixture(); assert.equal((await fresh.open(null, true)).ok, true);
  assert.equal(fresh.map.get(ID).launchMode, 'new');
});

test('a permit joins an already-created exact ordinary resume without spawning again', async () => {
  const f = fixture(); f.authorize(); let checked = 0;
  f.map.set(ID, { pty: {}, generation: 7, outputBuffer: [], launchMode: 'resume', launchSourceId: ID });
  f.context.triggerRendererBridge.ensureJoined = async () => { checked++; return { ok: true }; };
  const result = await f.open();
  assert.equal(result.ok, true); assert.equal(result.reattached, true);
  assert.equal(checked, 1); assert.equal(f.spawns.length, 0);
});

test('an uppercase ordinary tab appearing during preparation prevents a second normalized-ID spawn', async () => {
  const f = fixture(); f.authorize();
  f.context.scheduleProjects = () => ({ add: async () => { f.map.set(ID.toUpperCase(), { pty: {}, generation: 9 }); } });
  const result = await f.open();
  assert.equal(result.ok, false); assert.equal(result.reason, 'session target changed'); assert.equal(f.spawns.length, 0);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateTriggerOpen } = require('../src/main/triggers/trigger-launch');
const { resolveLocalTarget } = require('../src/main/triggers/trigger-actions');
const { encodeProjectPath } = require('../encode-project-path');

function realValidation(f, deps) {
  f.context.validateTriggerOpen = permit => validateTriggerOpen(permit, deps);
}
function liveDeps(f, live) {
  const target = { ...f.permit.target, project: f.permit.project };
  f.permit.target = target;
  const scans = []; let count = 0;
  const deps = { launchAllowed: () => true, broker: f.context.triggerRendererBridge, remoteTarget: async () => false,
    liveElsewhere: async (_id, deadline) => { scans.push(deadline); return count++ === 0 ? { known: true, live: null } : live; },
    resolveTarget: async () => ({ ok: true, ...target }) };
  return { deps, scans };
}
const lateLiveness = [
  ['scheduled writer', { known: true, live: { kind: 'schedule' } }, 'scheduled session is not supported'],
  ['background writer', { known: true, live: { kind: 'bg' } }, 'background session is not supported'],
  ['other interactive writer', { known: true, live: { kind: 'interactive' } }, 'session live elsewhere'],
  ['unknown liveness', { known: false }, 'session liveness unavailable'],
];
for (const [name, live, reason] of lateLiveness) {
  test(`the final main-process validation refuses a late ${name} without spawning`, async () => {
    const f = fixture(); f.authorize();
    const { deps, scans } = liveDeps(f, live);
    realValidation(f, deps);
    const result = await f.open();
    assert.equal(result.ok, false); assert.equal(result.reason, reason);
    assert.equal(scans.length, 2, 'initial and final liveness observations');
    assert.ok(scans.every(deadline => deadline === f.permit.deadline && Number.isFinite(deadline)), 'both observations receive the permit deadline');
    assert.equal(f.spawns.length, 0); assert.equal(f.marks.length, 0); assert.equal(f.map.size, 0);
  });
}
test('the same real validation without a late change spawns exactly once', async () => {
  const f = fixture(); f.authorize();
  const { deps, scans } = liveDeps(f, { known: true, live: null });
  realValidation(f, deps);
  const result = await f.open();
  assert.equal(result.ok, true); assert.equal(scans.length, 2);
  assert.equal(f.spawns.length, 1); assert.equal(f.marks.length, 1);
});

function transcriptWorld(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-main-final-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); const projectsDir = path.join(root, 'transcripts');
  fs.mkdirSync(project);
  const folder = encodeProjectPath(project);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const transcript = path.join(projectsDir, folder, ID + '.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: ID, cwd: project }) + '\n');
  const snapshot = { allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} };
  return { project, projectsDir, folder, transcript,
    deps: { fs, projectsDir, getCachedSession: () => ({ folder }), getCachedFolder: () => null, getProjectSnapshot: async () => snapshot, now: Date.now } };
}
const lateTranscript = {
  missing: world => fs.unlinkSync(world.transcript),
  empty: world => fs.writeFileSync(world.transcript, ''),
  'whitespace only': world => fs.writeFileSync(world.transcript, '  \n'),
  malformed: world => fs.writeFileSync(world.transcript, 'not json\n'),
  directory: world => { fs.unlinkSync(world.transcript); fs.mkdirSync(world.transcript); },
  symlink: world => { fs.renameSync(world.transcript, world.transcript + '.target'); fs.symlinkSync(world.transcript + '.target', world.transcript); },
};
for (const [name, change] of Object.entries(lateTranscript)) {
  test(`the final main-process validation refuses a transcript that became ${name} during preparation`, async t => {
    const f = fixture(); f.authorize();
    const world = transcriptWorld(t);
    const target = await resolveLocalTarget(ID, { ...world.deps, deadline: Date.now() + 2000 });
    assert.equal(target.ok, true);
    Object.assign(f.permit, { project: target.project, target });
    realValidation(f, { ...world.deps, launchAllowed: () => true, broker: f.context.triggerRendererBridge,
      remoteTarget: async () => false, liveElsewhere: async () => ({ known: true, live: null }), resolveTarget: resolveLocalTarget });
    f.context.scheduleProjects = () => ({ add: async () => { change(world); } });
    const result = await f.open();
    assert.equal(result.ok, false); assert.equal(result.reason, 'no readable transcript');
    assert.equal(f.spawns.length, 0); assert.equal(f.marks.length, 0); assert.equal(f.map.size, 0);
  });
}
test('the real validation with an unchanged transcript spawns exactly once', async t => {
  const f = fixture(); f.authorize();
  const world = transcriptWorld(t);
  const target = await resolveLocalTarget(ID, { ...world.deps, deadline: Date.now() + 2000 });
  Object.assign(f.permit, { project: target.project, target });
  realValidation(f, { ...world.deps, launchAllowed: () => true, broker: f.context.triggerRendererBridge,
    remoteTarget: async () => false, liveElsewhere: async () => ({ known: true, live: null }), resolveTarget: resolveLocalTarget });
  const result = await f.open();
  assert.equal(result.ok, true); assert.equal(f.spawns.length, 1);
});

function named(name = 'Task one') {
  const f = fixture(); f.permit.mode = 'new'; f.permit.requestedSessionId = null; f.permit.name = name; f.authorize();
  return f;
}
test('a new trigger permit launches claude with its broker-owned name', async () => {
  const f = named();
  const r = await f.open('permit', true); assert.equal(r.ok, true);
  assert.ok(f.spawns[0].args[0].endsWith(` && claude --session-id ${ID} --name Task one`), f.spawns[0].args[0]);
});
test('renderer options and defaults cannot replace the permit name', async () => {
  const f = named();
  const r = await f.open('permit', true, { name: 'renderer', sessionName: 'renderer', worktreeName: 'w' }); assert.equal(r.ok, true);
  assert.match(f.spawns[0].args[0], /--name Task one/); assert.doesNotMatch(f.spawns[0].args[0], /renderer/);
});
test('a launch without a trigger permit never acquires a name', async () => {
  const f = fixture(); f.permit.name = 'Task one';
  const r = await f.open(null, true, { name: 'renderer' }); assert.equal(r.ok, true);
  assert.doesNotMatch(f.spawns[0].args[0], /--name/);
});
test('a resume permit carrying a name does not pass it', async () => {
  const f = fixture(); f.permit.name = 'Task one'; f.authorize();
  const r = await f.open(); assert.equal(r.ok, true);
  assert.doesNotMatch(f.spawns[0].args[0], /--name/);
});
test('revocation during preparation of a named launch prevents the spawn', async () => {
  const f = named();
  f.context.scheduleProjects = () => ({ add: async () => { f.context.triggerRendererBridge.checkPermit = () => null; } });
  const r = await f.open('permit', true); assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});
test('a missing or invalid permit cannot authorize a named spawn', async () => {
  const f = fixture(); f.permit.name = 'Task one';
  const r = await f.open('permit', true); assert.equal(r.ok, false); assert.equal(f.spawns.length, 0);
});
