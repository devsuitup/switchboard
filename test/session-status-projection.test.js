'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../public/session-status-projection.js');
const projection = fs.existsSync(filename) ? require(filename) : {};

function status(snapshot, turn, proof) {
  assert.equal(typeof projection.projectSessionStatus, 'function', 'the shared state/detail projection is exported');
  return projection.projectSessionStatus(snapshot, turn, proof);
}

test('current blocking evidence outranks an open head and an interactive shell', () => {
  assert.deepEqual(status({ liveness: 'alive' }, { state: 'open' }, { blocking: true, shell: true }),
    { state: 'waiting', detail: 'blocking-dialog' });
});

test('waiting-for-input and response-ready alone are idle prompt evidence, never a blocking dialog', () => {
  assert.deepEqual(status({ liveness: 'alive', waitingForInput: true, responseReady: true }, { state: 'closed' }),
    { state: 'idle', detail: 'prompt' });
  assert.deepEqual(status({ liveness: 'alive', waitingForInput: true, responseReady: true }),
    { state: 'unknown', detail: 'head-unknown' });
});

test('a newer open head defeats stale idle and equal hint timestamps', () => {
  for (const idleHintAt of [undefined, 90, 100]) {
    assert.deepEqual(status({ liveness: 'alive', idleHintAt, promptHint: true },
      { state: 'open', lastEntryAt: 100, observedAt: 200 }), { state: 'busy', detail: 'open-turn' });
  }
});

test('absence or replacement of a descriptor never proves exit', () => {
  for (const liveness of [undefined, 'unknown', 'dead']) {
    assert.deepEqual(status({ liveness, promptHint: true }, { state: 'closed' }),
      { state: 'unknown', detail: 'no-live-proof' });
  }
  assert.deepEqual(status({ liveness: 'dead' }, { state: 'closed' }, { confirmedExit: true }),
    { state: 'exited', detail: 'confirmed-exit' });
  assert.deepEqual(status({ liveness: 'alive' }, { state: 'open' }, { confirmedExit: true }),
    { state: 'busy', detail: 'open-turn' });
  assert.deepEqual(status({ liveness: 'dead' }, { state: 'closed' }, { confirmedExit: true, ambiguous: true }),
    { state: 'unknown', detail: 'ambiguous' });
});

test('live shells, prompt hints, descriptorless owned PTYs and hosted jobs use the state/detail table', () => {
  const cases = [
    [{ liveness: 'alive' }, undefined, { shell: true }, 'busy', 'shell'],
    [{ liveness: 'alive' }, undefined, {}, 'unknown', 'head-unknown'],
    [{ liveness: 'alive', promptHint: true }, undefined, {}, 'idle', 'prompt'],
    [{ liveness: 'alive', idleHintAt: 110 }, { state: 'open', lastEntryAt: 100 }, {}, 'idle', 'prompt'],
    [{ liveness: 'alive', promptHintAt: 210 }, { state: 'open', observedAt: 200 }, {}, 'idle', 'prompt'],
    [{ liveness: 'unknown' }, { state: 'open' }, { ptyHere: true }, 'busy', 'open-turn'],
    [{ liveness: 'unknown' }, undefined, { ptyHere: true }, 'unknown', 'head-unknown'],
    [{ liveness: 'alive', backgroundJob: true, idleHintAt: 110 }, { state: 'open', lastEntryAt: 100 }, {}, 'busy', 'open-turn'],
    [{ liveness: 'alive', backgroundJob: true, promptHint: true }, undefined, {}, 'unknown', 'head-unknown'],
    [{ liveness: 'alive', backgroundJob: true, promptHint: true, promptHintAt: 210 }, undefined, {}, 'idle', 'prompt'],
    [{ liveness: 'alive', backgroundJob: true }, { state: 'closed' }, {}, 'idle', 'prompt'],
    [{ liveness: 'alive', backgroundJob: true }, undefined, {}, 'unknown', 'head-unknown'],
    [{ liveness: 'unknown' }, { state: 'open' }, { blocking: true, shell: true }, 'unknown', 'no-live-proof'],
    [{ liveness: 'alive' }, { state: 'open' }, { ambiguous: true }, 'unknown', 'ambiguous'],
  ];
  for (const [snapshot, turn, proof, state, detail] of cases) {
    const before = JSON.stringify({ snapshot, turn, proof });
    assert.deepEqual(status(snapshot, turn, proof), { state, detail });
    assert.equal(JSON.stringify({ snapshot, turn, proof }), before);
  }
  assert.deepEqual(status(), { state: 'unknown', detail: 'no-live-proof' });
});

test('CommonJS and classic-script consumers share the same pure projection', () => {
  assert.equal(typeof projection.projectHeadActivity, 'function', 'the shared head-precedence projection is exported');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const classic = vm.runInContext('sessionStatusProjection', context);
  const snapshot = { liveness: 'alive', promptHint: true };
  assert.equal(JSON.stringify(classic.projectHeadActivity(snapshot)), JSON.stringify(projection.projectHeadActivity(snapshot)));
  assert.equal(JSON.stringify(classic.projectSessionStatus(snapshot)), JSON.stringify(projection.projectSessionStatus(snapshot)));
  assert.equal(projection.projectHeadActivity({ liveness: 'unknown' }, { state: 'open' }).headTurn, 'open');
});
