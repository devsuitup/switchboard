'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createWindowsJobHelper } = require('../src/main/terminals/windows-job-helper');
const { trackWindowsPty, killPty, releaseWindowsPty, stopPtyWithEvidence } = require('../src/main/terminals/pty-ops');

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { spawnError = false, lateError = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  const children = [], writes = [], tabs = [];
  const helper = createWindowsJobHelper({ startupMs: 100, spawn() {
    const child = new EventEmitter();
    children.push(child);
    if (spawnError) throw new Error('denied');
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin.write = line => {
      writes.push(line.trim());
      const [op, id] = line.trim().split(' ');
      queueMicrotask(() => child.stdout.emit('data', op === 'assign' && lateError ? `error ${id} 5\n`
        : op === 'observe' ? `observed ${id} 0\n`
          : `${{ assign: 'assigned', terminate: 'terminated', release: 'released', 'terminate-retained': 'terminated' }[op]} ${id}\n`));
    };
    return child;
  } });
  function tab(pid) {
    let exited;
    const pty = { pid, _agent: {}, onExit(fn) { exited = fn; },
      kill() { this._agent.exitCode = 0; exited(); }, exit() { exited(); } };
    tabs.push(pty);
    pty.initial = trackWindowsPty(pty, { jobs: helper, platform: 'win32', spawnTime: 100 });
    return pty;
  }
  async function tick(ms) { monotonic += ms; t.mock.timers.tick(ms); await flush(); }
  t.after(async () => {
    children.forEach(child => child.emit('exit'));
    await Promise.all(tabs.map(pty => releaseWindowsPty(pty)));
  });
  return { helper, children, writes, tab, tick };
}

test('1156: waiting restored tabs recover without opening a new tab and close their jobs', async t => {
  const f = fixture(t), a = f.tab(897), b = f.tab(898);
  await f.tick(100);
  assert.equal(await a.initial, false); assert.equal(await b.initial, false);
  await f.tick(999);
  assert.equal(f.children.length, 1);
  await f.tick(1);
  assert.equal(f.children.length, 2, 'backoff expiry must restart for waiting tabs');
  f.children[1].stdout.emit('data', 'ready\n'); await flush();
  assert.equal(f.writes.filter(line => line.startsWith('assign ')).length, 2, 'every live restored tab gets one late assignment');
  for (const pty of [a, b]) killPty({ pty, kind: 'local-pty' }, 'tab', { platform: 'win32' });
  await flush();
  const assigned = f.writes.filter(line => line.startsWith('assign ')).map(line => line.split(' ')[1]);
  assert.deepEqual(f.writes.filter(line => line.startsWith('terminate ')), assigned.map(id => `terminate ${id}`));
});

for (const state of ['exited', 'closed', 'released', 'native exit', 'changed pid']) {
  test(`1156: recovery skips a ${state} tab and still assigns a live sibling`, async t => {
    const f = fixture(t), gone = f.tab(897), live = f.tab(898);
    await f.tick(100); await gone.initial; await live.initial;
    if (state === 'exited') gone.exit();
    if (state === 'closed') {
      gone.kill = () => {};
      killPty({ pty: gone, kind: 'local-pty' }, 'gone', { platform: 'win32' });
    }
    if (state === 'released') await releaseWindowsPty(gone);
    if (state === 'native exit') gone._agent.exitCode = 0;
    if (state === 'changed pid') gone.pid = 999;
    await f.tick(1000);
    assert.equal(f.children.length, 2, 'a live sibling must trigger recovery');
    f.children[1].stdout.emit('data', 'ready\n'); await flush();
    const assignments = f.writes.filter(line => line.startsWith('assign '));
    assert.equal(assignments.length, 1, 'only the live sibling is assigned');
    assert.match(assignments[0], / 898 100$/);
  });
}

test('1156: externally triggered readiness replays once and a failed late assignment stays failed', async t => {
  const f = fixture(t, { lateError: true }), pty = f.tab(897);
  await f.tick(100); await pty.initial;
  t.mock.method(performance, 'now', () => 1100);
  t.mock.timers.setTime(101100);
  const ready = f.helper.start();
  assert.equal(f.children.length, 2, 'explicit start can recover before the retry timer fires');
  f.children[1].stdout.emit('data', 'ready\n'); await ready; await flush();
  assert.equal(f.writes.filter(line => line.startsWith('assign ')).length, 1, 'failed tab must receive its late attempt');
  await f.tick(60000); await f.helper.start(); await flush();
  assert.equal(f.writes.filter(line => line.startsWith('assign ')).length, 1, 'a native rejection must not loop');
});

test('1156: late assignment updates the tracked assignment used by evidence close', async t => {
  const f = fixture(t), pty = f.tab(897);
  await f.tick(100); await pty.initial;
  await f.tick(1000);
  assert.equal(f.children.length, 2, 'waiting tab must recover');
  f.children[1].stdout.emit('data', 'ready\n'); await flush();
  const proof = await stopPtyWithEvidence({ pty, kind: 'local-pty', generation: 1 }, 'tab', { platform: 'win32' });
  assert.equal(proof.ended, true, 'evidence close must use the successful late assignment');
  assert.ok(f.writes.some(line => line.startsWith('terminate-retained ')));
});

for (const spawnError of [false, true]) {
  test(`1156: autonomous retries exhaust three starts (${spawnError ? 'spawn error' : 'timeout'})`, async t => {
    const f = fixture(t, { spawnError }), pty = f.tab(897);
    await f.tick(100); await pty.initial;
    await f.tick(1000);
    assert.equal(f.children.length, 2, 'waiting tabs trigger the second attempt');
    if (!spawnError) await f.tick(100);
    await f.tick(1999); assert.equal(f.children.length, 2);
    await f.tick(1); assert.equal(f.children.length, 3);
    await f.tick(100); await f.tick(60000);
    assert.equal(f.children.length, 3, 'automatic retries must stop at the existing cap');
  });
}

test('1156: a backwards wall clock does not hold off helper startup retry', async t => {
  const f = fixture(t);
  const first = f.helper.assign('first', 897, 100);
  await f.tick(100); assert.equal(await first, false);
  t.mock.timers.setTime(0);
  await f.tick(1000);
  const next = f.helper.assign('next', 898, 100);
  assert.equal(f.children.length, 2, 'monotonic backoff must expire despite Date.now moving backwards');
  f.children[1].stdout.emit('data', 'ready\n');
  assert.equal(await next, true);
});
