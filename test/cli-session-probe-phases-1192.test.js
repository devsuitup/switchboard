'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const state = require('../cli-session-state');

const OUTPUT = '900 1 134360000000000000\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-probe-phases-'));
  const f = { time: 100000, logs: [], timers: new Set(), script: null };
  const schedule = (fn, ms) => {
    const timer = { at: f.time + ms, fn, unref() {} };
    f.timers.add(timer);
    return timer;
  };
  f.advance = ms => {
    f.time += ms;
    for (const timer of [...f.timers]) if (timer.at <= f.time) { f.timers.delete(timer); timer.fn(); }
  };
  state.init({ dir, activeSessions: new Map(), platform: 'win32', ownPid: 900,
    now: () => f.time, schedule, cancel: timer => f.timers.delete(timer),
    log: { info: line => f.logs.push(line), debug() {}, warn() {} },
    readProcessTable: (timeout, options) => state.probeProcessTable('win32', timeout, (_exe, _args, _opts, done) => {
      if (!f.script) { f.time += f.duration; done(null, OUTPUT); return undefined; }
      const child = Object.assign(new EventEmitter(), { kill() {} });
      Promise.resolve().then(() => f.script(child, done));
      return child;
    }, options?.signal, options?.phases),
  });
  t.after(() => { state.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('a probe that overruns its budget reports when its child spawned, was killed, exited and closed', async t => {
  const f = fixture(t);
  f.script = (child, done) => {
    f.time += 5; child.emit('spawn');
    f.time += 211000; child.kill('SIGTERM');
    f.time += 500; child.emit('exit', null, 'SIGTERM');
    f.time += 196; child.emit('close', null, 'SIGTERM');
    f.time += 5; done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '');
  };
  await state.refreshProcessTable({ force: true });
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /ok=0 timeout=1 error=0 maxMs=211706 /);
  assert.match(f.logs[0], / worstOverrun: totalMs=211706 timeoutMs=15000 spawnAtMs=5 killAtMs=211005 exitAtMs=211505 closeAtMs=211701 callbackAtMs=211706$/);
});

test('a successful probe that overruns its budget is reported although nothing failed', async t => {
  const f = fixture(t);
  f.duration = 20000;
  await state.refreshProcessTable({ force: true });
  f.advance(60000);
  assert.equal(f.logs.length, 1, 'an overrun window is reported even when every probe succeeded');
  assert.match(f.logs[0], /ok=1 timeout=0 error=0/);
  assert.match(f.logs[0], / worstOverrun: totalMs=20000 timeoutMs=15000 spawnAtMs=n\/a killAtMs=n\/a exitAtMs=n\/a closeAtMs=n\/a callbackAtMs=20000$/);
});

test('probes within their budget add no overrun to a failure summary and keep a clean window silent', async t => {
  const f = fixture(t);
  f.duration = 100;
  await state.refreshProcessTable({ force: true });
  f.advance(60000);
  assert.deepEqual(f.logs, [], 'a window of in-budget successes stays silent');
  f.script = (child, done) => {
    f.time += 3; child.emit('spawn');
    f.time += 4000; child.emit('exit', 1, null); child.emit('close', 1, null);
    done(Object.assign(new Error('failed'), { code: 1 }), '');
  };
  await state.refreshProcessTable({ force: true });
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /ok=0 timeout=0 error=1/);
  assert.doesNotMatch(f.logs[0], /worstOverrun/);
});

test('the worst overrun of a window is the one reported', async t => {
  const f = fixture(t);
  for (const duration of [16000, 40000, 17000]) {
    f.duration = duration;
    await state.refreshProcessTable({ force: true });
  }
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], / worstOverrun: totalMs=40000 timeoutMs=15000 /);
});
