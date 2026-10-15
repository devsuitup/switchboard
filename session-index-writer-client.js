'use strict';

// see .ai/contexts/session-index-writer.md
function createWriterWorkerClient({ workerFactory, onSettings = () => {}, timeoutMs = 30000, maxRestarts = 3 }) {
  let worker, closing, stopped = false, restarts = 0, nextId = 0;
  const queue = [];
  const active = new Map();
  let bootResolve, bootReject;
  const ready = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  ready.catch(() => {});

  function settle(job, error, value) {
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(value);
  }

  async function fail(current, error) {
    if (worker !== current) return;
    worker = null;
    for (const job of active.values()) settle(job, new Error(`writer outcome unknown for request ${job.id}: ${error.message}`));
    active.clear();
    await current.terminate().catch(() => {});
    if (stopped) return;
    if (++restarts > maxRestarts) {
      stopped = true;
      bootReject(error);
      for (const job of queue.splice(0)) settle(job, error);
      return;
    }
    start();
  }

  function dispatch() {
    if (!worker?.writerReady) return;
    while (queue.length && active.size < 32) {
      const job = queue.shift();
      active.set(job.id, job);
      const current = worker;
      job.timer = setTimeout(() => void fail(current, new Error('writer command timed out')), timeoutMs);
      try { current.postMessage({ id: job.id, command: job.command, args: job.args }); }
      catch (error) { void fail(current, error); return; }
      if (worker !== current) return;
    }
  }

  function start() {
    let current;
    try { current = workerFactory(); }
    catch (error) { stopped = true; bootReject(error); for (const job of queue.splice(0)) settle(job, error); return; }
    worker = current;
    const bootTimer = setTimeout(() => void fail(current, new Error('writer bootstrap timed out')), timeoutMs);
    current.on('message', message => {
      if (worker !== current) return;
      if (message.ready) {
        clearTimeout(bootTimer);
        onSettings(message.settings);
        current.writerReady = true;
        bootResolve(message);
        dispatch();
        return;
      }
      const job = active.get(message.id);
      if (!job) return;
      active.delete(message.id);
      onSettings(message.settings || []);
      const error = message.error ? Object.assign(new Error(message.error.message), { code: message.error.code, requestId: job.id }) : null;
      settle(job, error, message.result);
      dispatch();
    });
    current.on('error', error => { clearTimeout(bootTimer); void fail(current, error); });
    current.on('exit', code => { clearTimeout(bootTimer); void fail(current, new Error(`writer exited ${code}`)); });
  }

  function request(command, ...args) {
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
        stopped = true;
        const current = worker;
        worker = null;
        if (current) await current.terminate();
      }
    })();
    return closing;
  }

  start();
  return { ready, request, close };
}

module.exports = { createWriterWorkerClient };
