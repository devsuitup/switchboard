'use strict';

module.exports = function createClock() {
  let time = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const timer = { unref() {} };
      timers.set(timer, { callback, due: time + delay });
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    advance(ms) {
      time += ms;
      for (const [timer, task] of [...timers]) {
        if (task.due <= time) {
          timers.delete(timer);
          task.callback();
        }
      }
    },
    get size() { return timers.size; },
  };
};
