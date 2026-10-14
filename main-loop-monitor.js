'use strict';

const perf = require('node:perf_hooks');

function createMainLoopMonitor({ enabled, trace, monitorEventLoopDelay = perf.monitorEventLoopDelay,
  setInterval: schedule = setInterval, clearInterval: cancel = clearInterval }) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  let collecting = false;
  let stopped = false;
  function sync() {
    const on = !stopped && enabled();
    if (on === collecting) return;
    collecting = on;
    if (on) { histogram.reset(); histogram.enable(); }
    else histogram.disable();
  }
  sync();
  const timer = schedule(() => {
    sync();
    if (!collecting) return;
    trace('main.loop', null, { maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6 });
    histogram.reset();
  }, 1000);
  timer.unref();
  return { sync, stop() { stopped = true; sync(); cancel(timer); } };
}

module.exports = { createMainLoopMonitor };
