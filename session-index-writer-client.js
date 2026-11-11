'use strict';

// see .ai/contexts/session-index-writer.md
function createWriterWorkerClient({ workerFactory, onSettings = () => {}, onBusyCounts = () => {}, onBootstrap = () => {}, timeoutMs = 30000, maxRestarts = 3,
  now = () => Date.now(), setTimeout = global.setTimeout, clearTimeout = global.clearTimeout, heartbeatMs = 30000, log = console }) {
  let worker, closing, stopped = false, terminated = false, nextId = 0, restartTimer;
  const restarts = [];
  const queue = [];
  const active = new Map();
  const terminations = new Set();
  const sealedWorkflows = new Set();
  const retiredWorkflows = new Set();
  const workflowTerminations = new Map();
  let bootResolve, bootReject, bootstrapWarning = false;
  const ready = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  ready.catch(() => {});

  function terminateWorker(current) {
    clearTimeout(current.bootTimer);
    clearTimeout(current.heartbeatTimer);
    const terminated = Promise.resolve().then(() => current.terminate());
    terminations.add(terminated);
    terminated.then(() => { terminations.delete(terminated); current.confirmTermination(); }, () => {});
    return terminated;
  }

  function terminate() {
    terminated = true;
    stopped = true;
    clearTimeout(restartTimer);
    const error = new Error('writer shut down; unfinished request outcome unknown');
    bootReject(error);
    const jobs = [...queue.splice(0), ...active.values()];
    for (const job of jobs) settle(job, error);
    active.clear();
    for (const job of jobs) retireWorkflow(job.workflowId, false);
    const current = worker;
    worker = null;
    if (current) terminateWorker(current);
    return Promise.all([...terminations]);
  }

  function settle(job, error, value) {
    clearTimeout(job.timer);
    if (job.settled) return;
    job.settled = true;
    if (error) job.reject(error);
    else job.resolve(value);
  }
  function pruneRestarts() {
    while (restarts.length && now() - restarts[0] >= 60000) restarts.shift();
  }
  function restart(error) {
    pruneRestarts();
    if (restarts.length >= maxRestarts) {
      stopped = true;
      bootReject(error);
      const jobs = queue.splice(0);
      for (const job of jobs) settle(job, error);
      for (const job of jobs) retireWorkflow(job.workflowId, false);
      return;
    }
    const backoff = [100, 500, 1000][Math.min(restarts.length, 2)];
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopped) { restarts.push(now()); start(); }
    }, backoff);
  }

  async function fail(current, error) {
    if (worker !== current) return;
    worker = null;
    const jobs = [...active.values()];
    for (const job of jobs) settle(job, new Error(`writer outcome unknown for request ${job.id}: ${error.message}`));
    active.clear();
    for (const job of jobs) retireWorkflow(job.workflowId, false);
    await terminateWorker(current).catch(() => {});
    if (stopped) return;
    restart(error);
  }

  function dispatch() {
    if (!worker?.writerReady) return;
    while (queue.length && active.size < 32) {
      const job = queue.shift();
      active.set(job.id, job);
      const current = worker;
      if (job.workflowId) workflowTerminations.set(job.workflowId, current.terminationConfirmed);
      try { current.postMessage({ id: job.id, command: job.command, args: job.args, ...(job.workflowId ? { workflowId: job.workflowId } : {}) }); }
      catch (error) { void fail(current, error); return; }
      if (worker !== current) return;
    }
  }

  function start() {
    let current;
    try { current = workerFactory(); }
    catch (error) { restart(error); return; }
    worker = current;
    current.terminationConfirmed = new Promise(resolve => { current.confirmTermination = resolve; });
    current.bootTimer = setTimeout(() => void fail(current, new Error('writer bootstrap timed out')), timeoutMs);
    const heartbeat = () => {
      clearTimeout(current.heartbeatTimer);
      current.heartbeatTimer = setTimeout(() => void fail(current, new Error('writer heartbeat timed out; unresponsive')), heartbeatMs);
    };
    current.on('message', message => {
      if (worker !== current) return;
      heartbeat();
      if (message.busyCounts) {
        log.info('[session-index-writer] SQLITE_BUSY ' + JSON.stringify(message.busyCounts));
        onBusyCounts(message.busyCounts);
        return;
      }
      if (message.heartbeat) return;
      if (message.ready) {
        if (current.writerReady) return;
        clearTimeout(current.bootTimer);
        onSettings(message.settings);
        try { onBootstrap(message); } catch (error) {
          if (!bootstrapWarning) {
            bootstrapWarning = true;
            try { log.warn('[session-index-writer] bootstrap observer failed: ' + (error?.message ?? String(error))); } catch {}
          }
        }
        current.writerReady = true;
        bootResolve(message);
        dispatch();
        return;
      }
      const job = active.get(message.id);
      if (!job) return;
      if (message.started) {
        job.timer ||= setTimeout(() => settle(job, Object.assign(new Error(`writer command timed out for request ${job.id}; outcome unknown`), { code: 'WRITER_TIMEOUT', requestId: job.id })), timeoutMs);
        return;
      }
      active.delete(message.id);
      if (message.settings) onSettings(message.settings);
      const error = message.error ? Object.assign(new Error(message.error.message), { code: message.error.code, requestId: job.id }) : null;
      settle(job, error, message.result);
      retireWorkflow(job.workflowId, false);
      dispatch();
    });
    current.on('error', error => { void fail(current, error); });
    current.on('exit', code => { void fail(current, new Error(`writer exited ${code}`)); });
  }

  function request(command, ...args) {
    if (stopped && !terminated && !closing && restarts.length) {
      pruneRestarts();
      if (restarts.length < maxRestarts) { stopped = false; restart(new Error('writer circuit recovery')); }
    }
    if (closing || stopped) return Promise.reject(new Error('writer is closing or shut down'));
    return enqueue(command, args);
  }

  function enqueue(command, args, workflowId) {
    return new Promise((resolve, reject) => {
      queue.push({ id: ++nextId, command, args, workflowId, resolve, reject });
      dispatch();
    });
  }

  function requestForWorkflow(workflowId, command, ...args) {
    if (sealedWorkflows.has(workflowId)) return Promise.reject(Object.assign(new Error('project workflow is sealed'), { code: 'WORKFLOW_SEALED' }));
    if (closing || stopped) return Promise.reject(new Error('writer is closing or shut down'));
    return enqueue(command, args, workflowId);
  }
  function fenceWorkflow(workflowId) {
    sealedWorkflows.add(workflowId);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].workflowId === workflowId) {
      settle(queue.splice(i, 1)[0], Object.assign(new Error('project workflow is sealed'), { code: 'WORKFLOW_SEALED' }));
    }
    return request('fenceWorkflow', workflowId);
  }
  function retireWorkflow(workflowId, requested = true) {
    if (!workflowId) return;
    if (requested) retiredWorkflows.add(workflowId);
    if (!retiredWorkflows.has(workflowId)) return;
    if ([...active.values(), ...queue].some(job => job.workflowId === workflowId)) return;
    retiredWorkflows.delete(workflowId);
    workflowTerminations.delete(workflowId);
    if (!sealedWorkflows.delete(workflowId)) return;
    void request('retireWorkflow', workflowId).catch(() => {});
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      try {
        await ready;
        if (stopped && !worker) throw new Error('writer circuit is open; close cannot be acknowledged');
        await enqueue('close', []);
      }
      finally {
        await terminate();
      }
    })();
    return closing;
  }

  start();
  return { ready, request, requestForWorkflow, fenceWorkflow, retireWorkflow,
    waitForWorkflowTermination: workflowId => workflowTerminations.get(workflowId) || Promise.resolve(), close, terminate };
}

module.exports = { createWriterWorkerClient };
