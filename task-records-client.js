'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createTaskRecordsClient({ onSnapshot = () => {}, onRekey = () => {}, onError = () => {}, maxEntries = 2048, workerFactory = () => new Worker(path.join(__dirname, 'workers/task-records.js')) } = {}) {
  const snapshots = new Map();
  const requests = new Map();
  const dirty = new Map();
  let worker;
  let seq = 0;
  let disposed = false;
  let unavailable = false;
  const redirects = new Map();
  function resolve(id) { const seen = new Set(); while (redirects.has(id) && !seen.has(id)) { seen.add(id); id = redirects.get(id); } return id; }
  function send(message) {
    if (disposed || unavailable) return Promise.resolve();
    if (!worker) {
      worker = workerFactory();
      worker.on('message', message => {
        if (message.rekey) {
          const { oldId, newId, continued } = message.rekey;
          if (continued) {
            redirects.set(oldId, newId);
            while (redirects.size > maxEntries) redirects.delete(redirects.keys().next().value);
          }
          snapshots.delete(oldId);
          onRekey(oldId, newId, continued);
        }
        if (message.snapshot) {
          const s = message.snapshot;
          if (!s.headTurn && snapshots.get(s.parentSessionId)?.headTurn) s.headTurn = snapshots.get(s.parentSessionId).headTurn;
          snapshots.set(s.parentSessionId, s);
          while (snapshots.size > maxEntries) snapshots.delete(snapshots.keys().next().value);
          onSnapshot(s);
        }
        if (message.error) onError(message.error);
        if (message.requestId) { requests.get(message.requestId)?.(); requests.delete(message.requestId); }
      });
      worker.on('error', error => {
        unavailable = true;
        onError(error.message);
        for (const resolve of requests.values()) resolve();
        requests.clear();
      });
      worker.on('exit', () => {
        unavailable = true;
        for (const settle of requests.values()) settle();
        requests.clear();
      });
    }
    const requestId = ++seq;
    const promise = new Promise(resolve => requests.set(requestId, resolve));
    worker.postMessage({ ...message, requestId });
    return promise;
  }
  function read(file, parentSessionId, { turnOnly = false } = {}) {
    const running = dirty.get(file);
    if (running) { running.again = true; running.turnOnly &&= turnOnly; return running.promise; }
    const work = { again: false, turnOnly };
    work.promise = (async () => {
      do { work.again = false; await send({ type: 'read', file, parentSessionId, turnOnly: work.turnOnly }); } while (work.again && !disposed);
    })().finally(() => dirty.delete(file));
    dirty.set(file, work);
    return work.promise;
  }
  return { read,
    readBatch: rows => send({ type: 'readBatch', rows }),
    job: (parentSessionId, evidence) => send({ type: 'job', parentSessionId, evidence }),
    child: (file, parentSessionId, agentId) => send({ type: 'child', file, parentSessionId, agentId }),
    ownerDied: parentSessionId => send({ type: 'death', parentSessionId }),
    ownerAlive: parentSessionId => send({ type: 'alive', parentSessionId }),
    rekey: (oldId, newId, { continued = false } = {}) => send({ type: 'rekey', oldId, newId, continued }),
    hasRecord: (id, taskId) => snapshots.get(resolve(id))?.tasks.some(t => t.id === taskId) || false,
    snapshots: () => [...snapshots.values()],
    async dispose() { disposed = true; for (const resolve of requests.values()) resolve(); requests.clear(); if (worker) await worker.terminate(); },
  };
}

module.exports = { createTaskRecordsClient };
