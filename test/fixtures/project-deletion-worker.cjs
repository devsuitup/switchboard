'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

module.exports = function workerHarness(db, onMessage = () => {}) {
  const port = new EventEmitter(), messages = [], pending = new Map();
  let id = 0;
  port.postMessage = message => {
    messages.push(message); onMessage(message);
    if (message.id && !message.started) {
      const waiter = pending.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
    }
  };
  const filename = require.resolve('../../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port }
      : name === '../session-index-store' ? { openSessionIndexStore: () => db } : nativeRequire(name),
    Buffer, setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename });
  function post(command, ...args) {
    const requestId = ++id;
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: { message: 'worker test deadline' } }); }, 10000);
      pending.set(requestId, { resolve, timer });
      port.emit('message', { id: requestId, command, args });
    });
  }
  const client = { ready: Promise.resolve(), async request(command, ...args) {
    const reply = await post(command, ...args);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  } };
  return { post, client, messages };
};

module.exports.createWorker = function createWorker(db) {
  const worker = new EventEmitter(), port = new EventEmitter();
  let stopped = false;
  port.postMessage = message => { if (!stopped) worker.emit('message', message); };
  worker.postMessage = message => port.emit('message', message);
  worker.terminate = async () => { stopped = true; };
  const filename = require.resolve('../../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  queueMicrotask(() => vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port }
      : name === '../session-index-store' ? { openSessionIndexStore: () => db } : nativeRequire(name),
    Buffer, setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename }));
  return worker;
};
