'use strict';

// see .ai/contexts/viewer-panel.md (File list workers)
function createFileListsWorkerClient({ workerFactory, snapshot, apply, getVersion = () => snapshot().version, timeoutMs = 30000, hardTimeoutMs = 5 * 60 * 1000, maxDiscards = 3 }) {
  let worker = null;
  let stopped = false;
  let active = null;
  let pending = null;
  let nextId = 0;
  const waiters = new Set();

  function settle(waiter, error, result) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }

  function resetWorker() {
    clearTimeout(active?.timer);
    const old = worker;
    worker = null;
    active = null;
    if (old) Promise.resolve(old.terminate()).catch(() => {});
  }

  function fail(error) {
    resetWorker();
    pending = null;
    for (const waiter of waiters) settle(waiter, error);
  }

  function dispatchPending() {
    const job = pending;
    pending = null;
    if (job && job.waiters.some(waiter => waiters.has(waiter))) dispatch(job);
  }

  async function receive(message) {
    const job = active;
    if (!job || message.id !== job.id || job.receiving) return;
    if (message.error) { fail(new Error(message.error)); return; }
    job.receiving = true;
    try {
      const valid = () => active === job && getVersion() === job.version;
      const accepted = valid() && await apply(message.result, valid);
      if (active !== job) return;
      clearTimeout(job.timer);
      if (!accepted || !valid()) {
        if (++job.discards < maxDiscards && job.waiters.some(waiter => waiters.has(waiter))) {
          job.waiters.push(...(pending?.waiters || []));
          pending = null;
          dispatch(job);
          return;
        }
        for (const waiter of job.waiters) settle(waiter, new Error('file list snapshot changed'));
      } else {
        for (const waiter of job.waiters) settle(waiter, null, message.result);
      }
      active = null;
      dispatchPending();
    } catch (error) { if (active === job) fail(error); }
  }

  function dispatch(job) {
    try {
      if (!worker) {
        const current = workerFactory();
        worker = current;
        current.on('message', message => { if (worker === current) void receive(message); });
        current.on('error', error => { if (worker === current) fail(error); });
        current.on('exit', code => { if (worker === current) fail(new Error(`file list worker exited ${code}`)); });
      }
      const state = snapshot();
      active = { ...job, id: ++nextId, version: state.version, receiving: false };
      active.timer = setTimeout(() => fail(new Error('file list worker hard deadline exceeded')), hardTimeoutMs);
      worker.postMessage({ ...state, id: active.id });
    } catch (error) { fail(error); }
  }

  function request() {
    if (stopped) return Promise.reject(new Error('file list worker shut down'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        settle(waiter, new Error('file list worker timed out'));
        if (active && !active.waiters.some(w => waiters.has(w))) {
          resetWorker();
          dispatchPending();
        }
      }, timeoutMs);
      if (active) {
        if (!pending) pending = { waiters: [], discards: 0 };
        pending.waiters.push(waiter);
      } else dispatch({ waiters: [waiter], discards: 0 });
    });
  }

  function shutdown() {
    stopped = true;
    fail(new Error('file list worker shut down'));
  }

  return { request, shutdown };
}

module.exports = { createFileListsWorkerClient };
