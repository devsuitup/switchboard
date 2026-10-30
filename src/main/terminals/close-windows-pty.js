'use strict';

const CLOSE_GRACE_MS = 2000;

function closeWindowsPty(pty, close, terminate, { schedule = setTimeout } = {}) {
  const deadline = Date.now() + CLOSE_GRACE_MS;
  close();
  function check() {
    const remaining = deadline - Date.now();
    if (pty._agent?.exitCode !== undefined || remaining <= 0) { void terminate(); return; }
    const step = Math.min(25, remaining);
    const timer = schedule(check, step);
    timer?.unref?.();
  }
  check();
}

module.exports = { closeWindowsPty };
