'use strict';

const perf = require('node:perf_hooks');

function createMainLoopMonitor({ enabled, trace, env = process.env, performance = perf.performance,
  monitorEventLoopDelay = perf.monitorEventLoopDelay,
  setInterval: schedule = setInterval, clearInterval: cancel = clearInterval }) {
  const histogram = env.SWITCHBOARD_MAIN_LOOP_HISTOGRAM === '1'
    ? monitorEventLoopDelay({ resolution: 20 }) : null;
  let collecting = false;
  let stopped = false;
  let expected = performance.now() + 1000;
  function sync() {
    const on = !stopped && enabled();
    if (on === collecting) return;
    collecting = on;
    if (on) {
      histogram?.reset();
      histogram?.enable();
    } else histogram?.disable();
  }
  sync();
  const timer = schedule(() => {
    sync();
    const now = performance.now();
    const lagMs = Math.max(0, now - expected);
    expected = now + 1000;
    if (!collecting) return;
    const data = { lagMs };
    if (histogram) {
      data.maxMs = histogram.max / 1e6;
      data.p99Ms = histogram.percentile(99) / 1e6;
    }
    trace('main.loop', null, data);
    histogram?.reset();
  }, 1000);
  timer.unref();
  return { sync, stop() { stopped = true; sync(); cancel(timer); } };
}

module.exports = { createMainLoopMonitor };
