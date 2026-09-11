// Tests for the cold-cache working-set restore planner (issue #205, audit
// finding 5, .work-files/switchboard/audit-fable-2026-09-11.md).
//
// createRestorePlanner (public/restore-plan.js) is the actual decision this
// bug lives in: telling "not indexed yet" apart from "genuinely deleted" for
// each saved working-set id, across the many progressive `projects-changed`
// ticks a large history produces while populateCacheViaWorker streams
// sessionMap one folder at a time. It is require()'d directly below — never
// re-implemented — so reverting the fix in public/restore-plan.js turns
// these tests red.
//
// app.js's tickRestorePlanner()/restoreWorkingSet() orchestration (DOM
// toasts, which call sites tick the planner) still can't be loaded via
// vm.runInContext without prohibitive DOM scaffolding (see
// test/session-restore.test.js, same codebase precedent) and is out of
// scope here — only the wiring fact that updateIndexingBanner() ticks the
// planner on payload.done is asserted, by reading the app.js source.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRestorePlanner } = require('../public/restore-plan');

function sm(ids) {
  return new Map(ids.map(id => [id, { sessionId: id }]));
}

const SAVED_AB = [
  { sessionId: 'sa', projectPath: '/a', active: false },
  { sessionId: 'sb', projectPath: '/b', active: true },
];

// ---------------------------------------------------------------------------
// Auto mode (incremental restore)
// ---------------------------------------------------------------------------

test('auto: partial index at tick 1 restores the indexed subset, waits for the rest, then finishes', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  const openSessions = new Map();

  // tick 1: only 'sa' indexed so far.
  let plan = planner.tick({ sessionMap: sm(['sa']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId), ['sa']);
  assert.equal(plan.remaining, 1, 'sb still pending');

  // tick 2: nothing new yet -> wait, not nothing.
  plan = planner.tick({ sessionMap: sm(['sa']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'wait');

  // tick 3: 'sb' shows up -> restores the rest.
  plan = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId), ['sb']);
  assert.equal(plan.remaining, 0);

  // tick 4: fully resolved -> nothing, forever.
  plan = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'nothing');
});

test('auto: none indexed at tick 1 -> wait, never nothing', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  const plan = planner.tick({ sessionMap: sm([]), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'wait', 'must not silently drop the working set while the cache is cold');
  assert.equal(plan.remaining, 2);
});

test('auto: indexingDone with ids still missing -> nothing (deleted sessions), never an infinite wait', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  // 'sa' shows up, indexing finishes, 'sb' never appeared.
  let plan = planner.tick({ sessionMap: sm(['sa']), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');

  plan = planner.tick({ sessionMap: sm(['sa']), openSessions: new Map(), indexingDone: true, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'nothing', 'indexing finished, the rest is presumed deleted, not still pending');
});

test('auto: tick cap reached -> nothing', () => {
  const planner = createRestorePlanner({ savedSet: [{ sessionId: 'sa', projectPath: '/a', active: true }], maxTicks: 3 });
  const openSessions = new Map();
  let plan;
  for (let i = 0; i < 3; i++) {
    plan = planner.tick({ sessionMap: sm([]), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  }
  assert.equal(plan.action, 'nothing', 'bounded — must give up eventually even with no signal');
});

test('auto: dismiss stops the wait', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  planner.dismiss();
  const plan = planner.tick({ sessionMap: sm([]), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'nothing');
});

test('auto: a session opened outside restore cancels the plan', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  const plan = planner.tick({ sessionMap: sm(['sa']), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: true });
  assert.equal(plan.action, 'nothing', 'no automatic restore behind the user once they have acted');

  // Stays settled afterwards even if the flag clears and data arrives.
  const plan2 = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan2.action, 'nothing');
});

test('auto: ids already open (opened before the planner ran) are treated as satisfied', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB });
  const openSessions = new Map([['sa', { closed: false }]]);
  const plan = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId), ['sb'], 'sa is already open, not re-restored');
});

test('empty saved set -> nothing, never waits', () => {
  const planner = createRestorePlanner({ savedSet: [] });
  const plan = planner.tick({ sessionMap: sm([]), openSessions: new Map(), indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'nothing');
});

// ---------------------------------------------------------------------------
// askOnce mode (the "ask" toast) — one decision, not one per tick.
// ---------------------------------------------------------------------------

test('askOnce: waits until every saved id is indexed, then a single restore with all candidates', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB, askOnce: true });
  const openSessions = new Map();

  let plan = planner.tick({ sessionMap: sm(['sa']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'wait', 'must not ask about a partial picture');

  plan = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId).sort(), ['sa', 'sb']);

  // Never asks again.
  plan = planner.tick({ sessionMap: sm(['sa', 'sb']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'nothing');
});

test('askOnce: indexingDone with some ids missing asks once with what indexed so far', () => {
  const planner = createRestorePlanner({ savedSet: SAVED_AB, askOnce: true });
  const openSessions = new Map();

  let plan = planner.tick({ sessionMap: sm(['sa']), openSessions, indexingDone: false, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'wait');

  plan = planner.tick({ sessionMap: sm(['sa']), openSessions, indexingDone: true, sessionOpenedOutsideRestore: false });
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId), ['sa']);
});

// ---------------------------------------------------------------------------
// Wiring — updateIndexingBanner(payload) in app.js must tick the planner
// when payload.done is true. app.js cannot be loaded headlessly (DOM), so
// this is a source assertion rather than a behavioral one; see header.
// ---------------------------------------------------------------------------

test('wiring: updateIndexingBanner ticks the restore planner on payload.done', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fnStart = src.indexOf('function updateIndexingBanner');
  assert.ok(fnStart !== -1, 'updateIndexingBanner must exist');
  const fnEnd = src.indexOf('\nfunction dismissIndexingBanner', fnStart);
  assert.ok(fnEnd !== -1, 'dismissIndexingBanner must follow updateIndexingBanner');
  const body = src.slice(fnStart, fnEnd);

  assert.match(body, /if\s*\(payload\.done\)\s*\{/, 'must branch on payload.done');
  assert.match(body, /tickRestorePlanner\(\)/, 'must tick the planner when indexing finishes');
});
