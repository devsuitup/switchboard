'use strict';

const CLOSE_GRACE_MS = 2000;

function closeWindowsPty(pty, close, terminate, { schedule = setTimeout, evidence = false, deadline: stopDeadline = Infinity } = {}) {
  if (evidence) {
    const deadline = Math.min(stopDeadline, Date.now() + CLOSE_GRACE_MS);
    return new Promise(resolve => {
      let issued = false;
      try { issued = close() !== false; } catch {}
      function check() {
        const remaining = deadline - Date.now();
        if (!issued || pty._agent?.exitCode !== undefined || remaining <= 0) {
          Promise.resolve().then(terminate).then(proof => resolve(issued && proof?.ended === true ? proof
            : { ended: false, code: 'UNKNOWN' }), () => resolve({ ended: false, code: 'UNKNOWN' }));
          return;
        }
        const timer = schedule(check, Math.min(25, remaining));
        timer?.unref?.();
      }
      check();
    });
  }
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
