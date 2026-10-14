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
  monitor.stop();
  assert.equal(calls.at(-1), 'clear');
});
