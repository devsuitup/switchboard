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

test('an unresolved deletion hold survives unrelated launches until its owner releases', async () => {
  const gate = createProjectOperationGate(), held = gate.hold('/deletion');
  await held.ready;
  for (let i = 0; i < 32; i++) {
    const other = gate.tryAdmit('/other'); other.release();
    assert.equal(gate.tryAdmitAll(['/other', '/deletion']) === null, true, 'held project must stay excluded');
  }
  assert.throws(() => gate.hold('/deletion'));
  held.release();
  const next = gate.tryAdmitAll(['/other', '/deletion']); assert.ok(next); next.release();
});

for (const alias of [null, 'vps']) {
  test(`missing project entries do not reserve a fallback identity for host ${alias}`, async () => {
    const gate = createProjectOperationGate();
    const held = gate.hold(alias ? '/' : process.cwd(), alias);
    for (const project of [null, undefined, '']) {
      const admission = gate.tryAdmit(project, alias);
      assert.ok(admission, 'a missing project must be admitted without a fallback key');
      admission.release();
      admission.release();
    }
    const admission = gate.tryAdmitAll([null, undefined, '', '/another'], alias);
    assert.ok(admission, 'missing entries must not refuse another real project');
    assert.equal(gate.tryAdmitAll([null, alias ? '/' : process.cwd()], alias), null,
      'a held real identity must still refuse a mixed reservation');
    held.release();
    const noProject = gate.tryAdmitAll([null, undefined, ''], alias);
    const fallback = gate.hold(alias ? '/' : process.cwd(), alias);
    let ready = false;
    fallback.ready.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, true, 'no-project admission must not delay a hold of the fallback identity');
    noProject.release();
    fallback.release();
    admission.release();
    gate.tryAdmitAll([], alias).release();
  });
}
