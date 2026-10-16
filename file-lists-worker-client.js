'use strict';

// see .ai/contexts/viewer-panel.md (File list workers)
function createFileListsWorkerClient({ workerFactory, snapshot, apply, onError = () => {}, getVersion = () => snapshot().version, timeoutMs = 30000, hardTimeoutMs = 5 * 60 * 1000, maxDiscards = 3 }) {
  let worker = null;
  const terminations = new Set();
  let stopped = false;
  let active = null;
  let pending = null;
  let applying = null;
  let pendingApply = null;
  let generation = 0;
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
    if (old) {
      const terminated = Promise.resolve().then(() => old.terminate());
      terminations.add(terminated);
      terminated.then(() => terminations.delete(terminated), () => {});
    }
  }

  function fail(error, report = true) {
    const published = active?.published || active?.background || applying?.published || pendingApply?.published;
    generation++;
    resetWorker();
    pending = null;
    clearTimeout(applying?.timer);
    clearTimeout(pendingApply?.timer);
    pendingApply = null;
    for (const waiter of waiters) settle(waiter, error);
    if (report && published) onError(error);
  }

  function dispatchPending() {
    if (active) return;
    const job = pending;
    pending = null;
    if (job && job.waiters.some(waiter => waiters.has(waiter))) dispatch(job);
  }

  function retry(job) {
    clearTimeout(job.timer);
    if (++job.discards < maxDiscards && (job.published || job.background || job.waiters.some(waiter => waiters.has(waiter)))) {
      if (active) {
        active.background = true;
        active.discards = Math.max(active.discards, job.discards);
      } else {
        job.waiters.push(...(pending?.waiters || []));
        pending = null;
        dispatch(job);
      }
      return;
    }
    for (const waiter of job.waiters) settle(waiter, new Error('file list snapshot changed'));
    if (job.published || job.background) onError(new Error('file list index snapshot changed'));
    dispatchPending();
  }

  function failApply(job, error) {
    if (job.cancelled || job.generation !== generation || stopped) return;
    job.cancelled = true;
    if (pendingApply === job) pendingApply = null;
    onError(error);
    retry(job);
  }

  async function applyPending() {
    if (applying || !pendingApply) return;
    const job = pendingApply;
    pendingApply = null;
    applying = job;
    const current = () => job.generation === generation && !job.cancelled && !stopped;
    const valid = () => current() && getVersion() === job.version;
    try {
      await new Promise(resolve => setImmediate(resolve));
      const accepted = valid() && await apply(job.result, valid);
      if (current() && (!accepted || !valid())) retry(job);
    } catch (error) { if (current()) failApply(job, error); }
    finally {
      clearTimeout(job.timer);
      applying = null;
      void applyPending();
    }
  }

  function receive(message) {
    const job = active;
    if (!job || message.id !== job.id || job.receiving) return;
    if (message.error) { fail(new Error(message.error)); return; }
    job.receiving = true;
    try {
      active = null;
      if (getVersion() !== job.version) { retry(job); return; }
      for (const waiter of job.waiters) settle(waiter, null, message.result);
      job.published = true;
      job.result = message.result;
      clearTimeout(pendingApply?.timer);
      pendingApply = job;
      void applyPending();
      dispatchPending();
    } catch (error) { fail(error); }
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
      active = { ...job, id: ++nextId, version: state.version, generation, receiving: false, background: job.background || job.published, published: false, cancelled: false };
      const dispatched = active;
      active.timer = setTimeout(() => {
        const error = new Error('file list worker hard deadline exceeded');
        if (dispatched.published) failApply(dispatched, error);
        else fail(error);
      }, hardTimeoutMs);
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
        if (active && !active.receiving && !active.published && !active.waiters.some(w => waiters.has(w))) {
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

  async function shutdown() {
    stopped = true;
    fail(new Error('file list worker shut down'), false);
    await Promise.all([...terminations]);
  }

  return { request, shutdown };
}

module.exports = { createFileListsWorkerClient };
