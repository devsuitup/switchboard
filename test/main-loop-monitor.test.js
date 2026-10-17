'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('main loop monitoring follows the trace flag, reports milliseconds, resets and stops', () => {
  const { createMainLoopMonitor } = require('../main-loop-monitor');
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
    trace: (...args) => calls.push(args),
    monitorEventLoopDelay: () => histogram,
    setInterval: (fn, ms) => { tick = fn; assert.equal(ms, 1000); return { unref() {} }; },
    clearInterval: () => calls.push('clear'),
  });
  tick();
  assert.deepEqual(calls, []);
  on = true;
  monitor.sync();
  tick();
  assert.deepEqual(calls, ['reset', 'enable', ['main.loop', null, { maxMs: 7, p99Ms: 3 }], 'reset']);
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

test('main loop monitoring spaces histogram wakeups by at least 100 ms', () => {
  const { createMainLoopMonitor } = require('../main-loop-monitor');
  const monitor = createMainLoopMonitor({
    enabled: () => false,
    trace: () => assert.fail('disabled monitoring must not trace'),
    monitorEventLoopDelay: ({ resolution }) => {
      assert.ok(resolution >= 100, `histogram resolution ${resolution} ms must be at least 100 ms`);
      return {};
    },
    setInterval: (fn, ms) => { assert.ok(ms >= 100); return { unref() {} }; },
    clearInterval: () => {},
  });
  monitor.stop();
});

test('main loop monitoring reports a simulated 600 ms stall in maxMs', () => {
  const { createMainLoopMonitor } = require('../main-loop-monitor');
  let tick;
  const events = [];
  const histogram = {
    max: 0,
    percentile: n => { assert.equal(n, 99); return histogram.max; },
    enable() {},
    disable() {},
    reset() { this.max = 0; },
  };
  const monitor = createMainLoopMonitor({
    enabled: () => true,
    trace: (...args) => events.push(args),
    monitorEventLoopDelay: () => histogram,
    setInterval: fn => { tick = fn; return { unref() {} }; },
    clearInterval: () => {},
  });
  histogram.max = 600 * 1e6;
  tick();
  assert.deepEqual(events, [['main.loop', null, { maxMs: 600, p99Ms: 600 }]]);
  assert.equal(histogram.max, 0);
  monitor.stop();
});
