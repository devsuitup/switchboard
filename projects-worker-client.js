'use strict';

// see .ai/contexts/session-cache.md ("Projects query worker")
const RECONCILE_TIMEOUT_MS = 5 * 60 * 1000;

function createProjectsWorkerClient({ workerFactory, snapshot, apply, accepted = () => {}, canReconcile = () => true, timeoutMs = 30000, reconcileTimeoutMs = RECONCILE_TIMEOUT_MS, maxDiscards = 3 }) {
  let worker = null;
  const terminations = new Set();
  let stopped = false;
  let active = null;
  let pending = null;
  let nextId = 0;
  const waiters = new Set();
  let receiving = null;
  const receiveChains = new Set();
  const mergeOptions = (a, b) => ({ ...a, ...b, reconcile: !!(a?.reconcile || b?.reconcile),
    readOnly: !!(a?.readOnly || b?.readOnly), measureBytes: !!(a?.measureBytes || b?.measureBytes) });
  const deliverable = result => result?.effects?.length === 0 && result.keptLiveRows?.length === 0 && !result.reconciled;

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

  function markStale(job, reason, before, after) {
    if (job.stale) return;
    job.stale = true;
    job.conflict = { reason, before, after };
  }

  function conflict(job, result) {
    if (active !== job) return;
    clearTimeout(job.timer);
    const limit = job.conflict?.reason === 'deletion' ? Math.max(2, maxDiscards) : maxDiscards;
    if (++job.discards < limit && (job.options.reconcile || job.waiters.some(waiter => waiters.has(waiter)))) {
      if (!(job.options.readOnly && pending?.options.reconcile)) {
        job.options = mergeOptions(job.options, pending?.options);
        job.waiters.push(...(pending?.waiters || []));
        pending = null;
      }
      dispatch(job);
      return;
    }
    active = null;
    if (deliverable(result)) {
      for (const waiter of job.waiters) settle(waiter, null, { ...result, stale: true });
      dispatchPending();
      return;
    }
    const error = Object.assign(new Error('Projects changed while loading; reload to retry.'), {
      code: 'PROJECTS_SNAPSHOT_CONFLICT', dispatches: job.discards, reconcile: !!job.options.reconcile, reason: 'unknown', ...job.conflict });
    for (const waiter of job.waiters) settle(waiter, error);
    dispatchPending();
  }

  function receive(message) {
    if (!active || message.id !== active.id) return;
    if (message.error) { fail(new Error(message.error)); return; }
    try {
      const state = snapshot();
      if (message.progress) {
        if (active.stale) return;
        if (state.liveVersion !== active.liveVersion) return markStale(active, 'live', active.liveVersion, state.liveVersion);
        if (state.version !== active.version) return markStale(active, 'db');
        const job = active;
        const applied = apply({ ...message.progress, reconciled: false });
        const finish = acknowledgment => {
          if (active !== job) return;
          const current = snapshot();
          if (current.liveVersion !== job.liveVersion) markStale(job, 'live', job.liveVersion, current.liveVersion);
          else if (acknowledgment?.committedRevision !== undefined && current.writerRevision !== acknowledgment.committedRevision
            || acknowledgment?.version !== undefined && current.version !== acknowledgment.version) markStale(job, 'db');
          if (!job.stale) active.version = acknowledgment?.version ?? current.version;
        };
        if (applied?.then) return applied.then(finish).catch(error => {
          if (active !== job) return;
          if (error.code === 'PROJECT_EPOCH_STALE' || error.code === 'DELETION_OWNERSHIP') {
            job.options = { ...job.options, readOnly: true };
            markStale(job, 'deletion');
          } else if (error.code === 'WRITER_STALE') markStale(job, 'writer');
          else fail(error);
        });
        return finish();
      }
      const job = active;
      const result = message.result;
      const allowDbChange = deliverable(result);
      if (state.liveVersion !== job.liveVersion) markStale(job, 'live', job.liveVersion, state.liveVersion);
      else if (!allowDbChange && state.version !== job.version) markStale(job, 'db');
      if (job.stale) return conflict(job, result);
      const finish = acknowledgment => {
        if (active !== job) return;
        const current = snapshot();
        const dbChanged = acknowledgment?.committedRevision !== undefined
          ? current.writerRevision !== acknowledgment.committedRevision : current.version !== (acknowledgment?.version ?? job.version);
        if (current.liveVersion !== job.liveVersion) markStale(job, 'live', job.liveVersion, current.liveVersion);
        else if (!allowDbChange && dbChanged) markStale(job, 'db');
        if (job.stale) return conflict(job, result);
        clearTimeout(job.timer);
        accepted(result, { delivered: job.waiters.some(waiter => waiters.has(waiter)) });
        active = null;
        for (const waiter of job.waiters) settle(waiter, null, result);
        dispatchPending();
      };
      const applied = apply(result);
      if (applied?.then) return applied.then(finish).catch(error => {
        if (active !== job) return;
        if (error.code === 'PROJECT_EPOCH_STALE' || error.code === 'DELETION_OWNERSHIP') {
          job.options = { ...job.options, readOnly: true };
          markStale(job, 'deletion');
          return conflict(job);
        }
        if (error.code === 'WRITER_STALE') {
          markStale(job, 'writer');
          return conflict(job);
        }
        fail(error);
      });
      finish(applied);
    } catch (error) { fail(error); }
  }

  function dispatch(job) {
    try {
      if (!worker) {
        const current = workerFactory();
        worker = current;
        current.on('message', message => {
          const receiveCurrent = () => worker === current ? receive(message) : undefined;
          const result = receiving ? receiving.then(receiveCurrent) : receiveCurrent();
          if (result?.then) {
            const queued = Promise.resolve(result).finally(() => {
              receiveChains.delete(queued);
              if (receiving === queued) receiving = null;
            });
            receiveChains.add(queued);
            receiving = queued;
          }
        });
        current.on('error', error => { if (worker === current) fail(error); });
        current.on('exit', code => { if (worker === current) fail(new Error(`projects worker exited ${code}`)); });
      }
      const state = snapshot();
      if (!canReconcile()) job.options = { ...job.options, reconcile: false, readOnly: true };
      active = { ...job, id: ++nextId, version: state.version, liveVersion: state.liveVersion, stale: false, conflict: undefined };
      if (job.options.reconcile || active.hardDeadline) {
        active.hardDeadline ||= Date.now() + reconcileTimeoutMs;
        active.timer = setTimeout(() => {
          receiving = null;
          fail(new Error('projects worker reconcile timed out'));
        }, Math.max(0, active.hardDeadline - Date.now()));
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
        settle(waiter, Object.assign(new Error('projects worker timed out'), { code: 'PROJECTS_WORKER_TIMEOUT', timeoutMs,
          ...(active ? { reconcile: !!active.options.reconcile, dispatches: active.discards + 1 } : {}) }));
        if (active && !active.options.reconcile && !active.waiters.some(w => waiters.has(w))) {
          resetWorker();
          receiving = null;
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

  async function shutdown() {
    stopped = true;
    fail(new Error('projects worker shut down'));
    await Promise.all([...terminations, ...[...receiveChains].map(chain => chain.catch(() => {}))]);
  }

  return { request, shutdown };
}

module.exports = { createProjectsWorkerClient };
