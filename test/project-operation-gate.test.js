'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectOperationGate } = require('../src/main/shared/project-operation-gate');

test('a hold refuses this project, keeps other projects admitted and release restores admission', async () => {
  const gate = createProjectOperationGate();
  const held = gate.hold('/project');
  await held.ready;
  assert.equal(gate.tryAdmit('/project'), null, 'held project must refuse a launch');
  const other = gate.tryAdmit('/another');
  assert.ok(other);
  other.release();
  held.release();
  held.release();
  gate.tryAdmit('/project').release();
});

test('hold waits for every in-flight spawn reservation and refuses later admission synchronously', async () => {
  const gate = createProjectOperationGate();
  const first = gate.tryAdmit('/project');
  const second = gate.tryAdmit('/project');
  const held = gate.hold('/project');
  let ready = false;
  held.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false, 'hold must wait for in-flight spawn');
  assert.equal(gate.tryAdmit('/project'), null);
  first.release();
  first.release();
  await Promise.resolve();
  assert.equal(ready, false, 'idempotent release must not release another reservation');
  second.release();
  await held.ready;
  assert.equal(ready, true);
  held.release();
});

test('remote identity is alias plus POSIX path and never local realpath or Windows case folding', async () => {
  const gate = createProjectOperationGate();
  const held = gate.hold('/work/Repo/', 'vps');
  await held.ready;
  assert.equal(gate.tryAdmit('/work/Repo', 'vps'), null, 'same remote project must be held');
  for (const [project, alias] of [['/work/Repo', 'other'], ['/work/Repo', null], ['/work/repo', 'vps']]) {
    const admitted = gate.tryAdmit(project, alias);
    assert.ok(admitted);
    admitted.release();
  }
  assert.throws(() => gate.hold('/work/Repo', 'vps'), /operation/i);
  held.release();
});

test('a released pending hold does not lose its drain notification when another hold starts', async () => {
  const gate = createProjectOperationGate();
  const admission = gate.tryAdmit('/project');
  const first = gate.hold('/project');
  let firstReady = false;
  first.ready.then(() => { firstReady = true; });
  first.release();
  const second = gate.hold('/project');
  admission.release();
  await second.ready;
  assert.equal(firstReady, true, 'reacquiring a hold must not lose the earlier drain notification');
  second.release();
});

test('local real paths and their relative spelling share admission', () => {
  const gate = createProjectOperationGate();
  const held = gate.hold(__dirname);
  assert.equal(gate.tryAdmit(require('node:path').relative(process.cwd(), __dirname)), null);
  held.release();
});
