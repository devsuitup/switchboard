'use strict';

// see .ai/contexts/session-cache.md ("Projects query worker")
function createProjectsWorkerClient({ workerFactory, snapshot, apply, timeoutMs = 30000 }) {
  let worker = null;
  let stopped = false;
  let active = null;
  let pending = null;
  let nextId = 0;
  let timer = null;
  const waiters = [];

  function fail(error) {
    clearTimeout(timer);
    const old = worker;
    worker = null;
    active = pending = null;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    if (old) Promise.resolve(old.terminate()).catch(() => {});
  }

  function dispatch(options) {
    try {
      if (!worker) {
        const current = workerFactory();
        worker = current;
        current.on('message', message => {
          if (worker !== current || !active || message.id !== active.id) return;
          clearTimeout(timer);
          if (message.error) { fail(new Error(message.error)); return; }
          try {
            const state = snapshot();
            const readOnly = message.result.effects?.length === 0
              && message.result.keptLiveRows?.length === 0 && !message.result.reconciled;
            if (pending || (!readOnly && state.version !== active.version)) {
              const latest = { ...active.options, ...pending };
              pending = null;
              active = null;
              dispatch(latest);
              return;
            }
            apply(message.result);
            active = null;
            for (const waiter of waiters.splice(0)) waiter.resolve(message.result);
          } catch (error) { fail(error); }
        });
        current.on('error', error => { if (worker === current) fail(error); });
        current.on('exit', code => { if (worker === current) fail(new Error(`projects worker exited ${code}`)); });
      }
      const state = snapshot();
      const id = ++nextId;
      active = { id, version: state.version, options };
      timer = setTimeout(() => fail(new Error('projects worker timed out')), timeoutMs);
      worker.postMessage({ ...state, ...options, id });
    } catch (error) { fail(error); }
  }

  function request(options = {}) {
    if (stopped) return Promise.reject(new Error('projects worker shut down'));
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      if (active) pending = options;
      else dispatch(options);
    });
  }

  function shutdown() {
    stopped = true;
    fail(new Error('projects worker shut down'));
  }

  return { request, shutdown };
}

module.exports = { createProjectsWorkerClient };
