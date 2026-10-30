'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createMainLoopMonitor } = require('../src/main/app/main-loop-monitor');

function clock() {
  let now = 0;
  return {
    advance(ms) { now += ms; },
    performance: { now: () => now },
  };
}

test('trace alone emits tick lateness without a histogram', () => {
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
    time.advance(1500);
    tick();
    time.advance(1000);
    tick();
    assert.deepEqual(events, [
      ['main.loop', null, { lagMs: 500 }],
      ['main.loop', null, { lagMs: 0 }],
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
  time.advance(1000);
  tick();
  assert.deepEqual(calls, ['reset', 'enable',
    ['main.loop', null, { lagMs: 0, maxMs: 7, p99Ms: 3 }], 'reset']);
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

test('trace toggles preserve the tick baseline without enabling a histogram', () => {
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
  time.advance(5000);
  tick();
  assert.deepEqual(events, []);
  on = true;
  monitor.sync();
  time.advance(999);
  tick();
  assert.deepEqual(events, [{ lagMs: 0 }]);
  on = false;
  monitor.sync();
  time.advance(10000);
  tick();
  on = true;
  monitor.sync();
  time.advance(1000);
  tick();
  assert.deepEqual(events.at(-1), { lagMs: 0 });
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

test('enabling mid-interval preserves lateness when a block crosses the next tick', () => {
  const time = clock();
  let on = false;
  let tick;
  const events = [];
  const monitor = createMainLoopMonitor({
    enabled: () => on,
    env: {},
    performance: time.performance,
    trace: (cat, sid, data) => events.push(data),
    setInterval: fn => { tick = fn; return { unref() {} }; },
    clearInterval() {},
  });
  try {
    time.advance(1000);
    tick();
    time.advance(900);
    on = true;
    monitor.sync();
    time.advance(600);
    tick();
    assert.equal(events[0].lagMs, 500);
    time.advance(1000);
    tick();
    assert.equal(events[1].lagMs, 0);
  } finally { monitor.stop(); }
});

test('enabling mid-interval before a real block reports at least 400 ms lateness', { timeout: 6000 }, async () => {
  let on = false;
  let monitor;
  let blockTimer;
  let deadline;
  try {
    const event = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('main.loop probe timed out')), 5000);
      monitor = createMainLoopMonitor({
        enabled: () => on,
        env: {},
        trace: (cat, sid, data) => resolve(data),
      });
      blockTimer = setTimeout(() => {
        on = true;
        monitor.sync();
        const until = performance.now() + 600;
        while (performance.now() < until) {}
      }, 900);
    });
    assert.ok(event.lagMs >= 400, `lagMs=${event.lagMs} must expose the blocked tick`);
    assert.equal(Object.hasOwn(event, 'maxMs'), false);
  } finally {
    clearTimeout(blockTimer);
    clearTimeout(deadline);
    monitor?.stop();
  }
});
