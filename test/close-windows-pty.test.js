'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowsJobHelper } = require('../src/main/terminals/windows-job-helper');
const ops = require('../src/main/terminals/pty-ops');
const { closeWindowsPty } = require('../src/main/terminals/close-windows-pty');

for (const followup of ['legacy', 'retry']) test(`A4c2afix late assignment refusal preserves ${followup}`, async t => {
  const child = new EventEmitter(), writes = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  let acknowledge;
  child.stdin.write = line => {
    const [op, id] = line.trim().split(' '); writes.push(op);
    const reply = () => child.stdout.emit('data', op === 'observe' ? `observed ${id} 0\n`
      : `${{ assign: 'assigned', terminate: 'terminated', 'terminate-retained': 'terminated', release: 'released' }[op]} ${id}\n`);
    if (op === 'assign') acknowledge = reply;
    else queueMicrotask(reply);
  };
  const helper = createWindowsJobHelper({ spawn: () => { queueMicrotask(() => child.stdout.emit('data', 'ready\n')); return child; } });
  t.after(() => child.emit('exit'));
  let exit;
  const pty = { pid: 4242, _agent: {}, onExit(fn) { exit = fn; }, kill() { this._agent.exitCode = 0; exit(); } };
  const assigned = ops.trackWindowsPty(pty, { jobs: helper, platform: 'win32' });
  const session = { pty, generation: 1, kind: 'local-pty' };
  const refused = await ops.stopPtyWithEvidence(session, 'one', { platform: 'win32', deadline: Date.now() + 30 });
  assert.equal(refused.code, 'IDENTITY');
  acknowledge(); await assigned;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.includes('release'), false, 'refusal before kill must retain the assigned job');
  if (followup === 'legacy') {
    assert.equal(ops.killPty(session, 'one', { platform: 'win32' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(writes.includes('terminate'), 'later legacy kill still terminates the assigned job');
  } else {
    const retried = await ops.stopPtyWithEvidence(session, 'one', { platform: 'win32' });
    assert.equal(retried.ended, true, 'retry must not return the cached refusal');
    assert.ok(writes.includes('terminate-retained'));
  }
});

test('A4c2afix evidence poll timer does not keep the process alive', async () => {
  let unrefs = 0, check;
  const pty = { _agent: {} };
  const pending = closeWindowsPty(pty, () => true, async () => ({ ended: true }), {
    evidence: true, schedule(fn) { check = fn; return { unref() { unrefs++; } }; },
  });
  assert.equal(unrefs, 1, 'evidence poll timer must be unreferenced');
  pty._agent.exitCode = 0; check();
  assert.equal((await pending).ended, true);
});

function fakeHelper(t, { members = [0], assignment = true, termination = true, silence = false, pendingAssignment = false } = {}) {
  const child = new EventEmitter(), writes = [];
  let held = false;
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { held = false; };
  child.stdin.write = line => {
    const [op, id] = line.trim().split(' '); writes.push(op);
    queueMicrotask(() => {
      if (op === 'assign' && pendingAssignment) return;
      let reply;
      if (op === 'assign') { held = assignment; reply = assignment ? 'assigned' : 'error'; }
      if (op === 'terminate' || op === 'release') { held = false; reply = op === 'release' ? 'released' : 'terminated'; }
      if (op === 'terminate-retained') reply = termination && held ? 'terminated' : 'error';
      if (op === 'observe') {
        if (silence) return;
        reply = held ? `observed ${id} ${members.length > 1 ? members.shift() : members[0]}` : `error ${id} 6`;
      } else reply = `${reply} ${id}${reply === 'error' ? ' 5' : ''}`;
      child.stdout.emit('data', reply + '\n');
    });
  };
  const helper = createWindowsJobHelper({ spawn: () => { queueMicrotask(() => child.stdout.emit('data', 'ready\n')); return child; }, requestMs: 30 });
  t.after(() => child.emit('exit'));
  return { helper, writes, held: () => held };
}

async function tracked(t, settings) {
  const h = fakeHelper(t, settings);
  let exit;
  const pty = { pid: 4242, _agent: {}, onExit(fn) { exit = fn; }, kill() { this._agent.exitCode = 0; exit(); } };
  await ops.trackWindowsPty(pty, { jobs: h.helper, platform: 'win32' });
  return { ...h, pty, session: { pty, generation: 7, kind: 'local-pty' } };
}

test('A4c2a close evidence waits for termination result instead of returning a kill ACK', async () => {
  const proof = { ended: true, observedAt: 123 };
  const result = closeWindowsPty({ _agent: { exitCode: 0 } }, () => true, async () => proof, { evidence: true });
  assert.ok(result && typeof result.then === 'function', 'opt-in close must return the death-evidence promise');
  assert.deepEqual(await result, proof);
});

test('A4c2a assigned job remains held through intentional stop observation', async t => {
  const h = await tracked(t, { members: [1, 0] });
  assert.equal(typeof ops.stopPtyWithEvidence, 'function', 'a pinned PTY stop-evidence seam is required');
  const result = await ops.stopPtyWithEvidence(h.session, 'one', { platform: 'win32', deadline: Date.now() + 1000 });
  assert.equal(result.ended, true, 'empty retained job must prove tree death');
  assert.equal(result.generation, 7);
  assert.deepEqual(h.writes, ['assign', 'terminate-retained', 'observe', 'observe', 'release']);
  assert.equal(h.held(), false, 'finally releases the job');
});

for (const [name, settings] of Object.entries({ nonempty: { members: [1] }, assignment: { assignment: false },
  protected: { termination: false }, timeout: { silence: true } })) {
  test(`A4c2a ${name} cannot certify a stopped tree and releases the handle`, async t => {
    const h = await tracked(t, settings);
    assert.equal(typeof ops.stopPtyWithEvidence, 'function', 'a pinned PTY stop-evidence seam is required');
    const result = await ops.stopPtyWithEvidence(h.session, 'one', { platform: 'win32', deadline: Date.now() + 70 });
    assert.equal(result.ended, false);
    assert.equal(h.held(), false);
    if (name === 'assignment') assert.equal(h.writes.includes('terminate-retained'), false);
  });
}

for (const platform of ['linux', 'darwin']) test(`A4c2a ${platform} without controlled-tree evidence refuses before kill`, async () => {
  let kills = 0;
  const session = { kind: 'local-pty', generation: 1, pty: { pid: 123, kill() { kills++; } } };
  assert.equal(typeof ops.stopPtyWithEvidence, 'function', 'a pinned PTY stop-evidence seam is required');
  const result = await ops.stopPtyWithEvidence(session, 'one', { platform });
  assert.equal(result.code, 'UNSUPPORTED'); assert.equal(result.ended, false); assert.equal(kills, 0);
});

test('A4c2a a changed generation or attach PTY refuses before stop', async t => {
  const h = await tracked(t);
  assert.equal(typeof ops.stopPtyWithEvidence, 'function', 'a pinned PTY stop-evidence seam is required');
  assert.equal((await ops.stopPtyWithEvidence(h.session, 'one', { platform: 'win32', generation: 6 })).ended, false);
  h.session.isAttach = true;
  assert.equal((await ops.stopPtyWithEvidence(h.session, 'one', { platform: 'win32' })).ended, false);
  assert.deepEqual(h.writes, ['assign']);
});

test('A4c2a pending assignment cleanup respects the stop deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = fakeHelper(t, { pendingAssignment: true });
  const pty = { pid: 4242, _agent: {}, onExit() {}, kill() { assert.fail('unassigned PTY must not be closed'); } };
  void ops.trackWindowsPty(pty, { jobs: h.helper, platform: 'win32' });
  await new Promise(resolve => setImmediate(resolve));
  let settled = false;
  const stopped = ops.stopPtyWithEvidence({ pty, generation: 7, kind: 'local-pty' }, 'one', {
    platform: 'win32', deadline: Date.now() + 10,
  }).then(proof => { settled = true; return proof; });
  t.mock.timers.tick(10);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'cleanup must not wait beyond the stop deadline for assignment ACK');
  assert.equal((await stopped).ended, false);
});
