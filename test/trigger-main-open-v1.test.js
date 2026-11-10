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
