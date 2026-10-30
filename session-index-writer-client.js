'use strict';

// see .ai/contexts/session-index-writer.md
function createWriterWorkerClient({ workerFactory, onSettings = () => {}, onBusyCounts = () => {}, timeoutMs = 30000, maxRestarts = 3,
  now = () => Date.now(), setTimeout = global.setTimeout, clearTimeout = global.clearTimeout, heartbeatMs = 30000, log = console }) {
  let worker, closing, stopped = false, terminated = false, nextId = 0, restartTimer;
  const restarts = [];
  const queue = [];
  const active = new Map();
  const terminations = new Set();
  let bootResolve, bootReject;
  const ready = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  ready.catch(() => {});

  function terminateWorker(current) {
    clearTimeout(current.bootTimer);
    clearTimeout(current.heartbeatTimer);
    const terminated = Promise.resolve().then(() => current.terminate());
    terminations.add(terminated);
    terminated.then(() => terminations.delete(terminated), () => {});
    return terminated;
  }

  function terminate() {
    terminated = true;
    stopped = true;
    clearTimeout(restartTimer);
    const error = new Error('writer shut down; unfinished request outcome unknown');
    bootReject(error);
    for (const job of [...queue.splice(0), ...active.values()]) settle(job, error);
    active.clear();
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
      for (const job of queue.splice(0)) settle(job, error);
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
    for (const job of active.values()) settle(job, new Error(`writer outcome unknown for request ${job.id}: ${error.message}`));
    active.clear();
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
      try { current.postMessage({ id: job.id, command: job.command, args: job.args }); }
      catch (error) { void fail(current, error); return; }
      if (worker !== current) return;
    }
  }

  function start() {
    let current;
    try { current = workerFactory(); }
    catch (error) { restart(error); return; }
    worker = current;
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
        clearTimeout(current.bootTimer);
        onSettings(message.settings);
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

  function enqueue(command, args) {
    return new Promise((resolve, reject) => {
      queue.push({ id: ++nextId, command, args, resolve, reject });
      dispatch();
    });
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
  return { ready, request, close, terminate };
}

module.exports = { createWriterWorkerClient };
