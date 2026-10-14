'use strict';

// see .ai/contexts/session-cache.md ("Projects query worker")
const RECONCILE_TIMEOUT_MS = 5 * 60 * 1000;

function createProjectsWorkerClient({ workerFactory, snapshot, apply, timeoutMs = 30000, reconcileTimeoutMs = RECONCILE_TIMEOUT_MS, maxDiscards = 3 }) {
  let worker = null;
  let stopped = false;
  let active = null;
  let pending = null;
  let nextId = 0;
  const waiters = new Set();
  const mergeOptions = (a, b) => ({ ...a, ...b, reconcile: !!(a?.reconcile || b?.reconcile), measureBytes: !!(a?.measureBytes || b?.measureBytes) });

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

  function receive(message) {
    if (!active || message.id !== active.id) return;
    if (message.error) { fail(new Error(message.error)); return; }
    try {
      const state = snapshot();
      if (message.progress) {
        if (active.stale || state.version !== active.version) { active.stale = true; return; }
        apply({ ...message.progress, reconciled: false });
        active.version = snapshot().version;
        return;
      }
      const job = active;
      clearTimeout(job.timer);
      const result = message.result;
      const readOnly = result.effects?.length === 0 && result.keptLiveRows?.length === 0 && !result.reconciled;
      const stale = job.stale || (!readOnly && state.version !== job.version);
      if (stale && ++job.discards < maxDiscards && job.waiters.some(waiter => waiters.has(waiter))) {
        job.options = mergeOptions(job.options, pending?.options);
        job.waiters.push(...(pending?.waiters || []));
        pending = null;
        dispatch(job);
        return;
      }
      const published = stale ? { ...result, effects: [], keptLiveRows: [], reconciled: false, stale: true } : result;
      if (!stale) apply(result);
      active = null;
      for (const waiter of job.waiters) settle(waiter, null, published);
      dispatchPending();
    } catch (error) { fail(error); }
  }

  function dispatch(job) {
    try {
      if (!worker) {
        const current = workerFactory();
        worker = current;
        current.on('message', message => { if (worker === current) receive(message); });
        current.on('error', error => { if (worker === current) fail(error); });
        current.on('exit', code => { if (worker === current) fail(new Error(`projects worker exited ${code}`)); });
      }
      const state = snapshot();
      active = { ...job, id: ++nextId, version: state.version, stale: false };
      if (job.options.reconcile) {
        active.timer = setTimeout(() => fail(new Error('projects worker reconcile timed out')), reconcileTimeoutMs);
      }
      worker.postMessage({ ...state, ...job.options, id: active.id });
    } catch (error) { fail(error); }
  }

  function request(options = {}) {
    if (stopped) return Promise.reject(new Error('projects worker shut down'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        settle(waiter, new Error('projects worker timed out'));
        if (active && !active.options.reconcile && !active.waiters.some(w => waiters.has(w))) {
          resetWorker();
          dispatchPending();
        }
      }, timeoutMs);
      if (active) {
        if (!pending) pending = { options, waiters: [], discards: 0 };
        else pending.options = mergeOptions(pending.options, options);
        pending.waiters.push(waiter);
      } else dispatch({ options, waiters: [waiter], discards: 0 });
    });
  }

  function shutdown() {
    stopped = true;
    fail(new Error('projects worker shut down'));
  }

  return { request, shutdown };
}

module.exports = { createProjectsWorkerClient };
