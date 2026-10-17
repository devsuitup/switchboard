'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createMainLoopMonitor } = require('../main-loop-monitor');

function clock() {
  let now = 0;
  let active = 0;
  let idle = 0;
  return {
    advance(ms, busy = 0) { now += ms; active += busy; idle += ms - busy; },
    performance: {
      now: () => now,
      eventLoopUtilization(current, previous) {
        if (!current) return { active, idle, utilization: active / (active + idle) || 0 };
        const elapsedActive = current.active - previous.active;
        const elapsedIdle = current.idle - previous.idle;
        return { utilization: elapsedActive / (elapsedActive + elapsedIdle) || 0 };
      },
    },
  };
}

test('trace alone emits utilization deltas and tick lateness without a histogram', () => {
  const time = clock();
  const events = [];
  let tick;
  const monitor = createMainLoopMonitor({
    enabled: () => true,
    env: {},
    performance: time.performance,
    trace: (...args) => events.push(args),
    monitorEventLoopDelay: () => assert.fail('trace alone must not create a histogram'),
    setInterval: (fn, ms) => { tick = fn; assert.equal(ms, 1000); return { unref() {} }; },
    clearInterval() {},
  });
  try {
    time.advance(1500, 600);
    tick();
    time.advance(1000, 100);
    tick();
    assert.deepEqual(events, [
      ['main.loop', null, { elu: 0.4, lagMs: 500 }],
      ['main.loop', null, { elu: 0.1, lagMs: 0 }],
    ]);
  } finally { monitor.stop(); }
});

test('explicit histogram arm uses 20 ms, follows trace state, resets and stops', () => {
  const time = clock();
  let on = false;
  let tick;
  const calls = [];
  const histogram = {
    max: 7000000,
    percentile: n => { assert.equal(n, 99); return 3000000; },
    enable: () => calls.push('enable'),
    disable: () => calls.push('disable'),
    reset: () => calls.push('reset'),
  };
  const monitor = createMainLoopMonitor({
    enabled: () => on,
    env: { SWITCHBOARD_MAIN_LOOP_HISTOGRAM: '1' },
    performance: time.performance,
    trace: (...args) => calls.push(args),
    monitorEventLoopDelay: ({ resolution }) => { assert.equal(resolution, 20); return histogram; },
    setInterval: (fn, ms) => { tick = fn; assert.equal(ms, 1000); return { unref() {} }; },
    clearInterval: () => calls.push('clear'),
  });
  tick();
  assert.deepEqual(calls, []);
  on = true;
  monitor.sync();
  time.advance(1000, 250);
  tick();
  assert.deepEqual(calls, ['reset', 'enable',
    ['main.loop', null, { elu: 0.25, lagMs: 0, maxMs: 7, p99Ms: 3 }], 'reset']);
  on = false;
  monitor.sync();
  tick();
  assert.equal(calls.filter(Array.isArray).length, 1);
  assert.equal(calls.at(-1), 'disable');
  on = true;
  monitor.sync();
  monitor.stop();
  assert.equal(calls.at(-2), 'disable');
  assert.equal(calls.at(-1), 'clear');
  const stoppedCalls = calls.slice();
  monitor.sync();
  tick();
  assert.deepEqual(calls, stoppedCalls);
});

test('trace toggles reset utilization and lag baselines without enabling a histogram', () => {
  const time = clock();
  let on = false;
  let tick;
  let cleared = false;
  const events = [];
  const monitor = createMainLoopMonitor({
    enabled: () => on,
    env: {},
    performance: time.performance,
    trace: (cat, sid, data) => events.push(data),
    monitorEventLoopDelay: () => assert.fail('histogram must stay off'),
    setInterval: fn => { tick = fn; return { unref() {} }; },
    clearInterval: () => { cleared = true; },
  });
  time.advance(5000, 5000);
  tick();
  assert.deepEqual(events, []);
  on = true;
  monitor.sync();
  time.advance(999);
  tick();
  assert.deepEqual(events, [{ elu: 0, lagMs: 0 }]);
  on = false;
  monitor.sync();
  time.advance(10000, 10000);
  tick();
  on = true;
  monitor.sync();
  time.advance(1000, 200);
  tick();
  assert.deepEqual(events.at(-1), { elu: 0.2, lagMs: 0 });
  monitor.stop();
  assert.equal(cleared, true);
  monitor.sync();
  tick();
  assert.equal(events.length, 2);
});

test('histogram switch is read once at monitor startup and requires exactly 1', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const env = { SWITCHBOARD_MAIN_LOOP_HISTOGRAM: value };
    let on = false;
    let tick;
    const monitor = createMainLoopMonitor({
      enabled: () => on,
      env,
      trace: (cat, sid, data) => assert.equal(Object.hasOwn(data, 'maxMs'), false),
      monitorEventLoopDelay: () => assert.fail(`switch ${value} must not arm the histogram`),
      setInterval: fn => { tick = fn; return { unref() {} }; },
      clearInterval() {},
    });
    try {
      env.SWITCHBOARD_MAIN_LOOP_HISTOGRAM = '1';
      on = true;
      monitor.sync();
      tick();
    } finally { monitor.stop(); }
  }
});

test('real loop block across a one-second tick reports at least 400 ms lateness', { timeout: 6000 }, async () => {
  let monitor;
  let blockTimer;
  let deadline;
  try {
    const event = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('main.loop probe timed out')), 5000);
      monitor = createMainLoopMonitor({
        enabled: () => true,
        env: {},
        trace: (cat, sid, data) => resolve(data),
      });
      blockTimer = setTimeout(() => {
        const until = performance.now() + 600;
        while (performance.now() < until) {}
      }, 900);
    });
    assert.ok(event.lagMs >= 400, `lagMs=${event.lagMs} must expose the blocked tick`);
    assert.ok(event.elu >= 0 && event.elu <= 1, `elu=${event.elu} must be a fraction`);
    assert.equal(Object.hasOwn(event, 'maxMs'), false);
  } finally {
    clearTimeout(blockTimer);
    clearTimeout(deadline);
    monitor?.stop();
  }
});
