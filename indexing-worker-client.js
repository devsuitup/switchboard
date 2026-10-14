'use strict';

// see .ai/contexts/session-cache.md (Startup indexing worker)
function createIndexingWorkerClient({ workerFactory, snapshot, apply, progress = () => {}, trace = () => {}, timeoutMs = 10 * 60 * 1000, callerTimeoutMs = 30000 }) {
  let worker;
  let active;
  let stopped = false;
  let nextId = 0;
  const queue = [];

  function settle(waiter, error, result) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }

  function finish(error, result) {
    const job = active;
    if (!job) return;
    clearTimeout(job.timer);
    active = null;
    worker?.unref?.();
    trace('indexing.job', { kind: job.options.kind, jobId: job.id, totalMs: performance.now() - job.started, ok: !error,
      ...(error ? { error: error.message } : {}), sessions: result?.sessions, folders: result?.folders });
    for (const waiter of job.waiters) settle(waiter, error, result);
    dispatch();
  }

  function fail(error) {
    const old = worker;
    worker = null;
    if (old) Promise.resolve(old.terminate()).catch(() => {});
    finish(error);
  }

  async function receive(message) {
    const job = active;
    if (!job || message.id !== job.id) return;
    try {
      if (message.type === 'state') {
        worker.postMessage({ id: job.id, reply: message.sequence, state: snapshot() });
      } else if (message.type === 'batch') {
        await new Promise(resolve => setImmediate(resolve));
        if (active !== job || stopped) return;
        const before = snapshot();
        const accepted = before.version === message.version;
        const started = performance.now();
        if (accepted) apply(message);
        trace('indexing.apply', { kind: job.options.kind, jobId: job.id, entries: message.effects.length, bytes: message.bytes,
          applyMs: performance.now() - started, accepted });
        worker.postMessage({ id: job.id, reply: message.sequence, accepted, version: snapshot().version });
      } else if (message.type === 'progress') progress(message);
      else if (message.type === 'done') finish(message.error ? new Error(message.error) : null, message.result);
    } catch (error) { fail(error); }
  }

  function dispatch() {
    if (active || stopped || !queue.length) return;
    const job = queue.shift();
    if (job.options.kind === 'transitions' && job.waiters.every(waiter => waiter.settled)) { dispatch(); return; }
    active = { ...job, id: ++nextId, started: performance.now() };
    trace('indexing.start', { kind: job.options.kind, jobId: active.id, coldStart: job.options.coldStart,
      folders: job.options.folders?.length });
    active.timer = setTimeout(() => fail(new Error('indexing worker timed out')), timeoutMs);
    try {
      if (!worker) {
        const current = workerFactory();
        worker = current;
        current.on('message', message => { if (worker === current) void receive(message); });
        current.on('error', error => { if (worker === current) fail(error); });
        current.on('exit', code => { if (worker === current) fail(new Error(`indexing worker exited ${code}`)); });
      }
      worker.ref?.();
      worker.postMessage({ id: active.id, ...active.options });
    } catch (error) { fail(error); }
  }

  function request(options) {
    if (stopped) return Promise.reject(new Error('indexing worker shut down'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false };
      waiter.timer = setTimeout(() => settle(waiter, new Error('indexing worker caller timed out')),
        ['scan', 'entrypoints', 'titles', 'repair'].includes(options.kind) ? timeoutMs + callerTimeoutMs : callerTimeoutMs);
      const key = options.kind === 'refresh' ? JSON.stringify([options.projectsDir, options.folderPrefix, options.folders])
        : options.kind === 'transitions' ? options.folder : null;
      const pending = key !== null && queue.find(job => job.key === key && job.options.kind === options.kind);
      if (pending) {
        if (options.kind === 'refresh' && pending.options.fileSubsets && options.fileSubsets) {
          const paths = new Map(pending.options.fileSubsets.map(([folder, files]) => [folder, new Set(files)]));
          for (const [folder, files] of options.fileSubsets) for (const file of files) paths.get(folder).add(file);
          pending.options.fileSubsets = [...paths].map(([folder, files]) => [folder, [...files]]);
        } else pending.options = { ...options, fileSubsets: undefined };
        pending.waiters.push(waiter);
      } else queue.push({ options, key, waiters: [waiter] });
      dispatch();
    });
  }

  function shutdown() {
    stopped = true;
    for (const job of queue.splice(0)) for (const waiter of job.waiters) settle(waiter, new Error('indexing worker shut down'));
    fail(new Error('indexing worker shut down'));
  }

  return { request, shutdown };
}

module.exports = { createIndexingWorkerClient };
