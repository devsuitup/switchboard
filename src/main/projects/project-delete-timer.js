'use strict';

function armDeadlineTimer({ deadline, now, signal, schedule = setTimeout, cancel = clearTimeout }, expire) {
  let timer, disposed = false;
  const dispose = () => {
    disposed = true;
    cancel(timer);
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => {
    if (disposed) return;
    dispose();
    expire();
  };
  const arm = () => {
    if (disposed) return;
    if (signal?.aborted || now() >= deadline) return abort();
    timer = schedule(arm, Math.max(1, deadline - now()));
  };
  signal?.addEventListener('abort', abort, { once: true });
  arm();
  return dispose;
}

module.exports = { armDeadlineTimer };
